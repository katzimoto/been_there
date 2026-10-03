/**
 * `GoalStore` against Postgres: the dating goal, and the completed-date history.
 *
 * Three properties are this store's reason to exist, and none of them is
 * "reads and writes rows":
 *
 *  * **The two aggregates are stored under two keys.** `dating_goals` is keyed by
 *    `profile_id` and cascades from `app.profiles`; `completed_dates` is keyed by
 *    `owner_id` and has no reference to a profile at all. There is no statement
 *    here that could reach from a profile to a date, so "deleting a profile does
 *    not take the history with it" is the shape of the code rather than a
 *    condition somebody has to remember to check.
 *  * **A retry is a retry.** `entry_id` is the caller's token and part of the
 *    primary key, so `appendCompletedDate` collapses a replay with
 *    `ON CONFLICT DO NOTHING` and reports `created: false`. A second tap, a
 *    retry after a timeout and two workers racing on the same key all leave the
 *    count where one of them put it.
 *  * **Corrections are appended and never rewritten.** The port has no update and
 *    no delete on them, and this class has no method that could become one. A
 *    restatement rewrites the entry's *effective* day — a projection of the log,
 *    the way `likes.state` is a projection of likes and their supersessions —
 *    while the correction row keeps the day it replaced.
 *
 *    Note the asymmetry with the domain, which is deliberate:
 *    `correctCompletedDate` overwrites the record's `occurredOn` and retains only
 *    the days each restatement moved *to*, so the aggregate it returns cannot
 *    say what was claimed first. This store keeps that in `supersededOn`, which
 *    makes the chain of claims walkable here and is a **storage** guarantee
 *    rather than a claim about what `CompletedDateRecord` carries. The route
 *    drops the column on the way in, because the domain type has no field for it
 *    and inventing one would change what the domain promises.
 *
 * Every method runs on the caller's connection through the one `clientOf`, so a
 * write and the read that decided it are in the same unit of work.
 */
import type { UserId } from '@been-there/core';
import type { QueryResultRow } from 'pg';
import type {
  CompletedDateEntryRow,
  CompletedDateRow,
  DatingGoalRow,
  DateCorrectionRow,
  GoalStore,
  Transaction,
} from '@been-there/contracts';
import { clientOf } from './transaction.js';
import { fault, query } from './store-support.js';

/** The goal row, as Postgres returns it. Declared so a renamed column is a type error. */
type GoalDbRow = {
  readonly profile_id: string;
  readonly owner_id: string;
  readonly target: number;
  readonly updated_at: Date;
};

type CompletedDateDbRow = {
  readonly entry_id: string;
  readonly counterpart_id: string | null;
  /** Selected as text; see `dayOf`. */
  readonly occurred_on: string;
  readonly recorded_at: Date;
};

type CorrectionDbRow = {
  readonly entry_id: string;
  readonly correction_key: string;
  readonly kind: string;
  /** Selected as text; see `dayOf`. */
  readonly occurred_on: string | null;
  readonly superseded_on: string | null;
  readonly corrected_at: Date;
};

/**
 * The two correction kinds, as a lookup rather than a list a caller scans.
 *
 * A value that is not a key here is refused, so a row the domain could not have
 * produced is caught on the way in rather than on the way out.
 */
const CORRECTION_KIND: Readonly<Record<string, true>> = {
  withdrawn: true,
  restated: true,
};

/**
 * A `date` column, as the ISO string the domain holds it in.
 *
 * The driver parses a bare `date` into a `Date` at *local* midnight, and
 * formatting that back in UTC moves the day for every reader east of Greenwich:
 * `2026-03-01` read in Tokyo comes back as `2026-02-28`. So these columns are
 * selected as text and never go through a `Date` at all — `occurredOn` is an ISO
 * `YYYY-MM-DD` string in the domain, in the port and in every route body, and the
 * only conversion that happens is Postgres rendering its own `date`. This is
 * verified against a real database rather than reasoned about; see
 * `test/store-goal.test.ts`.
 */
function dayOf(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw fault(`app.${what} is not an ISO day`);
  }
  return value;
}

/**
 * A timestamp that is not a `Date` means the driver's type parser was changed or
 * bypassed, and "when was this written" would then be string comparison. Refuse
 * rather than pass it on.
 */
function instantOf(value: unknown, what: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw fault(`app.${what} is not a timestamp`);
  }
  return value;
}

function toGoalRow(row: GoalDbRow): DatingGoalRow {
  return {
    profileId: row.profile_id,
    ownerId: row.owner_id as UserId,
    target: row.target,
    updatedAt: instantOf(row.updated_at, `dating_goals.updated_at for ${row.profile_id}`),
  };
}

/**
 * Reads a correction back into the shape the domain folds over.
 *
 * `supersededOn` is read but deliberately **not** carried into the domain's
 * `DateCorrection`, which has no field for it: the domain asked for a log it can
 * count over, and the superseded day is what the *store* keeps so the log can
 * still be audited afterwards. Putting it in the domain type would be inventing
 * a field the domain does not have.
 */
function toCorrection(row: CorrectionDbRow): DateCorrectionRow {
  const entryId = row.entry_id;
  if (CORRECTION_KIND[row.kind] !== true) {
    throw fault(`a stored correction on ${entryId} has kind '${row.kind}', which is not a correction kind`);
  }
  const kind = row.kind as 'withdrawn' | 'restated';
  const occurredOn = row.occurred_on === null ? null : dayOf(row.occurred_on, `corrections.occurred_on on ${entryId}`);
  const supersededOn =
    row.superseded_on === null ? null : dayOf(row.superseded_on, `corrections.superseded_on on ${entryId}`);
  if ((kind === 'restated') !== (occurredOn !== null && supersededOn !== null)) {
    throw fault(
      `a stored ${kind} correction on ${entryId} carries the wrong days; the schema's CHECK should have refused it`,
    );
  }
  return {
    entryId,
    key: row.correction_key,
    kind,
    at: instantOf(row.corrected_at, `corrections.corrected_at on ${entryId}`),
    occurredOn,
    supersededOn,
  };
}

export class PostgresGoalStore implements GoalStore {
  /**
   * The goal for one profile, or `null` when the owner has never named one.
   *
   * `null` is a normal answer, not a fault: the default is the domain's to
   * supply, so a store that invented one here would give the owner two answers
   * to "what is my goal".
   */
  async findGoal(profileId: string, tx: Transaction): Promise<DatingGoalRow | null> {
    const client = clientOf(tx);
    if (profileId === '') {
      throw fault("findGoal: 'profileId' must be a non-empty string");
    }
    const found = await query<GoalDbRow>(
      client,
      `SELECT profile_id, owner_id, target, updated_at
         FROM app.dating_goals
        WHERE profile_id = $1`,
      [profileId],
    );
    const row = found.rows[0];
    return row === undefined ? null : toGoalRow(row);
  }

  /**
   * Writes the target for a profile.
   *
   * An upsert rather than an insert-then-update, so two devices setting a goal at
   * once converge instead of one of them taking a unique violation. No count is
   * written and none is read: `upsertGoal` cannot lose the completed-date history
   * because this statement does not name a table it lives in.
   *
   * The `owner_id` is only written on insert, and the `DO UPDATE` carries a
   * `WHERE` that the existing row belongs to the same owner. A profile that
   * changed hands therefore cannot be used to move an existing target to another
   * account — the profile's owner is a fact about the profile, not something a
   * request supplies. A row that fails the `WHERE` is left alone, which is the
   * answer: the profile is not this owner's to re-target.
   */
  async upsertGoal(row: DatingGoalRow, tx: Transaction): Promise<void> {
    const client = clientOf(tx);
    if (row.profileId === '') {
      throw fault("upsertGoal: 'profileId' must be a non-empty string");
    }
    if (!Number.isInteger(row.target)) {
      throw fault("upsertGoal: 'target' must be a whole number of dates");
    }
    instantOf(row.updatedAt, `dating_goals.updated_at for ${row.profileId}`);
    await query<{ profile_id: string }>(
      client,
      `INSERT INTO app.dating_goals (profile_id, owner_id, target, updated_at)
            VALUES ($1, $2::uuid, $3, $4::timestamptz)
       ON CONFLICT (profile_id) DO UPDATE
              SET target = EXCLUDED.target,
                  updated_at = EXCLUDED.updated_at
            WHERE app.dating_goals.owner_id = EXCLUDED.owner_id`,
      [row.profileId, row.ownerId, row.target, row.updatedAt],
    );
  }

  /**
   * The owner's whole history, oldest first, each entry with its corrections.
   *
   * Two statements rather than one join, because a join from the entries to the
   * correction log multiplies an entry out by its corrections and a reader has
   * to know not to count the repeats. Here every correction is returned exactly
   * once and grouped by `entry_id`, so the fold the domain does sees the same
   * shape it would have seen in memory.
   *
   * Corrections come back in append order — the schema's `seq`, not
   * `corrected_at` — because two corrections can share a millisecond and
   * ordering those by the caller's random key would make "the correction that
   * caused this entry to say what it says" a different answer per read. That
   * order is load-bearing rather than cosmetic: `supersededOn` is walked to
   * reconstruct what the owner originally claimed, and a shuffled log
   * reconstructs a claim they never made.
   */
  async findLedger(ownerId: UserId, tx: Transaction): Promise<readonly CompletedDateEntryRow[]> {
    const client = clientOf(tx);
    const entries = await query<CompletedDateDbRow>(
      client,
      `SELECT entry_id, counterpart_id, occurred_on::text AS occurred_on, recorded_at
         FROM app.completed_dates
        WHERE owner_id = $1::uuid
        ORDER BY recorded_at, entry_id`,
      [ownerId],
    );
    const corrections = await query<CorrectionDbRow>(
      client,
      `SELECT entry_id, correction_key, kind,
              occurred_on::text AS occurred_on, superseded_on::text AS superseded_on, corrected_at
         FROM app.completed_date_corrections
        WHERE owner_id = $1::uuid
        ORDER BY seq`,
      [ownerId],
    );
    const grouped = new Map<string, DateCorrectionRow[]>();
    for (const row of corrections.rows) {
      const correction = toCorrection(row);
      const seen = grouped.get(correction.entryId);
      if (seen === undefined) {
        grouped.set(correction.entryId, [correction]);
      } else {
        seen.push(correction);
      }
    }
    return entries.rows.map((row) => ({
      entryId: row.entry_id,
      counterpartId: row.counterpart_id as UserId | null,
      occurredOn: dayOf(row.occurred_on, `completed_dates.occurred_on on ${row.entry_id}`),
      recordedAt: instantOf(row.recorded_at, `completed_dates.recorded_at on ${row.entry_id}`),
      corrections: grouped.get(row.entry_id) ?? [],
    }));
  }

  /**
   * Appends a completed date, or reports that the `entryId` was already there.
   *
   * `ON CONFLICT DO NOTHING` rather than a read-then-write: two workers racing on
   * the same retry token must not be able to produce two rows, and a read first
   * would leave exactly that window open. `DO NOTHING` also leaves the caller's
   * transaction usable, which a unique violation would not — a duplicate is a
   * fact the service handles, not an aborted request.
   *
   * No standing, no block list, no match and no verification are consulted here,
   * and none are available here. `counterpart_id` is written as a bare uuid with
   * no foreign key, and a date with someone met outside the product is a real
   * date, so requiring the other person to exist would be a rule this module was
   * never asked to enforce.
   */
  async appendCompletedDate(row: CompletedDateRow, ownerId: UserId, tx: Transaction): Promise<{ created: boolean }> {
    const client = clientOf(tx);
    const recordedAt = instantOf(row.recordedAt, `completed_dates.recorded_at for ${row.entryId}`);
    const appended = await query<{ entry_id: string }>(
      client,
      `INSERT INTO app.completed_dates
         (owner_id, entry_id, counterpart_id, occurred_on, recorded_at)
       VALUES ($1::uuid, $2, $3::uuid, $4::date, $5::timestamptz)
       ON CONFLICT (owner_id, entry_id) DO NOTHING
       RETURNING entry_id`,
      [ownerId, row.entryId, row.counterpartId, row.occurredOn, recordedAt],
    );
    return { created: appended.rowCount === 1 };
  }

  /**
   * Appends a correction, and — for a restatement — moves the entry's effective
   * day in the same request.
   *
   * Two statements, and the order is the point. The correction goes first and
   * carries the day the entry *currently* says, read in the same statement, so
   * the log is complete before anything projects it. Only then is
   * `occurred_on` rewritten to the restated day — and only when the append
   * actually happened, so a replayed key neither moves the day twice nor records
   * the day it already moved to as the one being superseded.
   *
   * The restatement's `SELECT` refuses an entry that does not exist and refuses
   * one that has been withdrawn, which is "corrections accumulate and never
   * resurrect" as a database fact rather than only a rule the domain function
   * checked a moment earlier. A request that raced a withdrawal loses here.
   *
   * `{ applied: false }` covers both a replayed key and a second withdrawal, for
   * the same reason the domain returns the ledger unchanged for either: a retry
   * has to look like the first attempt.
   */
  async appendDateCorrection(row: DateCorrectionRow, ownerId: UserId, tx: Transaction): Promise<{ applied: boolean }> {
    const client = clientOf(tx);
    const { entryId, key, kind } = row;
    if (entryId === '') {
      throw fault("appendDateCorrection: 'entryId' must be a non-empty string");
    }
    if (key === '') {
      throw fault("appendDateCorrection: 'key' must be a non-empty string");
    }
    if (CORRECTION_KIND[kind] !== true) {
      throw fault(`appendDateCorrection: '${kind}' is not a correction kind`);
    }
    const at = instantOf(row.at, `corrections.corrected_at for ${entryId}`);
    const occurredOn = row.occurredOn ?? null;

    if (kind === 'withdrawn') {
      const withdrawn = await query<{ correction_key: string }>(
        client,
        `INSERT INTO app.completed_date_corrections
           (owner_id, entry_id, correction_key, kind, occurred_on, superseded_on, corrected_at)
         SELECT $1::uuid, entry_id, $3::text, 'withdrawn', NULL, NULL, $4::timestamptz
           FROM app.completed_dates
          WHERE owner_id = $1::uuid AND entry_id = $2
         ON CONFLICT (owner_id, entry_id, correction_key) DO NOTHING
         RETURNING correction_key`,
        [ownerId, entryId, key, at],
      );
      return { applied: withdrawn.rowCount === 1 };
    }

    if (occurredOn === null) {
      throw fault("appendDateCorrection: a 'restated' correction must name the day it restates to");
    }
    const restated = await query<{ correction_key: string }>(
      client,
      `INSERT INTO app.completed_date_corrections
         (owner_id, entry_id, correction_key, kind, occurred_on, superseded_on, corrected_at)
       SELECT c.owner_id, c.entry_id, $3::text, 'restated', $5::date, c.occurred_on, $4::timestamptz
         FROM app.completed_dates c
        WHERE c.owner_id = $1::uuid
          AND c.entry_id = $2
          AND NOT EXISTS (
            SELECT 1 FROM app.completed_date_corrections w
             WHERE w.owner_id = c.owner_id
               AND w.entry_id = c.entry_id
               AND w.kind = 'withdrawn'
          )
       ON CONFLICT (owner_id, entry_id, correction_key) DO NOTHING
       RETURNING correction_key`,
      [ownerId, entryId, key, at, occurredOn],
    );
    if (restated.rowCount === 1) {
      await query<{ entry_id: string }>(
        client,
        `UPDATE app.completed_dates
            SET occurred_on = $3::date
          WHERE owner_id = $1::uuid AND entry_id = $2`,
        [ownerId, entryId, occurredOn],
      );
    }
    return { applied: restated.rowCount === 1 };
  }
}
