/**
 * `AccountStandingStore`, proven against a real database.
 *
 * The property this file exists for is the one that keeps a ban a ban: a writer
 * holding a stale read must lose *visibly*, and a sanctioned account's standing
 * must still be there for a process that did not write it. Everything else here
 * is a corollary of those two — that `null` means "never judged" rather than
 * "unrestricted", that a corrupt row is loud rather than an empty capability
 * list, and that the grant is a Postgres array rather than an encoded string.
 *
 * Skipped, loudly, when `DATABASE_URL` is unset, and the schema is probed in
 * `beforeAll` so a suite that connected to a database without these tables
 * fails rather than reporting every one of these properties as satisfied.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { castId } from '@been-there/core';
import type { UserId } from '@been-there/core';
import { StoreError } from '@been-there/contracts';
import type { AccountStandingRow, Transaction } from '@been-there/contracts';
import { clientOf, createTransaction } from '../src/transaction.js';
import { PgAccountStandingStore } from '../src/store-account-standing.js';

// Same loading the migration runner does, so a developer who has run `make up`
// runs the real database rather than a suite that quietly did nothing.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENV_FILE = join(REPO_ROOT, '.env');
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const matched = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (matched === null) {
      continue;
    }
    const [, name, value] = matched;
    if (name !== undefined && value !== undefined && process.env[name] === undefined) {
      process.env[name] = value;
    }
  }
}

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString === undefined ? describe.skip : describe;

describeIfDb('AccountStandingStore, against Postgres', () => {
  const store = new PgAccountStandingStore();
  let pool: pg.Pool;
  let raw: PoolClient;
  let transaction: Transaction;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString });
    raw = await pool.connect();
    transaction = createTransaction(pool);
    // Connecting is not the same as reaching the schema this store reads.
    const probe = await raw.query<{
      user_id: string;
      state: string;
      capabilities: readonly string[];
      visible_in_product: boolean;
      case_id: string | null;
      decision_id: string | null;
      generation: number;
      updated_at: Date;
    }>(
      `SELECT user_id, state, capabilities, visible_in_product, case_id, decision_id,
              generation, updated_at
         FROM app.account_standing LIMIT 0`,
    );
    expect(probe.rows).toEqual([]);
  });

  afterAll(async () => {
    if (pool !== undefined) {
      raw.release();
      await pool.end();
    }
  });

  /** The FK to `app.users` demands a real user, so every test starts with one. */
  async function newUser(): Promise<UserId> {
    const id = castId<'UserId'>(randomUUID());
    await raw.query('INSERT INTO app.users (user_id, account_id) VALUES ($1, $2)', [id, randomUUID()]);
    return id;
  }

  function standing(
    userId: UserId,
    overrides: Partial<AccountStandingRow> = {},
  ): AccountStandingRow {
    return {
      userId,
      state: 'active',
      capabilities: ['browse_discovery', 'like', 'send_message', 'report', 'block', 'edit_profile'],
      visibleInProduct: true,
      caseId: null,
      decisionId: null,
      generation: 1,
      updatedAt: new Date(),
      ...overrides,
    };
  }

  function read(userId: UserId): Promise<AccountStandingRow | null> {
    return transaction.run((tx) => store.find(userId, tx));
  }

  function write(
    row: AccountStandingRow,
    expectedGeneration: number | null,
  ): Promise<boolean> {
    return transaction.run((tx) => store.upsert(row, expectedGeneration, tx));
  }

  /** The generation a caller would have read, for the write-back. */
  async function generationOf(userId: UserId): Promise<number | null> {
    return (await read(userId))?.generation ?? null;
  }

  it('reports a never-judged account as null rather than as unrestricted', async () => {
    // The distinction the whole table rests on: `null` is "no decision has been
    // taken", and the initial state belongs to the account machine and the
    // service's projection. A store that answered `active` here would be the
    // thing that un-bans everyone on a fresh boot.
    expect(await read(await newUser())).toBeNull();
  });

  it('round-trips every field of a written standing', async () => {
    const userId = await newUser();
    const caseId = randomUUID();
    const decisionId = randomUUID();
    // A real case, because `case_id` is a foreign key: an unattributable
    // standing is one a moderator could not answer a question about.
    await raw.query(
      `INSERT INTO app.cases
         (case_id, subject_id, origin, state, priority, queue, opened_at, due_at, opened_by)
       VALUES ($1, $2, 'report', 'open', 'high', 'triage', now(), now(), 'system')`,
      [caseId, userId],
    );
    const row = standing(userId, {
      state: 'suspended',
      capabilities: ['report', 'block'],
      visibleInProduct: false,
      caseId,
      decisionId,
      generation: 1,
      updatedAt: new Date('2026-04-01T12:00:00.000Z'),
    });

    expect(await write(row, null)).toBe(true);

    expect(await read(userId)).toEqual(row);
  });

  it('applies a write carrying the generation the caller read', async () => {
    const userId = await newUser();
    expect(await write(standing(userId), null)).toBe(true);
    expect(await generationOf(userId)).toBe(1);

    expect(
      await write(standing(userId, { state: 'limited', generation: 1 }), 1),
    ).toBe(true);

    const found = await read(userId);
    expect(found?.state).toBe('limited');
    expect(found?.generation).toBe(2);
  });

  it('refuses a stale write and leaves the row exactly as it was', async () => {
    const userId = await newUser();
    // Generation 1, written as a first sanction: an account nobody has judged
    // has no standing row at all.
    expect(await write(standing(userId, { state: 'suspended', visibleInProduct: false }), null)).toBe(
      true,
    );

    // Two enforcement decisions both read generation 1. The first commits; the
    // second is a lift of a restriction nobody lifted, and applying it would
    // hand a sanctioned account its capabilities back.
    const stale = await generationOf(userId);
    expect(stale).toBe(1);
    expect(await write(standing(userId, { state: 'banned', visibleInProduct: false }), stale)).toBe(
      true,
    );
    expect(
      await write(standing(userId, { state: 'active', visibleInProduct: true }), stale),
    ).toBe(false);

    // The refusal must be a refusal, not a silent no-op the caller cannot tell
    // from a success: nothing about the row moved, and the counter did not.
    const found = await read(userId);
    expect(found?.state).toBe('banned');
    expect(found?.visibleInProduct).toBe(false);
    expect(found?.generation).toBe(2);
  });

  it('does not let a refused write walk the generation counter back', async () => {
    const userId = await newUser();
    await write(standing(userId), null);
    expect(await write(standing(userId, { state: 'limited' }), 1)).toBe(true);
    expect(await generationOf(userId)).toBe(2);

    // A caller echoing its stale read must not be able to rewind to a
    // generation it already won and then win again from it.
    expect(await write(standing(userId, { state: 'active', generation: 1 }), 1)).toBe(false);
    expect(await generationOf(userId)).toBe(2);
  });

  it('refuses a generation the row has never reached, rather than treating it as a match', async () => {
    const userId = await newUser();
    await write(standing(userId, { state: 'suspended' }), null);

    expect(await write(standing(userId, { state: 'active' }), 99)).toBe(false);
    expect((await read(userId))?.state).toBe('suspended');
  });

  it('lets a null generation insert but never overwrite, so a first write cannot clobber a row', async () => {
    const userId = await newUser();
    expect(await write(standing(userId, { state: 'banned', visibleInProduct: false }), null)).toBe(true);

    // A racing writer that read nothing before the row appeared. It must not
    // win, and it must not be handed a unique violation it cannot act on
    // either: the standing already on record is the one that happened.
    expect(await write(standing(userId, { state: 'active', visibleInProduct: true }), null)).toBe(false);
    expect((await read(userId))?.state).toBe('banned');
    expect((await read(userId))?.visibleInProduct).toBe(false);
  });

  it('converges two concurrent first-writes on one row instead of conflicting', async () => {
    const userId = await newUser();
    // Both writers read nothing, so both take the insert path. Issued
    // concurrently on separate connections, which is the only way to reach the
    // race: sequentially the second one would merely see the row.
    const results = await Promise.all([
      write(standing(userId, { state: 'banned', visibleInProduct: false }), null),
      write(standing(userId, { state: 'suspended' }), null),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const rows = await raw.query('SELECT state FROM app.account_standing WHERE user_id = $1', [userId]);
    expect(rows.rows).toHaveLength(1);
    expect(['banned', 'suspended']).toContain(rows.rows[0]?.['state']);
  });

  it('keeps a sanctioned standing for a process that did not write it', async () => {
    const userId = await newUser();
    await write(standing(userId, { state: 'banned', capabilities: ['report'], visibleInProduct: false }), null);

    // A restart, as far as this store is concerned: a brand new pool and a brand
    // new store instance, holding nothing the writer held. If the standing were
    // only in memory — or if a read defaulted to `active` — this is where every
    // banned account would come back into the product.
    const restartedPool = new pg.Pool({ connectionString });
    try {
      const restartedTransaction = createTransaction(restartedPool);
      const found = await restartedTransaction.run((tx) =>
        new PgAccountStandingStore().find(userId, tx),
      );

      expect(found?.state).toBe('banned');
      expect(found?.capabilities).toEqual(['report']);
      expect(found?.visibleInProduct).toBe(false);
    } finally {
      await restartedPool.end();
    }
  });

  it('replaces the capability list, so a lifted restriction does not accumulate grants', async () => {
    const userId = await newUser();
    await write(standing(userId, { state: 'limited', capabilities: ['report', 'block'] }), null);

    expect(
      await write(standing(userId, { state: 'active', capabilities: ['browse_discovery'] }), 1),
    ).toBe(true);

    expect((await read(userId))?.capabilities).toEqual(['browse_discovery']);
  });

  it('stores capability names as a Postgres array, not as an encoded string', async () => {
    // Every one of these is array syntax: a comma, a quote, a brace, a
    // backslash and a leading space. A hand-built array literal or a JSON blob
    // would mangle or split them.
    const awkward = ['a,b', 'c"d', 'e{f}', 'back\\slash', ' leading space ', 'NULL'];
    const userId = await newUser();
    const empty = await newUser();

    await write(standing(userId, { capabilities: awkward }), null);
    await write(standing(empty, { capabilities: [] }), null);

    expect((await read(userId))?.capabilities).toEqual(awkward);
    expect((await read(empty))?.capabilities).toEqual([]);
  });

  it('keeps one account standing out of another account row', async () => {
    const mine = await newUser();
    const theirs = await newUser();
    await write(standing(mine, { state: 'banned', visibleInProduct: false }), null);
    await write(standing(theirs, { state: 'active' }), null);

    expect((await read(mine))?.state).toBe('banned');
    expect((await read(theirs))?.state).toBe('active');
  });

  it('refuses a state the account machine cannot produce, and records nothing', async () => {
    const userId = await newUser();
    await expect(write(standing(userId, { state: 'quarantined' }), null)).rejects.toBeInstanceOf(
      StoreError,
    );
    expect(await read(userId)).toBeNull();
  });

  it('refuses an expected generation the row could never have held', async () => {
    const userId = await newUser();
    // 0 would match no rows and be reported as a lost race, which is a false
    // story about a decision that never had anything to be stale against.
    await expect(write(standing(userId), 0)).rejects.toBeInstanceOf(StoreError);
    expect(await read(userId)).toBeNull();
  });

  it('surfaces a standing for an account that is not a user, rather than orphaning it', async () => {
    await expect(write(standing(castId<'UserId'>(randomUUID())), null)).rejects.toBeInstanceOf(StoreError);
  });

  it('leaves nothing behind when the unit of work rolls back', async () => {
    const userId = await newUser();
    await expect(
      transaction.run(async (tx) => {
        await store.upsert(standing(userId, { state: 'banned' }), null, tx);
        throw new Error('the appeal was not recorded');
      }),
    ).rejects.toThrow('the appeal was not recorded');

    // A ban that committed without the case that justifies it is worse than a
    // ban that did not happen.
    expect(await read(userId)).toBeNull();
  });

  it('refuses to run outside a unit of work rather than on a released connection', async () => {
    const userId = await newUser();
    await write(standing(userId, { state: 'suspended', visibleInProduct: false }), null);

    // The handle a `Transaction` hands out is only live inside `run`. Outside
    // it the client is `undefined`, and a store that reached past that would be
    // issuing the sanction outside the unit of work that records it.
    await expect(
      store.upsert(standing(userId, { state: 'active' }), 1, transaction),
    ).rejects.toBeInstanceOf(StoreError);
    expect((await read(userId))?.state).toBe('suspended');
  });

  it('raises on a standing whose capabilities are not a list', async () => {
    const userId = await newUser();
    // The column is `text[] NOT NULL`, so nothing can be written into it that is
    // not a list — the only way to hold one is to change the column. That is
    // done on the transaction's own connection, because an `ALTER TABLE` holds
    // an exclusive lock: doing it on one connection and reading on another
    // would simply wait for itself. The throw at the end rolls the schema
    // change and the row back together.
    await expect(
      transaction.run(async (tx) => {
        const client = clientOf(tx);
        // The column's default is a `text[]` literal, so it has to go before
        // the type changes or Postgres refuses to cast it.
        await client.query('ALTER TABLE app.account_standing ALTER COLUMN capabilities DROP DEFAULT');
        // `USING '[]'` rather than a cast of the existing values: a `text[]`
        // renders as `{a,b}`, which is not JSON, so casting the rows already in
        // the table would fail on data this test does not own. The rewrite is
        // undone with everything else when the transaction rolls back.
        await client.query(
          `ALTER TABLE app.account_standing
              ALTER COLUMN capabilities TYPE jsonb USING '[]'::jsonb`,
        );
        await client.query(
          `INSERT INTO app.account_standing (user_id, capabilities) VALUES ($1, '"not a list"'::jsonb)`,
          [userId],
        );
        await expect(store.find(userId, tx)).rejects.toBeInstanceOf(StoreError);
        await expect(store.find(userId, tx)).rejects.toThrow(/capabilities/);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    const columns = await raw.query<{ data_type: string }>(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'account_standing' AND column_name = 'capabilities'`,
    );
    expect(columns.rows[0]?.data_type).toBe('ARRAY');
  });

  it('raises on a standing whose state no domain can have produced', async () => {
    const userId = await newUser();
    // The same shape, one constraint over: the CHECK is what stops such a row
    // existing at all, so the read-side guard is proved by dropping the CHECK
    // inside a transaction that puts it back.
    await expect(
      transaction.run(async (tx) => {
        const client = clientOf(tx);
        await client.query('ALTER TABLE app.account_standing DROP CONSTRAINT account_standing_state_check');
        await client.query(
          `INSERT INTO app.account_standing (user_id, state) VALUES ($1, 'quarantined')`,
          [userId],
        );
        await expect(store.find(userId, tx)).rejects.toBeInstanceOf(StoreError);
        await expect(store.find(userId, tx)).rejects.toThrow(/state/);
        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    const constraint = await raw.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_constraint
        WHERE conname = 'account_standing_state_check'`,
    );
    expect(constraint.rows[0]?.count).toBe('1');
  });

  it('reports a query fault as a StoreError, not as an unrestricted account', async () => {
    const userId = await newUser();
    await write(standing(userId, { state: 'banned', visibleInProduct: false }), null);
    await raw.query('ALTER TABLE app.account_standing RENAME TO account_standing_moved');

    try {
      await expect(read(userId)).rejects.toBeInstanceOf(StoreError);
    } finally {
      await raw.query('ALTER TABLE app.account_standing_moved RENAME TO account_standing');
    }

    // The standing is still there, and still a ban: a read that failed must not
    // have looked like an account nobody had sanctioned.
    expect((await read(userId))?.state).toBe('banned');
  });
});
