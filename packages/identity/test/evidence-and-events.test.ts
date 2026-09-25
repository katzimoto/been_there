import { describe, expect, it } from 'vitest';
import {
  type ActorId,
  type DomainError,
  type EventId,
  type Result,
  type SubjectId,
  type VerificationId,
  InMemoryEventBus,
  castId,
  isClearedToConsume,
} from '@been-there/core';
import {
  EVIDENCE_ACCESS_RULES,
  EVIDENCE_RETENTION,
  EVIDENCE_SENSITIVITY,
  type EvidenceAccessAuditEntry,
  type EvidenceAccessLog,
  type EvidenceAccessRequest,
  type EvidenceKind,
  IDENTITY_EVENTS,
  IDENTITY_EVENT_CATALOGUE,
  type IdentityStatusProjection,
  type VerificationEvidence,
  buildIdentityEvent,
  evidenceExpiry,
  evidenceRetentionDays,
  grantEvidenceAccess,
  projectIdentityStatus,
  purgeDueEvidence,
} from '../src/index.js';
import { SUBJECT, T0, daysLater, hoursLater } from './support.js';

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

class RecordingLog implements EvidenceAccessLog {
  readonly entries: EvidenceAccessAuditEntry[] = [];
  append(entry: EvidenceAccessAuditEntry): void {
    this.entries.push(entry);
  }
}

const VERIFICATION = castId<'VerificationId'>('vrf-1');

function evidence(kind: EvidenceKind, capturedAt: Date = T0): VerificationEvidence {
  return {
    kind,
    verificationId: VERIFICATION,
    capturedAt,
    storageRef: `ref:${kind}`,
    sensitivity: EVIDENCE_SENSITIVITY,
    digest: 'sha256:abc',
    expiresAt: evidenceExpiry(kind, capturedAt),
  };
}

function accessRequest(overrides: Partial<EvidenceAccessRequest> = {}): EvidenceAccessRequest {
  return {
    verificationId: VERIFICATION,
    actorId: castId<'ActorId'>('mod-9'),
    actorKind: 'human',
    role: 'moderator',
    justification: 'Appealing report case-1, checking the document capture.',
    now: T0,
    ...overrides,
  };
}

describe('evidence retention', () => {
  it('deletes biometric artefacts far sooner than derived text', () => {
    expect(evidenceRetentionDays('selfie_image')).toBe(EVIDENCE_RETENTION.biometricArtefactDays);
    expect(evidenceRetentionDays('government_id_image')).toBe(
      EVIDENCE_RETENTION.biometricArtefactDays,
    );
    expect(evidenceRetentionDays('document_text_extract')).toBe(
      EVIDENCE_RETENTION.derivedExtractDays,
    );
    expect(EVIDENCE_RETENTION.biometricArtefactDays).toBeLessThan(
      EVIDENCE_RETENTION.derivedExtractDays,
    );
  });

  it('keeps the access log long after the artefact it describes', () => {
    expect(EVIDENCE_RETENTION.accessLogDays).toBeGreaterThan(EVIDENCE_RETENTION.derivedExtractDays);
  });

  it('drops exactly the artefacts past their deadline', () => {
    const old = evidence('selfie_image', daysLater(-40));
    const fresh = evidence('selfie_image', daysLater(-2));
    const extract = evidence('document_text_extract', daysLater(-40));
    const survivors = purgeDueEvidence([old, fresh, extract], T0);
    expect(survivors.map((item) => item.storageRef)).toEqual([
      'ref:selfie_image',
      'ref:document_text_extract',
    ]);
  });

  it('classifies every artefact as restricted', () => {
    expect(EVIDENCE_SENSITIVITY).toBe('restricted');
    for (const kind of [
      'government_id_image',
      'selfie_image',
      'liveness_video',
      'document_text_extract',
      'provider_response',
    ] as const) {
      expect(evidence(kind).sensitivity).toBe('restricted');
    }
  });
});

describe('audited evidence access', () => {
  const stored = [evidence('selfie_image'), evidence('government_id_image')];

  it('grants only the unexpired artefacts, once, for a short window', () => {
    const log = new RecordingLog();
    const grant = succeeded(grantEvidenceAccess(accessRequest(), stored, log));
    expect(grant.storageRefs.sort()).toEqual(['ref:government_id_image', 'ref:selfie_image']);
    expect(grant.maxUses).toBe(1);
    expect(grant.expiresAt.getTime() - T0.getTime()).toBe(
      EVIDENCE_ACCESS_RULES.grantTtlMinutes * 60_000,
    );
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toEqual({
      at: T0,
      actorId: accessRequest().actorId,
      verificationId: VERIFICATION,
      outcome: 'granted',
      denialCode: null,
      justification: accessRequest().justification,
    });
  });

  it('refuses automation outright, before anything else is considered', () => {
    const log = new RecordingLog();
    const error = errorOf(
      grantEvidenceAccess(accessRequest({ actorKind: 'system', role: null }), [], log),
    );
    expect(error.code).toBe('permission_denied');
    expect(log.entries[0]?.outcome).toBe('denied');
  });

  it('refuses a role that is not on the access list', () => {
    const log = new RecordingLog();
    expect(errorOf(grantEvidenceAccess(accessRequest({ role: null }), stored, log)).code).toBe(
      'permission_denied',
    );
  });

  it('refuses a justification that is not one', () => {
    const log = new RecordingLog();
    const error = errorOf(
      grantEvidenceAccess(accessRequest({ justification: 'checking' }), stored, log),
    );
    expect(error.code).toBe('validation_failed');
  });

  it('reports nothing to grant once retention has run out, and says so in the log', () => {
    const log = new RecordingLog();
    const error = errorOf(grantEvidenceAccess(accessRequest({ now: daysLater(31) }), stored, log));
    expect(error.code).toBe('not_found');
    expect(log.entries).toEqual([
      {
        at: daysLater(31),
        actorId: accessRequest().actorId,
        verificationId: VERIFICATION,
        outcome: 'denied',
        denialCode: 'not_found',
        justification: accessRequest().justification,
      },
    ]);
  });

  it('grants a subset when only some artefacts are still inside retention', () => {
    const log = new RecordingLog();
    const mixed = [
      evidence('selfie_image', daysLater(-29)),
      evidence('liveness_video', daysLater(-40)),
    ];
    const grant = succeeded(grantEvidenceAccess(accessRequest({ now: daysLater(-1) }), mixed, log));
    expect(grant.storageRefs).toEqual(['ref:selfie_image']);
  });

  it('writes exactly one audit record per request, granted or denied', () => {
    const log = new RecordingLog();
    grantEvidenceAccess(accessRequest(), stored, log);
    grantEvidenceAccess(accessRequest({ role: null }), stored, log);
    expect(log.entries.map((entry) => entry.outcome)).toEqual(['granted', 'denied']);
  });
});
