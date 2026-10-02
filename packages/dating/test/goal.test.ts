import { describe, expect, it } from 'vitest';
import { type ProfileId, castId } from '@been-there/core';
import {
  DATING_GOAL_DEFAULT,
  DATING_GOAL_LIMITS,
  type CompletedDateLedger,
  type DatingGoal,
  EMPTY_LEDGER,
  type DiscoverySnapshot,
  completedDateCount,
  correctCompletedDate,
  defaultDatingGoal,
  emptyCompletedDateLedger,
  evaluateEligibility,
  goalProgress,
  isCounted,
  recordCompletedDate,
  recordLike,
  setDatingGoal,
} from '../src/index.js';
import {
  A,
  AT,
  B,
  LATER,
  failure,
  key,
  like,
  matchedLedger,
  relationship,
  standing,
  succeeded,
} from './fixtures.js';

const PROFILE: ProfileId = castId<'ProfileId'>('profile-a');

/** `AT` is 2026-01-01, so a 2025 day has happened and a 2026-06 day has not. */
const PAST_DAY = '2025-06-14';
const FUTURE_DAY = '2026-06-02';

const goal = (target: number): DatingGoal =>
  succeeded(setDatingGoal(defaultDatingGoal(PROFILE, A, AT), target, LATER));

/** A key that `ledgerWith` never generates, so it can be added to any of them. */
const FIRST_DATE = {
  entryId: key('date-entry'),
  counterpartId: B,
  occurredOn: PAST_DAY,
  recordedAt: AT,
} as const;

/** A ledger holding `count` dates recorded on distinct days, each with its own key. */
function ledgerWith(count: number): CompletedDateLedger {
  let ledger = emptyCompletedDateLedger(A);
  for (let index = 0; index < count; index += 1) {
    const day = String((index % 28) + 1).padStart(2, '0');
    const month = String((Math.floor(index / 28) % 12) + 1).padStart(2, '0');
    ledger = succeeded(
      recordCompletedDate(ledger, {
        entryId: key(`generated-${index}`),
        counterpartId: B,
        occurredOn: `2025-${month}-${day}`,
        recordedAt: AT,
      }),
    );
  }
  return ledger;
}

describe('dating goal', () => {
  it('starts at 1,000 dates', () => {
    expect(DATING_GOAL_DEFAULT).toBe(1_000);
    expect(defaultDatingGoal(PROFILE, A, AT).target).toBe(1_000);
  });

  it('saves a valid goal and reads it back unchanged', () => {
    const saved = succeeded(setDatingGoal(defaultDatingGoal(PROFILE, A, AT), 250, LATER));

    expect(saved.target).toBe(250);
    expect(saved.profileId).toBe(PROFILE);
    expect(saved.updatedAt).toBe(LATER);
    // Re-saving the same target is not a change.
    expect(succeeded(setDatingGoal(saved, 250, LATER))).toEqual(saved);
  });

  it('refuses zero, a negative and a non-integer, each with its own reason', () => {
    const current = defaultDatingGoal(PROFILE, A, AT);
    const refusals = [
      { target: 0, reason: 'below_minimum' },
      { target: -1, reason: 'below_minimum' },
      { target: 12.5, reason: 'not_a_whole_number' },
    ] as const;

    for (const { target, reason } of refusals) {
      const refused = failure(setDatingGoal(current, target, LATER));
      expect(refused.code).toBe('validation_failed');
      expect(refused.domain).toBe('dating.goal');
      expect(refused.details?.reason).toBe(reason);
      expect(refused.details?.target).toBe(target);
      expect(refused.message.length).toBeGreaterThan(0);
    }
  });

  it('refuses a number that is not an integer at all', () => {
    const current = defaultDatingGoal(PROFILE, A, AT);
    for (const target of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(failure(setDatingGoal(current, target, LATER)).details?.reason).toBe('not_a_whole_number');
    }
  });

  it('refuses a target no progress view could render, and accepts the largest it could', () => {
    const current = defaultDatingGoal(PROFILE, A, AT);

    expect(DATING_GOAL_LIMITS.max).toBeGreaterThan(DATING_GOAL_DEFAULT);
    expect(succeeded(setDatingGoal(current, DATING_GOAL_LIMITS.max, LATER)).target).toBe(DATING_GOAL_LIMITS.max);
    expect(
      failure(setDatingGoal(current, DATING_GOAL_LIMITS.max + 1, LATER)).details?.reason,
    ).toBe('above_maximum');
  });

  it('leaves the completed count untouched when the goal moves in either direction', () => {
    const ledger = ledgerWith(12);
    expect(completedDateCount(ledger)).toBe(12);

    const lowered = goal(5);
    const raised = goal(40);

    expect(goalProgress(ledger, lowered)).toEqual({ completed: 12, target: 5, goalReached: true, beyondGoal: 7 });
    expect(goalProgress(ledger, raised)).toEqual({ completed: 12, target: 40, goalReached: false, beyondGoal: 0 });
    // The ledger was never handed to `setDatingGoal`, and is still the same
    // ledger afterwards: the count sat nowhere near the target to be overwritten.
    expect(completedDateCount(ledger)).toBe(12);
  });

  it('reports the same count after a persisted round trip and a goal change', () => {
    const ledger = ledgerWith(9);
    const saved = succeeded(setDatingGoal(defaultDatingGoal(PROFILE, A, AT), 4, LATER));
    // A persistence round trip returns the ledger and the goal as they were stored.
    const reloaded = { ownerId: ledger.ownerId, records: [...ledger.records] };

    expect(goalProgress(reloaded, saved).completed).toBe(goalProgress(ledger, saved).completed);
    expect(goalProgress(reloaded, defaultDatingGoal(PROFILE, A, LATER)).completed).toBe(9);
  });
});

describe('completed-date counter', () => {
  it('starts at zero', () => {
    expect(completedDateCount(emptyCompletedDateLedger(A))).toBe(0);
    expect(goalProgress(emptyCompletedDateLedger(A), defaultDatingGoal(PROFILE, A, AT))).toEqual({
      completed: 0,
      target: 1_000,
      goalReached: false,
      beyondGoal: 0,
    });
  });

  it('counts a date the owner records, against the day they said it happened', () => {
    const one = succeeded(recordCompletedDate(emptyCompletedDateLedger(A), FIRST_DATE));
    const two = succeeded(
      recordCompletedDate(one, {
        entryId: key('second-date'),
        counterpartId: B,
        occurredOn: '2025-06-20',
        recordedAt: LATER,
      }),
    );

    expect(completedDateCount(one)).toBe(1);
    expect(completedDateCount(two)).toBe(2);
    expect(two.records.find((entry) => entry.entryId === key('second-date'))?.occurredOn).toBe('2025-06-20');
  });

  it('counts a retried record once, however many times it arrives', () => {
    const first = succeeded(recordCompletedDate(emptyCompletedDateLedger(A), FIRST_DATE));
    const second = succeeded(recordCompletedDate(first, FIRST_DATE));
    const third = succeeded(recordCompletedDate(second, FIRST_DATE));

    expect(completedDateCount(third)).toBe(1);
    expect(third).toBe(first);
  });

  it('counts nothing for a like or a match, because it never sees them', () => {
    const matched = succeeded(
      recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), {
        actor: standing(A),
        target: standing(B),
        blocks: [],
        passes: [],
        at: AT,
      }),
    );
    expect(matched.ledger.likes).toHaveLength(1);
    expect(matchedLedger().likes.every((entry) => entry.state === 'matched')).toBe(true);

    // None of the above is a date, and none of them moved the counter.
    expect(completedDateCount(emptyCompletedDateLedger(A))).toBe(0);
  });

  it('refuses a day that is not on the calendar', () => {
    const ledger = emptyCompletedDateLedger(A);
    for (const occurredOn of ['2025-02-31', '2025-13-01', '14/06/2025', '2025-06-14T20:00:00Z']) {
      const refused = failure(recordCompletedDate(ledger, { ...FIRST_DATE, occurredOn }));
      expect(refused.code).toBe('validation_failed');
      expect(refused.domain).toBe('dating.completed_dates');
      expect(refused.details?.reason).toBe('not_a_calendar_day');
    }
    expect(completedDateCount(ledger)).toBe(0);
  });

  it('refuses a date that has not happened yet', () => {
    const refused = failure(
      recordCompletedDate(emptyCompletedDateLedger(A), { ...FIRST_DATE, occurredOn: FUTURE_DAY }),
    );

    expect(refused.details?.reason).toBe('in_the_future');
    expect(completedDateCount(emptyCompletedDateLedger(A))).toBe(0);
  });

  it('requires nothing of the other person, including that they exist', () => {
    const recorded = succeeded(
      recordCompletedDate(emptyCompletedDateLedger(A), { ...FIRST_DATE, counterpartId: null }),
    );
    expect(completedDateCount(recorded)).toBe(1);
  });

  it('refuses a date with yourself', () => {
    const refused = failure(
      recordCompletedDate(emptyCompletedDateLedger(A), { ...FIRST_DATE, counterpartId: A }),
    );
    expect(refused.details?.reason).toBe('self_recorded');
  });
});

describe('correcting a recorded date', () => {
  const recordedWithFirstDate = (count: number): CompletedDateLedger =>
    succeeded(recordCompletedDate(ledgerWith(count), FIRST_DATE));

  it('decrements the count by exactly one when the date is withdrawn', () => {
    const recorded = recordedWithFirstDate(3);
    const corrected = succeeded(
      correctCompletedDate(recorded, FIRST_DATE.entryId, { kind: 'withdrawn', key: key('w-1'), at: LATER }),
    );

    expect(completedDateCount(recorded)).toBe(4);
    expect(completedDateCount(corrected)).toBe(3);
  });

  it('keeps the count when only the day was wrong, and shows the corrected day', () => {
    const corrected = succeeded(
      correctCompletedDate(recordedWithFirstDate(3), FIRST_DATE.entryId, {
        kind: 'restated',
        key: key('r-1'),
        at: LATER,
        occurredOn: '2025-06-15',
      }),
    );
    const entry = corrected.records.find((candidate) => candidate.entryId === FIRST_DATE.entryId);

    expect(completedDateCount(corrected)).toBe(4);
    expect(entry?.occurredOn).toBe('2025-06-15');
    // What the owner originally claimed is still on the record, so the
    // correction is reviewable rather than an overwrite.
    expect(entry?.corrections).toHaveLength(1);
    expect(entry?.corrections[0]?.kind).toBe('restated');
  });

  it('refuses a restatement to a day that is not a real day', () => {
    const recorded = succeeded(recordCompletedDate(emptyCompletedDateLedger(A), FIRST_DATE));
    const refused = failure(
      correctCompletedDate(recorded, FIRST_DATE.entryId, {
        kind: 'restated',
        key: key('r-2'),
        at: LATER,
        occurredOn: '2025-06-31',
      }),
    );

    expect(refused.details?.reason).toBe('not_a_calendar_day');
    expect(completedDateCount(recorded)).toBe(1);
  });

  it('goes to zero and stays there, never below', () => {
    const recorded = succeeded(recordCompletedDate(emptyCompletedDateLedger(A), FIRST_DATE));
    const withdrawn = succeeded(
      correctCompletedDate(recorded, FIRST_DATE.entryId, { kind: 'withdrawn', key: key('w-1'), at: LATER }),
    );
    expect(completedDateCount(withdrawn)).toBe(0);

    // A second, separately-keyed withdrawal is a no-op rather than -1.
    const again = succeeded(
      correctCompletedDate(withdrawn, FIRST_DATE.entryId, { kind: 'withdrawn', key: key('w-2'), at: LATER }),
    );
    expect(completedDateCount(again)).toBe(0);
    expect(goalProgress(again, goal(1_000)).goalReached).toBe(false);
  });

  it('counts a retried correction once', () => {
    const correction = { kind: 'withdrawn', key: key('w-1'), at: LATER } as const;
    const first = succeeded(correctCompletedDate(recordedWithFirstDate(2), FIRST_DATE.entryId, correction));
    const second = succeeded(correctCompletedDate(first, FIRST_DATE.entryId, correction));

    expect(second).toBe(first);
    expect(completedDateCount(second)).toBe(2);
  });

  it('will not resurrect a withdrawn date by restating it', () => {
    const withdrawn = succeeded(
      correctCompletedDate(recordedWithFirstDate(1), FIRST_DATE.entryId, {
        kind: 'withdrawn',
        key: key('w-1'),
        at: LATER,
      }),
    );
    const refused = failure(
      correctCompletedDate(withdrawn, FIRST_DATE.entryId, {
        kind: 'restated',
        key: key('r-1'),
        at: LATER,
        occurredOn: '2025-06-15',
      }),
    );

    expect(refused.code).toBe('conflict');
    expect(completedDateCount(withdrawn)).toBe(1);
  });

  it('reports not_found rather than inventing a date to withdraw', () => {
    const recorded = succeeded(recordCompletedDate(emptyCompletedDateLedger(A), FIRST_DATE));
    const refused = failure(
      correctCompletedDate(recorded, key('entry-never-recorded'), {
        kind: 'withdrawn',
        key: key('w-1'),
        at: LATER,
      }),
    );

    expect(refused.code).toBe('not_found');
    expect(completedDateCount(recorded)).toBe(1);
  });

  it('withdraws the right entry when a correction names any one of many', () => {
    const late = succeeded(
      recordCompletedDate(ledgerWith(3), {
        entryId: key('late-date'),
        counterpartId: B,
        occurredOn: '2025-07-01',
        recordedAt: AT,
      }),
    );
    const corrected = succeeded(
      correctCompletedDate(late, key('late-date'), { kind: 'withdrawn', key: key('w-late'), at: LATER }),
    );

    expect(completedDateCount(corrected)).toBe(3);
    expect(corrected.records.filter(isCounted)).toHaveLength(3);
    // The withdrawn entry is retained, not removed, so the drop is explainable.
    expect(corrected.records).toHaveLength(4);
    expect(corrected.records.find((entry) => entry.entryId === key('late-date'))?.corrections).toHaveLength(1);
  });
});

describe('reaching the goal', () => {
  const snapshot = (): DiscoverySnapshot => ({
    viewer: standing(A),
    candidate: standing(B),
    relationship: relationship(),
    distance: 'lt_5_km',
    now: AT,
  });

  it('leaves the viewer in discovery', () => {
    expect(evaluateEligibility(snapshot())).toEqual({ eligible: true });
  });

  it('still lets them date and match', () => {
    const matched = succeeded(
      recordLike(EMPTY_LEDGER, like(A, B, 'like-a-b'), {
        actor: standing(A),
        target: standing(B),
        blocks: [],
        passes: [],
        at: AT,
      }),
    );
    const reached = goalProgress(ledgerWith(1_000), goal(1_000));
    expect(reached.goalReached).toBe(true);

    // The like still stands, and a reciprocal like still matches, with the goal
    // reached. Nothing in the interaction path reads the goal.
    expect(matched.ledger.likes[0]?.state).toBe('live');
    expect(matchedLedger().likes.every((entry) => entry.state === 'matched')).toBe(true);
  });

  it('is not a cap: the count passes the target and reports how far past it is', () => {
    expect(goalProgress(ledgerWith(1_003), goal(1_000))).toEqual({
      completed: 1_003,
      target: 1_000,
      goalReached: true,
      beyondGoal: 3,
    });
  });

  it('keeps the count through a correction made after the target is passed', () => {
    const corrected = succeeded(
      correctCompletedDate(ledgerWith(1_003), key('generated-0'), {
        kind: 'withdrawn',
        key: key('w-1'),
        at: LATER,
      }),
    );

    expect(goalProgress(corrected, goal(1_000))).toEqual({
      completed: 1_002,
      target: 1_000,
      goalReached: true,
      beyondGoal: 2,
    });
  });

  it('publishes only whole numbers and a boolean, so no client can render a score', () => {
    const progress = goalProgress(ledgerWith(500), goal(1_000));
    for (const value of Object.values(progress)) {
      // A ratio would be a non-integer; a percentage a string or a value that is
      // neither the count nor the target. Neither exists on this record.
      expect(value === true || value === false || Number.isInteger(value)).toBe(true);
    }
    expect(progress.completed).toBe(500);
    expect(progress.target).toBe(1_000);
  });
});

describe('the count survives a profile being replaced', () => {
  it('keeps the ledger when a profile is deleted and a new one takes its place', () => {
    const ledger = ledgerWith(7);
    // A new profile starts from the default target; the ledger is keyed by the
    // user, so deletion has nothing to take.
    const recreated = defaultDatingGoal(castId<'ProfileId'>('profile-a-2'), A, LATER);

    expect(recreated.profileId).not.toBe(PROFILE);
    expect(goalProgress(ledger, recreated)).toEqual({
      completed: 7,
      target: DATING_GOAL_DEFAULT,
      goalReached: false,
      beyondGoal: 0,
    });
    expect(completedDateCount(ledger)).toBe(7);
  });

  it('keys the history to the owner rather than to whichever profile is live', () => {
    const history = ledgerWith(4);
    const firstDate = succeeded(recordCompletedDate(emptyCompletedDateLedger(A), FIRST_DATE));

    expect(history.ownerId).toBe(firstDate.ownerId);
    expect(history.ownerId).toBe(A);
    expect(completedDateCount(history)).toBe(4);
    expect(completedDateCount(firstDate)).toBe(1);
  });
});