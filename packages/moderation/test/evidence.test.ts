import { describe, expect, it } from 'vitest';
import { type EvidenceKind, captureEvidence, openCase, readEvidence } from '../src/index.js';
import {
  CORRELATION,
  IDENTITY_OFFICER,
  LEAD,
  MODERATOR,
  SUBJECT,
  harness,
  identityIntake,
  rejected,
  succeeded,
} from './support.js';

function capture(h: ReturnType<typeof harness>, kind: EvidenceKind, summary = 'A short summary.') {
  return succeeded(
    captureEvidence(h.ctx, {
      kind,
      subjectId: SUBJECT,
      sourceDomain: 'moderation',
      artefactReference: `blob://${kind}`,
      digest: `sha256:${kind}`,
      redactedSummary: summary,
      capture: { at: 'review', caseId: 'case-1' as never, moderatorId: MODERATOR.actorId },
      caseId: 'case-1' as never,
      actorId: MODERATOR.actorId,
      correlationId: CORRELATION,
    }),
  );
}

describe('evidence capture', () => {
  it('records the moment of capture and never moves it', () => {
    const h = harness();
    const record = capture(h, 'message_snapshot');
    h.clock.advanceHours(6);

    expect(record.capturedAt.toISOString()).toBe('2026-01-05T09:00:00.000Z');
    expect(readEvidence(h.ctx, MODERATOR, record).visibility).toBe('full');
    expect(record.capturedAt.toISOString()).toBe('2026-01-05T09:00:00.000Z');
  });

  it('writes an audit row at capture, naming the moment and the case it belongs to', () => {
    const h = harness();
    const record = capture(h, 'message_snapshot');
    const row = h.audit.byEntity('evidence', record.evidenceId)[0];

    expect(row?.action).toBe('evidence.captured');
    expect(row?.actorId).toBe(MODERATOR.actorId);
    expect(row?.caseId).toBe('case-1');
    expect(row?.occurredAt).toEqual(record.capturedAt);
    expect(row?.detail.access).toBe('reviewer');
  });

  it('refuses evidence that has no summary safe to show at any clearance', () => {
    const h = harness();
    const empty = captureEvidence(h.ctx, {
      kind: 'message_snapshot',
      subjectId: SUBJECT,
      sourceDomain: 'moderation',
      artefactReference: 'blob://x',
      digest: 'sha256:x',
      redactedSummary: '   ',
      capture: { at: 'review', caseId: 'case-1' as never, moderatorId: MODERATOR.actorId },
      caseId: 'case-1' as never,
      actorId: MODERATOR.actorId,
      correlationId: CORRELATION,
    });
    expect(rejected(empty).code).toBe('validation_failed');
  });

  it('classifies every evidence kind from one table, so nobody invents a policy', () => {
    const h = harness();
    const kinds: EvidenceKind[] = ['message_snapshot', 'risk_assessment', 'device_signal', 'ip_or_location', 'identity_artefact'];
    const access = kinds.map((kind) => capture(h, kind).access);

    expect(access).toEqual(['reviewer', 'reviewer', 'escalated_reviewer', 'escalated_reviewer', 'identity_privacy_officer']);
  });
});

describe('the redaction gate', () => {
  it('lets a plain reviewer read the behaviour under review', () => {
    const h = harness();
    const view = readEvidence(h.ctx, MODERATOR, capture(h, 'message_snapshot'));

    expect(view.visibility).toBe('full');
    if (view.visibility === 'full') {
      expect(view.artefactReference).toBe('blob://message_snapshot');
      expect(view.digest).toBe('sha256:message_snapshot');
    }
  });

  it('denies a plain reviewer the forensic evidence and records the attempt', () => {
    const h = harness();
    const record = capture(h, 'device_signal');
    const view = readEvidence(h.ctx, MODERATOR, record, 'case-1' as never);

    expect(view.visibility).toBe('denied');
    const row = h.audit.byEntity('evidence', record.evidenceId).at(-1);
    expect(row?.action).toBe('evidence.read_denied');
    expect(row?.outcome).toBe('denied');
    expect(row?.detail).toMatchObject({ visibility: 'denied', clearance: 'reviewer', required: 'escalated_reviewer' });
  });

  it('lets a lead read the forensic evidence, and logs the read', () => {
    const h = harness();
    const record = capture(h, 'device_signal');
    const view = readEvidence(h.ctx, LEAD, record, 'case-1' as never);

    expect(view.visibility).toBe('full');
    const row = h.audit.byEntity('evidence', record.evidenceId).at(-1);
    expect(row?.action).toBe('evidence.read');
    expect(row?.actorId).toBe(LEAD.actorId);
  });

  it('never shows a raw identity artefact to a moderator, at any clearance', () => {
    const h = harness();
    const record = capture(h, 'identity_artefact', 'Identity artefact held by the identity domain.');

    for (const actor of [MODERATOR, LEAD]) {
      const view = readEvidence(h.ctx, actor, record, 'case-1' as never);
      expect(view.visibility).toBe('redacted');
      expect(view).not.toHaveProperty('artefactReference');
      expect(view).not.toHaveProperty('digest');
      if (view.visibility === 'redacted') {
        expect(view.redactedSummary).toBe('Identity artefact held by the identity domain.');
      }
    }
  });

});


describe('evidence captured at intake', () => {
  it('is readable by a reviewer as a redacted summary only', () => {
    const h = harness();
    const opened = succeeded(openCase(h.ctx, identityIntake()));
    const record = opened.evidence[0];

    expect(record?.access).toBe('identity_privacy_officer');
    expect(record?.sensitivity).toBe('sensitive');
    const view = readEvidence(h.ctx, MODERATOR, record!, opened.moderationCase.caseId);
    expect(view.visibility).toBe('redacted');
  });
});
