import { describe, expect, it } from 'vitest';
import {
  type DomainError,
  type IdentityState,
  type Result,
  type VerificationId,
  assertMachineIsTotal,
  castId,
} from '@been-there/core';
import {
  ATTEMPT_POLICY,
  REVIEW_ESCALATION_POLICY,
  type VerificationAttempt,
  attemptMachine,
  beginCapture,
  completeFromProvider,
  escalateAfterRepeatedFailure,
  expireAttempt,
  planVerificationStart,
  recordCapture,
  resolveReview,
  submitToProvider,
} from '../src/index.js';
import {
  SUBJECT,
  T0,
  attemptInFlight,
  check,
  finding,
  hoursLater,
  daysLater as daysAgo,
  passingChecks,
  providerResult,
} from './support.js';

function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

function errorOf<T, E extends DomainError>(result: Result<T, E>): DomainError {
  if (result.ok) {
    throw new Error('expected a rejection');
  }
  return result.error;
}

/** Walks an attempt to `awaiting_provider` with every required check captured. */
function awaitingProvider(): VerificationAttempt {
  const started = succeeded(
    planVerificationStart({
      verificationId: castId<'VerificationId'>('vrf-1'),
      subjectId: SUBJECT,
      identityState: 'unverified',
      now: T0,
      reVerification: false,
      reason: { code: 'onboarding' },
      existing: [],
    }),
  );
  let attempt = succeeded(beginCapture(started.attempt, T0));
  attempt = succeeded(
    recordCapture(
      attempt,
      {
        check: 'document_authenticity',
        kind: 'government_id_image',
        storageRef: 'ref:id',
        digest: 'd1',
      },
      hoursLater(0.1),
    ),
  );
  attempt = succeeded(
    recordCapture(
      attempt,
      { check: 'liveness', kind: 'liveness_video', storageRef: 'ref:liveness', digest: 'd2' },
      hoursLater(0.2),
    ),
  );
  attempt = succeeded(
    recordCapture(
      attempt,
      { check: 'likeness', kind: 'selfie_image', storageRef: 'ref:selfie', digest: 'd3' },
      hoursLater(0.3),
    ),
  );
  return succeeded(submitToProvider(attempt, hoursLater(0.4)));
}

describe('attempt machine totality', () => {
  it('has no way out of a terminal state and no way into a dead end', () => {
    expect(() =>
      assertMachineIsTotal(attemptMachine, ['passed', 'failed', 'expired']),
    ).not.toThrow();
    // A manual review is not terminal: the reviewer has to be able to finish.
    expect(attemptMachine.legalEvents('manual_review')).toContain('review_cleared');
    expect(attemptMachine.legalEvents('passed')).toEqual([]);
  });
});

describe('starting an attempt', () => {
  const base = {
    verificationId: castId<'VerificationId'>('vrf-1'),
    subjectId: SUBJECT,
    now: T0,
    reVerification: false,
    reason: { code: 'onboarding' } as const,
  };

  it('resolves the identity move through the shared kernel', () => {
    const started = succeeded(
      planVerificationStart({ ...base, identityState: 'unverified', existing: [] }),
    );
    expect(started.identity).toEqual({ viaEvent: 'submit_verification', state: 'pending' });
    expect(started.attempt.state).toBe('initiated');
    expect(started.attempt.expiresAt.getTime() - T0.getTime()).toBe(
      ATTEMPT_POLICY.ttlHours * 60 * 60 * 1000,
    );
  });

  it('refuses a second attempt while one is in flight, even in manual review', () => {
    for (const state of ['initiated', 'capturing', 'awaiting_provider', 'manual_review'] as const) {
      const error = errorOf(
        planVerificationStart({
          ...base,
          identityState: 'unverified',
          existing: [attemptInFlight({ state })],
        }),
      );
      expect(error.code).toBe('conflict');
    }
  });

  it('allows a fresh attempt once the previous one reached a resting state', () => {
    for (const state of ['passed', 'failed', 'expired'] as const) {
      expect(
        planVerificationStart({
          ...base,
          identityState: 'verification_failed',
          existing: [attemptInFlight({ state })],
        }).ok,
      ).toBe(true);
    }
  });

  it('rate-limits a subject hammering the verification flow', () => {
    const existing = Array.from({ length: ATTEMPT_POLICY.maxAttemptsPerDay }, (_, index) =>
      attemptInFlight({
        state: 'failed',
        verificationId: castId<'VerificationId'>(`vrf-${index}`),
        startedAt: hoursLater(-index - 1),
      }),
    );
    const error = errorOf(
      planVerificationStart({ ...base, identityState: 'verification_failed', existing }),
    );
    expect(error.code).toBe('rate_limited');
  });

  it('does not count attempts from more than a day ago', () => {
    const existing = Array.from({ length: ATTEMPT_POLICY.maxAttemptsPerDay }, (_, index) =>
      attemptInFlight({
        state: 'failed',
        verificationId: castId<'VerificationId'>(`vrf-old-${index}`),
        startedAt: hoursLater(-25 - index),
      }),
    );
    expect(
      planVerificationStart({ ...base, identityState: 'verification_failed', existing }).ok,
    ).toBe(true);
  });

  it('defers to the identity machine when the subject may not be verifying', () => {
    const error = errorOf(
      planVerificationStart({ ...base, identityState: 'verified', existing: [] }),
    );
    expect(error.code).toBe('invalid_transition');
  });
});

describe('capturing evidence', () => {
  it('supersedes an earlier capture of the same kind instead of accumulating', () => {
    const attempt = succeeded(beginCapture(awaitingProviderInit(), T0));
    const first = succeeded(
      recordCapture(
        attempt,
        { check: 'likeness', kind: 'selfie_image', storageRef: 'ref:selfie-1', digest: 'd1' },
        T0,
      ),
    );
    expect(first.evidence).toHaveLength(1);
    const second = succeeded(
      recordCapture(
        first,
        { check: 'likeness', kind: 'selfie_image', storageRef: 'ref:selfie-2', digest: 'd2' },
        hoursLater(ATTEMPT_POLICY.retakeCooldownMinutes / 60 + 0.1),
      ),
    );
    expect(second.evidence).toHaveLength(1);
    expect(second.evidence[0]?.storageRef).toBe('ref:selfie-2');
    expect(second.evidence[0]?.digest).toBe('d2');
    expect(second.completedChecks).toEqual(['likeness']);
    expect(second.state).toBe('capturing');
  });

  it('rate-limits a retake inside the cooldown', () => {
    const first = succeeded(
      recordCapture(
        succeeded(beginCapture(awaitingProviderInit(), T0)),
        { check: 'likeness', kind: 'selfie_image', storageRef: 'ref:selfie-1', digest: 'd1' },
        T0,
      ),
    );
    const tooSoon = errorOf(
      recordCapture(
        first,
        { check: 'likeness', kind: 'selfie_image', storageRef: 'ref:selfie-2', digest: 'd2' },
        hoursLater(ATTEMPT_POLICY.retakeCooldownMinutes / 60 - 0.01),
      ),
    );
    expect(tooSoon.code).toBe('rate_limited');
    // A refused retake leaves the stored artefact untouched.
    expect(first.evidence[0]?.storageRef).toBe('ref:selfie-1');
  });

  it('allows a different artefact kind inside the cooldown', () => {
    const first = succeeded(
      recordCapture(
        succeeded(beginCapture(awaitingProviderInit(), T0)),
        { check: 'likeness', kind: 'selfie_image', storageRef: 'ref:selfie-1', digest: 'd1' },
        T0,
      ),
    );
    const second = succeeded(
      recordCapture(
        first,
        { check: 'liveness', kind: 'liveness_video', storageRef: 'ref:liveness-1', digest: 'd2' },
        hoursLater(0.05),
      ),
    );
    expect(second.evidence.map((item) => item.kind).sort()).toEqual([
      'liveness_video',
      'selfie_image',
    ]);
  });

  it('stores evidence as restricted with a retention deadline and no bytes', () => {
    const attempt = awaitingProvider();
    expect(attempt.evidence.map((item) => item.kind).sort()).toEqual([
      'government_id_image',
      'liveness_video',
      'selfie_image',
    ]);
    for (const item of attempt.evidence) {
      expect(item.sensitivity).toBe('restricted');
      expect(item.expiresAt.getTime()).toBeGreaterThan(item.capturedAt.getTime());
      expect(Object.keys(item).sort()).toEqual([
        'capturedAt',
        'digest',
        'expiresAt',
        'kind',
        'sensitivity',
        'storageRef',
        'verificationId',
      ]);
    }
  });

  it('never calls a provider with a half-captured verification', () => {
    const partial = succeeded(
      recordCapture(
        succeeded(beginCapture(awaitingProviderInit(), T0)),
        {
          check: 'document_authenticity',
          kind: 'government_id_image',
          storageRef: 'ref:id',
          digest: 'd',
        },
        hoursLater(0.1),
      ),
    );
    const error = errorOf(submitToProvider(partial, hoursLater(0.2)));
    expect(error.code).toBe('validation_failed');
  });
});

describe('completing from the provider', () => {
  it('passes an attempt and grants verified when the policy is clean', () => {
    const completed = succeeded(
      completeFromProvider(awaitingProvider(), 'pending', providerResult(), [], hoursLater(1)),
    );
    expect(completed.attempt.state).toBe('passed');
    expect(completed.decision.decision).toBe('pass');
    expect(completed.identity).toEqual({ viaEvent: 'provider_result_received', state: 'verified' });
    expect(completed.attempt.decision?.confidence.value).toBe(0.95);
  });

  it('takes a borderline user out of discovery pending a human', () => {
    const completed = succeeded(
      completeFromProvider(
        awaitingProvider(),
        'pending',
        providerResult({ confidence: 0.7 }),
        [],
        hoursLater(1),
      ),
    );
    expect(completed.attempt.state).toBe('manual_review');
    expect(completed.identity).toEqual({ viaEvent: 'flag_for_review', state: 'review_required' });
  });

  it('never fails a user on a blocking anomaly', () => {
    const result = providerResult({
      confidence: 0.1,
      checks: passingChecks().map((c) =>
        c.check === 'likeness' ? check('likeness', 'failed', 0.05) : c,
      ),
    });
    const completed = succeeded(
      completeFromProvider(
        awaitingProvider(),
        'pending',
        result,
        [finding('impossible_travel_between_attempts', 'blocking')],
        hoursLater(1),
      ),
    );
    expect(completed.attempt.state).toBe('manual_review');
    expect(completed.identity.state).toBe('review_required');
  });

  it('refuses to complete an attempt the machine already left', () => {
    const error = errorOf(
      completeFromProvider(awaitingProviderInit(), 'pending', providerResult(), [], hoursLater(1)),
    );
    expect(error.code).toBe('invalid_transition');
  });

  it('refuses a completion whose result cannot move the identity state it is given', () => {
    // An attempt cannot complete for a subject who is not pending: the
    // identity machine is the authority, not the attempt.
    const error = errorOf(
      completeFromProvider(
        awaitingProvider(),
        'review_required',
        providerResult(),
        [],
        hoursLater(1),
      ),
    );
    expect(error.code).toBe('invalid_transition');
  });
});

describe('resolving a manual review', () => {
  it('requires a named reviewer in both directions', () => {
    const inReview = succeeded(
      completeFromProvider(
        awaitingProvider(),
        'pending',
        providerResult({ confidence: 0.7 }),
        [],
        hoursLater(1),
      ),
    );
    expect(errorOf(resolveReview(inReview.attempt, 'cleared', '   ', hoursLater(2))).code).toBe(
      'validation_failed',
    );
    const cleared = succeeded(resolveReview(inReview.attempt, 'cleared', 'mod-7', hoursLater(2)));
    expect(cleared.state).toBe('passed');
    expect(cleared.reviewerId).toBe('mod-7');
  });

  it('can be confirmed as fraud only by a named human', () => {
    const inReview = succeeded(
      completeFromProvider(
        awaitingProvider(),
        'pending',
        providerResult({ confidence: 0.7 }),
        [],
        hoursLater(1),
      ),
    );
    const failed = succeeded(
      resolveReview(inReview.attempt, 'confirmed_fraud', 'mod-7', hoursLater(2)),
    );
    expect(failed.state).toBe('failed');
  });
});

describe('ending an attempt', () => {
  it('refuses to expire before the deadline', () => {
    const error = errorOf(expireAttempt(awaitingProvider(), hoursLater(1)));
    expect(error.code).toBe('conflict');
  });

  it('expires once the deadline passes and is then final', () => {
    const after = hoursLater(ATTEMPT_POLICY.ttlHours + 1);
    const expired = succeeded(expireAttempt(awaitingProvider(), after));
    expect(expired.state).toBe('expired');
    expect(errorOf(expireAttempt(expired, after)).code).toBe('invalid_transition');
  });

  it('holds a manual review open rather than expiring it under the reviewer', () => {
    const inReview = succeeded(
      completeFromProvider(
        awaitingProvider(),
        'pending',
        providerResult({ confidence: 0.7 }),
        [],
        hoursLater(1),
      ),
    );
    expect(
      errorOf(expireAttempt(inReview.attempt, hoursLater(ATTEMPT_POLICY.ttlHours + 5))).code,
    ).toBe('invalid_transition');
  });
});

/** A freshly initiated attempt, used where the capture state is irrelevant. */
function awaitingProviderInit(): VerificationAttempt {
  return succeeded(
    planVerificationStart({
      verificationId: castId<'VerificationId'>('vrf-init'),
      subjectId: SUBJECT,
      identityState: 'unverified',
      now: T0,
      reVerification: false,
      reason: { code: 'onboarding' },
      existing: [],
    }),
  ).attempt;
}

describe('repeated failure reaches a person', () => {
  const failed = (index: number, at: Date): VerificationAttempt => ({
    ...attemptInFlight(),
    verificationId: castId<'VerificationId'>(`vrf-fail-${index}`),
    state: 'failed',
    startedAt: at,
    updatedAt: at,
  });

  it('leaves the first two failures with another retry', () => {
    for (const count of [1, 2]) {
      const attempts = Array.from({ length: count }, (_, index) =>
        failed(index, daysAgo(index)),
      );
      const result = escalateAfterRepeatedFailure({
        identityState: 'verification_failed',
        attempts,
      });

      expect(succeeded(result)).toBeNull();
    }
  });

  it('escalates the third consecutive failure to review_required', () => {
    // Before the kernel had the edge, `flag_for_review` from
    // `verification_failed` was `invalid_transition`, so the only thing an
    // implementer could build from "repeated failure leads to review_required"
    // was an error.
    const attempts = [0, 1, 2].map((index) => failed(index, daysAgo(index)));
    const escalation = succeeded(
      escalateAfterRepeatedFailure({ identityState: 'verification_failed', attempts }),
    );

    expect(escalation?.viaEvent).toBe('flag_for_review');
    expect(escalation?.state).toBe<IdentityState>('review_required');
    expect(escalation?.consecutiveFailures).toBe(REVIEW_ESCALATION_POLICY.consecutiveFailuresBeforeReview);
  });

  it('counts the run of failures, not every failure the account ever had', () => {
    // Three failures last March must not escalate a person who failed once
    // yesterday and is failing again now.
    const attempts = [
      failed(0, new Date('2026-01-04T09:00:00.000Z')),
      failed(1, new Date('2026-01-05T09:00:00.000Z')),
      failed(2, new Date('2026-01-06T09:00:00.000Z')),
      attemptInFlight({
        verificationId: castId<'VerificationId'>('vrf-pass'),
        state: 'passed',
        startedAt: new Date('2026-01-07T09:00:00.000Z'),
      }),
      failed(3, T0),
      failed(4, hoursLater(1)),
    ];
    const result = escalateAfterRepeatedFailure({
      identityState: 'verification_failed',
      attempts,
    });

    expect(succeeded(result)).toBeNull();
  });

  it('cannot escalate a state that is not a failed verification', () => {
    // The counter is not the authority: the kernel still decides. An escalation
    // attempted from a state that never failed is refused rather than invented.
    const attempts = [0, 1, 2].map((index) => failed(index, daysAgo(index)));
    const error = errorOf(
      escalateAfterRepeatedFailure({ identityState: 'unverified', attempts }),
    );

    expect(error.code).toBe('invalid_transition');
  });

  it('never touches account standing on the way to a review', () => {
    // A review is a verification outcome, not an enforcement: the escalation
    // resolves to `review_required` and nothing else exists on this path.
    const attempts = [0, 1, 2].map((index) => failed(index, daysAgo(index)));
    const escalation = succeeded(
      escalateAfterRepeatedFailure({ identityState: 'verification_failed', attempts }),
    );

    expect(escalation?.state).toBe<IdentityState>('review_required');
    expect(REVIEW_ESCALATION_POLICY.consecutiveFailuresBeforeReview).toBe(3);
  });
});

describe('a rate limit a person can read', () => {
  it('tells the person when the attempt cap lifts', () => {
    // The copy says "Try again" and the cap refuses it three times out of five.
    // The error now carries the moment the oldest of today's attempts leaves the
    // 24-hour window, so the screen can say when rather than lying by omission.
    const startedAt = new Date('2026-03-01T06:00:00.000Z');
    const existing = Array.from({ length: ATTEMPT_POLICY.maxAttemptsPerDay }, (_, index) => ({
      ...attemptInFlight(),
      verificationId: castId<'VerificationId'>(`vrf-${index}`),
      state: 'expired' as const,
      startedAt: new Date(startedAt.getTime() + index * 30 * 60 * 1000),
    }));
    const error = errorOf(
      planVerificationStart({
        verificationId: castId<'VerificationId'>('vrf-new'),
        subjectId: SUBJECT,
        identityState: 'verification_failed',
        now: hoursLater(2),
        reVerification: false,
        reason: { code: 'user_requested' },
        existing,
      }),
    );

    expect(error.code).toBe('rate_limited');
    expect(error.details?.retryAt).toBe(
      new Date(startedAt.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    );
  });

  it('tells the person when a retake cooldown lifts', () => {
    const attempt = succeeded(
      recordCapture(
        succeeded(beginCapture(awaitingProviderInit(), T0)),
        {
          kind: 'selfie_image',
          check: 'liveness',
          storageRef: 'blob://selfie-1',
          digest: 'sha256:selfie-1',
        },
        T0,
      ),
    );
    const error = errorOf(
      recordCapture(
        attempt,
        {
          kind: 'selfie_image',
          check: 'liveness',
          storageRef: 'blob://selfie-2',
          digest: 'sha256:selfie-2',
        },
        hoursLater(ATTEMPT_POLICY.retakeCooldownMinutes / 60 - 0.1),
      ),
    );

    expect(error.code).toBe('rate_limited');
    expect(error.details?.retryAt).toBe(
      new Date(T0.getTime() + ATTEMPT_POLICY.retakeCooldownMinutes * 60_000).toISOString(),
    );
  });

  it('lets a retake through once the cooldown has elapsed', () => {
    const attempt = succeeded(
      recordCapture(
        succeeded(beginCapture(awaitingProviderInit(), T0)),
        {
          kind: 'selfie_image',
          check: 'liveness',
          storageRef: 'blob://selfie-1',
          digest: 'sha256:selfie-1',
        },
        T0,
      ),
    );
    const retake = recordCapture(
      attempt,
      {
        kind: 'selfie_image',
        check: 'liveness',
        storageRef: 'blob://selfie-2',
        digest: 'sha256:selfie-2',
      },
      hoursLater(ATTEMPT_POLICY.retakeCooldownMinutes / 60 + 0.1),
    );

    expect(retake.ok).toBe(true);
  });
});
