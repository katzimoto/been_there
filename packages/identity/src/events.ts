import {
  type ActorId,
  type CorrelationId,
  type DataSensitivity,
  type DomainEvent,
  type EventId,
  type SubjectId,
  castId,
} from '@been-there/core';
import type { AnomalyFinding } from './anomaly.js';
import type { EvidenceAccessAuditEntry } from './evidence.js';
import type { IdentityStatusProjection } from './read-model.js';
import type { ReverificationRequester, ReverificationReason } from './reverification.js';

/**
 * The events this domain publishes (issue #3).
 *
 * Sensitivity is declared per event, in one table, so a review question is
 * "is this row's classification right?" rather than "what does this payload
 * leak?". The distribution is the design:
 *
 *  - exactly one `public` event, and its payload is the public projection, so
 *    discovery can be driven by the bus alone;
 *  - `internal` for operational facts a product domain may usefully know but
 *    must never render;
 *  - `sensitive` for anomaly findings — the safety domains may read them, the
 *    product may not;
 *  - `restricted` for evidence access, because the access log is the record
 *    that survives the artefact.
 */

export const IDENTITY_EVENTS = {
  /** The only event the dating product is allowed to consume. */
  statusChanged: 'identity.status_changed',
  attemptStarted: 'verification.attempt.started',
  attemptCompleted: 'verification.attempt.completed',
  reviewProposed: 'verification.review.proposed',
  anomalyDetected: 'verification.anomaly',
  reVerificationRequested: 'verification.re_verification.requested',
  evidenceAccessed: 'verification.evidence.accessed',
} as const;

export type IdentityEventType = (typeof IDENTITY_EVENTS)[keyof typeof IDENTITY_EVENTS];

export interface IdentityEventDefinition {
  readonly version: number;
  readonly sensitivity: DataSensitivity;
  readonly description: string;
}

/**
 * The catalogue as a record rather than a list, because the lookup used when
 * building an event must be total: an event type that is not a key is
 * unrepresentable at the type level, so there is no runtime "unknown event"
 * case to handle.
 */
export const IDENTITY_EVENT_CATALOGUE: Readonly<
  Record<IdentityEventType, IdentityEventDefinition>
> = {
  [IDENTITY_EVENTS.statusChanged]: {
    version: 1,
    // Public because discovery is driven by it. The payload is the projection
    // and nothing else, which is what makes "public" safe here.
    sensitivity: 'public',
    description: 'The subject identity state changed. Payload is the public projection.',
  },
  [IDENTITY_EVENTS.attemptStarted]: {
    version: 1,
    sensitivity: 'internal',
    description: 'A verification attempt was opened. Never rendered to a user.',
  },
  [IDENTITY_EVENTS.attemptCompleted]: {
    version: 1,
    sensitivity: 'internal',
    description:
      'An attempt reached a terminal or review state, with the decision label and the confidence band. No evidence, no provider reason text.',
  },
  [IDENTITY_EVENTS.reviewProposed]: {
    version: 1,
    sensitivity: 'sensitive',
    description: 'A finding requires a human review before any outcome is granted.',
  },
  [IDENTITY_EVENTS.anomalyDetected]: {
    version: 1,
    sensitivity: 'sensitive',
    description: 'Identity anomaly findings, as counts and codes only.',
  },
  [IDENTITY_EVENTS.reVerificationRequested]: {
    version: 1,
    sensitivity: 'internal',
    description: 'A re-verification was authorised, with the requesting domain and reason code.',
  },
  [IDENTITY_EVENTS.evidenceAccessed]: {
    version: 1,
    sensitivity: 'restricted',
    description: 'An audited read of verification evidence, granted or denied.',
  },
};

/* -------------------------------------------------------------------------- */
/* Payloads                                                                    */
/* -------------------------------------------------------------------------- */

export interface StatusChangedPayload {
  readonly identity: IdentityStatusProjection;
}

export interface AttemptStartedPayload {
  readonly verificationId: string;
  readonly reVerification: boolean;
  readonly reasonCode: string;
}

export interface AttemptCompletedPayload {
  readonly verificationId: string;
  readonly attemptState: string;
  readonly decision: 'pass' | 'fail' | 'manual_review';
  /** Band only. The raw score stays inside the identity domain. */
  readonly confidenceBand: string;
}

export interface ReviewProposedPayload {
  readonly subjectId: SubjectId;
  readonly detector: string;
  readonly findings: readonly AnomalyFinding[];
}

export interface AnomalyDetectedPayload {
  readonly subjectId: SubjectId;
  readonly findings: readonly AnomalyFinding[];
}

export interface ReVerificationRequestedPayload {
  readonly subjectId: SubjectId;
  readonly reason: ReverificationReason;
  readonly requestedBy: ReverificationRequester['kind'];
}

export interface EvidenceAccessedPayload {
  readonly entry: EvidenceAccessAuditEntry;
}

export interface IdentityEventPayloads {
  [IDENTITY_EVENTS.statusChanged]: StatusChangedPayload;
  [IDENTITY_EVENTS.attemptStarted]: AttemptStartedPayload;
  [IDENTITY_EVENTS.attemptCompleted]: AttemptCompletedPayload;
  [IDENTITY_EVENTS.reviewProposed]: ReviewProposedPayload;
  [IDENTITY_EVENTS.anomalyDetected]: AnomalyDetectedPayload;
  [IDENTITY_EVENTS.reVerificationRequested]: ReVerificationRequestedPayload;
  [IDENTITY_EVENTS.evidenceAccessed]: EvidenceAccessedPayload;
}

export interface PublishIdentityEventInput<T extends IdentityEventType> {
  readonly type: T;
  readonly eventId: EventId;
  readonly payload: IdentityEventPayloads[T];
  readonly subjectId?: SubjectId;
  readonly actorId: ActorId | 'system';
  readonly correlationId: CorrelationId;
  readonly causationId?: EventId;
  readonly occurredAt: Date;
}

/**
 * Builds a catalogue-typed event. Sensitivity is never passed in by the caller:
 * it comes from the catalogue row, so an event cannot be published at a lower
 * classification than its type allows by mistake.
 */
export function buildIdentityEvent<T extends IdentityEventType>(
  input: PublishIdentityEventInput<T>,
): DomainEvent<IdentityEventPayloads[T]> {
  const definition = IDENTITY_EVENT_CATALOGUE[input.type];
  return {
    eventId: input.eventId,
    type: input.type,
    version: definition.version,
    occurredAt: input.occurredAt,
    actorId: input.actorId,
    ...(input.subjectId === undefined ? {} : { subjectId: input.subjectId }),
    correlationId: input.correlationId,
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    sensitivity: definition.sensitivity,
    payload: input.payload,
  };
}
