import {
  type DomainError,
  type IdentityEvent,
  type IdentityState,
  type Result,
  type SubjectId,
  type StateMachine,
  type VerificationId,
  andThen,
  defineStateMachine,
  domainError,
  identityMachine,
  ok,
} from '@been-there/core';
import type { AnomalyFinding } from './anomaly.js';
import { type EvidenceKind, type VerificationEvidence, evidenceExpiry } from './evidence.js';
import {
  type IdentityConfidence,
  type VerificationDecision,
  type VerificationDecisionRecord,
  decideVerificationOutcome,
} from './likeness.js';
import {
  REQUIRED_CHECKS,
  type ProviderVerificationResult,
  type VerificationCheck,
} from './provider.js';

/**
 * The verification attempt aggregate (issue #3).
 *
 * The shared kernel owns *whether a person is verified*. This aggregate owns
 * *how we got to an answer*: what was captured, what the provider said, what
 * the detectors found, and what we decided. It is a separate machine from the
 * identity machine on purpose — a vendor outage, a blurry retake, and a person
 * lying about their age are three different facts, and one status field cannot
 * hold all three without lying about two of them.
 *
 * Every function here is pure: it takes an attempt and returns a new one, or a
 * `Result` error explaining why not. Nothing throws, and nothing reaches out to
 * the provider itself — that is `VerificationProvider`'s job.
 */

export type VerificationAttemptState =
  | 'initiated'
  | 'capturing'
  | 'awaiting_provider'
  | 'passed'
  | 'failed'
  | 'manual_review'
  | 'expired';

export type VerificationAttemptEvent =
  | 'begin_capture'
  | 'record_capture'
  | 'submit_to_provider'
  | 'result_passed'
  | 'result_failed'
  | 'result_inconclusive'
  | 'review_cleared'
  | 'review_confirmed_fraud'
  | 'expire'
  | 'withdraw';

export interface VerificationAttemptContext {
  readonly completedChecks?: readonly VerificationCheck[];
  readonly providerResult?: ProviderVerificationResult;
  readonly anomalies?: readonly AnomalyFinding[];
  readonly reviewerId?: string;
}

/** The three live states. Everything else is a resting place. */
const LIVE_ATTEMPT_STATES: readonly VerificationAttemptState[] = [
  'initiated',
  'capturing',
  'awaiting_provider',
];

const TERMINAL_ATTEMPT_STATES: readonly VerificationAttemptState[] = [
  'passed',
  'failed',
  'expired',
];

const decisionFrom = (context: VerificationAttemptContext): VerificationDecision | null => {
  if (context.providerResult === undefined) {
    return null;
  }
  return decideVerificationOutcome({
    confidence: context.providerResult.confidence,
    checks: context.providerResult.checks,
    anomalies: context.anomalies ?? [],
  }).decision;
};

const allRequiredCaptured = (context: VerificationAttemptContext): boolean =>
  REQUIRED_CHECKS.every((check) => context.completedChecks?.includes(check) === true);

/**
 * The attempt lifecycle, as data. The guards on the three result events re-derive
 * the decision from the provider output, so no caller can hand this machine a
 * `passed` event that the policy would not have granted.
 */
export const attemptMachine: StateMachine<
  VerificationAttemptState,
  VerificationAttemptEvent,
  VerificationAttemptContext
> = defineStateMachine<
  VerificationAttemptState,
  VerificationAttemptEvent,
  VerificationAttemptContext
>({
  domain: 'identity.attempt',
  initial: 'initiated',
  transitions: [
    { event: 'begin_capture', from: ['initiated'], to: 'capturing' },
    {
      event: 'record_capture',
      from: ['capturing'],
      to: 'capturing',
      note: 'A retake supersedes the previous artefact of the same kind; evidence does not accumulate.',
    },
    {
      event: 'submit_to_provider',
      from: ['capturing'],
      to: 'awaiting_provider',
      guard: allRequiredCaptured,
      note: 'Never call a vendor with a half-captured verification.',
    },
    {
      event: 'result_passed',
      from: ['awaiting_provider'],
      to: 'passed',
      guard: (ctx) => decisionFrom(ctx) === 'pass',
      note: 'Only a policy-clean provider result passes.',
    },
    {
      event: 'result_failed',
      from: ['awaiting_provider'],
      to: 'failed',
      guard: (ctx) => decisionFrom(ctx) === 'fail',
    },
    {
      event: 'result_inconclusive',
      from: ['awaiting_provider'],
      to: 'manual_review',
      guard: (ctx) => decisionFrom(ctx) === 'manual_review',
      note: 'Borderline, contradictory, or anomalous input is a human, never an auto-decision.',
    },
    {
      event: 'review_cleared',
      from: ['manual_review'],
      to: 'passed',
      guard: (ctx) => ctx?.reviewerId !== undefined,
      note: 'Only a named human may clear a review.',
    },
    {
      event: 'review_confirmed_fraud',
      from: ['manual_review'],
      to: 'failed',
      guard: (ctx) => ctx?.reviewerId !== undefined,
    },
    {
      event: 'expire',
      from: LIVE_ATTEMPT_STATES,
      to: 'expired',
      note: 'Held open: a manual_review attempt is not expired out from under the reviewer.',
    },
    {
      event: 'withdraw',
      from: LIVE_ATTEMPT_STATES,
      to: 'expired',
      note: 'The user backed out. Recorded as an ended attempt, not as a failure.',
    },
  ],
});

/**
 * Timing and volume policy. Anti-abuse lives here as well as on
 * re-verification: a verification endpoint that can be hammered is both a cost
 * problem and a way to keep a victim in a permanent capture loop.
 */
export const ATTEMPT_POLICY = {
  /** An attempt that never gets a result ends here rather than lingering. */
  ttlHours: 24,
  /**
   * Minimum gap between captures of the same kind. Long enough that a user
   * fixing a blurry photo is not rate-limited, short enough to feel instant.
   */
  retakeCooldownMinutes: 15,
  /** Attempts a subject may start in a rolling 24 hours. */
  maxAttemptsPerDay: 5,
} as const;

export type VerificationStartReason =
  | { readonly code: 'onboarding' }
  | { readonly code: 'user_requested' }
  | { readonly code: 'identity_expired' }
  | { readonly code: 'risk_signal'; readonly riskAssessmentId: string }
  | { readonly code: 'case_linked'; readonly caseId: string }
  | { readonly code: 'anomaly_findings'; readonly findings: readonly AnomalyFinding[] };

export interface VerificationAttempt {
  readonly verificationId: VerificationId;
  readonly subjectId: SubjectId;
  readonly state: VerificationAttemptState;
  /** True when the attempt was demanded by something other than onboarding. */
  readonly reVerification: boolean;
  readonly reason: VerificationStartReason;
  readonly startedAt: Date;
  readonly updatedAt: Date;
  readonly expiresAt: Date;
  readonly submittedAt: Date | null;
  readonly completedChecks: readonly VerificationCheck[];
  readonly evidence: readonly VerificationEvidence[];
  readonly confidence: IdentityConfidence | null;
  readonly decision: VerificationDecisionRecord | null;
  readonly reviewerId: string | null;
}

/** The identity-machine move this attempt implies, resolved through the kernel. */
export interface IdentityTransitionProposal {
  readonly viaEvent: IdentityEvent;
  readonly state: IdentityState;
}

export interface VerificationStartInput {
  readonly verificationId: VerificationId;
  readonly subjectId: SubjectId;
  readonly identityState: IdentityState;
  readonly now: Date;
  readonly reVerification: boolean;
  readonly reason: VerificationStartReason;
  /** The subject's other attempts, newest first. */
  readonly existing: readonly VerificationAttempt[];
}

export interface VerificationStartResult {
  readonly attempt: VerificationAttempt;
  readonly identity: IdentityTransitionProposal;
}

export function isOpenAttempt(state: VerificationAttemptState): boolean {
  // A manual review counts as open: the attempt is still awaiting a human, so
  // a second attempt must not start and a re-verification must not be demanded.
  return !TERMINAL_ATTEMPT_STATES.includes(state);
}

export function planVerificationStart(
  input: VerificationStartInput,
): Result<VerificationStartResult, DomainError> {
  const open = input.existing.find((attempt) => isOpenAttempt(attempt.state));
  if (open !== undefined) {
    return domainError('conflict', 'identity', 'a verification attempt is already in flight', {
      state: open.state,
    });
  }

  const dayAgo = input.now.getTime() - 24 * 60 * 60 * 1000;
  const startedToday = input.existing.filter(
    (attempt) => attempt.startedAt.getTime() > dayAgo,
  ).length;
  if (startedToday >= ATTEMPT_POLICY.maxAttemptsPerDay) {
    return domainError('rate_limited', 'identity', 'too many verification attempts today', {
      startedToday,
      maxAttemptsPerDay: ATTEMPT_POLICY.maxAttemptsPerDay,
    });
  }

  const viaEvent: IdentityEvent = input.reVerification
    ? 'reverify_requested'
    : 'submit_verification';
  const next = identityMachine.next(input.identityState, viaEvent, {
    reVerification: input.reVerification,
  });
  if (!next.ok) {
    return next;
  }

  const expiresAt = new Date(input.now.getTime() + ATTEMPT_POLICY.ttlHours * 60 * 60 * 1000);
  return ok({
    identity: { viaEvent, state: next.value },
    attempt: {
      verificationId: input.verificationId,
      subjectId: input.subjectId,
      state: attemptMachine.initial,
      reVerification: input.reVerification,
      reason: input.reason,
      startedAt: input.now,
      updatedAt: input.now,
      expiresAt,
      submittedAt: null,
      completedChecks: [],
      evidence: [],
      confidence: null,
      decision: null,
      reviewerId: null,
    },
  });
}

function applyAttemptEvent(
  attempt: VerificationAttempt,
  event: VerificationAttemptEvent,
  context: VerificationAttemptContext,
  now: Date,
): Result<VerificationAttempt, DomainError> {
  return andThen(attemptMachine.next(attempt.state, event, context), (state) =>
    ok({ ...attempt, state, updatedAt: now }),
  );
}

export function beginCapture(
  attempt: VerificationAttempt,
  now: Date,
): Result<VerificationAttempt, DomainError> {
  return applyAttemptEvent(attempt, 'begin_capture', {}, now);
}

export interface CaptureInput {
  readonly check: VerificationCheck;
  readonly kind: EvidenceKind;
  /** Opaque storage locator supplied by the evidence store, never a URL. */
  readonly storageRef: string;
  /** SHA-256 digest of the artefact. */
  readonly digest: string;
}

/**
 * Records one captured artefact. A retake of the same kind replaces the earlier
 * artefact rather than adding to it: a user who re-uploads their passport six
 * times must not leave six copies of their passport behind.
 *
 * Retakes are also rate-limited. An uncapped capture endpoint is both a
 * vendor-cost problem and a way to keep someone in a permanent retry loop, so
 * a second capture of the same kind inside the cooldown is refused.
 */
export function recordCapture(
  attempt: VerificationAttempt,
  capture: CaptureInput,
  now: Date,
): Result<VerificationAttempt, DomainError> {
  const previous = attempt.evidence.find((item) => item.kind === capture.kind);
  if (
    previous !== undefined &&
    now.getTime() - previous.capturedAt.getTime() < ATTEMPT_POLICY.retakeCooldownMinutes * 60_000
  ) {
    return domainError('rate_limited', 'identity', 'a retake of this artefact is too soon', {
      kind: capture.kind,
      retakeCooldownMinutes: ATTEMPT_POLICY.retakeCooldownMinutes,
    });
  }
  const supersede = attempt.evidence.filter((item) => item.kind !== capture.kind);
  const completedChecks = [...new Set([...attempt.completedChecks, capture.check])];
  const evidence: VerificationEvidence = {
    kind: capture.kind,
    verificationId: attempt.verificationId,
    capturedAt: now,
    storageRef: capture.storageRef,
    sensitivity: 'restricted',
    digest: capture.digest,
    expiresAt: evidenceExpiry(capture.kind, now),
  };
  return andThen(applyAttemptEvent(attempt, 'record_capture', { completedChecks }, now), (next) =>
    ok({ ...next, evidence: [...supersede, evidence], completedChecks }),
  );
}

export function submitToProvider(
  attempt: VerificationAttempt,
  now: Date,
): Result<VerificationAttempt, DomainError> {
  return andThen(
    applyAttemptEvent(
      attempt,
      'submit_to_provider',
      { completedChecks: attempt.completedChecks },
      now,
    ),
    (next) => ok({ ...next, submittedAt: now }),
  );
}

export interface CompletedVerification {
  readonly attempt: VerificationAttempt;
  readonly decision: VerificationDecisionRecord;
  readonly identity: IdentityTransitionProposal;
}

const ATTEMPT_EVENT_BY_DECISION: Readonly<Record<VerificationDecision, VerificationAttemptEvent>> =
  {
    pass: 'result_passed',
    fail: 'result_failed',
    manual_review: 'result_inconclusive',
  };

const IDENTITY_EVENT_BY_DECISION: Readonly<Record<VerificationDecision, IdentityEvent>> = {
  pass: 'provider_result_received',
  fail: 'fail',
  manual_review: 'flag_for_review',
};

/**
 * Applies a provider result to the attempt and resolves the identity move that
 * follows from it.
 *
 * The decision is computed once here and re-derived by the machine's guards, so
 * the attempt state and the stored decision can never disagree. A `manual_review`
 * outcome resolves to `flag_for_review` on the identity machine, which takes the
 * user out of discovery while a human looks. An anomaly can therefore make a
 * verification *slower*, and can never make it *worse* than a review.
 */
export function completeFromProvider(
  attempt: VerificationAttempt,
  identityState: IdentityState,
  result: ProviderVerificationResult,
  anomalies: readonly AnomalyFinding[],
  now: Date,
): Result<CompletedVerification, DomainError> {
  const decision = decideVerificationOutcome({
    confidence: result.confidence,
    checks: result.checks,
    anomalies,
  });
  const context: VerificationAttemptContext = {
    completedChecks: attempt.completedChecks,
    providerResult: result,
    anomalies,
  };
  const viaEvent = IDENTITY_EVENT_BY_DECISION[decision.decision];
  const identityContext =
    decision.confidence.band === 'unusable' ? {} : { confidence: decision.confidence.value };
  const identityNext = identityMachine.next(identityState, viaEvent, identityContext);
  if (!identityNext.ok) {
    return identityNext;
  }
  return andThen(
    applyAttemptEvent(attempt, ATTEMPT_EVENT_BY_DECISION[decision.decision], context, now),
    (next) =>
      ok({
        attempt: {
          ...next,
          confidence: decision.confidence,
          decision,
        },
        decision,
        identity: { viaEvent, state: identityNext.value },
      }),
  );
}

/**
 * Resolves a manual review. `outcome: 'cleared'` grants the attempt, and
 * `'confirmed_fraud'` ends it — both require a named human, and neither is
 * reachable from automation.
 *
 * The kernel guard only checks that a reviewer id is *present*. This function
 * tightens that to *named*: a blank string is the failure mode that turns
 * "a person decided this" into "the system decided this", and a review record
 * with a blank reviewer is worthless in an appeal.
 */
export function resolveReview(
  attempt: VerificationAttempt,
  outcome: 'cleared' | 'confirmed_fraud',
  reviewerId: string,
  now: Date,
): Result<VerificationAttempt, DomainError> {
  if (reviewerId.trim().length === 0) {
    return domainError('validation_failed', 'identity', 'a review must name its reviewer');
  }
  const event: VerificationAttemptEvent =
    outcome === 'cleared' ? 'review_cleared' : 'review_confirmed_fraud';
  return andThen(applyAttemptEvent(attempt, event, { reviewerId }, now), (next) =>
    ok({ ...next, reviewerId }),
  );
}

/**
 * Ends an attempt that never produced a result. Refuses before the deadline,
 * so a scheduler bug cannot cut a live attempt — or a review — short.
 */
export function expireAttempt(
  attempt: VerificationAttempt,
  now: Date,
): Result<VerificationAttempt, DomainError> {
  if (now.getTime() < attempt.expiresAt.getTime()) {
    return domainError('conflict', 'identity', 'attempt has not reached its deadline', {
      expiresAt: attempt.expiresAt.toISOString(),
    });
  }
  return applyAttemptEvent(attempt, 'expire', {}, now);
}
