import {
  type ActorId,
  type DataSensitivity,
  type DomainError,
  type Result,
  type VerificationId,
  domainError,
  ok,
} from '@been-there/core';

/**
 * Verification evidence (issue #3).
 *
 * The most sensitive data the platform holds. A selfie is not a password that
 * can be rotated: if a face template leaks, the person has to live with it.
 * Three decisions follow from that, and all three are in this file.
 *
 *  1. Evidence is `restricted`, one class stricter than the `sensitive`
 *     artefacts named in the overview's sensitivity table. The overview
 *     classifies *per field* (commitment 7) and raw biometrics are the one
 *     field class that cannot be reissued, so they take the strictest
 *     classification rather than the one that happens to sit in a list.
 *  2. The domain holds references, never bytes. `VerificationEvidence` has no
 *     field that can carry an image, a video, or a presigned URL, so evidence
 *     cannot leak through a return type, a log line, or an event payload.
 *  3. Every read is granted, logged, short-lived, and single-use.
 */

export type EvidenceKind =
  | 'government_id_image'
  | 'selfie_image'
  | 'liveness_video'
  | 'document_text_extract'
  | 'provider_response';

/** Kinds that are biometric. These get the shortest retention. */
export const BIOMETRIC_EVIDENCE_KINDS: readonly EvidenceKind[] = [
  'government_id_image',
  'selfie_image',
  'liveness_video',
];

export const EVIDENCE_SENSITIVITY = 'restricted' as const satisfies DataSensitivity;

export interface VerificationEvidence {
  readonly kind: EvidenceKind;
  readonly verificationId: VerificationId;
  readonly capturedAt: Date;
  /**
   * Opaque, non-guessable, access-controlled storage locator. Deliberately not
   * a URL: a URL is something that ends up in a log line.
   */
  readonly storageRef: string;
  /** Pinned to the literal, so the classification cannot drift per record. */
  readonly sensitivity: typeof EVIDENCE_SENSITIVITY;
  /** SHA-256 digest for integrity and dedupe. Non-reversible by construction. */
  readonly digest: string;
  /** Hard deletion deadline, computed once by `EVIDENCE_RETENTION`. */
  readonly expiresAt: Date;
}

/**
 * Retention policy. These numbers are the product's privacy promise, so they
 * are a named constant with a stated reason rather than a value sprinkled
 * through a job.
 */
export const EVIDENCE_RETENTION = {
  /**
   * Biometric artefacts are deleted 30 days after capture. Long enough to cover
   * the appeal window a real user needs; short enough that a breach of the
   * evidence store does not become a breach of everyone's face. Pending a
   * per-market legal answer (see Open questions).
   */
  biometricArtefactDays: 30,
  /**
   * Non-biometric extracts (OCR text, provider verdicts) live 180 days: they
   * support appeals and provider disputes, and they are re-derivable from a
   * document the user can re-upload.
   */
  derivedExtractDays: 180,
  /**
   * Access logs outlive the evidence they describe. An audit trail that is
   * deleted with the artefact cannot answer "who looked at this?", which is
   * the only question the log exists for. 7 years is the common baseline for
   * this class of record; it is a placeholder pending the market answer.
   */
  accessLogDays: 2555,
  /** A legal hold suspends deletion. It is recorded, never silent. */
  legalHoldSuspendsDeletion: true,
  /**
   * A fresh capture of the same kind supersedes the earlier one. Evidence must
   * not accumulate as a user retries a blurry photo.
   */
  reCaptureSupersedes: true,
} as const;

export function evidenceRetentionDays(kind: EvidenceKind): number {
  return BIOMETRIC_EVIDENCE_KINDS.includes(kind)
    ? EVIDENCE_RETENTION.biometricArtefactDays
    : EVIDENCE_RETENTION.derivedExtractDays;
}

export function evidenceExpiry(kind: EvidenceKind, capturedAt: Date): Date {
  const expires = new Date(capturedAt.getTime());
  expires.setUTCDate(expires.getUTCDate() + evidenceRetentionDays(kind));
  return expires;
}

/** Drops everything past its retention deadline. The deletion job's domain logic. */
export function purgeDueEvidence(
  evidence: readonly VerificationEvidence[],
  now: Date,
): readonly VerificationEvidence[] {
  return evidence.filter((item) => item.expiresAt.getTime() > now.getTime());
}

/* -------------------------------------------------------------------------- */
/* Audited access                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Roles permitted to open evidence. A role is not a person: every grant is
 * additionally attributed to a named `actorId` and written to the log.
 */
export const EVIDENCE_ACCESS_ROLES = ['moderator', 'identity_reviewer', 'identity_ops'] as const;

export type EvidenceAccessRole = (typeof EVIDENCE_ACCESS_ROLES)[number];

export interface EvidenceAccessRequest {
  readonly verificationId: VerificationId;
  readonly actorId: ActorId;
  /** `system` covers detectors, jobs, and services. See the denial rule below. */
  readonly actorKind: 'human' | 'system';
  readonly role: EvidenceAccessRole | null;
  /** Recorded verbatim in the log. The record is the accountability. */
  readonly justification: string;
  readonly now: Date;
}

export interface EvidenceAccessAuditEntry {
  readonly at: Date;
  readonly actorId: ActorId;
  readonly verificationId: VerificationId;
  readonly outcome: 'granted' | 'denied';
  readonly denialCode: string | null;
  readonly justification: string;
}

export interface EvidenceAccessLog {
  append(entry: EvidenceAccessAuditEntry): void;
}

export interface EvidenceAccessGrant {
  readonly verificationId: VerificationId;
  /** One artefact per kind, exactly the unexpired ones. */
  readonly storageRefs: readonly string[];
  readonly grantedAt: Date;
  readonly expiresAt: Date;
  /** Evidence grants are single-use: re-reading requires a new audited grant. */
  readonly maxUses: 1;
}

export const EVIDENCE_ACCESS_RULES = {
  /**
   * A grant lasts 15 minutes. Long enough to open a document and a selfie,
   * short enough that a leaked URL dies on its own.
   */
  grantTtlMinutes: 15,
  /** "I am an operator" is not a justification. */
  minJustificationLength: 24,
} as const;

/**
 * Grants access to evidence, or explains why not. Every outcome is written to
 * the audit log before the function returns — a denial is a record too, because
 * the denial is exactly what a reviewer will ask to see after an incident.
 *
 * Denial order is deliberate: the actor is checked before the justification and
 * before whether any evidence even exists, so an unauthorised caller learns
 * nothing about what is on file.
 */
export function grantEvidenceAccess(
  request: EvidenceAccessRequest,
  evidence: readonly VerificationEvidence[],
  log: EvidenceAccessLog,
): Result<EvidenceAccessGrant, DomainError> {
  const denial = (
    code: 'permission_denied' | 'validation_failed' | 'not_found',
    message: string,
    details?: Readonly<Record<string, string | number | boolean | null>>,
  ): Result<EvidenceAccessGrant, DomainError> => {
    log.append({
      at: request.now,
      actorId: request.actorId,
      verificationId: request.verificationId,
      outcome: 'denied',
      denialCode: code,
      justification: request.justification,
    });
    return domainError(code, 'identity', message, details);
  };

  if (request.actorKind === 'system') {
    return denial('permission_denied', 'automated actors may never read identity evidence');
  }
  if (request.role === null || !EVIDENCE_ACCESS_ROLES.includes(request.role)) {
    return denial('permission_denied', 'role is not permitted to read identity evidence');
  }
  if (request.justification.trim().length < EVIDENCE_ACCESS_RULES.minJustificationLength) {
    return denial('validation_failed', 'a substantive justification is required');
  }

  const live = evidence.filter(
    (item) =>
      item.verificationId === request.verificationId &&
      item.expiresAt.getTime() > request.now.getTime(),
  );
  if (live.length === 0) {
    return denial('not_found', 'no retained evidence for this verification');
  }

  const grantedAt = request.now;
  const expiresAt = new Date(grantedAt.getTime() + EVIDENCE_ACCESS_RULES.grantTtlMinutes * 60_000);
  log.append({
    at: grantedAt,
    actorId: request.actorId,
    verificationId: request.verificationId,
    outcome: 'granted',
    denialCode: null,
    justification: request.justification,
  });
  return ok({
    verificationId: request.verificationId,
    storageRefs: live.map((item) => item.storageRef),
    grantedAt,
    expiresAt,
    maxUses: 1,
  });
}
