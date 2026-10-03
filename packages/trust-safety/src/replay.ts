import type { SubjectId } from '@been-there/core';
import {
  ESCALATION_STATUSES,
  type DetectorReliability,
  type EscalationStatus,
  RELIABILITIES,
} from './escalation.js';
import {
  type SignalLedger,
  SIGNAL_LEDGER_CAPACITY,
  appendSignal,
  EMPTY_LEDGER,
} from './correlation.js';
import {
  BEHAVIOUR_KINDS,
  type BehaviourKey,
  type BehaviourKind,
  type Signal,
  type SignalAuthor,
  SIGNAL_CATEGORIES,
  type SignalCategory,
  type SignalFacts,
  createSignal,
} from './signal.js';

/**
 * Rebuilding a `SignalLedger` from the durable signal log.
 *
 * ## Why this is not a map over rows
 *
 * `risk_signals` is the evidence a moderator can re-read to justify a decision,
 * so a replay may not invent anything to make a row usable. A stored row is a
 * `Signal` only if the domain's own constructor accepts it, and that check is
 * `createSignal` — the same one a live detector's output passes through. A
 * replay that assembled signals field-by-field would be a second answer to "what
 * is a Signal", free to disagree about exactly the rows that matter: a
 * `report_against` whose actor was never recorded, or one whose declaration
 * claims a reliability no detector ever asserted.
 *
 * So every row goes through `createSignal`, and a row it refuses is **skipped
 * and counted**. Not dropped: the caller is handed each skip with its reason,
 * because a subject whose history was partly unreadable is under-scored, and
 * under-scoring is the direction that hurts. Silently folding what it can would
 * produce a ledger that looks whole.
 *
 * ## The one field the log does not store
 *
 * `SignalAuthor.dependsOnReports` describes a detector's *inputs* — whether its
 * only evidence is a report about the subject — and it is deliberately **not**
 * persisted, because it is a fact about the running code rather than about a
 * past observation. Migration 007 stores the other four author fields precisely
 * so the log is self-describing; this one is the residue, and the reason the
 * catalogue is a required parameter rather than an assumption.
 *
 * A row whose detector this build does not run is therefore not replayable: the
 * only way to supply the missing declaration would be to guess it, and a guessed
 * `dependsOnReports: false` is a fabricated claim that `createSignal` would
 * happily accept. It is skipped as `unknown_detector` instead.
 */

/**
 * Why a stored row could not become a `Signal`.
 *
 * A closed vocabulary, and each member is a different thing the replay does not
 * know. They are deliberately not merged: an operator reading "3 rows skipped"
 * needs to know whether the answer is "written before the columns existed"
 * (permanent, benign) or "this build cannot read them" (a code problem).
 */
export type ReplaySkipReason =
  /** A field is missing or the wrong type, so the row cannot be read at all. */
  | 'unreadable'
  /** `actor_id` is null: nothing recorded who performed the behaviour. */
  | 'no_actor'
  /** `reliability`/`category`/`escalation` is null: nobody ever declared one. */
  | 'no_author'
  /** No detector in this build's catalogue answers to that name. */
  | 'unknown_detector'
  /** The behaviour kind is not one this build declares. */
  | 'unknown_behaviour'
  /** `createSignal` refused the row. Its own wording is carried on the skip. */
  | 'refused';

/** One stored row the replay could not use, and the single reason why. */
export interface SkippedSignal {
  /**
   * The row's own id, so it can be found in `risk_signals`. Null only when the
   * row was too malformed to carry one.
   */
  readonly signalId: string | null;
  readonly detector: string | null;
  readonly occurredAt: Date | null;
  readonly reason: ReplaySkipReason;
  /** The domain's own words, for `refused`; null for every other reason. */
  readonly detail: string | null;
}

/** What a replay produced, and — the point of it — what it could not. */
export interface ReplayReport {
  /** The rebuilt ledger, oldest first and bounded by `SIGNAL_LEDGER_CAPACITY`. */
  readonly ledger: SignalLedger;
  /** How many rows became signals. `replayed + skipped.length` is the window read. */
  readonly replayed: number;
  readonly skipped: readonly SkippedSignal[];
  /**
   * `skipped` counted by reason. This is the number a deployment can watch: a
   * non-zero `no_author` is a pre-migration history, and a non-zero
   * `unknown_detector` means a detector was renamed or removed under a log that
   * still holds the evidence it produced.
   */
  readonly skippedByReason: Readonly<Record<ReplaySkipReason, number>>;
}

/**
 * The window a replay should read.
 *
 * The ledger is bounded by `SIGNAL_LEDGER_CAPACITY` in memory, so asking for
 * more rows than that buys nothing. Note precisely what the bound is measured
 * against: **rows read, not rows replayed.** A window containing skipped rows
 * yields a ledger shorter than the bound, which is exactly why the skip count is
 * reported instead of inferred from the ledger's length.
 */
export const REPLAY_WINDOW = SIGNAL_LEDGER_CAPACITY;

/**
 * How many skip reports one recorder retains.
 *
 * Bounded for the same reason `REFUSALS_RETAINED` is: a long-lived process
 * replaying many subjects must not grow without limit. Oldest are dropped.
 */
export const REPLAYS_RETAINED = 64;

/**
 * The `RiskStore` port hands back untyped records — it is the persistence
 * boundary, and `PgRiskStore` validates on the way out. The replay narrows every
 * field itself rather than casting the whole row, because the port's type makes
 * no promise about a record's contents.
 *
 * Exported as `StoredSignal` because a caller assembling rows for a replay — a
 * migration check, a test, a backfill — needs the same shape the reader expects,
 * and guessing the field names from the database columns is how a replay starts
 * inventing. Every field is nullable-or-unknown in practice; the *value* types
 * here are the store's, not a promise that any particular row has them.
 */
export type StoredSignal = Readonly<Record<string, unknown>>;

type StoredRow = StoredSignal;

type Narrow<T> = (value: unknown) => T | null;

const nonEmptyString: Narrow<string> = (value) =>
  typeof value === 'string' && value.length > 0 ? value : null;

const finiteNumber: Narrow<number> = (value) =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const validDate: Narrow<Date> = (value) =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;

/**
 * The `facts` column as the domain's closed vocabulary.
 *
 * The cast is safe *because* `createSignal` validates it on the next line and
 * refuses anything outside `SignalFacts`, so a fact key a future detector adds
 * cannot reach a ledger through this seam — it becomes a `refused` skip.
 */
const factObject: Narrow<SignalFacts> = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as SignalFacts)
    : null;

/**
 * A stored declaration field, narrowed against the vocabulary the type is
 * derived from. `null` in means `null` out, and so does a value the current
 * build does not recognise — which is what keeps a renamed reliability from
 * being cast into a union it no longer belongs to.
 */
function declared<T extends string>(
  value: string | null,
  vocabulary: readonly T[],
): T | null {
  return value !== null && vocabulary.includes(value as T) ? (value as T) : null;
}

/**
 * Rebuilds a ledger from stored rows, oldest first.
 *
 * `detectors` is the catalogue this process is actually running, and it is
 * required rather than defaulted because the log cannot supply
 * `dependsOnReports`: assuming `false` would let a detector whose only evidence
 * is a report be replayed as one that fires independently of reports, which is
 * the claim `safety.detected_before_first_report` is built on.
 *
 * The result is a ledger *and* a report. A caller that acts on the ledger
 * without reading `skipped` is acting on a history it does not have.
 */
export function replaySignals(
  rows: readonly StoredRow[],
  detectors: readonly SignalAuthor[],
): ReplayReport {
  const catalogue = new Map(detectors.map((detector) => [detector.detector, detector]));
  const skipped: SkippedSignal[] = [];
  const skippedByReason: Record<ReplaySkipReason, number> = {
    unreadable: 0,
    no_actor: 0,
    no_author: 0,
    unknown_detector: 0,
    unknown_behaviour: 0,
    refused: 0,
  };
  let ledger = EMPTY_LEDGER;
  let replayed = 0;

  for (const row of rows) {
    const signalId = nonEmptyString(row['signalId']);
    const detector = nonEmptyString(row['detector']);
    const occurredAt = validDate(row['occurredAt']);
    const identified = { signalId, detector, occurredAt };

    const actorId = nonEmptyString(row['actorId']);
    const reliability = declared(nonEmptyString(row['reliability']), RELIABILITIES);
    const category = declared(nonEmptyString(row['category']), SIGNAL_CATEGORIES);
    const escalation = declared(nonEmptyString(row['escalation']), ESCALATION_STATUSES);
    const weight = finiteNumber(row['weight']);
    const entityId = nonEmptyString(row['entityId']);
    const facts = factObject(row['facts']);
    const kind = nonEmptyString(row['behaviour']);
    const subjectId = nonEmptyString(row['subjectId']);

    const author = detector === null ? undefined : catalogue.get(detector);

    // Ordered so a row with several problems always reports the same reason,
    // and so the reason names the *first* thing wrong with it: structure, then
    // missing provenance, then code drift, then the domain's own verdict.
    //
    // Structure comes first deliberately. A row missing most of its fields is
    // reported `unreadable`, not `no_actor` — naming a specific missing column on
    // a row that cannot be read at all would send an operator to fix the wrong
    // thing, and the tallies would credit `no_author` for rows that simply are
    // not rows.
    const readable =
      weight !== null &&
      entityId !== null &&
      facts !== null &&
      occurredAt !== null &&
      detector !== null &&
      subjectId !== null &&
      kind !== null;
    const reason: ReplaySkipReason | null = !readable
      ? 'unreadable'
      : // A self-attributed kind would make `actorId` equal `subjectId`, but
        // `report_against` requires them to differ — so a row that does not say
        // who reported cannot become one that says the subject reported
        // themselves. Filling it in is the fabrication migration 007 refused.
        actorId === null
        ? 'no_actor'
        : // Likewise a null declaration: the log says nobody ever claimed a
          // reliability for this row, and deriving one from the detector name
          // would invent the claim in an evidence table.
          reliability === null || category === null || escalation === null
          ? 'no_author'
          : author === undefined
            ? 'unknown_detector'
            : !BEHAVIOUR_KINDS.includes(kind as BehaviourKind)
              ? 'unknown_behaviour'
              : null;

    if (reason !== null) {
      skipped.push({ ...identified, reason, detail: null });
      skippedByReason[reason] += 1;
      continue;
    }

    // Every narrowing above held, which is what makes these casts honest rather
    // than a way of silencing the compiler.
    const behaviour: BehaviourKey = {
      kind: kind as BehaviourKind,
      entityId: entityId as string,
    };
    const built = createSignal(
      {
        subjectId: subjectId as SubjectId,
        actorId: actorId as SubjectId,
        behaviour,
        occurredAt: occurredAt as Date,
        weight: weight as number,
        facts: facts as SignalFacts,
      },
      {
        detector: detector as string,
        reliability: reliability as DetectorReliability,
        category: category as SignalCategory,
        escalation: escalation as EscalationStatus,
        dependsOnReports: author?.dependsOnReports ?? false,
      },
    );

    if (!built.ok) {
      skipped.push({
        ...identified,
        reason: 'refused',
        detail: `${built.error.code} ${built.error.message}`,
      });
      skippedByReason.refused += 1;
      continue;
    }

    ledger = appendSignal(ledger, built.value);
    replayed += 1;
  }

  return { ledger, replayed, skipped, skippedByReason };
}