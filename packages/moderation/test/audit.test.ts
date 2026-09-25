import { describe, expect, it } from 'vitest';
import { createAuditLog, decide, readEvidence, triageReport } from '../src/index.js';
import {
  CORRELATION,
  LEAD,
  MODERATOR,
  SUBJECT,
  caseInReview,
  harness,
  makeReport,
  openCaseFromReport,
  succeeded,
} from './support.js';

const RATIONALE = 'Repeated threats after two explicit requests to stop contacting me.';

describe('the audit log', () => {
  it('offers no way to amend or remove a row', () => {
    const log = createAuditLog();
    expect('update' in log).toBe(false);
    expect('delete' in log).toBe(false);
    expect('remove' in log).toBe(false);
    expect(Object.keys(log).sort()).toEqual([
      'append',
      'byActor',
      'byEntity',
      'bySubject',
      'entries',
      'forCase',
    ]);
  });

  it('keeps a total order, and never replaces an earlier row for one entity', () => {
    const h = harness();
    const report = succeeded(makeReport(h));
    succeeded(
      triageReport(h.ctx, { report, moderatorId: MODERATOR.actorId, correlationId: CORRELATION }),
    );

    expect(h.audit.byEntity('report', report.reportId).map((row) => row.action)).toEqual([
      'report.submitted',
      'report.triaged',
    ]);
    expect(h.audit.entries.every((row, index) => row.sequence === index)).toBe(true);

    // The evidence is on the record before the report that cites it.
    const captured = h.audit.byEntity('evidence', report.capturedEvidence[0]!.evidenceId)[0]!;
    const submitted = h.audit.byEntity('report', report.reportId)[0]!;
    expect(captured.sequence).toBeLessThan(submitted.sequence);
  });

  it('answers "what happened to this account" in order', () => {
    const h = harness();
    const reviewed = caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h))));
    succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'restrict',
        rationale: RATIONALE,
        currentAccountState: 'active',
        removedCapabilities: ['send_message'],
        correlationId: CORRELATION,
      }),
    );

    const subjectHistory = h.audit.bySubject(SUBJECT).map((entry) => entry.action);
    expect(subjectHistory).toEqual([
      'evidence.captured',
      'report.submitted',
      'report.triaged',
      'case.opened',
      'case.assigned',
      'case.review_started',
      'decision.recorded',
      'case.resolved',
    ]);
  });

  it('records who decided, on what evidence, and how it can be undone', () => {
    const h = harness();
    const reviewed = caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h))));
    const outcome = succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'ban',
        rationale: RATIONALE,
        currentAccountState: 'active',
        correlationId: CORRELATION,
      }),
    );
    const row = h.audit.byEntity('decision', outcome.decision.decisionId)[0];

    expect(row?.actorId).toBe(MODERATOR.actorId);
    expect(row?.caseId).toBe(outcome.moderationCase.caseId);
    expect(row?.evidenceIds).toEqual(outcome.moderationCase.evidenceIds);
    expect(row?.decisionId).toBe(outcome.decision.decisionId);
    expect(row?.reversal).toEqual({ via: 'account_state', accountEvent: 'lift_ban' });
    expect(row?.detail).toMatchObject({ action: 'ban', fromState: 'active', toState: 'banned' });
  });

  it('records nothing reversible for a decision that carried no sanction', () => {
    const h = harness();
    const reviewed = caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h))));
    const outcome = succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'clear',
        rationale: 'Context shows the messages were a joke between friends.',
        currentAccountState: 'active',
        correlationId: CORRELATION,
      }),
    );

    expect(h.audit.byEntity('decision', outcome.decision.decisionId)[0]?.reversal).toBeNull();
  });

  it('tells one moderator’s actions apart from another’s', () => {
    const h = harness();
    const reviewed = caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h))));
    succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'warn',
        rationale: RATIONALE,
        currentAccountState: 'active',
        correlationId: CORRELATION,
      }),
    );

    expect(h.audit.byActor(MODERATOR.actorId).map((row) => row.action)).toEqual([
      'report.triaged',
      'case.opened',
      'case.assigned',
      'case.review_started',
      'decision.recorded',
      'case.resolved',
    ]);
    expect(h.audit.byActor(LEAD.actorId)).toHaveLength(0);
  });

  it('puts the whole evidence-to-decision chain under one case id', () => {
    const h = harness();
    const report = succeeded(makeReport(h));
    const opened = openCaseFromReport(h, report);
    const reviewed = caseInReview(h, opened);
    const record = report.capturedEvidence[0]!;
    readEvidence(h.ctx, MODERATOR, record, opened.caseId);
    const outcome = succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'suspend',
        rationale: RATIONALE,
        currentAccountState: 'active',
        correlationId: CORRELATION,
      }),
    );

    const chain = h.audit.forCase(outcome.moderationCase.caseId);
    expect(chain.map((row) => row.action)).toEqual([
      'case.opened',
      'case.assigned',
      'case.review_started',
      'evidence.read',
      'decision.recorded',
      'case.resolved',
    ]);
    expect(chain.every((row) => row.caseId === outcome.moderationCase.caseId)).toBe(true);
    const decision = chain.find((row) => row.action === 'decision.recorded');
    expect(decision?.evidenceIds).toEqual(report.capturedEvidence.map((item) => item.evidenceId));
  });
});
