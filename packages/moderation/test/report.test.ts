import { describe, expect, it } from 'vitest';
import { assertMachineIsTotal, capabilitiesFor, canPerform } from '@been-there/core';
import {
  type CasePriority,
  REPORT_REASON_POLICY,
  type ReportState,
  openCase,
  priorityForReason,
  reportMachine,
  submitReport,
  triageReport,
} from '../src/index.js';
import {
  CORRELATION,
  MODERATOR,
  REPORTER,
  CONVERSATION,
  SUBJECT,
  harness,
  makeReport,
  messageEvidence,
  rejected,
  openCaseFromReport,
  succeeded,
  unmatchedRelationship,
} from './support.js';

describe('report lifecycle table', () => {
  it('is total: every terminal state is a dead end and submission can move', () => {
    expect(() => assertMachineIsTotal(reportMachine, ['merged', 'actioned', 'dismissed'])).not.toThrow();
  });

  it('only lets triage leave `submitted`', () => {
    expect(reportMachine.allowedEvents('submitted')).toEqual(['triage']);
    expect(reportMachine.legalEvents('submitted')).toEqual(['triage']);
  });

  it('never lets a submitted report be actioned, dismissed or merged', () => {
    const h = harness();
    const report = succeeded(makeReport(h));
    for (const event of ['merge', 'action', 'dismiss', 'escalate'] as const) {
      expect(rejected(reportMachine.next(report.state, event, { caseId: 'c', moderatorId: 'm', decisionId: 'd' })).code).toBe(
        'invalid_transition',
      );
    }
  });

  it('requires a named moderator and a case before a report may be merged or actioned', () => {
    for (const event of ['merge', 'action', 'dismiss'] as const) {
      expect(rejected(reportMachine.next('triaged', event, { caseId: 'c-1' })).code).toBe('validation_failed');
      expect(rejected(reportMachine.next('triaged', event, { moderatorId: 'm-1' })).code).toBe(
        'validation_failed',
      );
    }
    expect(succeeded(reportMachine.next('triaged', 'merge', { caseId: 'c-1', moderatorId: 'm-1' }))).toBe(
      'merged',
    );
  });

  it('lets an escalated report still end in action or dismissal, and nothing else', () => {
    const authority = { caseId: 'c-1', moderatorId: 'm-1', decisionId: 'd-1' };
    expect(succeeded(reportMachine.next('escalated', 'action', authority))).toBe('actioned');
    expect(succeeded(reportMachine.next('escalated', 'dismiss', authority))).toBe('dismissed');
    expect(rejected(reportMachine.next('escalated', 'merge', authority)).code).toBe('invalid_transition');
    expect(rejected(reportMachine.next('escalated', 'escalate', { moderatorId: 'm-1' })).code).toBe(
      'invalid_transition',
    );
  });

  it('records triage under the moderator who did it', () => {
    const h = harness();
    const report = succeeded(makeReport(h));
    const triaged = succeeded(
      triageReport(h.ctx, { report, moderatorId: MODERATOR.actorId, correlationId: CORRELATION }),
    );
    expect(triaged.state).toBe<ReportState>('triaged');
    const row = h.audit.byEntity('report', report.reportId).at(-1);
    expect(row?.action).toBe('report.triaged');
    expect(row?.actorId).toBe(MODERATOR.actorId);
  });

  it('refuses to triage the same report twice', () => {
    const h = harness();
    const report = succeeded(makeReport(h));
    const triaged = succeeded(
      triageReport(h.ctx, { report, moderatorId: MODERATOR.actorId, correlationId: CORRELATION }),
    );
    expect(rejected(
      triageReport(h.ctx, { report: triaged, moderatorId: MODERATOR.actorId, correlationId: CORRELATION }),
    ).code).toBe('invalid_transition');
  });
});

describe('report submission rules', () => {
  it('rejects a self report', () => {
    const h = harness();
    const error = rejected(makeReport(h, { subjectId: REPORTER, reporterId: REPORTER }));
    expect(error.code).toBe('validation_failed');
  });

  it('accepts an anonymous report and records that it was anonymous', () => {
    const h = harness();
    const report = succeeded(makeReport(h, { reporterId: null }));
    expect(report.reporterId).toBeNull();
    const row = h.audit.byEntity('report', report.reportId).at(-1);
    expect(row?.detail.anonymous).toBe(true);
    expect(row?.actorId).toBe('system');
  });

  it('demands a description when the category is only `other`', () => {
    const h = harness();
    expect(rejected(makeReport(h, { reason: 'other', statement: 'bad' })).code).toBe('validation_failed');
    expect(
      succeeded(makeReport(h, { reason: 'other', statement: 'He showed up at my workplace twice.' }))
        .reason,
    ).toBe('other');
  });

  it('refuses a report with no evidence, because there would be nothing to review', () => {
    const h = harness();
    expect(rejected(makeReport(h, { evidence: [] })).code).toBe('validation_failed');
  });

  it('caps the length of a report statement', () => {
    const h = harness();
    expect(rejected(makeReport(h, { statement: 'x'.repeat(2001) })).code).toBe('validation_failed');
    expect(succeeded(makeReport(h, { statement: 'x'.repeat(2000) })).statement).toHaveLength(2000);
  });

  it('refuses evidence with no redacted summary to fall back on', () => {
    const h = harness();
    expect(
      rejected(makeReport(h, { evidence: [messageEvidence({ redactedSummary: '   ' })] })).code,
    ).toBe('validation_failed');
  });

  it('keeps reporting available to a banned account', () => {
    // A banned user with a genuine safety concern must still reach a human.
    expect(canPerform({ state: 'banned' }, 'report')).toBe(true);
    expect(capabilitiesFor('banned')).toContain('report');
  });
});

describe('reporting after an unmatch', () => {
  it('captures the evidence and the relationship at the moment of the report', () => {
    const h = harness();
    const report = succeeded(makeReport(h, { relationship: unmatchedRelationship() }));

    expect(report.relationship.status).toBe('unmatched');
    expect(report.relationship.conversationId).toBe(CONVERSATION);
    expect(report.relationship.messageRange).toEqual({ from: 'msg-1', to: 'msg-3' });
    expect(report.capturedEvidence).toHaveLength(1);
    expect(report.capturedEvidence[0]?.capture).toEqual({
      at: 'report_submission',
      reportId: report.reportId,
    });
  });

  it('still opens a case after the dating relationship no longer exists', () => {
    const h = harness();
    // The conversation is gone from every other domain's read-model; the report
    // does not ask for it again, so triage is unaffected.
    const report = succeeded(makeReport(h, { relationship: unmatchedRelationship() }));
    const moderationCase = openCaseFromReport(h, report);

    expect(moderationCase.subjectId).toBe(SUBJECT);
    expect(moderationCase.reportIds).toEqual([report.reportId]);
    expect(moderationCase.evidenceIds).toEqual(report.capturedEvidence.map((item) => item.evidenceId));
  });

  it('refuses to open a case from a report that was never triaged', () => {
    const h = harness();
    const report = succeeded(makeReport(h));
    const error = rejected(
      openCase(h.ctx, {
        source: 'user_report',
        report,
        openedBy: MODERATOR.actorId,
        correlationId: CORRELATION,
      }),
    );
    expect(error.code).toBe('not_eligible');
  });

  it('keeps an anonymous post-unmatch report fully auditable', () => {
    const h = harness();
    const report = succeeded(makeReport(h, { reporterId: null, reason: 'threats_or_violence' }));
    const moderationCase = openCaseFromReport(h, report);

    expect(moderationCase.priority).toBe('urgent');
    const opened = h.audit.byEntity('case', moderationCase.caseId).at(0);
    expect(opened?.action).toBe('case.opened');
    expect(opened?.evidenceIds).toEqual(report.capturedEvidence.map((item) => item.evidenceId));

    for (const item of report.capturedEvidence) {
      const captured = h.audit.byEntity('evidence', item.evidenceId).at(0);
      expect(captured?.action).toBe('evidence.captured');
      expect(captured?.sequence).toBeLessThan(opened?.sequence ?? 0);
      expect(captured?.actorId).toBe('system');
    }
  });
});

describe('submitReport input handling', () => {
  it('never trusts a live relationship lookup for a report that must survive it', () => {
    const h = harness();
    const submission = succeeded(
      submitReport(h.ctx, {
        reportId: 'r-manual' as never,
        subjectId: SUBJECT,
        reporterId: REPORTER,
        reason: 'harassment',
        statement: null,
        relationship: { status: 'never_matched', capturedAt: h.clock.now(), conversationId: null, messageRange: null },
        evidence: [messageEvidence({ kind: 'profile_snapshot', sourceDomain: 'dating-core' })],
        correlationId: CORRELATION,
      }),
    );
    expect(submission.report.relationship.status).toBe('never_matched');
    expect(submission.report.capturedEvidence[0]?.kind).toBe('profile_snapshot');
  });
});

describe('the report reason a member can actually give', () => {
  it('routes a report about being steered off-platform to a person-safety queue', () => {
    // The copy catalogue offers this report and the triage taxonomy had nowhere
    // to put it, so the only reason a member could file was `other` or a
    // nearest-miss that triages as a scam at `normal` with no person-safety flag.
    const h = harness();
    const report = succeeded(
      submitReport(h.ctx, {
        reportId: 'rep-unsafe' as never,
        subjectId: SUBJECT,
        reporterId: REPORTER,
        reason: 'unsafe_contact',
        statement: null,
        relationship: unmatchedRelationship(),
        evidence: [messageEvidence()],
        correlationId: CORRELATION,
      }),
    );

    expect(report.report.reason).toBe('unsafe_contact');
    expect(priorityForReason('unsafe_contact')).toBe<CasePriority>('high');
    // Not the same queue as a scam, and not a downgrade into one.
    expect(priorityForReason('scam_or_solicitation')).toBe<CasePriority>('normal');
    expect(REPORT_REASON_POLICY.unsafe_contact.isPersonSafety).toBe(true);
    expect(REPORT_REASON_POLICY.scam_or_solicitation.isPersonSafety).toBe(false);
  });

  it('opens the case at the priority the reason implies', () => {
    const h = harness();
    const opened = openCaseFromReport(
      h,
      succeeded(
        submitReport(h.ctx, {
          reportId: 'rep-unsafe-2' as never,
          subjectId: SUBJECT,
          reporterId: REPORTER,
          reason: 'unsafe_contact',
          statement: null,
          relationship: unmatchedRelationship(),
          evidence: [messageEvidence()],
          correlationId: CORRELATION,
        }),
      ).report,
    );

    expect(opened.priority).toBe<CasePriority>('high');
    expect(opened.dueAt.getTime() - opened.openedAt.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it('has a triage policy for every reason the type admits', () => {
    // The catalogue and the taxonomy are one list; a reason with no policy row
    // would read `undefined` at the triage gate instead of failing loudly.
    expect(Object.keys(REPORT_REASON_POLICY).sort()).toEqual([
      'fake_or_misleading_profile',
      'harassment',
      'hate_or_discrimination',
      'impersonation',
      'minor_safety',
      'non_consensual_intimacy',
      'other',
      'scam_or_solicitation',
      'sexual_content',
      'spam',
      'threats_or_violence',
      'unsafe_contact',
    ]);
  });
});
