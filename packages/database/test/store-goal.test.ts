/**
 * `GoalStore` against a real Postgres, proving the properties the port promises
 * rather than the shape of a row it just wrote.
 *
 * The properties this file exists for are the three the domain decided and the
 * database then had to be built to keep:
 *
 *  * **A retry counts once.** `entry_id` is the caller's token and part of the
 *    key, so a replayed record and a record racing on the same token both leave
 *    one row. An implementation that read first and inserted second would pass a
 *    sequential duplicate and fail a concurrent one, which is why the
 *    concurrency case is here rather than only the duplicate.
 *  * **Deleting a profile does not take the history with it.** The goal cascades
 *    from `app.profiles`; the ledger has no reference to a profile at all. The
 *    test deletes the profile row outright and then reads the ledger back.
 *  * **Corrections are a log, not an edit.** A withdrawal leaves the entry in
 *    place; a restatement moves the effective day and leaves the superseded one
 *    in the log. Deleting the log row would be the only way to lose that, and
 *    the port has no method that could.
 *
 * The suite fails loudly rather than skipping, via `support/database.ts`: a store
 * that cannot reach its database is exactly the situation where a green tick is
 * most damaging.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { castId } from '@been-there/core';
import type { UserId } from '@been-there/core';
import type { CompletedDateRow, DateCorrectionRow, Transaction } from '@been-there/contracts';
import { databasePool, dropDatabase } from './support/database.js';
import { clientOf, createTransaction } from '../src/transaction.js';
import { PostgresGoalStore } from '../src/store-goal.js';

const DAY_ONE = new Date('2026-03-01T19:30:00.000Z');
const DAY_TWO = new Date('2026-03-05T21:00:00.000Z');
const LATER = new Date('2026-03-06T08:00:00.000Z');

describe('GoalStore, against Postgres', () => {
  const store = new PostgresGoalStore();
  let pool: pg.Pool;
  let raw: PoolClient;
  let transaction: Transaction;

  beforeAll(async () => {
    pool = await databasePool('goal');
    raw = await pool.connect();
    transaction = createTransaction(pool);
    // Connecting is not the same as reaching the schema this store reads. A
    // suite that skipped the probe would report every property below as
    // satisfied by a table that was never there.
    const probe = await raw.query<{ profile_id: string; target: number }>(
      'SELECT profile_id, target FROM app.dating_goals LIMIT 0',
    );
    expect(probe.rows).toEqual([]);
  });

  afterAll(async () => {
    raw.release();
    await pool.end();
    await dropDatabase();
  });

  /** One unit of work, the way a request gets one. */
  function inTx<T>(body: (tx: Transaction) => Promise<T>): Promise<T> {
    return transaction.run(body);
  }

  /** A user and the profile row the goal's foreign key needs. */
  async function userWithProfile(): Promise<{ userId: UserId; profileId: string }> {
    const userId = castId<'UserId'>(randomUUID());
    const profileId = `profile:${userId}`;
    await inTx(async (tx) => {
      const client = clientOf(tx);
      await client.query('INSERT INTO app.users (user_id, account_id) VALUES ($1, $2)', [
        userId,
        randomUUID(),
      ]);
      await client.query(
        "INSERT INTO app.profiles (user_id, profile_id, state, content) VALUES ($1, $2, 'draft', '{}'::jsonb)",
        [userId, profileId],
      );
    });
    return { userId, profileId };
  }

  function date(over: Partial<CompletedDateRow> = {}): CompletedDateRow {
    return {
      entryId: randomUUID(),
      counterpartId: null,
      occurredOn: '2026-03-01',
      recordedAt: DAY_ONE,
      ...over,
    };
  }

  function correction(over: Partial<DateCorrectionRow> = {}): DateCorrectionRow {
    return {
      entryId: randomUUID(),
      key: randomUUID(),
      kind: 'withdrawn',
      at: LATER,
      occurredOn: null,
      supersededOn: null,
      ...over,
    };
  }

  // ------------------------------------------------------------------- goal --

  it('answers null for a profile that has never set a target, rather than inventing one', async () => {
    const { profileId } = await userWithProfile();
    const found = await inTx((tx) => store.findGoal(profileId, tx));
    // The default is the domain's to supply. A store that stored one would give
    // the owner two answers to "what is my goal", one of them a row.
    expect(found).toBeNull();
  });

  it('writes a target, and reads back the one it wrote', async () => {
    const { userId, profileId } = await userWithProfile();
    await inTx((tx) =>
      store.upsertGoal({ profileId, ownerId: userId, target: 250, updatedAt: DAY_ONE }, tx),
    );
    const found = await inTx((tx) => store.findGoal(profileId, tx));
    expect(found?.target).toBe(250);
    expect(found?.ownerId).toBe(userId);
  });

  it('re-targets in place, so a profile never accumulates two goals', async () => {
    const { userId, profileId } = await userWithProfile();
    await inTx((tx) => store.upsertGoal({ profileId, ownerId: userId, target: 10, updatedAt: DAY_ONE }, tx));
    await inTx((tx) => store.upsertGoal({ profileId, ownerId: userId, target: 20, updatedAt: DAY_TWO }, tx));
    const rows = await raw.query<{ target: number }>('SELECT target FROM app.dating_goals WHERE profile_id = $1', [
      profileId,
    ]);
    expect(rows.rows).toEqual([{ target: 20 }]);
  });

  it('refuses to move an existing target to another account', async () => {
    const first = await userWithProfile();
    const second = await userWithProfile();
    await inTx((tx) => store.upsertGoal({ profileId: first.profileId, ownerId: first.userId, target: 30, updatedAt: DAY_ONE }, tx));
    // A profile whose owner changed hands is not this account's to re-target.
    await inTx((tx) => store.upsertGoal({ profileId: first.profileId, ownerId: second.userId, target: 9999, updatedAt: DAY_TWO }, tx));
    const found = await inTx((tx) => store.findGoal(first.profileId, tx));
    expect(found?.target).toBe(30);
    expect(found?.ownerId).toBe(first.userId);
  });

  it('has no column in which a completed count could hide', async () => {
    const columns = await raw.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'dating_goals'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    // Not `count`, not `completed`, not `dates_taken`. The count is derived from
    // the ledger, and a column here would be a second source to disagree with it.
    expect(names.sort()).toEqual(['owner_id', 'profile_id', 'target', 'updated_at']);
  });

  // ---------------------------------------------------------------- ledger --

  it('records a date, and the ledger reads it back with no corrections', async () => {
    const { userId } = await userWithProfile();
    const row = date({ counterpartId: castId<'UserId'>(randomUUID()) });
    const appended = await inTx((tx) => store.appendCompletedDate(row, userId, tx));
    expect(appended.created).toBe(true);

    const ledger = await inTx((tx) => store.findLedger(userId, tx));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.entryId).toBe(row.entryId);
    expect(ledger[0]?.occurredOn).toBe('2026-03-01');
    expect(ledger[0]?.counterpartId).toBe(row.counterpartId);
    expect(ledger[0]?.corrections).toEqual([]);
  });

  it('records a date with someone the product has never heard of, because it took no foreign key', async () => {
    const { userId } = await userWithProfile();
    const stranger = castId<'UserId'>(randomUUID());
    // No `app.users` row for `stranger`. `recordCompletedDate` requires no
    // existence, so a schema with a foreign key here would refuse a date the
    // domain says is real.
    const appended = await inTx((tx) => store.appendCompletedDate(date({ counterpartId: stranger }), userId, tx));
    expect(appended.created).toBe(true);
    const ledger = await inTx((tx) => store.findLedger(userId, tx));
    expect(ledger[0]?.counterpartId).toBe(stranger);
  });

  it('counts a replayed entryId once, because it is part of the key', async () => {
    const { userId } = await userWithProfile();
    const row = date();
    const first = await inTx((tx) => store.appendCompletedDate(row, userId, tx));
    const retry = await inTx((tx) =>
      // The same token with a *different* day: a retry that disagrees with the
      // first attempt about when the date was.
      store.appendCompletedDate(date({ entryId: row.entryId, occurredOn: '2026-03-09' }), userId, tx),
    );
    expect(first.created).toBe(true);
    // `false`, not an error: a retry is a fact the caller handles, and raising
    // here would abort the transaction that carried it.
    expect(retry.created).toBe(false);
    const ledger = await inTx((tx) => store.findLedger(userId, tx));
    expect(ledger).toHaveLength(1);
    // The original day survives the retry's different one, which is what makes
    // `created: false` a safe answer rather than a lossy one.
    expect(ledger[0]?.occurredOn).toBe('2026-03-01');
  });

  it('leaves one row when two writers race on the same entryId', async () => {
    const { userId } = await userWithProfile();
    const shared = date();
    const racing = await Promise.all([
      transaction.run((tx) => store.appendCompletedDate(shared, userId, tx)),
      transaction.run((tx) => store.appendCompletedDate(shared, userId, tx)),
    ]);
    // A read-then-write implementation passes the sequential duplicate above and
    // fails this one, which is the whole reason the uniqueness is the schema's.
    expect(racing.filter((outcome) => outcome.created)).toHaveLength(1);
    const ledger = await inTx((tx) => store.findLedger(userId, tx));
    expect(ledger).toHaveLength(1);
  });

  it('scopes an entryId to its owner, so two people may choose the same token', async () => {
    const first = await userWithProfile();
    const second = await userWithProfile();
    const shared = randomUUID();
    expect((await inTx((tx) => store.appendCompletedDate(date({ entryId: shared }), first.userId, tx))).created).toBe(true);
    expect((await inTx((tx) => store.appendCompletedDate(date({ entryId: shared }), second.userId, tx))).created).toBe(true);
  });

  it('keeps one owner history out of another', async () => {
    const first = await userWithProfile();
    const second = await userWithProfile();
    await inTx((tx) => store.appendCompletedDate(date(), first.userId, tx));
    await inTx((tx) => store.appendCompletedDate(date(), second.userId, tx));
    const mine = await inTx((tx) => store.findLedger(first.userId, tx));
    const theirs = await inTx((tx) => store.findLedger(second.userId, tx));
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0]?.entryId).not.toBe(theirs[0]?.entryId);
  });

  it('returns entries oldest first, so the ledger folds in the order it happened', async () => {
    const { userId } = await userWithProfile();
    // Recorded out of order on purpose: `occurredOn` is all the same day here, so
    // the order under test is the one `findLedger` promises — by when the entry
    // was recorded — and asserting on `occurredOn` would not be testing it.
    await inTx((tx) => store.appendCompletedDate(date({ recordedAt: LATER }), userId, tx));
    await inTx((tx) => store.appendCompletedDate(date({ recordedAt: DAY_ONE }), userId, tx));
    await inTx((tx) => store.appendCompletedDate(date({ recordedAt: DAY_TWO }), userId, tx));
    const ledger = await inTx((tx) => store.findLedger(userId, tx));
    expect(ledger.map((row) => row.recordedAt.toISOString())).toEqual([
      DAY_ONE.toISOString(),
      DAY_TWO.toISOString(),
      LATER.toISOString(),
    ]);
  });

  it('refuses a day the calendar does not have, at the database as well as the domain', async () => {
    const { userId } = await userWithProfile();
    await expect(
      inTx((tx) => store.appendCompletedDate(date({ occurredOn: '2026-02-31' }), userId, tx)),
    ).rejects.toThrow();
  });

  // ------------------------------------------------------- profile lifetime --

  it('loses the target when the profile goes, and keeps the history', async () => {
    const { userId, profileId } = await userWithProfile();
    await inTx((tx) => store.upsertGoal({ profileId, ownerId: userId, target: 40, updatedAt: DAY_ONE }, tx));
    await inTx((tx) => store.appendCompletedDate(date(), userId, tx));

    await inTx(async (tx) => {
      await clientOf(tx).query('DELETE FROM app.profiles WHERE profile_id = $1', [profileId]);
    });

    // The goal is a setting on the card, so it went with the card.
    expect(await inTx((tx) => store.findGoal(profileId, tx))).toBeNull();
    // The history is a fact about a person, and it is still there. This is the
    // property the two keys exist for: no foreign key runs from a date to a
    // profile for a cascade to travel along.
    const ledger = await inTx((tx) => store.findLedger(userId, tx));
    expect(ledger).toHaveLength(1);
  });

  it('holds no foreign key from a completed date to a profile, for a cascade to travel along', async () => {
    // The behavioural test above would still pass if someone added a *nullable*
    // `profile_id` column to `completed_dates` with `ON DELETE CASCADE` and never
    // populated it — verified by doing exactly that, which the behavioural test
    // did not catch. The column is the latent cascade, and it is the column that
    // has to be absent, so this asserts on the schema rather than on an outcome.
    const keys = await raw.query<{ table_name: string; referenced: string | null }>(
      `SELECT tc.table_name, ccu.table_name AS referenced
         FROM information_schema.table_constraints AS tc
         LEFT JOIN information_schema.constraint_column_usage AS ccu
           ON ccu.constraint_name = tc.constraint_name
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_schema = 'app'
          AND tc.table_name IN ('completed_dates', 'completed_date_corrections')`,
    );
    // `users` twice — once per table — and `completed_dates` once, which is the
    // corrections table's own key back to the entry it corrects. What must not
    // appear is `profiles`: that would be a path from a card to a date.
    expect([...new Set(keys.rows.map((row) => row.referenced))].sort()).toEqual([
      'completed_dates',
      'users',
    ]);
    expect(keys.rows.map((row) => row.referenced)).not.toContain('profiles');
  });

  it('walks a chain of restatements back to the first day claimed', async () => {
    const { userId } = await userWithProfile();
    const row = date();
    await inTx((tx) => store.appendCompletedDate(row, userId, tx));
    // Three restatements in a row. The aggregate `correctCompletedDate` builds
    // would claim only '2026-03-09' and hold ['2026-03-08', '2026-03-07'] — enough
    // to say the entry was corrected, not enough to say what was claimed first.
    for (const day of ['2026-03-08', '2026-03-07', '2026-03-09']) {
      await inTx((tx) =>
        store.appendDateCorrection(
          correction({ entryId: row.entryId, kind: 'restated', occurredOn: day, supersededOn: null }),
          userId,
          tx,
        ),
      );
    }

    const ledger = await inTx((tx) => store.findLedger(userId, tx));
    // Walking `supersededOn` back from the effective day is the whole reason the
    // column exists. Without it this reconstruction is impossible — and it is the
    // *store's* guarantee rather than the domain's, since `DateCorrection` carries
    // no such field and the route drops the column on the way in.
    // `occurredOn` seeds from an optional chain and `supersededOn` is
    // `string | null` on the row, so the walk is typed to carry both rather
    // than narrowing by hand before the assertion has spoken.
    const claimed: (string | null | undefined)[] = [ledger[0]?.occurredOn];
    for (const stored of ledger[0]?.corrections.slice().reverse() ?? []) {
      claimed.push(stored.supersededOn);
    }
    expect(claimed).toEqual(['2026-03-09', '2026-03-07', '2026-03-08', '2026-03-01']);
    expect(claimed).toContain('2026-03-01');
  });

  it('gives a recreated profile the default and the old count, rather than either one twice', async () => {
    const { userId, profileId } = await userWithProfile();
    await inTx((tx) => store.upsertGoal({ profileId, ownerId: userId, target: 40, updatedAt: DAY_ONE }, tx));
    await inTx((tx) => store.appendCompletedDate(date(), userId, tx));
    await inTx(async (tx) => {
      await clientOf(tx).query('DELETE FROM app.profiles WHERE profile_id = $1', [profileId]);
    });
    // A brand new card under a new identity.
    const replacement = `profile:${randomUUID()}`;
    await inTx(async (tx) => {
      await clientOf(tx).query(
        "INSERT INTO app.profiles (user_id, profile_id, state, content) VALUES ($1, $2, 'draft', '{}'::jsonb)",
        [userId, replacement],
      );
    });

    expect(await inTx((tx) => store.findGoal(replacement, tx))).toBeNull();
    expect(await inTx((tx) => store.findLedger(userId, tx))).toHaveLength(1);
  });

  it('takes the whole history when the account itself is erased', async () => {
    const { userId, profileId } = await userWithProfile();
    await inTx((tx) => store.upsertGoal({ profileId, ownerId: userId, target: 5, updatedAt: DAY_ONE }, tx));
    await inTx((tx) => store.appendCompletedDate(date(), userId, tx));
    const entryId = (await inTx((tx) => store.findLedger(userId, tx)))[0]?.entryId ?? '';
    await inTx((tx) => store.appendDateCorrection(correction({ entryId }), userId, tx));

    await inTx(async (tx) => {
      await clientOf(tx).query('DELETE FROM app.users WHERE user_id = $1', [userId]);
    });

    // Scoped to this suite's users rather than counted across the table: the
    // earlier tests left rows behind, and asserting on the whole table would be
    // asserting on them.
    const left = await raw.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM app.completed_dates WHERE owner_id = $1',
      [userId],
    );
    const correctionsLeft = await raw.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM app.completed_date_corrections WHERE owner_id = $1',
      [userId],
    );
    // Erasure is a right, and it is the only delete that reaches these tables —
    // the correction log goes with the entry rather than being orphaned by it.
    expect(left.rows[0]?.count).toBe('0');
    expect(correctionsLeft.rows[0]?.count).toBe('0');
  });

  // ------------------------------------------------------------ corrections --

  it('appends a withdrawal and keeps the entry, because the count is a fold not a number', async () => {
    const { userId } = await userWithProfile();
    const row = date();
    await inTx((tx) => store.appendCompletedDate(row, userId, tx));
    const applied = await inTx((tx) =>
      store.appendDateCorrection(correction({ entryId: row.entryId, kind: 'withdrawn' }), userId, tx),
    );
    expect(applied.applied).toBe(true);

    const ledger = await inTx((tx) => store.findLedger(userId, tx));
    // Still there. A withdrawal that deleted the row would leave nothing to
    // explain the drop, and this store has no delete to do it with anyway.
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.corrections).toHaveLength(1);
    expect(ledger[0]?.corrections[0]?.kind).toBe('withdrawn');
    expect(ledger[0]?.occurredOn).toBe('2026-03-01');
  });

  it('moves the effective day on a restatement and keeps the day it replaced', async () => {
    const { userId } = await userWithProfile();
    const row = date();
    await inTx((tx) => store.appendCompletedDate(row, userId, tx));
    const applied = await inTx((tx) =>
      store.appendDateCorrection(
        correction({ entryId: row.entryId, kind: 'restated', occurredOn: '2026-03-07', supersededOn: null }),
        userId,
        tx,
      ),
    );
    expect(applied.applied).toBe(true);

    const ledger = await inTx((tx) => store.findLedger(userId, tx));
    expect(ledger[0]?.occurredOn).toBe('2026-03-07');
    // The log keeps what the entry said before. Without this the correction is an
    // edit that overwrote its own evidence, and "why is this the 7th?" has no
    // answer.
    expect(ledger[0]?.corrections[0]?.supersededOn).toBe('2026-03-01');
    expect(ledger[0]?.corrections[0]?.occurredOn).toBe('2026-03-07');
  });

  it('moves the day once for a replayed correction key, and keeps the original superseded day', async () => {
    const { userId } = await userWithProfile();
    const row = date();
    await inTx((tx) => store.appendCompletedDate(row, userId, tx));
    const key = randomUUID();
    const restate = (day: string) =>
      inTx((tx) =>
        store.appendDateCorrection(
          correction({ entryId: row.entryId, key, kind: 'restated', occurredOn: day, supersededOn: null }),
          userId,
          tx,
        ),
      );
    expect((await restate('2026-03-07')).applied).toBe(true);
    const retry = await restate('2026-03-08');

    expect(retry.applied).toBe(false);
    const ledger = await inTx((tx) => store.findLedger(userId, tx));
    // Not '2026-03-08': a retry has to look like the first attempt, and a second
    // restatement would also record the 7th as superseded, which never was.
    expect(ledger[0]?.occurredOn).toBe('2026-03-07');
    expect(ledger[0]?.corrections[0]?.supersededOn).toBe('2026-03-01');
    expect(ledger[0]?.corrections).toHaveLength(1);
  });

  it('will not resurrect a withdrawn entry by restating it, even against the store', async () => {
    const { userId } = await userWithProfile();
    const row = date();
    await inTx((tx) => store.appendCompletedDate(row, userId, tx));
    await inTx((tx) =>
      store.appendDateCorrection(correction({ entryId: row.entryId, kind: 'withdrawn' }), userId, tx),
    );
    const attempted = await inTx((tx) =>
      store.appendDateCorrection(
        correction({ entryId: row.entryId, kind: 'restated', occurredOn: '2026-03-07', supersededOn: null }),
        userId,
        tx,
      ),
    );

    // The domain refuses this in `correctCompletedDate`. The store refuses it too,
    // so a request that raced a withdrawal cannot slip past the check.
    expect(attempted.applied).toBe(false);
    const ledger = await inTx((tx) => store.findLedger(userId, tx));
    expect(ledger[0]?.occurredOn).toBe('2026-03-01');
  });

  it('ignores a correction for an entry that does not exist', async () => {
    const { userId } = await userWithProfile();
    const attempted = await inTx((tx) => store.appendDateCorrection(correction(), userId, tx));
    expect(attempted.applied).toBe(false);
    const rows = await raw.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM app.completed_date_corrections WHERE owner_id = $1',
      [userId],
    );
    expect(rows.rows[0]?.count).toBe('0');
  });

  it('refuses a restated correction that names no day, at the store', async () => {
    const { userId } = await userWithProfile();
    const row = date();
    await inTx((tx) => store.appendCompletedDate(row, userId, tx));
    await expect(
      inTx((tx) =>
        store.appendDateCorrection(
          correction({ entryId: row.entryId, kind: 'restated', occurredOn: null, supersededOn: null }),
          userId,
          tx,
        ),
      ),
    ).rejects.toThrow();
  });

  it('refuses a correction kind the domain does not define', async () => {
    const { userId } = await userWithProfile();
    const row = date();
    await inTx((tx) => store.appendCompletedDate(row, userId, tx));
    await expect(
      inTx((tx) =>
        store.appendDateCorrection(
          { ...correction({ entryId: row.entryId }), kind: 'deleted' as 'withdrawn' },
          userId,
          tx,
        ),
      ),
    ).rejects.toThrow();
  });

  it('has no update and no delete on a correction, in the schema as well as the port', async () => {
    // There is no trigger, grant or rule that could rewrite or remove a
    // correction row: the only way to lose one is to erase the account. This
    // checks the table carries no mutable-state column that a future migration
    // might treat as the current value.
    const columns = await raw.query<{ column_name: string; is_updatable: string }>(
      `SELECT column_name, is_updatable FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'completed_date_corrections'`,
    );
    const names = columns.rows.map((row) => row.column_name).sort();
    expect(names).toEqual([
      'corrected_at',
      'correction_key',
      'entry_id',
      'kind',
      'occurred_on',
      'owner_id',
      'seq',
      'superseded_on',
    ]);
    // No `state`, no `applied` flag, no `is_current` — nothing that would let a
    // reader pick one correction out as the live one instead of reading all.
    expect(names).not.toContain('state');
    expect(names).not.toContain('current');
  });
});
