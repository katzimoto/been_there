import {
  type ActorId,
  type DomainError,
  type IdentityEvent,
  type IdentityState,
  type Result,
  type RiskAssessmentId,
  type SubjectId,
  type VerificationId,
  andThen,
  domainError,
  identityMachine,
  ok,
} from '@been-there/core';
import { type VerificationAttemptState, isOpenAttempt } from './verification-request.js';

/**
 * Re-verification as a command interface (issue #3, feeds issue #15).
 *
 * Other domains may *ask* for a re-verification; only this domain decides
 * whether one happens. Three rules make that safe to expose:
 *
 *  1. Authority is explicit. Trust & Safety may ask, because it holds a risk
 *     assessment. The dating core may not, ever — a product domain that could
 *     demand identity checks could turn "she didn't reply" into a forced
 *     identity interrogation, which is a harassment primitive, not a safety
 *     feature.
 *  2. A re-verification may be rate-limited like any other user-facing flow,
 *     because that is what makes it safe to expose. Repeatedly expiring a
 *     victim's verification is a way of hiding them from the product without
 *     ever touching their account standing.
 *  3. It never changes account standing. The worst thing this command can do
 *     is make a user temporarily undiscoverable, and even that needs the
 *     identity machine's own rules to allow it.
 */

export type ReverificationReason =
  /** The verification aged out and the user is refreshing it. */
  | 'identity_expired'
  /** The user asked. */
  | 'user_requested'
  /** Trust & Safety raised a risk assessment. */
  | 'risk_signal'
  /** Moderation linked a case. */
  | 'case_linked'
  /** The identity domain's own detectors fired. */
  | 'anomaly_findings';

export type ReverificationRequester =
  | { readonly kind: 'subject'; readonly actorId: ActorId }
  | {
      readonly kind: 'trust_safety';
      readonly actorId: ActorId;
      readonly riskAssessmentId: RiskAssessmentId;
    }
  | { readonly kind: 'moderation'; readonly actorId: ActorId; readonly caseId: string }
  | { readonly kind: 'dating_core'; readonly actorId: ActorId };

/** Who may demand a re-verification. Everything else is refused by construction. */
export const REVERIFICATION_AUTHORITIES: Readonly<
  Record<ReverificationReason, readonly ReverificationRequester['kind'][]>
> = {
  identity_expired: ['subject'],
  user_requested: ['subject'],
  risk_signal: ['trust_safety'],
  case_linked: ['moderation'],
  anomaly_findings: ['trust_safety', 'moderation'],
};

interface ReverificationPolicy {
  readonly maxPerSubjectPer30Days: number;
  readonly cooldownHours: number;
  readonly subjectMayRequestOnlyWhen: readonly IdentityState[];
}

export const REVERIFICATION_POLICY: ReverificationPolicy = {
  /**
   * Re-verifications a subject may be put through in a rolling 30 days. Three
   * is enough for a real pattern (expired, then a risk signal, then a case) and
   * low enough that a caller cannot keep someone permanently invisible.
   */
  maxPerSubjectPer30Days: 3,
  /**
   * Minimum gap between two re-verifications. A re-verification interrupts
   * whatever the user is doing and drops them out of discovery while it runs,
   * so the minimum gap is a user-protection rule, not a cost rule.
   */
  cooldownHours: 24,
  /**
   * A subject may not demand a re-verification while already verified. Doing so
   * would be a self-inflicted visibility loss with no verification benefit, and
   * it is the shape a "make this account invisible" abuse would take from
   * inside.
   */
  subjectMayRequestOnlyWhen: ['expired', 'verification_failed'],
};

export interface ReverificationHistoryEntry {
  readonly verificationId: VerificationId;
  readonly requestedAt: Date;
  readonly reVerification: boolean;
  readonly attemptState: VerificationAttemptState;
}

export interface RequestReVerificationCommand {
  readonly subjectId: SubjectId;
  readonly reason: ReverificationReason;
  readonly requester: ReverificationRequester;
  readonly now: Date;
}

export interface ReverificationContext {
  readonly identityState: IdentityState;
  readonly history: readonly ReverificationHistoryEntry[];
}

export interface ReverificationPlan {
  readonly subjectId: SubjectId;
  readonly reason: ReverificationReason;
  readonly requestedBy: ReverificationRequester['kind'];
  /** Always true here: a first verification is a different command. */
  readonly reVerification: true;
  /** Resolved through the shared kernel, so the plan cannot invent a state. */
  readonly viaEvent: IdentityEvent;
  readonly nextIdentityState: IdentityState;
}

/**
 * Decides whether a re-verification may happen, and if so what it will do to the
 * identity state.
 *
 * Check order is part of the contract. Authority is checked first, before the
 * cooldown, before the open-attempt check, and before the state machine: an
 * unauthorised caller must not be able to learn whether a subject has a
 * verification in flight, how many they have had, or what state they are in.
 * Only a caller with authority over the subject gets that information back.
 */
export function requestReVerification(
  command: RequestReVerificationCommand,
  context: ReverificationContext,
): Result<ReverificationPlan, DomainError> {
  const permitted = REVERIFICATION_AUTHORITIES[command.reason];
  if (!permitted.includes(command.requester.kind)) {
    return domainError(
      'permission_denied',
      'identity',
      `${command.requester.kind} may not demand a re-verification for '${command.reason}'`,
      { requester: command.requester.kind, reason: command.reason },
    );
  }

  if (
    command.requester.kind === 'subject' &&
    !REVERIFICATION_POLICY.subjectMayRequestOnlyWhen.includes(context.identityState)
  ) {
    return domainError(
      'not_eligible',
      'identity',
      'a subject may only re-verify when they are not already verified',
      { state: context.identityState },
    );
  }

  const open = context.history.find((entry) => isOpenAttempt(entry.attemptState));
  if (open !== undefined) {
    return domainError('conflict', 'identity', 'a verification attempt is already in flight', {
      attemptState: open.attemptState,
    });
  }

  const reVerifications = context.history.filter(
    (entry) =>
      entry.reVerification &&
      entry.requestedAt.getTime() > command.now.getTime() - 30 * 24 * 60 * 60 * 1000,
  );
  if (reVerifications.length >= REVERIFICATION_POLICY.maxPerSubjectPer30Days) {
    return domainError(
      'rate_limited',
      'identity',
      're-verification limit reached for this subject',
      {
        requested: reVerifications.length,
        limit: REVERIFICATION_POLICY.maxPerSubjectPer30Days,
      },
    );
  }

  const lastRequestedAt = reVerifications.reduce<Date | null>(
    (latest, entry) =>
      latest === null || entry.requestedAt.getTime() > latest.getTime()
        ? entry.requestedAt
        : latest,
    null,
  );
  if (lastRequestedAt !== null) {
    const hoursSince = (command.now.getTime() - lastRequestedAt.getTime()) / (60 * 60 * 1000);
    if (hoursSince < REVERIFICATION_POLICY.cooldownHours) {
      return domainError('rate_limited', 'identity', 're-verification cooldown has not elapsed', {
        hoursSince: Math.floor(hoursSince),
        cooldownHours: REVERIFICATION_POLICY.cooldownHours,
      });
    }
  }

  return andThen(
    identityMachine.next(context.identityState, 'reverify_requested', { reVerification: true }),
    (state) =>
      ok({
        subjectId: command.subjectId,
        reason: command.reason,
        requestedBy: command.requester.kind,
        reVerification: true,
        viaEvent: 'reverify_requested',
        nextIdentityState: state,
      }),
  );
}
