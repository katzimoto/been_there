import type {
  ActorId,
  CorrelationId,
  DomainEvent,
  EventId,
  RiskAssessmentId,
  RiskState,
  SubjectId,
} from '@been-there/core';
import type { FrictionKind, ReversibleFriction } from './friction.js';
import type { ReviewCandidate, ReviewOrigin, ReviewTarget } from './review.js';

/**
 * Everything this domain publishes. Three types, all `internal`, none of them
 * user-visible. The set is closed so a reviewer can enumerate every automated
 * statement the platform makes about risk.
 */
export const TRUST_SAFETY_EVENT_TYPES = ['risk.changed', 'review_candidate.raised', 'friction.proposed'] as const;

export type TrustSafetyEventType = (typeof TRUST_SAFETY_EVENT_TYPES)[number];

/**
 * Safety output is never `public`.
 *
 * Narrowing this alias from `'internal'` to a union that includes `'public'` is
 * a compile error at every builder, which is the point: making risk observable
 * to a client has to be argued for, not done by adding a payload field.
 */
export type TrustSafetyEventSensitivity = 'internal';

export const TRUST_SAFETY_EVENT_SENSITIVITY: Readonly<
  Record<TrustSafetyEventType, TrustSafetyEventSensitivity>
> = {
  'risk.changed': 'internal',
  'review_candidate.raised': 'internal',
  'friction.proposed': 'internal',
};

export type RiskChangeReason = 'signal' | 'decay' | 'human_reassess';

export interface RiskChangedPayload {
  readonly subjectId: SubjectId;
  readonly assessmentId: RiskAssessmentId;
  readonly from: RiskState;
  readonly to: RiskState;
  readonly reason: RiskChangeReason;
  /** Detectors that contributed. Moderator-facing rationale, never user copy. */
  readonly detectors: readonly string[];
  /** Effective score that produced the move, 0..1. */
  readonly effectiveScore: number;
}

export interface ReviewCandidateRaisedPayload {
  readonly target: ReviewTarget;
  readonly state: RiskState;
  readonly origin: ReviewOrigin;
  /** Detector names behind the raise. */
  readonly independentDetectors: readonly string[];
  readonly confidence: number;
  readonly expiresAt: Date;
}

export interface FrictionProposedPayload {
  readonly subjectId: SubjectId;
  readonly kind: FrictionKind;
  readonly reason: string;
  readonly expiresAt: Date;
  readonly reversible: true;
}

export interface EventEnvelope {
  readonly eventId: EventId;
  readonly occurredAt: Date;
  readonly correlationId: CorrelationId;
  readonly causationId?: EventId;
}

/** Every builder narrows the envelope's sensitivity to the closed `internal` alias. */
export type TrustSafetyEventOf<T extends TrustSafetyEventType, P> = DomainEvent<P> & {
  readonly type: T;
  readonly sensitivity: TrustSafetyEventSensitivity;
};

export type TrustSafetyEvent =
  | TrustSafetyEventOf<'risk.changed', RiskChangedPayload>
  | TrustSafetyEventOf<'review_candidate.raised', ReviewCandidateRaisedPayload>
  | TrustSafetyEventOf<'friction.proposed', FrictionProposedPayload>;

function publish<T extends TrustSafetyEventType, P>(
  type: T,
  event: EventEnvelope,
  subjectId: SubjectId | undefined,
  actorId: ActorId | 'system',
  payload: P,
): TrustSafetyEventOf<T, P> {
  return {
    eventId: event.eventId,
    type,
    version: 1,
    occurredAt: event.occurredAt,
    actorId,
    ...(subjectId === undefined ? {} : { subjectId }),
    correlationId: event.correlationId,
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    sensitivity: TRUST_SAFETY_EVENT_SENSITIVITY[type],
    payload,
  };
}

export function riskChanged(
  event: EventEnvelope,
  payload: RiskChangedPayload,
): TrustSafetyEventOf<'risk.changed', RiskChangedPayload> {
  return publish('risk.changed', event, payload.subjectId, 'system', payload);
}

export function reviewCandidateRaised(
  event: EventEnvelope,
  candidate: ReviewCandidate,
): TrustSafetyEventOf<'review_candidate.raised', ReviewCandidateRaisedPayload> {
  return publish(
    'review_candidate.raised',
    event,
    candidate.target.kind === 'account' ? candidate.target.subjectId : undefined,
    'system',
    {
      target: candidate.target,
      state: candidate.state,
      origin: candidate.origin,
      independentDetectors: candidate.detectors,
      confidence: candidate.confidence,
      expiresAt: candidate.expiresAt,
    },
  );
}

export function frictionProposed(
  event: EventEnvelope,
  friction: ReversibleFriction,
): TrustSafetyEventOf<'friction.proposed', FrictionProposedPayload> {
  return publish('friction.proposed', event, friction.subjectId, 'system', {
    subjectId: friction.subjectId,
    kind: friction.kind,
    reason: friction.reason,
    expiresAt: friction.expiresAt,
    reversible: friction.reversible,
  });
}
