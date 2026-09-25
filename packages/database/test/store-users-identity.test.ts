/**
 * The two stores the whole flow starts from, proven against a real database.
 *
 * The property this file exists for is the identity generation: a writer
 * holding a stale read must lose *visibly*. Everything else here is either the
 * distinction between "no such row" and "the query failed", or the proof that a
 * conflict is something a caller can branch on rather than an opaque driver
 * error.
 *
 * Skipped, loudly, when `DATABASE_URL` is unset. A suite that silently passes
 * because it did nothing is worse than a failing one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { IdentityRecordRow, Transaction, UserRecord } from '@been-there/contracts';
import { StoreError } from '@been-there/contracts';
import { castId } from '@been-there/core';
import type { UserId } from '@been-there/core';
import { isConflict } from '../src/errors.js';
import { createTransaction } from '../src/transaction.js';
import { PostgresIdentityStore, PostgresUserStore, StoreConflictError } from '../src/store-users-identity.js';

// Same loading the migration runner does, so a developer who has run `make up`
// runs the real database rather than a suite that quietly did nothing.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENV_FILE = join(REPO_ROOT, '.env');
if (process.env.DATABASE_URL === undefined && existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match !== null && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString === undefined ? describe.skip : describe;

/** The OID pg uses for `timestamptz`; the only way to mis-read a row's clock. */
const TIMESTAMPTZ_OID = 1184;

describeIfDb('users and identity stores, against Postgres', () => {
  const users = new PostgresUserStore();
  const identity = new PostgresIdentityStore();
  let pool: pg.Pool;
  let transaction: Transaction;

  beforeAll(async () => {
    if (connectionString === undefined) {
      return;
    }
    pool = new pg.Pool({ connectionString });
    transaction = createTransaction(pool);
  });

  afterAll(async () => {
    if (pool !== undefined) {
      await pool.end();
    }
  });

  /** Every test owns fresh ids, so nothing is ever cleaned up and nothing collides. */
  function newUser(overrides: Partial<UserRecord> = {}): UserRecord {
    return {
      userId: castId<'UserId'>(randomUUID()),
      accountId: castId<'AccountId'>(randomUUID()),
      createdAt: new Date(),
      ...overrides,
    };
  }

  function identityRow(userId: UserId, overrides: Partial<IdentityRecordRow> = {}): IdentityRecordRow {
    return {
      userId,
      state: 'unverified',
      generation: 1,
      latestVerificationId: null,
      updatedAt: new Date(),
      ...overrides,
    };
  }

  /** A user with a first-generation identity row, which is what most cases need. */
  async function seededUser(): Promise<UserRecord> {
    const user = newUser();
    await transaction.run(async (tx) => {
      await users.create(user, tx);
      await identity.insert(identityRow(user.userId), tx);
    });
    return user;
  }

  /** The rejection itself, so the error can be inspected rather than only matched. */
  async function caught(body: () => Promise<unknown>): Promise<unknown> {
    return body().then(
      () => {
        throw new Error('expected the call to be refused, but it resolved');
      },
      (error: unknown) => error,
    );
  }

  it('pages the population in a total order, so two pages never repeat or skip', async () => {
    // Four users sharing one instant, in a run-unique slot. With no tiebreak
    // the order among rows sharing a `created_at` is whatever the plan
    // produced, and two pages of the same query can then disagree — which
    // discovery has no way to detect downstream.
    const at = new Date(Date.UTC(2000, 0, 1 + Math.floor(Math.random() * 30000)));
    const created: UserRecord[] = [];
    await transaction.run(async (tx) => {
      for (let index = 0; index < 4; index += 1) {
        const user = newUser({ createdAt: at });
        created.push(user);
        await users.create(user, tx);
      }
    });

    const first = await transaction.run((tx) => users.listCandidateIds({ limit: 3, offset: 0 }, tx));
    const second = await transaction.run((tx) => users.listCandidateIds({ limit: 3, offset: 3 }, tx));
    expect(first).toHaveLength(3);
    expect(first.filter((id) => second.includes(id))).toHaveLength(0);
    // No phantom candidates: every id on a page is a user that exists.
    const resolved = await transaction.run((tx) => Promise.all(first.map((id) => users.find(id, tx))));
    expect(resolved.every((record) => record !== null)).toBe(true);

    // A query returning a subset — the newest, say, or a hardcoded page — would
    // pass everything above and still hide users from discovery.
    const everyone = await transaction.run((tx) => users.listCandidateIds({ limit: 10000, offset: 0 }, tx));
    expect(created.every((user) => everyone.includes(user.userId))).toBe(true);
    // The documented tiebreak: rows sharing `created_at` come back by `user_id`,
    // so the four appear in id order whatever else the population contains.
    const positions = created
      .map((user) => user.userId)
      .sort()
      .map((id) => everyone.indexOf(id));
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it('reads back a user it created, with the timestamp the domain expects', async () => {
    const user = newUser();
    await transaction.run((tx) => users.create(user, tx));
    const found = await transaction.run((tx) => users.find(user.userId, tx));
    expect(found).toEqual(user);
    // A `timestamptz` handed back as a string would compile and then fail in
    // domain arithmetic, a long way from here.
    expect(found?.createdAt).toBeInstanceOf(Date);
    expect(found?.accountId).toBe(user.accountId);
  });

  it('finds a user by the account it signed up with', async () => {
    const user = newUser();
    await transaction.run((tx) => users.create(user, tx));
    const found = await transaction.run((tx) => users.findByAccount(user.accountId, tx));
    expect(found?.userId).toBe(user.userId);
  });

  it('answers null for a user and an account that were never here, rather than throwing', async () => {
    const byId = await transaction.run((tx) => users.find(castId<'UserId'>(randomUUID()), tx));
    const byAccount = await transaction.run((tx) => users.findByAccount(castId<'AccountId'>(randomUUID()), tx));
    expect(byId).toBeNull();
    expect(byAccount).toBeNull();
    expect(await transaction.run((tx) => identity.find(castId<'UserId'>(randomUUID()), tx))).toBeNull();
  });

  it('reports a duplicate userId as a conflict naming the key, not as an unknown fault', async () => {
    const user = newUser();
    await transaction.run((tx) => users.create(user, tx));
    const impostor = newUser({ userId: user.userId });

    const error = await caught(() => transaction.run((tx) => users.create(impostor, tx)));

    expect(error).toBeInstanceOf(StoreConflictError);
    expect(error).toBeInstanceOf(StoreError);
    // The whole point: a caller can branch on this without knowing about Postgres.
    expect(isConflict(error)).toBe(true);
    expect((error as StoreConflictError).code).toBe('23505');
    expect((error as StoreConflictError).constraint).toBe('users_pkey');
    // The refused create left the real user alone.
    const found = await transaction.run((tx) => users.find(user.userId, tx));
    expect(found?.accountId).toBe(user.accountId);
  });

  it('tells the two ways a create can collide apart, because the caller answers them differently', async () => {
    const user = newUser();
    await transaction.run((tx) => users.create(user, tx));

    const sameKey = await caught(() => transaction.run((tx) => users.create(newUser({ userId: user.userId }), tx)));
    const sameAccount = await caught(() =>
      transaction.run((tx) => users.create(newUser({ accountId: user.accountId }), tx)),
    );

    // Both are conflicts, so `isConflict` alone cannot answer "why".
    expect(isConflict(sameKey)).toBe(true);
    expect(isConflict(sameAccount)).toBe(true);
    expect((sameKey as StoreConflictError).constraint).toBe('users_pkey');
    expect((sameAccount as StoreConflictError).constraint).toBe('users_account_id_key');
  });

  it('refuses identity state for a user that does not exist, as a foreign-key conflict', async () => {
    const stranger = identityRow(castId<'UserId'>(randomUUID()));

    const error = await caught(() => transaction.run((tx) => identity.insert(stranger, tx)));

    // `23503`, not `23505`: a missing parent is a different question from a
    // duplicate, and a caller retrying on one and not the other needs to know.
    expect(isConflict(error)).toBe(true);
    expect((error as StoreConflictError).code).toBe('23503');
    expect(await transaction.run((tx) => identity.find(stranger.userId, tx))).toBeNull();
  });

  it('reports a second identity row for the same user as a conflict of its own', async () => {
    const user = await seededUser();
    const error = await caught(() => transaction.run((tx) => identity.insert(identityRow(user.userId), tx)));
    expect(isConflict(error)).toBe(true);
    expect((error as StoreConflictError).code).toBe('23505');
    // The first row is still generation 1: the duplicate did not reset it.
    const found = await transaction.run((tx) => identity.find(user.userId, tx));
    expect(found?.generation).toBe(1);
  });

  it('refuses an identity state the machine cannot produce, and leaves the row as it was', async () => {
    const user = await seededUser();
    const impossible = identityRow(user.userId, { state: 'definitely-verified' });

    const error = await caught(() => transaction.run((tx) => identity.insert(impossible, tx)));

    expect((error as StoreConflictError).code).toBe('23514');
    const found = await transaction.run((tx) => identity.find(user.userId, tx));
    expect(found?.state).toBe('unverified');
  });

  it('loses the second writer of one generation, and says so instead of overwriting', async () => {
    const user = await seededUser();
    const first = identityRow(user.userId, { state: 'pending', updatedAt: new Date('2026-01-01T00:00:00Z') });
    const stale = identityRow(user.userId, { state: 'verified', updatedAt: new Date('2026-01-02T00:00:00Z') });

    const won = await transaction.run((tx) => identity.update(first, 1, tx));
    expect(won).toBe(true);

    const afterWin = await transaction.run((tx) => identity.find(user.userId, tx));
    expect(afterWin?.state).toBe('pending');
    expect(afterWin?.generation).toBe(2);

    // The whole reason the column exists: this writer read generation 1, and
    // somebody else's decision has since replaced it.
    const lost = await transaction.run((tx) => identity.update(stale, 1, tx));
    expect(lost).toBe(false);

    const unchanged = await transaction.run((tx) => identity.find(user.userId, tx));
    expect(unchanged?.state).toBe('pending');
    expect(unchanged?.generation).toBe(2);
    expect(unchanged?.updatedAt).toEqual(afterWin?.updatedAt);
  });

  it('gives exactly one of two concurrent writers the same generation', async () => {
    const user = await seededUser();
    const at = new Date('2026-03-01T00:00:00Z');
    const one = identityRow(user.userId, { state: 'pending', updatedAt: at });
    const two = identityRow(user.userId, { state: 'review_required', updatedAt: at });

    // Same generation, issued without reading in between: the row lock makes
    // the loser re-check its WHERE against the row the winner just committed.
    const [a, b] = await Promise.all([
      transaction.run((tx) => identity.update(one, 1, tx)),
      transaction.run((tx) => identity.update(two, 1, tx)),
    ]);

    expect([a, b].filter((won) => won === true)).toHaveLength(1);
    const found = await transaction.run((tx) => identity.find(user.userId, tx));
    expect(found?.generation).toBe(2);
  });

  it('increments the generation rather than believing the one the caller echoes back', async () => {
    const user = await seededUser();
    // A caller whose read is one generation old, replaying its own stale row.
    const stale = identityRow(user.userId, { state: 'pending', generation: 1 });
    expect(await transaction.run((tx) => identity.update(stale, 1, tx))).toBe(true);
    // If the store wrote `row.generation` rather than `generation + 1`, this
    // would rewind the counter to 1 and a second stale writer would win.
    expect(await transaction.run((tx) => identity.update(stale, 1, tx))).toBe(false);
    const found = await transaction.run((tx) => identity.find(user.userId, tx));
    expect(found?.generation).toBe(2);
  });

  it('reports a lost race as false, but a nonsensical generation as a fault', async () => {
    const user = await seededUser();
    for (const generation of [0, -1, 1.5]) {
      const error = await caught(() => transaction.run((tx) => identity.update(identityRow(user.userId), generation, tx)));
      expect(error).toBeInstanceOf(StoreError);
      // Not a conflict: nothing in the database objected, the caller did.
      expect(isConflict(error)).toBe(false);
    }
    const found = await transaction.run((tx) => identity.find(user.userId, tx));
    expect(found?.generation).toBe(1);
  });

  it('answers false for a user with no identity state, because the write did not happen', async () => {
    const user = newUser();
    await transaction.run((tx) => users.create(user, tx));
    const won = await transaction.run((tx) => identity.update(identityRow(user.userId, { state: 'verified' }), 1, tx));
    expect(won).toBe(false);
    // And it invented nothing on the way: this is the path a naive
    // upsert-writer would take to hand out `verified` without a machine.
    expect(await transaction.run((tx) => identity.find(user.userId, tx))).toBeNull();
  });

  it('leaves nothing behind when the caller rolls its transaction back', async () => {
    const user = newUser();
    await expect(
      transaction.run(async (tx) => {
        await users.create(user, tx);
        await identity.insert(identityRow(user.userId), tx);
        throw new Error('the caller changed its mind');
      }),
    ).rejects.toThrow('the caller changed its mind');

    // Two stores, one unit of work. If either opened its own transaction, one
    // of these would still be here.
    expect(await transaction.run((tx) => users.find(user.userId, tx))).toBeNull();
    expect(await transaction.run((tx) => identity.find(user.userId, tx))).toBeNull();
  });

  it('refuses to hand back a row whose timestamp did not read back as a Date', async () => {
    const user = newUser();
    await transaction.run((tx) => users.create(user, tx));

    // The one way a row can arrive half-read: a driver type parser somebody
    // reconfigured. `undefined` would reach the domain as an absent user.
    const original = pg.types.getTypeParser(TIMESTAMPTZ_OID);
    pg.types.setTypeParser(TIMESTAMPTZ_OID, (value: string) => value);
    try {
      const error = await caught(() => transaction.run((tx) => users.find(user.userId, tx)));
      expect(error).toBeInstanceOf(StoreError);
      expect(isConflict(error)).toBe(false);
    } finally {
      pg.types.setTypeParser(TIMESTAMPTZ_OID, original);
    }
    // The parser is restored, so the row is still readable.
    expect(await transaction.run((tx) => users.find(user.userId, tx))).toEqual(user);
  });
});
