/**
 * `VerificationAttemptStore` against Postgres: the port, the SQL, and the
 * refusals. The translation between the domain's attempt and the schema's
 * columns is in `store-verification-attempts-rows.ts`, and that file also
 * carries the argument for why the non-tabular half of the aggregate lives in
 * the one `jsonb` column the table has.
 *
 * The state *vocabulary* is not repeated here — the `CHECK` on `state` is the
 * definition, and a second list would be a second thing to keep in step with
 * it, the argument `IdentityStore` makes about `setState`. The one lifecycle
 * fact this file carries is which states are *closed*, because the partial
 * unique index `verification_attempts_one_open` is defined in terms of it: a
 * row is open exactly when it is not terminal, and `closed_at` is written from
 * that.
 */
import type { PoolClient, QueryResultRow } from 'pg';
import { StoreError } from '@been-there/contracts';
import type { Transaction, VerificationAttemptStore } from '@been-there/contracts';
import type { UserId } from '@been-there/core';
import { isConflict, isRetryable } from './errors.js';
import { clientOf } from './transaction.js';
import {
  ATTEMPT_COLUMNS,
  ENVELOPE_CODECS,
  FIXED_FIELDS,
  PATCH_COLUMNS,
  SUPPLIED_FIELDS,
  TERMINAL_STATES,
  fault,
  isEnvelopeKey,
  isTerminal,
  readAttempt,
  readNullableText,
  readText,
  toAttemptRecord,
  toEnvelope,
  toEnvelopePatch,
  type AttemptRecord,
} from './store-verification-attempts-rows.js';

export type {
  AttemptConfidence,
  AttemptDecision,
  AttemptEvidence,
  AttemptRecord,
} from './store-verification-attempts-rows.js';

/**
 * The refusals a caller has to tell apart: the user already has an open attempt,
 * or this id was used before. Both are facts about the request rather than
 * outages, so both are not retryable.
 */
export type AttemptConflictReason = 'attempt_id_taken' | 'open_attempt_exists';

export class VerificationAttemptStoreError extends StoreError {
  readonly reason: AttemptConflictReason;
  constructor(reason: AttemptConflictReason, message: string) {
    super(message, { retryable: false });
    this.name = 'VerificationAttemptStoreError';
    this.reason = reason;
  }
}

/**
 * Sends one statement and turns anything that is not already a `StoreError`
 * into one, so "the query failed" can never look like "no row". No retry here: a
 * failed statement has already poisoned the caller's transaction, so re-sending
 * it would fail for a different reason. Retrying a unit of work belongs to the
 * transaction that owns it.
 */
async function query<Row extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: readonly unknown[],
): Promise<{ rows: Row[]; rowCount: number }> {
  try {
    const result = await client.query<Row>(text, values as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    if (error instanceof StoreError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : 'query failed';
    const detail = isConflict(error) ? `constraint violation: ${message}` : message;
    throw new StoreError(detail, { retryable: isRetryable(error), cause: error });
  }
}

/**
 * Turns the schema's refusals into ones a caller can act on. The two unique
 * violations are outcomes the product has names for. A foreign-key violation
 * means the user does not exist and a check violation means a state outside the
 * vocabulary, and both are `isConflict` rather than an outage.
 */
function translateInsertFailure(error: unknown, record: AttemptRecord): unknown {
  if (error instanceof StoreError) {
    return error;
  }
  const constraint =
    typeof error === 'object' && error !== null
      ? (error as Readonly<Record<string, unknown>>)['constraint']
      : null;
  if (constraint === 'verification_attempts_one_open') {
    return new VerificationAttemptStoreError(
      'open_attempt_exists',
      `insert: user ${record.subjectId} already has an open verification attempt`,
    );
  }
  if (constraint === 'verification_attempts_pkey') {
    return new VerificationAttemptStoreError(
      'attempt_id_taken',
      `insert: attempt ${record.verificationId} already exists`,
    );
  }
  return new StoreError(`insert: ${error instanceof Error ? error.message : 'failed'}`, {
    retryable: isRetryable(error),
    cause: error,
  });
}

/**
 * `VerificationAttemptStore` on Postgres. The constructor takes nothing: a store
 * holding a pool could reach around the caller's transaction, and the only
 * defence against that is not having one.
 */
export class PgVerificationAttemptStore implements VerificationAttemptStore {
  /**
   * Opens an attempt, or refuses.
   *
   * `verification_attempts_one_open` is partial on `closed_at IS NULL`, so two
   * devices starting a verification for one user race for it and exactly one
   * wins; the loser's insert fails on that index and is reported as
   * `open_attempt_exists` rather than as a generic fault, so a caller can tell
   * "you already have one open" from "this id was used before" from an outage.
   * `closed_at` is not an input: it is derived from the state the caller wrote,
   * because the store does not get a second say in when an attempt ends.
   */
  async insert(attempt: Readonly<Record<string, unknown>>, tx: Transaction): Promise<void> {
    const record = readAttempt(attempt, 'insert');
    try {
      await clientOf(tx).query(
        `INSERT INTO app.verification_attempts
           (attempt_id, user_id, state, checks, provider_reference, opened_at, closed_at)
         VALUES ($1, $2::uuid, $3, $4::jsonb, $5, $6::timestamptz, $7::timestamptz)`,
        [
          record.verificationId,
          record.subjectId,
          record.state,
          toEnvelope(record),
          record.providerReference,
          record.startedAt,
          isTerminal(record.state) ? record.updatedAt : null,
        ],
      );
    } catch (error) {
      throw translateInsertFailure(error, record);
    }
  }

  /**
   * One attempt by id, or `null`. `null` means no such attempt and is a normal
   * answer. It never covers a corrupt row: an unreadable `checks` document, or a
   * row whose `closed_at` disagrees with its state, throws. A caller handed a
   * half-read attempt would feed it to `submitToProvider`, which re-derives the
   * decision from what it is given.
   */
  async find(attemptId: string, tx: Transaction): Promise<AttemptRecord | null> {
    const result = await query<QueryResultRow>(
      clientOf(tx),
      `SELECT ${ATTEMPT_COLUMNS} FROM app.verification_attempts WHERE attempt_id = $1`,
      [attemptId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toAttemptRecord(row, 'find');
  }

  /**
   * The user's open attempt, or `null` if they have none. The predicate is the
   * index's own, so this is a lookup rather than a scan that has to be trusted.
   * More than one row is impossible while that index exists, and if it happens
   * anyway it throws rather than picking one: which of two open attempts a user
   * "has" is not a question this store answers by coin toss.
   */
  async findOpenFor(userId: UserId, tx: Transaction): Promise<AttemptRecord | null> {
    const result = await query<QueryResultRow>(
      clientOf(tx),
      `SELECT ${ATTEMPT_COLUMNS} FROM app.verification_attempts
        WHERE user_id = $1 AND closed_at IS NULL`,
      [userId],
    );
    if (result.rows.length > 1) {
      throw fault(
        `findOpenFor: user ${userId} has ${result.rows.length} open attempts; verification_attempts_one_open is not doing its job`,
      );
    }
    const row = result.rows[0];
    return row === undefined ? null : toAttemptRecord(row, 'findOpenFor');
  }

  /**
   * Patches an attempt and reports whether a row was there to patch.
   *
   * Three rules, each of them something a caller would otherwise get wrong
   * silently. A patch may not move a closed attempt back to open: the `WHERE`
   * clause refuses it, so a stale client replaying a `capturing` event against
   * an attempt that has since passed cannot undo the outcome, and cannot reopen
   * the user's gate to the product either. `false` answers both "refused" and
   * "no such row", and neither is a silent success. A patch may not rewrite a
   * fixed field — see `FIXED_FIELDS`. And an unknown key is a fault, not a
   * no-op: a typo that dropped `decision` would leave the stored outcome of a
   * verification disagreeing with the state in the same row.
   *
   * Envelope keys merge with `checks || $patch::jsonb`, so patching `state`
   * leaves the evidence, decision and confidence exactly as they were and
   * patching one of them replaces only that one. The merge happens inside the
   * statement, so there is no window for a second writer to slip a value in.
   */
  async update(
    attemptId: string,
    patch: Readonly<Record<string, unknown>>,
    tx: Transaction,
  ): Promise<boolean> {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const document: Record<string, unknown> = {};
    let state: string | null = null;
    let updatedAt: Date | null = null;

    for (const key of Object.keys(patch)) {
      if (FIXED_FIELDS[key] === true) {
        throw fault(`update: '${key}' is fixed when the attempt is opened and cannot be patched`);
      }
      if (isEnvelopeKey(key)) {
        document[key] = ENVELOPE_CODECS[key](patch[key], `update.${key}`);
        if (key === 'updatedAt') {
          // The only codec that yields a Date, and this branch is only reached
          // for that key, so the narrowed type is the real one.
          updatedAt = document['updatedAt'] as Date;
        }
        continue;
      }
      const column = PATCH_COLUMNS[key];
      if (column === undefined) {
        throw fault(
          `update: unknown patch key '${key}'; expected one of ${[...Object.keys(SUPPLIED_FIELDS), ...Object.keys(PATCH_COLUMNS)].join(', ')}`,
        );
      }
      if (key === 'state') {
        state = readText(patch[key], `update.${key}`);
      }
      values.push(key === 'state' ? state : readNullableText(patch[key], `update.${key}`));
      // Four parameters lead — the id, the patched state, the close instant and
      // the terminal states — so an assignment's placeholder follows its value.
      assignments.push(`${column} = $${values.length + 4}`);
    }

    if (Object.keys(document).length > 0) {
      values.push(toEnvelopePatch(document));
      assignments.push(`checks = checks || $${values.length + 4}::jsonb`);
    }

    const patched = await query<QueryResultRow>(
      clientOf(tx),
      `UPDATE app.verification_attempts
          SET ${assignments.join(', ')},
              closed_at = CASE WHEN $2::text = ANY ($4::text[])
                               THEN COALESCE(closed_at, COALESCE($3::timestamptz, now()))
                               ELSE closed_at END
        WHERE attempt_id = $1
          AND NOT (closed_at IS NOT NULL AND $2::text IS NOT NULL
                   AND $2::text <> ALL ($4::text[]))`,
      [attemptId, state, updatedAt, [...TERMINAL_STATES], ...values],
    );
    return patched.rowCount === 1;
  }
}
