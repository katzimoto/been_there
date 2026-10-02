import {
  type DomainError,
  type ProfileId,
  type Result,
  type UserId,
  domainError,
  ok,
} from '@been-there/core';
import type { IdempotencyKey } from './ids.js';

/**
 * The personal dating goal and the completed-date counter (issues #48, #49).
 *
 * Four decisions are load-bearing here, and each of them exists because the
 * obvious implementation gets it wrong:
 *
 *  1. **The goal and the count are two aggregates, not one record.**
 *     `setDatingGoal` takes a `DatingGoal` and returns a `DatingGoal`; the
 *     ledger is not a parameter, so "changing the goal preserves the count" is
 *     not a rule somebody has to remember, it is a function that cannot reach
 *     the count. Only the store that persists both could get it wrong.
 *
 *  2. **Corrections are events, not edits.** A withdrawal is an appended
 *     correction, so the aggregate can always answer "why did this drop from
 *     13 to 12?" An editable counter row cannot: after a bug writes 0, a row
 *     holding 0 and a user who genuinely has 0 are the same fact. Retaining
 *     corrections is the rule the like ledger already follows — a retraction is
 *     a state change on a retained row, never a deletion (§3.2 of
 *     `docs/architecture/dating-core.md`) — and it is what makes a correction
 *     *possible* rather than merely *allowed*.
 *
 *  3. **The counter is derived, never stored.** `completedDateCount` counts
 *     entries, so "cannot go below zero" is structural: there is no number in
 *     this module that a decrement could push below zero.
 *
 *  4. **Recording a date requires nothing of the other person.**
 *     `recordCompletedDate` takes no standing, no block list, no match and no
 *     verification state, and its `counterpartId` is nullable for a date with
 *     someone met outside the product. A mandatory-review requirement cannot be
 *     reintroduced without changing this signature, which is the point.
 *
 * **Reaching the goal is not a gate.** `goalProgress` returns integers and a
 * boolean for the owner's own view; nothing in discovery, matching or messaging
 * consumes it. There is deliberately no ratio or percentage field here: the "no
 * score is implied" rule in
 * `docs/features/profile-and-personalization.md` §4.2 is written about
 * compatibility, but the domain should not be the place that decides whether a
 * future client will one day draw a ring around a number, and the cheapest way
 * to refuse is never to publish a value that fits in a ring.
 */

/** The target a profile carries until its owner names another one. */
export const DATING_GOAL_DEFAULT = 1_000;

export const DATING_GOAL_LIMITS = {
  min: 1,
  /**
   * Issue #48 names no upper bound. One is set here anyway, because a target
   * past this is not a number any progress view can render, and accepting it
   * would store a claim the product cannot show back to the person who made it.
   * Deliberately far above the default, so this is not a goal anyone hits by
   * accident.
   */
  max: 100_000,
} as const;

const GOAL_DOMAIN = 'dating.goal';
const COUNTER_DOMAIN = 'dating.completed_dates';

/**
 * A target, and nothing else. The absence of a count field is the design: this
 * type cannot be corrupted by an edit to a number that does not sit beside it.
 *
 * The goal is **per profile** — a setting the owner makes on a publication, so
 * a profile that is deleted and recreated starts again at the default.
 */
export interface DatingGoal {
  readonly profileId: ProfileId;
  readonly ownerId: UserId;
  readonly target: number;
  readonly updatedAt: Date;
}

/** The goal a profile carries before its owner names another one. */
export function defaultDatingGoal(profileId: ProfileId, ownerId: UserId, at: Date): DatingGoal {
  return { profileId, ownerId, target: DATING_GOAL_DEFAULT, updatedAt: at };
}

/**
 * A whole number of dates, at least one.
 *
 * Zero is refused rather than treated as "no goal": the default already exists
 * for a user who has not chosen, and a stored 0 would then be indistinguishable
 * from a user who deliberately chose to aim at nothing.
 */
export function validateDatingGoalTarget(target: number): Result<number, DomainError> {
  if (!Number.isInteger(target)) {
    return domainError(
      'validation_failed',
      GOAL_DOMAIN,
      'a dating goal is a whole number of dates',
      { field: 'target', target, reason: 'not_a_whole_number' },
    );
  }
  if (target < DATING_GOAL_LIMITS.min) {
    return domainError(
      'validation_failed',
      GOAL_DOMAIN,
      `a dating goal is at least ${DATING_GOAL_LIMITS.min} date`,
      { field: 'target', target, reason: 'below_minimum' },
    );
  }
  if (target > DATING_GOAL_LIMITS.max) {
    return domainError(
      'validation_failed',
      GOAL_DOMAIN,
      `a dating goal is at most ${DATING_GOAL_LIMITS.max} dates`,
      { field: 'target', target, reason: 'above_maximum' },
    );
  }
  return ok(target);
}

/**
 * Changes the target. Note what is absent: the completed-date ledger is neither
 * a parameter nor a return value, so an implementation that stored the two
 * together could not express this call. The count survives because it was never
 * in reach.
 */
export function setDatingGoal(goal: DatingGoal, target: number, at: Date): Result<DatingGoal, DomainError> {
  const validated = validateDatingGoalTarget(target);
  if (!validated.ok) {
    return validated;
  }
  return ok({ ...goal, target: validated.value, updatedAt: at });
}

/**
 * A correction, appended rather than applied. `withdrawn` says the date did not
 * happen and the entry stops counting; `restated` says it happened on a
 * different day and keeps counting against that day.
 *
 * Both exist because "I typed the wrong day" and "I never went on that date"
 * are different corrections, and only one of them should cost the user a date.
 */
export type DateCorrection =
  | {
      readonly kind: 'withdrawn';
      readonly key: IdempotencyKey;
      readonly at: Date;
    }
  | {
      readonly kind: 'restated';
      readonly key: IdempotencyKey;
      readonly at: Date;
      /** ISO `YYYY-MM-DD`; the day the date actually happened. */
      readonly occurredOn: string;
    };

/**
 * One recorded date.
 *
 * `occurredOn` is the *effective* day: a restatement writes the corrected day
 * here, and the correction that caused it is retained alongside, so what the
 * owner was told at the time is still recoverable.
 */
export interface CompletedDateRecord {
  /** The owner's request key. Re-recording it is a retry, not a second date. */
  readonly entryId: IdempotencyKey;
  /** `null` for a date with someone met outside the product. */
  readonly counterpartId: UserId | null;
  /** ISO `YYYY-MM-DD`. */
  readonly occurredOn: string;
  readonly recordedAt: Date;
  readonly corrections: readonly DateCorrection[];
}

/**
 * The completed-date history, keyed by **user** rather than by profile.
 *
 * The counter answers "how many dates has this person been on", which is a fact
 * about a life and not about a publication. A `ProfileId` names a card whose
 * lifecycle ends in `deleted`; deleting a profile and creating another is an
 * ordinary act of privacy, and it must not take the history behind it with it.
 * The goal is per profile because a target is a setting on the card; the count
 * is per user because a date is not.
 *
 * Deleting a profile therefore leaves the ledger untouched and the new profile
 * starts from `DATING_GOAL_DEFAULT` — the count survives, the target is theirs
 * to set again.
 */
export interface CompletedDateLedger {
  readonly ownerId: UserId;
  readonly records: readonly CompletedDateRecord[];
}

export function emptyCompletedDateLedger(ownerId: UserId): CompletedDateLedger {
  return { ownerId, records: [] };
}

/** What the owner supplies when recording a date. */
export interface NewCompletedDate {
  readonly entryId: IdempotencyKey;
  readonly counterpartId: UserId | null;
  /** ISO `YYYY-MM-DD`. */
  readonly occurredOn: string;
  readonly recordedAt: Date;
}

/** UTC midnight for an instant, so two `Date`s on one day compare equal as days. */
function utcDay(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

/**
 * A date that happened is a real calendar day, and it has happened by the time
 * it is recorded. `2026-02-31` is refused rather than stored, because a
 * counter whose entries cannot be placed on a calendar cannot be reviewed by the
 * one person entitled to review it.
 */
function validateOccurredOn(
  occurredOn: string,
  recordedAt: Date,
): Result<string, DomainError> {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(occurredOn);
  if (match === null) {
    return domainError(
      'validation_failed',
      COUNTER_DOMAIN,
      'a completed date is a real day, written as YYYY-MM-DD',
      { field: 'occurredOn', occurredOn, reason: 'not_a_calendar_day' },
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const asDate = new Date(Date.UTC(year, month - 1, day));
  if (
    asDate.getUTCFullYear() !== year ||
    asDate.getUTCMonth() !== month - 1 ||
    asDate.getUTCDate() !== day
  ) {
    return domainError(
      'validation_failed',
      COUNTER_DOMAIN,
      'a completed date is a real day, written as YYYY-MM-DD',
      { field: 'occurredOn', occurredOn, reason: 'not_a_calendar_day' },
    );
  }
  if (asDate.getTime() > utcDay(recordedAt)) {
    return domainError(
      'validation_failed',
      COUNTER_DOMAIN,
      'a completed date cannot be in the future',
      { field: 'occurredOn', occurredOn, reason: 'in_the_future' },
    );
  }
  return ok(occurredOn);
}

/**
 * Whether a record still counts toward the total. Derived, never stored, so it
 * cannot drift away from the corrections that decided it.
 */
export function isCounted(record: CompletedDateRecord): boolean {
  return !record.corrections.some((correction) => correction.kind === 'withdrawn');
}

/**
 * The completed count.
 *
 * A count of entries, so it cannot be negative and no sequence of corrections
 * can make it so: withdrawing the last remaining entry yields 0, and
 * withdrawing it again yields 0.
 */
export function completedDateCount(ledger: CompletedDateLedger): number {
  return ledger.records.filter(isCounted).length;
}

/**
 * Records one date the owner says they went on.
 *
 * A retry carrying the same `entryId` replays the first attempt with the ledger
 * unchanged, so a double-tap, a retry after a timeout, and two workers racing
 * on the same key all leave the count where one of them put it.
 *
 * Nothing is required of the counterpart: no standing, no block, no match, no
 * verification, no existence. Those are not checked because they are not
 * available here, and a date with someone met offline is a real date too.
 */
export function recordCompletedDate(
  ledger: CompletedDateLedger,
  entry: NewCompletedDate,
): Result<CompletedDateLedger, DomainError> {
  if (entry.counterpartId === ledger.ownerId) {
    return domainError(
      'validation_failed',
      COUNTER_DOMAIN,
      'a completed date needs someone other than you',
      { field: 'counterpartId', reason: 'self_recorded' },
    );
  }
  const alreadyRecorded = ledger.records.some((record) => record.entryId === entry.entryId);
  if (alreadyRecorded) {
    return ok(ledger);
  }
  const validDay = validateOccurredOn(entry.occurredOn, entry.recordedAt);
  if (!validDay.ok) {
    return validDay;
  }
  const record: CompletedDateRecord = {
    entryId: entry.entryId,
    counterpartId: entry.counterpartId,
    occurredOn: entry.occurredOn,
    recordedAt: entry.recordedAt,
    corrections: [],
  };
  return ok({ ...ledger, records: [...ledger.records, record] });
}

/**
 * Appends a correction to a recorded date.
 *
 * A retried correction carrying the same `key` is a no-op. A second withdrawal
 * of an already-withdrawn entry is also a no-op rather than an error, because
 * that is what a retry looks like. A restatement of a withdrawn entry is a
 * conflict: corrections accumulate and never resurrect, so a withdrawn date
 * stays withdrawn however many times its day is redacted.
 */
export function correctCompletedDate(
  ledger: CompletedDateLedger,
  entryId: IdempotencyKey,
  correction: DateCorrection,
): Result<CompletedDateLedger, DomainError> {
  const record = ledger.records.find((candidate) => candidate.entryId === entryId);
  if (record === undefined) {
    return domainError('not_found', COUNTER_DOMAIN, 'no recorded date with that id', { entryId });
  }
  const alreadyApplied = record.corrections.some((applied) => applied.key === correction.key);
  if (alreadyApplied) {
    return ok(ledger);
  }
  const alreadyWithdrawn = !isCounted(record);
  if (alreadyWithdrawn) {
    return correction.kind === 'restated'
      ? domainError(
          'conflict',
          COUNTER_DOMAIN,
          'this date has been withdrawn; a withdrawn date cannot be restated',
          { entryId, reason: 'already_withdrawn' },
        )
      : ok(ledger);
  }
  if (correction.kind === 'restated') {
    const validDay = validateOccurredOn(correction.occurredOn, correction.at);
    if (!validDay.ok) {
      return validDay;
    }
    const restated: CompletedDateRecord = {
      ...record,
      occurredOn: correction.occurredOn,
      corrections: [...record.corrections, correction],
    };
    return ok({
      ...ledger,
      records: ledger.records.map((candidate) =>
        candidate.entryId === entryId ? restated : candidate,
      ),
    });
  }
  const withdrawn: CompletedDateRecord = { ...record, corrections: [...record.corrections, correction] };
  return ok({
    ...ledger,
    records: ledger.records.map((candidate) =>
      candidate.entryId === entryId ? withdrawn : candidate,
    ),
  });
}

/**
 * What the owner sees against their goal: integers and a boolean, recomputed
 * from the ledger on every call. A value here cannot be stale with respect to
 * either aggregate, which is what "the count survives a goal change" means once
 * persistence has reloaded both.
 */
export interface GoalProgress {
  readonly completed: number;
  readonly target: number;
  readonly goalReached: boolean;
  /** How many dates past the target the owner has been, if any. */
  readonly beyondGoal: number;
}

export function goalProgress(ledger: CompletedDateLedger, goal: DatingGoal): GoalProgress {
  const completed = completedDateCount(ledger);
  return {
    completed,
    target: goal.target,
    goalReached: completed >= goal.target,
    beyondGoal: Math.max(0, completed - goal.target),
  };
}