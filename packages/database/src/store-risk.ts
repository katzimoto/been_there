import type { RiskAssessmentId, SubjectId } from '@been-there/core';
import type { RiskStore, Transaction } from '@been-there/contracts';
import { StoreError } from '@been-there/contracts';
import { clientOf } from './transaction.js';
import { isConflict, isRetryable } from './errors.js';

/**
 * Trust & Safety persistence: the signal log and the current risk record.
 *
 * The two tables here are not peers. `risk_signals` is the durable fact — an
 * append-only log of what a detector observed, and the only thing a moderator
 * can re-read to justify a decision. `risk_assessments` is the *derived*
 * current state, one row per subject, recomputable by replaying that log. The
 * store therefore never mutates a signal and never treats the assessment as
 * history: the distinction is what makes a lost assessment update survivable
 * and a lost signal unrecoverable.
 *
 * ## Where the unit of work comes from
 *
 * Every method here takes the caller's `Transaction` and issues its statements
 * on that connection, via the one `clientOf` in `transaction.ts`. That matters
 * for this store in particular: appending a signal and writing the assessment
 * it produced are one fact, and a service that commits the first and loses the
 * second leaves a subject's risk record describing a signal the log does not
 * justify — the kind of error that surfaces months later as "why was this user
 * escalated" with no answer.
 */

/** A signal as the store accepts it. `signalId` is the idempotence key. */
export type RiskSignalInput = {
  readonly signalId: string;
  readonly subjectId: SubjectId;
  /** Which detector produced it: `link_velocity`, `harassment_language`, … */
  readonly detector: string;
  readonly behaviour: string;
  /** What it happened to — a conversation id, a report id. Opaque here. */
  readonly entityId?: string | null;
  /** Derived metadata only. Defaults to `{}`, matching the column default. */
  readonly facts?: Readonly<Record<string, unknown>>;
  /** 0 < weight <= 1, as the column constrains it. */
  readonly weight: number;
  readonly occurredAt: Date;
};

/** One row of the signal log, oldest-first when read in bulk. */
export type RiskSignalRow = {
  readonly signalId: string;
  readonly subjectId: SubjectId;
  readonly detector: string;
  readonly behaviour: string;
  readonly entityId: string | null;
  readonly facts: Readonly<Record<string, unknown>>;
  readonly weight: number;
  readonly occurredAt: Date;
  /**
   * Arrival order, monotonic. It is the last term in the read order and the
   * one that makes a ledger replayed from the database fold identically to the
   * in-memory ledger that produced it: two signals sharing an instant *and* a
   * detector are otherwise indistinguishable, and the domain orders them by
   * arrival.
   */
  readonly seq: number;
};

/** The current derived risk state for a subject. */
export type RiskAssessmentRow = {
  readonly subjectId: SubjectId;
  readonly assessmentId: RiskAssessmentId;
  readonly state: string;
  readonly lastSignalAt: Date | null;
  readonly contributingDetectors: readonly string[];
  readonly updatedAt: Date;
  /** What the caller read; handed back to `upsertAssessment` so a stale write is refused. */
  readonly generation: number;
};

/**
 * Every fault leaves here as a `StoreError`, classified.
 *
 * The classification is the point: a check violation is a caller bug worth
 * surfacing verbatim, a serialization failure is contention worth retrying,
 * and anything else is a plain fault. Collapsing them would mean either
 * reporting a transient blip as a refusal nobody hears about, or retrying a
 * bad request forever.
 *
 * The duplicate-delivery case is deliberately *not* here, because it never
 * arrives: `appendSignal` collapses a repeated `signal_id` in SQL, so the one
 * conflict a caller must not see as a fault is resolved before it can be
 * raised. What reaches this function as a conflict is a check or foreign-key
 * violation — a weight the machine does not allow, a state the risk machine
 * cannot produce, a subject that is not a user.
 */
function toStoreError(operation: string, error: unknown): StoreError {
  if (error instanceof StoreError) {
    return error;
  }
  const message = error instanceof Error ? error.message : `${operation} failed`;
  if (isRetryable(error)) {
    return new StoreError(`${operation}: ${message}`, { retryable: true, cause: error });
  }
  if (isConflict(error)) {
    return new StoreError(`${operation}: constraint violation: ${message}`, {
      retryable: false,
      cause: error,
    });
  }
  return new StoreError(`${operation}: ${message}`, { retryable: false, cause: error });
}

/** A JSON-object column that is not one is a corrupt row, not an empty fact. */
function asFactObject(value: unknown, context: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StoreError(`${context} is not a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * A `text[]` the domain reads as a list of detector names.
 *
 * Only the shape is checked. The column is `text[]`, so Postgres cannot hold a
 * non-string element — `'{1,2}'::text[]` is stored as `{"1","2"}` — and a
 * per-element check would be a guard against nothing. What is worth failing
 * on is the driver handing back something that is not a list at all, which
 * would reach the domain as a JSON blob or a string and turn a moderator's
 * rationale into a type error three layers away.
 */
function asDetectorList(value: unknown, context: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new StoreError(`${context} is not an array`);
  }
  const items: readonly unknown[] = value;
  return items as readonly string[];
}

/**
 * A timestamp that is not a `Date` means the driver's type parser was changed
 * or bypassed, and the ordering and decay arithmetic downstream would then be
 * string comparison on a safety window. Refuse rather than pass it on.
 */
function asDate(value: unknown, context: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new StoreError(`${context} is not a valid timestamp`);
  }
  return value;
}

/**
 * `seq` is a `bigint`, and the driver hands those back as strings rather than
 * lose precision. Left as a string it would order lexically — `'10' < '9'` —
 * which is a quietly corrupt arrival order rather than a type error, so it is
 * converted here and checked while converting.
 */
function asSequence(value: unknown, context: string): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < 1) {
    throw new StoreError(`${context} is not a sequence number`);
  }
  return parsed;
}

const SIGNAL_COLUMNS =
  'signal_id, subject_id, detector, behaviour, entity_id, facts, weight, occurred_at, seq';
/** `seq` is assigned by the sequence on insert, so it is never bound. */
const INSERT_COLUMNS = SIGNAL_COLUMNS.replace(', seq', '');

/** The driver's row shape, before validation. */
type SignalDbRow = {
  readonly signal_id: string;
  readonly subject_id: string;
  readonly detector: string;
  readonly behaviour: string;
  readonly entity_id: string | null;
  readonly facts: unknown;
  readonly weight: number;
  readonly occurred_at: unknown;
  readonly seq: unknown;
};

function toSignalRow(row: SignalDbRow): RiskSignalRow {
  return {
    signalId: row.signal_id,
    subjectId: row.subject_id as SubjectId,
    detector: row.detector,
    behaviour: row.behaviour,
    entityId: row.entity_id,
    facts: asFactObject(row.facts, 'risk_signals.facts'),
    weight: row.weight,
    occurredAt: asDate(row.occurred_at, 'risk_signals.occurred_at'),
    seq: asSequence(row.seq, 'risk_signals.seq'),
  };
}

/**
 * Postgres implementation of the `RiskStore` port.
 *
 * Stateless, and that is deliberate: it holds no connection of its own, so it
 * cannot accidentally run a statement outside the caller's transaction. The
 * pool is needed to *begin* a transaction (`createTransaction`), not to serve
 * a query.
 */
export class PgRiskStore implements RiskStore {
  /**
   * Appends a signal, collapsing a redelivery onto the existing row.
   *
   * `signal_id` is the primary key, so `ON CONFLICT … DO NOTHING` makes a
   * replay indistinguishable from the first delivery at the storage layer.
   * That matters more here than anywhere else in the product: a duplicated
   * delivery that appended a second row would double the signal's weight and
   * could carry a subject to `high` on an artefact of the transport rather
   * than on behaviour. The first delivery wins, so a later payload carrying
   * the same id is ignored rather than silently rewriting the record of what
   * was observed.
   *
   * The conflict is resolved in SQL rather than by catching `23505`, so a
   * duplicate is a fact the caller never has to handle — and a check or
   * foreign-key violation still surfaces, because only `signal_id` is listed
   * as a conflict target.
   *
   * The port returns nothing, unlike `appendLike`/`appendPass`/`createBlock`,
   * which return `{ created }`. Nothing is lost here: the service rebuilds the
   * assessment from `findSignalsFor`, which counts deduplicated rows either
   * way, so nothing downstream needs to know whether *this* delivery was the
   * one that added the signal.
   */
  async appendSignal(signal: RiskSignalInput, tx: Transaction): Promise<void> {
    const facts = asFactObject(signal.facts ?? {}, 'risk_signals.facts');
    try {
      await clientOf(tx).query(
        `INSERT INTO app.risk_signals (${INSERT_COLUMNS})
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         ON CONFLICT (signal_id) DO NOTHING`,
        [
          signal.signalId,
          signal.subjectId,
          signal.detector,
          signal.behaviour,
          signal.entityId ?? null,
          JSON.stringify(facts),
          signal.weight,
          signal.occurredAt,
        ],
      );
    } catch (error) {
      throw toStoreError('appendSignal', error);
    }
  }

  /**
   * The most recent `limit` signals for a subject, **oldest first**.
   *
   * The ordering and the limit together are the whole contract, and getting
   * either wrong fails silently:
   *
   *  * `limit` selects from the **newest** N. Truncating the oldest N would
   *    hide the recent behaviour the safety engine exists to see, so a burst
   *    that should escalate would look like a quiet history.
   *  * The result is then re-ordered **ascending**, because corroboration
   *    reads a window and the repeat counter walks the sequence; handing back
   *    descending would make "the last signal" the first element.
   *  * Ties are broken the way the domain breaks them, all the way down.
   *    `occurred_at` is not unique — two detectors can observe the same
   *    instant — and `correlation.ts`'s `compareSignals` sorts a ledger by
   *    `(occurredAt, detector, subjectId)`, leaving signals that share an
   *    instant *and* a detector in arrival order. Ordering here by
   *    `(occurred_at, detector, seq)` reproduces that comparator exactly, so a
   *    ledger replayed from the database folds to the same repeat count as the
   *    in-memory one that produced it. `seq` is the reason the last term is
   *    expressible at all: an arrival-ordered column, which a uuid cannot be.
   *    `risk_signals_ordered` is built on exactly this key order.
   */
  async findSignalsFor(
    subjectId: SubjectId,
    limit: number,
    tx: Transaction,
  ): Promise<readonly RiskSignalRow[]> {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new StoreError(`findSignalsFor: limit must be a positive integer, got ${limit}`);
    }
    try {
      const result = await clientOf(tx).query<SignalDbRow>(
        `SELECT ${SIGNAL_COLUMNS}
           FROM (
             SELECT ${SIGNAL_COLUMNS}
               FROM app.risk_signals
              WHERE subject_id = $1
              ORDER BY occurred_at DESC, detector ASC, seq DESC
              LIMIT $2
           ) AS newest_window
          ORDER BY occurred_at ASC, detector ASC, seq ASC`,
        [subjectId, limit],
      );
      // Decoding inside the try is deliberate: `toStoreError` passes a
      // `StoreError` through untouched, so a corrupt row keeps its own message
      // instead of being reported as a query failure.
      return result.rows.map(toSignalRow);
    } catch (error) {
      throw toStoreError('findSignalsFor', error);
    }
  }

  /**
   * The current assessment, or `null` when the subject has none.
   *
   * `null` means "no assessment yet" and is a normal answer — a subject
   * starts at `normal` by absence. It never covers a failed query: those throw
   * a `StoreError`, so "this user is not risky" and "we could not tell" can
   * never be confused by a caller that forgot to check.
   *
   * `generation` comes back because the caller has to hand it to
   * `upsertAssessment` for the write to be applied. A read that dropped it
   * would leave every caller guessing, and a guess is last-write-wins.
   */
  async findAssessment(subjectId: SubjectId, tx: Transaction): Promise<RiskAssessmentRow | null> {
    try {
      const result = await clientOf(tx).query<{
        readonly subject_id: string;
        readonly assessment_id: string;
        readonly state: string;
        readonly last_signal_at: unknown;
        readonly contributing_detectors: unknown;
        readonly generation: number;
        readonly updated_at: unknown;
      }>(
        `SELECT subject_id, assessment_id, state, last_signal_at, contributing_detectors,
                generation, updated_at
           FROM app.risk_assessments
          WHERE subject_id = $1`,
        [subjectId],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }
      return {
        subjectId: row.subject_id as SubjectId,
        assessmentId: row.assessment_id as RiskAssessmentId,
        state: row.state,
        lastSignalAt:
          row.last_signal_at === null
            ? null
            : asDate(row.last_signal_at, 'risk_assessments.last_signal_at'),
        contributingDetectors: asDetectorList(
          row.contributing_detectors,
          'risk_assessments.contributing_detectors',
        ),
        generation: row.generation,
        updatedAt: asDate(row.updated_at, 'risk_assessments.updated_at'),
      };
    } catch (error) {
      throw toStoreError('findAssessment', error);
    }
  }

  /**
   * Writes the current risk state, or refuses if the row moved under the
   * caller. `expectedGeneration` is what the caller read; `null` means it read
   * nothing, so this may only insert.
   *
   * The store replaces; it never merges in SQL. Accumulation is the *domain's*
   * job — `applySignal` unions the incoming detector into the list it read off
   * the previous record — so the value written here is the whole of the
   * domain's decision. Merging in the database would make the result a
   * function of the row being overwritten as well as of the decision, and
   * would resurrect a detector the domain dropped when it discarded a signal.
   *
   * The array is bound as a Postgres `text[]` parameter rather than a JSON
   * blob, because the domain reads it as a list and a moderator-facing query
   * will want to join against it.
   *
   * ## Why the generation is checked
   *
   * The row is a pure fold over `risk_signals`, so a lost update is a lost fold
   * *step* rather than lost evidence — the next signal would recompute it. That
   * makes the hazard recoverable but not acceptable, because until the next
   * signal the subject is under-scored, and under-scoring is the direction that
   * hurts. The writer set is also wider than one service: `applyDecay`,
   * `applyDispute` and `reassessByHuman` all rewrite this row.
   *
   * One statement covers both paths, with no branching: the conflict clause's
   * `WHERE` compares the row's generation against the parameter, and a `NULL`
   * parameter makes the comparison `NULL`, which is not true — so `null` can
   * only ever insert, and a row created by a racing writer is left alone for
   * the caller to re-read and re-fold.
   */
  async upsertAssessment(
    subjectId: SubjectId,
    assessmentId: RiskAssessmentId,
    state: string,
    lastSignalAt: Date | null,
    detectors: readonly string[],
    expectedGeneration: number | null,
    tx: Transaction,
  ): Promise<{ applied: boolean }> {
    if (detectors.some((detector) => typeof detector !== 'string')) {
      throw new StoreError('upsertAssessment: contributing_detectors must be strings');
    }
    if (lastSignalAt !== null && Number.isNaN(lastSignalAt.getTime())) {
      throw new StoreError('upsertAssessment: lastSignalAt is not a valid timestamp');
    }
    try {
      const result = await clientOf(tx).query(
        `INSERT INTO app.risk_assessments
           (subject_id, assessment_id, state, last_signal_at, contributing_detectors, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (subject_id) DO UPDATE
            SET assessment_id = EXCLUDED.assessment_id,
                state = EXCLUDED.state,
                last_signal_at = EXCLUDED.last_signal_at,
                contributing_detectors = EXCLUDED.contributing_detectors,
                generation = app.risk_assessments.generation + 1,
                updated_at = now()
          WHERE app.risk_assessments.generation = $6`,
        [subjectId, assessmentId, state, lastSignalAt, [...detectors], expectedGeneration],
      );
      return { applied: result.rowCount === 1 };
    } catch (error) {
      throw toStoreError('upsertAssessment', error);
    }
  }
}
