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
  castId,
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
   *
   * `verification_failed` is deliberately absent even though the subject can
   * act from that state, because a failed attempt is not re-*verified*, it is
   * *retried*: `submit_verification` is legal from `verification_failed` and
   * lands in the same `pending` state this command would have produced. Naming
   * it here would have invited a call the machine then refuses with
   * `invalid_transition`, after the open-attempt, cap and cooldown checks had
   * all already run. This list is a subset of the machine's
   * `reverify_requested.from`, never a superset.
   */
  subjectMayRequestOnlyWhen: ['expired'],
};

/**
 * Which limit stopped a demand. Recorded rather than inferred from the message
 * text, because the recipient of a signal is a human deciding whether the system
 * was pulling one person out of discovery too often, and "we hit the cap" and
 * "it has not been 24 hours yet" are different conversations.
 */
export type ReverificationLimit = 'per_subject_per_30_days' | 'cooldown';

/**
 * A demand an automated caller was not allowed to make. Identity cannot open a
 * moderation case — it has no case vocabulary and the dependency runs the other
 * way — so the honest way to make the fact visible to a human is to hand the
 * caller a record and require the caller to have somewhere to put it. A
 * `ReverificationRefusalLog` alone was not enough: every refusal looks the same
 * to a log, and a subject tapping a button twice is not a safety signal while
 * * Trust & Safety hitting the cap three times in a month is exactly the pattern
 * §8.3 R2 exists to catch.
 */
export interface ReverificationLimitSignal {
  readonly at: Date;
  /** The account the demand would have been applied to. */
  readonly subjectId: SubjectId;
  /** The automated caller that made it. Never a subject. */
  readonly actorId: ActorId;
  readonly requesterKind: 'trust_safety' | 'moderation';
  readonly reason: ReverificationReason;
  readonly limit: ReverificationLimit;
  /** When the block lifts, so the caller can resume rather than give up. */
  readonly blockedUntil: Date;
  /** Re-verifications already in the rolling window, and the cap. */
  readonly requested: number;
  readonly cap: number;
}

/** The rolling window the cap is counted over. Named once, used three times. */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface ReverificationSignalLog {
  append(signal: ReverificationLimitSignal): void;
}

/**
 * Both sinks, as one argument. A separate positional parameter would have let a
 * caller pass the refusal log and quietly leave escalation unwired, which is the
 * failure this type exists to make impossible.
 */
export interface ReverificationSinks {
  readonly refusals: ReverificationRefusalLog;
  readonly signals: ReverificationSignalLog;
}

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

/**
 * One refused demand, written before the refusal is returned. A denial is a
 * record too, and this is the record: the command carries no evidence and the
 * plan never exists, so without it there would be nothing anywhere that showed
 * who tried to re-verify whom.
 */
export interface ReverificationRefusal {
  readonly at: Date;
  /** The caller that made the demand. Never the intended subject, unless they are the same. */
  readonly actorId: ActorId;
  /** The account the demand would have been applied to. */
  readonly intendedSubjectId: SubjectId;
  readonly requesterKind: ReverificationRequester['kind'];
  readonly reason: ReverificationReason;
  readonly code: DomainError['code'];
}

/**
 * Where refusals go. A sink rather than a returned value, because the caller of
 * a `Result` is free to log the error and ignore it — the record has to be
 * written by the domain that made the decision, or it does not exist.
 */
export interface ReverificationRefusalLog {
  append(refusal: ReverificationRefusal): void;
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
 * Check order is part of the contract. Authority is checked first — the
 * reason→requester table, then whether a `subject` demand is for the subject
 * themselves — before the subject's eligibility, before an open human review,
 * before the open attempt, before the 30-day cap, before the cooldown, and
 * before the state machine. An unauthorised caller must not be able to learn
 * whether a subject has a verification in flight, how many they have had, or
 * what state they are in. Only a caller with authority over the subject gets
 * that information back.
 *
 * Every refusal is appended to `sinks.refusals` before it is returned, for the
 * same reason the evidence module writes its denials: the denial is the record
 * a reviewer will ask for after an incident. A cross-subject demand in
 * particular is a harassment attempt, and a harassment attempt that leaves no
 * trace is a harassment attempt that can be repeated forever.
 *
 * A cap or cooldown refusal by an *automated* caller also writes a signal. A
 * subject who taps a button twice has found a rate limit, which the refusal row
 * records; Trust & Safety hitting the cap on the same person three times in a
 * month has found something else — that the system keeps pulling one person out
 * of discovery — and nobody downstream can see that from a `rate_limited` error.
 */
export function requestReVerification(
  command: RequestReVerificationCommand,
  context: ReverificationContext,
  sinks: ReverificationSinks,
): Result<ReverificationPlan, DomainError> {
  const refuse = (
    code: DomainError['code'],
    message: string,
    details?: DomainError['details'],
  ): Result<ReverificationPlan, DomainError> => {
    sinks.refusals.append({
      at: command.now,
      actorId: command.requester.actorId,
      intendedSubjectId: command.subjectId,
      requesterKind: command.requester.kind,
      reason: command.reason,
      code,
    });
    return domainError(code, 'identity', message, details);
  };

  // Only an automated caller can be the subject of a signal; a `subject` demand
  // that trips a limit is a person being told to wait, not a system pulling them
  // out of discovery on somebody else's initiative.
  const raise = (
    limit: ReverificationLimit,
    blockedUntil: Date,
    requested: number,
  ): void => {
    if (command.requester.kind === 'subject' || command.requester.kind === 'dating_core') {
      return;
    }
    sinks.signals.append({
      at: command.now,
      subjectId: command.subjectId,
      actorId: command.requester.actorId,
      requesterKind: command.requester.kind,
      reason: command.reason,
      limit,
      blockedUntil,
      requested,
      cap:
        limit === 'per_subject_per_30_days'
          ? REVERIFICATION_POLICY.maxPerSubjectPer30Days
          : REVERIFICATION_POLICY.cooldownHours,
    });
  };

  const permitted = REVERIFICATION_AUTHORITIES[command.reason];
  if (!permitted.includes(command.requester.kind)) {
    return refuse(
      'permission_denied',
      `${command.requester.kind} may not demand a re-verification for '${command.reason}'`,
      { requester: command.requester.kind, reason: command.reason },
    );
  }

  if (
    command.requester.kind === 'subject' &&
    // A self-service demand and the account it is about name the same account
    // under two id brands, so the comparison is made through `castId`, the
    // package's single sanctioned widening point. Without it the check does not
    // compile, which is how it went missing in the first place.
    command.requester.actorId !== castId<'ActorId'>(command.subjectId)
  ) {
    // "A user demands a re-verification" only means the user demands *their
    // own*. Anything else is one user reaching into another account's
    // visibility, and it is refused before any other check runs so the
    // attempt tells the caller nothing about the account it reached for.
    return refuse('permission_denied', 'a subject may only demand their own re-verification', {
      requester: 'subject',
      reason: command.reason,
    });
  }

  if (
    command.requester.kind === 'subject' &&
    !REVERIFICATION_POLICY.subjectMayRequestOnlyWhen.includes(context.identityState)
  ) {
    return refuse(
      'not_eligible',
      'a subject may only re-verify when they are not already verified',
      {
        state: context.identityState,
      },
    );
  }

  if (context.identityState === 'review_required') {
    // A human is already looking at this account. `reverify_requested` is
    // legal from `review_required`, so without this an automated caller could
    // walk an escalated case straight back into `pending` and out of the queue
    // it was put in — automation undoing a human's involvement, which is the
    // shape commitment 2 exists to forbid. The kernel's edge is the backstop;
    // this is the refusal that explains itself.
    return refuse('conflict', 'a human review is already open on this account', {
      state: 'review_required',
    });
  }

  const open = context.history.find((entry) => isOpenAttempt(entry.attemptState));
  if (open !== undefined) {
    return refuse('conflict', 'a verification attempt is already in flight', {
      attemptState: open.attemptState,
    });
  }

  const requestedAts = context.history
    .filter(
      (entry) =>
        entry.reVerification &&
        entry.requestedAt.getTime() > command.now.getTime() - WINDOW_MS,
    )
    .map((entry) => entry.requestedAt.getTime());
  const requested = requestedAts.length;
  if (requested >= REVERIFICATION_POLICY.maxPerSubjectPer30Days) {
    raise(
      'per_subject_per_30_days',
      new Date(Math.min(...requestedAts) + WINDOW_MS),
      requested,
    );
    return refuse('rate_limited', 're-verification limit reached for this subject', {
      requested,
      limit: REVERIFICATION_POLICY.maxPerSubjectPer30Days,
    });
  }

  const lastRequestedAt = requestedAts.length > 0 ? Math.max(...requestedAts) : null;
  if (lastRequestedAt !== null) {
    const hoursSince = (command.now.getTime() - lastRequestedAt) / (60 * 60 * 1000);
    if (hoursSince < REVERIFICATION_POLICY.cooldownHours) {
      raise(
        'cooldown',
        new Date(lastRequestedAt + REVERIFICATION_POLICY.cooldownHours * 60 * 60 * 1000),
        requested,
      );
      return refuse('rate_limited', 're-verification cooldown has not elapsed', {
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
