/**
 * `@been-there/identity` — the public entry point of the identity domain.
 *
 * Other domains import from here and only from here. The overview's boundary
 * table calls a cross-domain `src/` import a review rejection, so this file is
 * the boundary: everything reachable from it is public, and everything not in
 * it is an implementation detail of the identity domain.
 *
 * What a consumer is meant to use:
 *
 *  - `IdentityStatusProjection` and `isDiscoverable` for eligibility questions;
 *  - `IDENTITY_EVENTS` and the event payloads for reacting to status changes;
 *  - `requestReVerification` if it holds the authority to demand one;
 *  - `VerificationProvider` to plug a vendor adapter in.
 *
 * What no consumer should want — and what this barrel therefore still exports,
 * but only for the identity domain's own services and tests — is everything
 * about evidence, confidence, and anomaly internals.
 */
export {
  type EvidenceAccessAuditEntry,
  type EvidenceAccessGrant,
  type EvidenceAccessLog,
  type EvidenceAccessRequest,
  type EvidenceAccessRole,
  type EvidenceKind,
  type VerificationEvidence,
  BIOMETRIC_EVIDENCE_KINDS,
  EVIDENCE_ACCESS_ROLES,
  EVIDENCE_ACCESS_RULES,
  EVIDENCE_RETENTION,
  EVIDENCE_SENSITIVITY,
  evidenceExpiry,
  evidenceRetentionDays,
  grantEvidenceAccess,
  purgeDueEvidence,
} from './evidence.js';

export {
  type AnomalyCode,
  type AnomalyFinding,
  type AnomalySeverity,
  type AnomalySignals,
  type ReviewProposal,
  ANOMALY_SEVERITY_RANK,
  ANOMALY_THRESHOLDS,
  detectIdentityAnomalies,
  detectReverificationAbuse,
  maxSeverity,
  proposeReview,
} from './anomaly.js';

export {
  type ConfidenceBand,
  type DecisionInput,
  type IdentityConfidence,
  type VerificationDecision,
  type VerificationDecisionRecord,
  CONFIDENCE_THRESHOLDS,
  classifyConfidence,
  decideVerificationOutcome,
  isBoundedConfidence,
  makeConfidence,
} from './likeness.js';

export {
  type ProviderCheckOutcome,
  type ProviderCheckResult,
  type ProviderFailure,
  type ProviderFailureEffect,
  type ProviderFailureReason,
  type ProviderSession,
  type ProviderSessionRequest,
  type ProviderVerificationResult,
  type VerificationCheck,
  type VerificationProvider,
  REQUIRED_CHECKS,
  classifyProviderFailure,
  providerFailureError,
} from './provider.js';

export {
  type CaptureInput,
  type CompletedVerification,
  type IdentityTransitionProposal,
  type VerificationAttempt,
  type VerificationAttemptContext,
  type VerificationAttemptEvent,
  type VerificationAttemptState,
  type VerificationStartInput,
  type VerificationStartReason,
  type VerificationStartResult,
  ATTEMPT_POLICY,
  attemptMachine,
  beginCapture,
  completeFromProvider,
  expireAttempt,
  isOpenAttempt,
  planVerificationStart,
  recordCapture,
  resolveReview,
  submitToProvider,
} from './verification-request.js';

export {
  REVERIFICATION_AUTHORITIES,
  REVERIFICATION_POLICY,
  type RequestReVerificationCommand,
  type ReverificationContext,
  type ReverificationHistoryEntry,
  type ReverificationPlan,
  type ReverificationReason,
  type ReverificationRefusal,
  type ReverificationRefusalLog,
  type ReverificationRequester,
  requestReVerification,
} from './reverification.js';

export {
  IDENTITY_PROJECTION_VERSION,
  type IdentityStatusProjection,
  hasProjectionChanged,
  projectIdentityStatus,
  toIdentityRecord,
} from './read-model.js';

export {
  type AnomalyDetectedPayload,
  type AttemptCompletedPayload,
  type AttemptStartedPayload,
  type EvidenceAccessedPayload,
  type IdentityEventDefinition,
  type IdentityEventPayloads,
  type IdentityEventType,
  type PublishIdentityEventInput,
  type ReVerificationRequestedPayload,
  type ReviewProposedPayload,
  type StatusChangedPayload,
  IDENTITY_EVENTS,
  IDENTITY_EVENT_CATALOGUE,
  buildIdentityEvent,
} from './events.js';
