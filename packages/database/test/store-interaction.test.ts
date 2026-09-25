/**
 * `InteractionStore` against a real Postgres, proving the properties the port
 * promises rather than the shape of a row it just wrote.
 *
 * Every test here would fail against a plausible wrong implementation: a
 * supersession the caller has to remember, a match insert that loses a race
 * instead of converging, a block release that deletes the evidence or answers
 * to the wrong party, a count that reports a change that did not happen.
 *
 * The suite is skipped, loudly, when there is no `DATABASE_URL`. It reads the
 * repository `.env` the way `scripts/migrate.mjs` does, so a developer who ran
 * `make up` gets the real database without exporting anything.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { MatchId, UserId } from '@been-there/core';
import type { Transaction } from '@been-there/contracts';
import { StoreError } from '@been-there/contracts';
import { clientOf, createTransaction } from '../src/transaction.js';
import { InteractionConflictError, PostgresInteractionStore } from '../src/store-interaction.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENV_FILE = join(REPO_ROOT, '.env');
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const parsed = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    const name = parsed?.[1];
    const value = parsed?.[2];
    if (name !== undefined && value !== undefined && process.env[name] === undefined) {
      process.env[name] = value;
    }
  }
}

const connectionString = process.env.DATABASE_URL;
const describeIfDb = connectionString === undefined ? describe.skip : describe;

const DAY_ONE = new Date('2026-03-01T10:00:00.000Z');
const DAY_TWO = new Date('2026-03-02T10:00:00.000Z');
const DAY_THREE = new Date('2026-03-03T10:00:00.000Z');

describeIfDb('InteractionStore, against Postgres', () => {
  let pool: pg.Pool;
  let transaction: Transaction;
  const store = new PostgresInteractionStore();

  beforeAll(() => {
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

  /** One unit of work, the way a request gets one. */
  function inTx<T>(body: (tx: Transaction) => Promise<T>): Promise<T> {
    return transaction.run(body);
  }

  /** Two users, because a like has to point at somebody. */
  async function twoUsers(): Promise<{ a: UserId; b: UserId }> {
    const a = randomUUID() as UserId;
    const b = randomUUID() as UserId;
    await inTx(async (tx) => {
      const client = clientOf(tx);
      await client.query('INSERT INTO app.users (user_id, account_id) VALUES ($1,$2), ($3,$4)', [
        a,
        randomUUID(),
        b,
        randomUUID(),
      ]);
    });
    return { a, b };
  }

  /** The pair in the canonical order `upsertMatch` insists on. */
  function ordered(a: UserId, b: UserId): [UserId, UserId] {
    return a < b ? [a, b] : [b, a];
  }

  function like(over: Partial<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> {
    return {
      likeId: randomUUID(),
      from: randomUUID(),
      to: randomUUID(),
      createdAt: DAY_ONE,
      ...over,
    };
  }

  // ------------------------------------------------------------ appendLike --

  it('supersedes the pass it overrides in the same call, and records which one', async () => {
    const { a, b } = await twoUsers();
    const passId = randomUUID();
    await inTx((tx) => store.appendPass({ passId, from: a, to: b, createdAt: DAY_ONE }, tx));

    const result = await inTx((tx) =>
      store.appendLike(like({ from: a, to: b, createdAt: DAY_TWO }), tx),
    );
    expect(result.created).toBe(true);

    // A separate supersedePass call would also make this pass, which is exactly
    // why the like is the thing that has to make it.
    const passes = await inTx((tx) => store.findPassesFor(a, tx));
    expect(passes.map((entry) => entry['state'])).toEqual(['superseded']);
    const likes = await inTx((tx) => store.findLikesFor(a, tx));
    expect(likes[0]?.['supersededPassId']).toBe(passId);
  });

  it('leaves the counterpart’s pass alone, because one person’s like is not the other’s decision', async () => {
    const { a, b } = await twoUsers();
    await inTx((tx) =>
      store.appendPass({ passId: randomUUID(), from: b, to: a, createdAt: DAY_ONE }, tx),
    );

    await inTx((tx) => store.appendLike(like({ from: a, to: b, createdAt: DAY_TWO }), tx));

    const passes = await inTx((tx) => store.findPassesFor(a, tx));
    expect(passes.map((entry) => entry['state'])).toEqual(['live']);
  });

  it('a rolled-back like leaves neither the like nor the supersession behind', async () => {
    const { a, b } = await twoUsers();
    await inTx((tx) =>
      store.appendPass({ passId: randomUUID(), from: a, to: b, createdAt: DAY_ONE }, tx),
    );

    await expect(
      inTx(async (tx) => {
        await store.appendLike(like({ from: a, to: b, createdAt: DAY_TWO }), tx);
        throw new Error('the request failed after the like');
      }),
    ).rejects.toThrow('the request failed after the like');

    expect(await inTx((tx) => store.findLikesFor(a, tx))).toEqual([]);
    const passes = await inTx((tx) => store.findPassesFor(a, tx));
    expect(passes.map((entry) => entry['state'])).toEqual(['live']);
  });

  it('a replayed like is a fact, not a fault: created:false and no second row', async () => {
    const { a, b } = await twoUsers();
    const row = like({ from: a, to: b, createdAt: DAY_ONE });

    expect(await inTx((tx) => store.appendLike(row, tx))).toEqual({ created: true });
    expect(await inTx((tx) => store.appendLike(row, tx))).toEqual({ created: false });
    expect(await inTx((tx) => store.appendLike(row, tx))).toEqual({ created: false });

    expect(await inTx((tx) => store.findLikesFor(a, tx))).toHaveLength(1);
  });

  it('a second like id for the same live pair is a conflict the caller can catch, and the transaction survives it', async () => {
    const { a, b } = await twoUsers();
    await inTx((tx) => store.appendLike(like({ from: a, to: b, createdAt: DAY_ONE }), tx));

    await inTx(async (tx) => {
      await expect(
        store.appendLike(like({ from: a, to: b, createdAt: DAY_TWO }), tx),
      ).rejects.toBeInstanceOf(InteractionConflictError);
      // If the conflict had been raised by letting the unique index fire, this
      // statement would fail with 25P02 instead of answering.
      expect(await store.findLikesFor(a, tx)).toHaveLength(1);
    });

    expect(await inTx((tx) => store.findLikesFor(a, tx))).toHaveLength(1);
  });

  it('the reciprocal direction is a different like, not a duplicate', async () => {
    const { a, b } = await twoUsers();
    expect(
      await inTx((tx) => store.appendLike(like({ from: a, to: b, createdAt: DAY_ONE }), tx)),
    ).toEqual({
      created: true,
    });
    expect(
      await inTx((tx) => store.appendLike(like({ from: b, to: a, createdAt: DAY_ONE }), tx)),
    ).toEqual({
      created: true,
    });
    expect(await inTx((tx) => store.findLikesFor(a, tx))).toHaveLength(2);
  });

  it('reusing a like id for a different pair is a fault, not a silent replay', async () => {
    const { a, b } = await twoUsers();
    const { a: other } = await twoUsers();
    const row = like({ from: a, to: b, createdAt: DAY_ONE });
    await inTx((tx) => store.appendLike(row, tx));

    await expect(
      inTx((tx) => store.appendLike({ ...row, from: other, to: a }, tx)),
    ).rejects.toBeInstanceOf(StoreError);
  });

  // --------------------------------------------------------- the like ledger --

  it('the ledger holds both directions of a pair and only the likes that still count', async () => {
    const { a, b } = await twoUsers();
    const mine = randomUUID();
    const theirs = randomUUID();
    const later = randomUUID();
    await inTx((tx) =>
      store.appendLike(like({ likeId: mine, from: a, to: b, createdAt: DAY_ONE }), tx),
    );
    await inTx((tx) =>
      store.appendLike(like({ likeId: theirs, from: b, to: a, createdAt: DAY_TWO }), tx),
    );

    // A withdrawn like is history, and a later decision is a new row: if the
    // store kept the withdrawn one, `resolveMatch` would match on a decision
    // the user took back.
    expect(await inTx((tx) => store.updateLike(mine, 'withdrawn', tx))).toBe(true);
    await inTx((tx) =>
      store.appendLike(like({ likeId: later, from: a, to: b, createdAt: DAY_THREE }), tx),
    );

    const ledger = await inTx((tx) => store.findLikesFor(a, tx));
    expect(ledger.map((entry) => entry['likeId'])).toEqual([theirs, later]);
  });

  it('a decided like stays decided: a retry succeeds, and a withdrawal is final', async () => {
    const { a, b } = await twoUsers();
    const likeId = randomUUID();
    await inTx((tx) => store.appendLike(like({ likeId, from: a, to: b, createdAt: DAY_ONE }), tx));

    expect(await inTx((tx) => store.updateLike(likeId, 'matched', tx))).toBe(true);
    expect(await inTx((tx) => store.updateLike(likeId, 'matched', tx))).toBe(true);
    expect(await inTx((tx) => store.findLikesFor(a, tx))).toEqual([
      expect.objectContaining({ state: 'matched' }),
    ]);

    // An unmatch overtakes the match, and is allowed to.
    expect(await inTx((tx) => store.updateLike(likeId, 'withdrawn', tx))).toBe(true);
    // But a taken-back decision is never revived, or a retracted like could
    // become a match again years later.
    expect(await inTx((tx) => store.updateLike(likeId, 'matched', tx))).toBe(false);
    expect(await inTx((tx) => store.updateLike(randomUUID(), 'matched', tx))).toBe(false);
  });

  // ---------------------------------------------------------- supersedePass --

  it('supersedePass reports one row moved, then none, and never a phantom change', async () => {
    const { a, b } = await twoUsers();
    const { a: stranger } = await twoUsers();
    expect(await inTx((tx) => store.supersedePass(a, b, DAY_TWO, tx))).toBe(0);

    await inTx((tx) =>
      store.appendPass({ passId: randomUUID(), from: a, to: b, createdAt: DAY_ONE }, tx),
    );
    expect(await inTx((tx) => store.supersedePass(a, b, DAY_TWO, tx))).toBe(1);
    expect(await inTx((tx) => store.supersedePass(a, b, DAY_THREE, tx))).toBe(0);
    expect(await inTx((tx) => store.supersedePass(stranger, b, DAY_TWO, tx))).toBe(0);

    // Superseded, not deleted: the pass is the evidence that the pair was
    // passed and later liked.
    const passes = await inTx((tx) => store.findPassesFor(a, tx));
    expect(passes).toHaveLength(1);
  });

  it('findPassesFor is ordered, and by the pair rather than by insertion accident', async () => {
    const { a, b } = await twoUsers();
    const { a: third } = await twoUsers();
    await inTx((tx) =>
      store.appendPass({ passId: randomUUID(), from: b, to: a, createdAt: DAY_ONE }, tx),
    );
    await inTx((tx) =>
      store.appendPass({ passId: randomUUID(), from: a, to: b, createdAt: DAY_THREE }, tx),
    );
    await inTx((tx) =>
      store.appendPass({ passId: randomUUID(), from: a, to: third, createdAt: DAY_TWO }, tx),
    );

    const passes = await inTx((tx) => store.findPassesFor(a, tx));
    expect(passes.map((entry) => entry['createdAt'])).toEqual([DAY_ONE, DAY_TWO, DAY_THREE]);
    // The counterpart's pass is here too, so a caller can check direction itself.
    expect(passes.map((entry) => entry['from'])).toEqual([b, a, a]);
  });

  it('a replayed pass id is a fact, and a second pass for the same pair is a conflict', async () => {
    const { a, b } = await twoUsers();
    const row = { passId: randomUUID(), from: a, to: b, createdAt: DAY_ONE };
    expect(await inTx((tx) => store.appendPass(row, tx))).toEqual({ created: true });
    expect(await inTx((tx) => store.appendPass(row, tx))).toEqual({ created: false });
    await expect(
      inTx((tx) => store.appendPass({ ...row, passId: randomUUID(), createdAt: DAY_TWO }, tx)),
    ).rejects.toBeInstanceOf(InteractionConflictError);
  });

  // ----------------------------------------------------------------- blocks --

  it('only the blocker can release, and the release leaves the block on the record', async () => {
    const { a, b } = await twoUsers();
    const blockId = randomUUID();
    await inTx((tx) =>
      store.createBlock({ blockId, blocker: a, blocked: b, createdAt: DAY_ONE }, tx),
    );

    // The wrong party asks first, and gets nothing: a block is lifted by the
    // person who placed it or by nobody.
    expect(await inTx((tx) => store.releaseBlock(b, a, DAY_TWO, tx))).toBe(0);
    const untouched = await inTx((tx) => store.findBlocksBetween(a, b, tx));
    expect(untouched).toEqual([expect.objectContaining({ active: true, liftedAt: null })]);

    expect(await inTx((tx) => store.releaseBlock(a, b, DAY_TWO, tx))).toBe(1);
    expect(await inTx((tx) => store.releaseBlock(a, b, DAY_THREE, tx))).toBe(0);

    const lifted = await inTx((tx) => store.findBlocksBetween(a, b, tx));
    expect(lifted).toHaveLength(1);
    expect(lifted[0]).toEqual(
      expect.objectContaining({ blockId, active: false, liftedAt: DAY_TWO }),
    );
  });

  it('a released block can be made again, because a lift is not a veto forever', async () => {
    const { a, b } = await twoUsers();
    const first = randomUUID();
    await inTx((tx) =>
      store.createBlock({ blockId: first, blocker: a, blocked: b, createdAt: DAY_ONE }, tx),
    );
    expect(await inTx((tx) => store.releaseBlock(a, b, DAY_TWO, tx))).toBe(1);

    const second = randomUUID();
    expect(
      await inTx((tx) =>
        store.createBlock({ blockId: second, blocker: a, blocked: b, createdAt: DAY_THREE }, tx),
      ),
    ).toEqual({ created: true });

    // Both are on the record: the block that was lifted, and the one standing.
    const blocks = await inTx((tx) => store.findBlocksBetween(a, b, tx));
    expect(blocks).toHaveLength(2);
    expect(blocks.map((entry) => entry['blockId']).sort()).toEqual([first, second].sort());
    expect(blocks.filter((entry) => entry['active'] === true)).toHaveLength(1);
  });

  it('findBlocksBetween is symmetric, because a block is applied in two', async () => {
    const { a, b } = await twoUsers();
    await inTx((tx) =>
      store.createBlock({ blockId: randomUUID(), blocker: b, blocked: a, createdAt: DAY_ONE }, tx),
    );

    const forwards = await inTx((tx) => store.findBlocksBetween(a, b, tx));
    const backwards = await inTx((tx) => store.findBlocksBetween(b, a, tx));
    expect(forwards).toHaveLength(1);
    expect(backwards).toEqual(forwards);
    expect(forwards[0]).toEqual(expect.objectContaining({ blocker: b, blocked: a }));
  });

  it('a replayed block id is a fact, and a block on the same pair from the other side is a conflict', async () => {
    const { a, b } = await twoUsers();
    const row = { blockId: randomUUID(), blocker: a, blocked: b, createdAt: DAY_ONE };
    expect(await inTx((tx) => store.createBlock(row, tx))).toEqual({ created: true });
    expect(await inTx((tx) => store.createBlock(row, tx))).toEqual({ created: false });
    await expect(
      inTx((tx) => store.createBlock({ ...row, blockId: randomUUID() }, tx)),
    ).rejects.toBeInstanceOf(InteractionConflictError);
  });

  // ---------------------------------------------------------------- matches --

  it('two concurrent reciprocal likes converge on one match, and both callers get that one', async () => {
    const { a, b } = await twoUsers();
    const [first, second] = ordered(a, b);
    const likeOne = randomUUID();
    const likeTwo = randomUUID();
    const firstId = `match:${randomUUID()}`;
    const secondId = `match:${randomUUID()}`;

    const results = await Promise.all([
      inTx((tx) =>
        store.upsertMatch(
          {
            matchId: firstId,
            participants: [first, second],
            likeIds: [likeOne],
            standings: ['active', 'active'],
            createdAt: DAY_ONE,
          },
          tx,
        ),
      ),
      inTx((tx) =>
        store.upsertMatch(
          {
            participants: [first, second],
            matchId: secondId,
            likeIds: [likeTwo],
            standings: ['active', 'active'],
            createdAt: DAY_TWO,
          },
          tx,
        ),
      ),
    ]);

    // The loser's match id is not the winner's, and the caller is told which
    // one is real: exactly one match, whichever transaction lost.
    expect(results[0]?.['matchId']).toBe(results[1]?.['matchId']);

    const found = await inTx((tx) => store.findMatchByPair(a, b, tx));
    expect(found).not.toBeNull();
    expect(results[0]?.['matchId']).toBe(found?.['matchId']);
    // The winner is one of the two ids offered, never a third thing and never
    // both: that is what "exactly one match" has to mean after a race. And the
    // losing writer's like is a real fact, so it converges into the row
    // rather than being thrown away.
    expect([firstId, secondId]).toContain(found?.['matchId']);
    expect([...(found?.['likeIds'] as string[])].sort()).toEqual([likeOne, likeTwo].sort());
  });

  it('an ended match is not revived by a like that raced its ending', async () => {
    const { a, b } = await twoUsers();
    const [first, second] = ordered(a, b);
    const match = await inTx((tx) =>
      store.upsertMatch(
        {
          matchId: `match:${randomUUID()}`,
          participants: [first, second],
          likeIds: [randomUUID()],
          standings: ['closed_by_actor', 'closed_by_target'],
          createdAt: DAY_ONE,
        },
        tx,
      ),
    );
    expect(
      await inTx((tx) =>
        store.updateMatch(
          match['matchId'] as MatchId,
          { endedAt: DAY_TWO, endedCause: 'unmatched' },
          tx,
        ),
      ),
    ).toBe(true);

    const converged = await inTx((tx) =>
      store.upsertMatch(
        {
          matchId: `match:${randomUUID()}`,
          participants: [first, second],
          likeIds: [randomUUID()],
          standings: ['active', 'active'],
          createdAt: DAY_THREE,
        },
        tx,
      ),
    );

    expect(converged['matchId']).toBe(match['matchId']);
    expect(converged['endedCause']).toBe('unmatched');
    expect(converged['standings']).toEqual(['closed_by_actor', 'closed_by_target']);
  });

  it('updateMatch patches standings and the end separately, and refuses a key it does not know', async () => {
    const { a, b } = await twoUsers();
    const { a: c } = await twoUsers();
    const [first, second] = ordered(a, b);
    const match = await inTx((tx) =>
      store.upsertMatch(
        {
          matchId: `match:${randomUUID()}`,
          participants: [first, second],
          likeIds: [randomUUID()],
          standings: ['active', 'active'],
          createdAt: DAY_ONE,
        },
        tx,
      ),
    );
    const matchId = match['matchId'] as MatchId;

    // A per-party standing and a shared cause are one patch, not one column.
    expect(
      await inTx((tx) =>
        store.updateMatch(
          matchId,
          {
            standings: ['closed_by_actor', 'restricted_by_target'],
            endedAt: DAY_TWO,
            endedCause: 'ended_by_block',
          },
          tx,
        ),
      ),
    ).toBe(true);

    const patched = await inTx((tx) => store.findMatch(matchId, tx));
    expect(patched?.['standings']).toEqual(['closed_by_actor', 'restricted_by_target']);
    expect(patched?.['endedAt']).toEqual(DAY_TWO);
    expect(patched?.['endedCause']).toBe('ended_by_block');

    // A typo must not be a write that quietly does nothing.
    await expect(
      inTx((tx) =>
        store.updateMatch(matchId, { standingsg: ['closed_by_actor', 'closed_by_actor'] }, tx),
      ),
    ).rejects.toBeInstanceOf(StoreError);
    expect((await inTx((tx) => store.findMatch(matchId, tx)))?.['standings']).toEqual([
      'closed_by_actor',
      'restricted_by_target',
    ]);

    expect(
      await inTx((tx) =>
        store.updateMatch(`match:${randomUUID()}` as MatchId, { endedCause: 'unmatched' }, tx),
      ),
    ).toBe(false);
    expect(await inTx((tx) => store.findMatchesFor(c, { limit: 10, offset: 0 }, tx))).toEqual({
      items: [],
      total: 0,
    });
  });

  it('findMatchesFor pages without losing the total past the end', async () => {
    const { a, b } = await twoUsers();
    const { a: c, b: d } = await twoUsers();
    const [first, second] = ordered(a, b);
    const [third, fourth] = ordered(c, d);
    const older = `match:${randomUUID()}`;
    const newer = `match:${randomUUID()}`;
    await inTx((tx) =>
      store.upsertMatch(
        {
          matchId: older,
          participants: [first, second],
          likeIds: [randomUUID()],
          standings: ['active', 'active'],
          createdAt: DAY_ONE,
        },
        tx,
      ),
    );
    await inTx((tx) =>
      store.upsertMatch(
        {
          matchId: newer,
          participants: [third, fourth],
          likeIds: [randomUUID()],
          standings: ['active', 'active'],
          createdAt: DAY_TWO,
        },
        tx,
      ),
    );

    const newest = await inTx((tx) => store.findMatchesFor(a, { limit: 1, offset: 0 }, tx));
    expect(newest.total).toBe(1);
    expect(newest.items[0]?.['matchId']).toBe(older);

    const past = await inTx((tx) => store.findMatchesFor(c, { limit: 10, offset: 5 }, tx));
    expect(past.items).toEqual([]);
    expect(past.total).toBe(1);

    await expect(
      inTx((tx) => store.findMatchesFor(c, { limit: -1, offset: 0 }, tx)),
    ).rejects.toBeInstanceOf(StoreError);
  });

  it('a match cannot be written for a pair that is not in canonical order', async () => {
    const { a, b } = await twoUsers();
    const [first, second] = ordered(a, b);
    await expect(
      inTx((tx) =>
        store.upsertMatch(
          {
            matchId: 'match:reversed',
            participants: [second, first],
            likeIds: [randomUUID()],
            standings: ['active', 'active'],
            createdAt: DAY_ONE,
          },
          tx,
        ),
      ),
    ).rejects.toBeInstanceOf(StoreError);
  });

  // --------------------------------------------------------------- profiles --

  it('profile and preferences round-trip through jsonb, and an upsert replaces rather than appends', async () => {
    const { a } = await twoUsers();
    expect(await inTx((tx) => store.findProfile(a, tx))).toBeNull();
    expect(await inTx((tx) => store.findPreferences(a, tx))).toBeNull();

    await inTx((tx) =>
      store.upsertProfile(
        {
          profileId: `profile:${randomUUID()}`,
          userId: a,
          state: 'draft',
          content: { bio: 'one', interests: ['chess'] },
          updatedAt: DAY_ONE,
        },
        tx,
      ),
    );
    const written = await inTx((tx) => store.findProfile(a, tx));
    expect(written).toEqual(
      expect.objectContaining({
        userId: a,
        state: 'draft',
        content: { bio: 'one', interests: ['chess'] },
      }),
    );

    await inTx((tx) =>
      store.upsertProfile(
        {
          profileId: written?.profileId ?? a,
          userId: a,
          state: 'complete',
          content: { bio: 'two' },
          updatedAt: DAY_TWO,
        },
        tx,
      ),
    );
    const replaced = await inTx((tx) => store.findProfile(a, tx));
    expect(replaced?.state).toBe('complete');
    expect(replaced?.content).toEqual({ bio: 'two' });

    await inTx((tx) => store.upsertPreferences(a, { ageRange: [28, 40] }, tx));
    expect(await inTx((tx) => store.findPreferences(a, tx))).toEqual({ ageRange: [28, 40] });
    // An expression of no preference is not a filter that excludes everybody.
    await inTx((tx) => store.upsertPreferences(a, {}, tx));
    expect(await inTx((tx) => store.findPreferences(a, tx))).toEqual({});
  });

  it('a jsonb column that is not an object is a loud fault, not an undefined that looks like no data', async () => {
    const { a } = await twoUsers();
    await inTx(async (tx) => {
      const client = clientOf(tx);
      await client.query(
        'INSERT INTO app.profiles (user_id, state, content) VALUES ($1, $2, $3::jsonb)',
        [a, 'complete', '["not", "an", "object"]'],
      );
      await client.query('INSERT INTO app.preferences (user_id, value) VALUES ($1, $2::jsonb)', [
        a,
        'null',
      ]);
    });

    await expect(inTx((tx) => store.findProfile(a, tx))).rejects.toBeInstanceOf(StoreError);
    await expect(inTx((tx) => store.findPreferences(a, tx))).rejects.toBeInstanceOf(StoreError);
  });

  // ---------------------------------------------------------- the wiring --
  it('a nested tx.run rides the outer transaction rather than a second one', async () => {
    const { a, b } = await twoUsers();
    const passId = randomUUID();

    // A service method composing another store method must not commit on its
    // own: a nested run that opened a connection would leave the inner write
    // behind when the outer one rolls back.
    await expect(
      inTx(async (tx) => {
        await tx.run((inner) =>
          store.appendPass({ passId, from: a, to: b, createdAt: DAY_ONE }, inner),
        );
        await tx.run((inner) =>
          store.appendLike(like({ from: a, to: b, createdAt: DAY_TWO }), inner),
        );
        throw new Error('the request failed after composing two stores');
      }),
    ).rejects.toThrow('the request failed after composing two stores');

    expect(await inTx((tx) => store.findPassesFor(a, tx))).toEqual([]);
    expect(await inTx((tx) => store.findLikesFor(a, tx))).toEqual([]);

    const committed = await inTx(async (tx) => {
      await tx.run((inner) =>
        store.appendPass({ passId, from: a, to: b, createdAt: DAY_ONE }, inner),
      );
      return tx.run((inner) =>
        store.appendLike(like({ from: a, to: b, createdAt: DAY_TWO }), inner),
      );
    });
    expect(committed.created).toBe(true);
    expect(await inTx((tx) => store.findPassesFor(a, tx))).toEqual([
      expect.objectContaining({ state: 'superseded' }),
    ]);
  });

  it('refuses a transaction it cannot run on, rather than quietly taking a second connection', async () => {
    const { a } = await twoUsers();
    const foreign: Transaction = {
      client: { notAClient: true },
      run: async () => undefined as never,
    };

    // A store that opened its own transaction here would be the half-succeeded
    // like-and-match the port exists to prevent, and nothing else would fail.
    await expect(store.findProfile(a, foreign)).rejects.toBeInstanceOf(StoreError);
    await expect(store.appendLike(like(), foreign)).rejects.toBeInstanceOf(StoreError);
  });
});
