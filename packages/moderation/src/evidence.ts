import {
  type ActorId,
  type CaseId,
  type CorrelationId,
  type DataSensitivity,
  type DomainError,
  type ReportId,
  type Result,
  type UserId,
  domainError,
  ok,
} from '@been-there/core';
import type { EvidenceId } from './ids.js';
import type { ModerationContext } from './events.js';

/**
 * Evidence (issue #7).
 *
 * Two rules make evidence usable in a moderation process that has to survive
 * being audited:
 *
 *  1. **Captured at the time, never reconstructed.** An `EvidenceRecord` is
 *     minted by `captureEvidence` at the moment the behaviour happened and is
 *     `readonly` end to end — the type has no mutator. A case points at evidence
 *     by id; it never edits, summarises over, or re-captures it. That is what
 *     makes a report still reviewable after the match that produced it is gone.
 *  2. **Access is a property of the evidence type, not of the case.** Every
 *     `EvidenceKind` carries a fixed clearance and sensitivity in
 *     `EVIDENCE_POLICY`, so "may this moderator see this" is answered by data
 *     rather than by remembering.
 */
export type EvidenceKind =
  | 'message_snapshot'
  | 'conversation_snapshot'
  | 'profile_snapshot'
  | 'photo_snapshot'
  | 'report_statement'
  | 'risk_assessment'
  | 'account_history'
  | 'device_signal'
  | 'ip_or_location'
  | 'moderator_note'
  | 'identity_anomaly'
  | 'identity_artefact';

export type EvidenceSourceDomain =
  | 'moderation'
  | 'communication'
  | 'trust-safety'
  | 'identity'
  | 'dating-core';

/**
 * Clearance ladder. `reviewer` < `escalated_reviewer` < `lead`, and
 * `identity_privacy_officer` sits outside the moderation hierarchy entirely:
 * it is the only role that may read raw identity artefacts, and it is not a
 * promotion of a moderator.
 */
export type ReviewerClearance =
  | 'reviewer'
  | 'escalated_reviewer'
  | 'lead'
  | 'identity_privacy_officer';

export const CLEARANCE_RANK: Readonly<Record<ReviewerClearance, number>> = {
  reviewer: 0,
  escalated_reviewer: 1,
  lead: 2,
  identity_privacy_officer: 3,
};

export interface EvidencePolicy {
  /** Minimum clearance that may read the artefact itself. */
  readonly access: ReviewerClearance;
  /** Classification of the artefact's contents (issue #8, per field). */
  readonly sensitivity: DataSensitivity;
  /** Why the access level is what it is — a reviewable diff, not a guess. */
  readonly rationale: string;
}

export const EVIDENCE_POLICY: Readonly<Record<EvidenceKind, EvidencePolicy>> = {
  message_snapshot: {
    access: 'reviewer',
    sensitivity: 'restricted',
    rationale: 'The reported message is the behaviour under review; any reviewer needs it.',
  },
  conversation_snapshot: {
    access: 'reviewer',
    sensitivity: 'restricted',
    rationale: 'Surrounding context decides intent; a reviewer cannot judge a line in isolation.',
  },
  profile_snapshot: {
    access: 'reviewer',
    sensitivity: 'restricted',
    rationale: 'A frozen copy of the profile as the reporter saw it at report time.',
  },
  photo_snapshot: {
    access: 'reviewer',
    sensitivity: 'restricted',
    rationale: 'Frozen copy of the reported photo, including later-deleted content.',
  },
  report_statement: {
    access: 'reviewer',
    sensitivity: 'restricted',
    rationale: "The reporter's own words, retained even when the report is anonymous.",
  },
  risk_assessment: {
    access: 'reviewer',
    sensitivity: 'internal',
    rationale: 'Risk state and detector names as rationale, never as a verdict.',
  },
  account_history: {
    access: 'reviewer',
    sensitivity: 'restricted',
    rationale: 'Prior decisions for this subject; repeat behaviour is context, not proof.',
  },
  device_signal: {
    access: 'escalated_reviewer',
    sensitivity: 'internal',
    rationale: 'Device and session forensics invite over-reading; only escalated work justifies it.',
  },
  ip_or_location: {
    access: 'escalated_reviewer',
    sensitivity: 'sensitive',
    rationale: 'Exact coordinates are sensitive and never reach a plain reviewer.',
  },
  moderator_note: {
    access: 'reviewer',
    sensitivity: 'restricted',
    rationale: 'Case working notes; the next reviewer needs them.',
  },
  identity_anomaly: {
    access: 'identity_privacy_officer',
    sensitivity: 'sensitive',
    rationale: 'A moderator may know an anomaly exists; only the identity domain may see the result.',
  },
  identity_artefact: {
    access: 'identity_privacy_officer',
    sensitivity: 'sensitive',
    rationale: 'Raw selfie/liveness artefacts never appear in a moderation surface, in any form.',
  },
};

/** Where the evidence came from, fixed at capture. */
export type EvidenceCapture =
  | { readonly at: 'report_submission'; readonly reportId: ReportId }
  | { readonly at: 'case_intake'; readonly caseId: CaseId }
  | { readonly at: 'review'; readonly caseId: CaseId; readonly moderatorId: ActorId };

export interface EvidenceRecord {
  readonly evidenceId: EvidenceId;
  readonly kind: EvidenceKind;
  readonly subjectId: UserId;
  /** Set once, at capture. Never "when we got round to filing it". */
  readonly capturedAt: Date;
  readonly capture: EvidenceCapture;
  readonly sourceDomain: EvidenceSourceDomain;
  readonly artefactReference: string;
  /** Content hash, so a later reviewer can prove the artefact has not changed. */
  readonly digest: string;
  /** The one line that is safe at every clearance, including no clearance. */
  readonly redactedSummary: string;
  readonly access: ReviewerClearance;
  readonly sensitivity: DataSensitivity;
  /** null until the per-market retention policy exists (see open questions). */
  readonly retentionExpiresAt: Date | null;
}

export interface CaptureEvidenceSpec {
  readonly kind: EvidenceKind;
  readonly subjectId: UserId;
  readonly sourceDomain: EvidenceSourceDomain;
  readonly artefactReference: string;
  readonly digest: string;
  readonly redactedSummary: string;
  readonly capture: EvidenceCapture;
  readonly caseId: CaseId | null;
  readonly actorId: ActorId | 'system';
  readonly correlationId: CorrelationId;
  readonly retentionExpiresAt?: Date | null | undefined;
}

/**
 * The only constructor. Anything that wants evidence goes through here, so
 * nothing reaches a case without an audit row naming the moment of capture.
 */
export function captureEvidence(
  ctx: ModerationContext,
  spec: CaptureEvidenceSpec,
): Result<EvidenceRecord, DomainError> {
  if (spec.redactedSummary.trim().length === 0) {
    return domainError(
      'validation_failed',
      'moderation.evidence',
      'evidence must carry a redacted summary: it is the only field visible without clearance',
      { kind: spec.kind },
    );
  }
  const policy = EVIDENCE_POLICY[spec.kind];
  const record: EvidenceRecord = {
    evidenceId: ctx.ids.next(),
    kind: spec.kind,
    subjectId: spec.subjectId,
    capturedAt: ctx.now(),
    capture: spec.capture,
    sourceDomain: spec.sourceDomain,
    artefactReference: spec.artefactReference,
    digest: spec.digest,
    redactedSummary: spec.redactedSummary,
    access: policy.access,
    sensitivity: policy.sensitivity,
    retentionExpiresAt: spec.retentionExpiresAt ?? null,
  };

  ctx.audit.append({
    occurredAt: record.capturedAt,
    actorId: spec.actorId,
    action: 'evidence.captured',
    entityType: 'evidence',
    entityId: record.evidenceId,
    subjectId: record.subjectId,
    caseId: spec.caseId,
    evidenceIds: [record.evidenceId],
    decisionId: null,
    outcome: 'allowed',
    reversal: null,
    detail: { kind: record.kind, sourceDomain: record.sourceDomain, access: record.access },
  });
  ctx.events.emit({
    type: 'moderation.evidence_captured',
    actorId: spec.actorId,
    subjectId: record.subjectId,
    correlationId: spec.correlationId,
    sensitivity: 'restricted',
    payload: { evidenceId: record.evidenceId, kind: record.kind },
  });

  return ok(record);
}

/**
 * A human working the queue. `identityPrivacyRole` is a separate appointment
 * outside the moderation hierarchy, not a moderator seniority level.
 */
export interface ModeratorActor {
  readonly actorId: ActorId;
  readonly isLead: boolean;
  readonly identityPrivacyRole: boolean;
}

export function clearanceFor(actor: ModeratorActor): ReviewerClearance {
  if (actor.identityPrivacyRole) {
    return 'identity_privacy_officer';
  }
  return actor.isLead ? 'lead' : 'reviewer';
}

export type EvidenceView =
  | {
      readonly visibility: 'full';
      readonly evidenceId: EvidenceId;
      readonly kind: EvidenceKind;
      readonly capturedAt: Date;
      readonly artefactReference: string;
      readonly digest: string;
      readonly redactedSummary: string;
    }
  | {
      /** Never the artefact. Only the summary — enough to run the case on. */
      readonly visibility: 'redacted';
      readonly evidenceId: EvidenceId;
      readonly kind: EvidenceKind;
      readonly capturedAt: Date;
      readonly redactedSummary: string;
    }
  | { readonly visibility: 'denied'; readonly evidenceId: EvidenceId; readonly kind: EvidenceKind };

/**
 * The redaction gate. Three outcomes, not two, because raw identity evidence is
 * not merely hidden from a moderator — it is redacted, and the case continues on
 * the summary. A plain reviewer asking for identity artefacts is `denied`; a
 * lead asking for them is `redacted`, and stays redacted.
 */
export function readEvidence(
  ctx: ModerationContext,
  actor: ModeratorActor,
  record: EvidenceRecord,
  caseId: CaseId | null = null,
): EvidenceView {
  const clearance = clearanceFor(actor);
  const base = { evidenceId: record.evidenceId, kind: record.kind, capturedAt: record.capturedAt };

  let view: EvidenceView;
  if (record.access === 'identity_privacy_officer') {
    view = actor.identityPrivacyRole
      ? {
          visibility: 'full',
          ...base,
          artefactReference: record.artefactReference,
          digest: record.digest,
          redactedSummary: record.redactedSummary,
        }
      : { visibility: 'redacted', ...base, redactedSummary: record.redactedSummary };
  } else if (CLEARANCE_RANK[clearance] >= CLEARANCE_RANK[record.access]) {
    view = {
      visibility: 'full',
      ...base,
      artefactReference: record.artefactReference,
      digest: record.digest,
      redactedSummary: record.redactedSummary,
    };
  } else {
    view = { visibility: 'denied', ...base };
  }

  ctx.audit.append({
    occurredAt: ctx.now(),
    actorId: actor.actorId,
    action: view.visibility === 'denied' ? 'evidence.read_denied' : 'evidence.read',
    entityType: 'evidence',
    entityId: record.evidenceId,
    subjectId: record.subjectId,
    caseId,
    evidenceIds: [record.evidenceId],
    decisionId: null,
    outcome: view.visibility === 'denied' ? 'denied' : 'allowed',
    reversal: null,
    detail: { visibility: view.visibility, clearance, required: record.access },
  });

  return view;
}
