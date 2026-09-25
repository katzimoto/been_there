import { describe, expect, it } from 'vitest';
import { type ReportId, castId } from '@been-there/core';
import { type Report, mergeReports } from '../src/index.js';
import {
  CORRELATION,
  LEAD,
  MODERATOR,
  OTHER_SUBJECT,
  REPORTER,
  openCaseFromReport,
  harness,
  makeReport,
  messageEvidence,
  rejected,
  submitAndTriage,
  succeeded,
} from './support.js';

function threeReports(h: ReturnType<typeof harness>): Report[] {
  return [
    submitAndTriage(h, { reason: 'harassment' }),
    submitAndTriage(h, {
      reason: 'harassment',
      reporterId: null,
      evidence: [messageEvidence({ digest: 'sha256:msg-2', artefactReference: 'blob://messages/2' })],
    }),
    submitAndTriage(h, { reason: 'threats_or_violence' }),
  ];
}

describe('merging reports about one behaviour', () => {
  it('loses no report, no reporter and no captured evidence', () => {
    const h = harness();
    const opened = openCaseFromReport(h, succeeded(makeReport(h)));
    const [first, second, third] = threeReports(h);
    const reports = [first!, second!, third!];

    const outcome = succeeded(mergeReports(h.ctx, opened, reports, MODERATOR, CORRELATION));

    expect(outcome.moderationCase.reportIds).toEqual([
      opened.reportIds[0],
      first!.reportId,
      second!.reportId,
      third!.reportId,
    ]);
    expect(outcome.mergedReports).toHaveLength(3);
    for (const [index, report] of reports.entries()) {
      const merged = outcome.mergedReports[index];
      expect(merged?.reportId).toBe(report.reportId);
      expect(merged?.state).toBe('merged');
      expect(merged?.mergedCaseId).toBe(opened.caseId);
      expect(merged?.reporterId).toBe(report.reporterId);
      expect(merged?.statement).toBe(report.statement);
      expect(merged?.capturedEvidence.map((item) => item.evidenceId)).toEqual(
        report.capturedEvidence.map((item) => item.evidenceId),
      );
    }
    expect(outcome.mergedReports[1]?.reporterId).toBeNull();
  });

  it('unions the evidence without duplicating an artefact both reports captured', () => {
    const h = harness();
    const opened = openCaseFromReport(h, succeeded(makeReport(h)));
    const shared = { ...messageEvidence(), digest: 'sha256:shared' };
    const a = submitAndTriage(h, { evidence: [shared, messageEvidence({ digest: 'sha256:a' })] });
    const b = submitAndTriage(h, { evidence: [shared, messageEvidence({ digest: 'sha256:b' })] });

    const outcome = succeeded(mergeReports(h.ctx, opened, [a, b], MODERATOR, CORRELATION));

    const caseEvidence = outcome.moderationCase.evidenceIds;
    expect(caseEvidence.length).toBe(new Set(caseEvidence).size);
    expect(caseEvidence).toEqual([
      ...opened.evidenceIds,
      ...a.capturedEvidence.map((item) => item.evidenceId),
      ...b.capturedEvidence.map((item) => item.evidenceId),
    ]);
  });

  it('raises the case to the strongest priority any merged report implies', () => {
    const h = harness();
    const opened = openCaseFromReport(h, succeeded(makeReport(h, { reason: 'spam' })));
    expect(opened.priority).toBe('low');

    const reports = threeReports(h);
    const outcome = succeeded(
      mergeReports(h.ctx, opened, [reports[0]!, reports[2]!], MODERATOR, CORRELATION),
    );

    expect(outcome.moderationCase.priority).toBe('urgent');
    expect(outcome.moderationCase.dueAt.getTime() - outcome.moderationCase.openedAt.getTime()).toBe(
      4 * 60 * 60 * 1000,
    );
  });

  it('leaves an already-merged report alone when merged again', () => {
    const h = harness();
    const opened = openCaseFromReport(h, succeeded(makeReport(h)));
    const [first] = threeReports(h);
    const once = succeeded(mergeReports(h.ctx, opened, [first!], MODERATOR, CORRELATION));
    const twice = succeeded(
      // Re-merging what the store now holds, not the stale pre-merge copy.
      mergeReports(h.ctx, once.moderationCase, once.mergedReports, MODERATOR, CORRELATION),
    );

    expect(twice.moderationCase.reportIds).toEqual(once.moderationCase.reportIds);
    expect(twice.mergedReports).toHaveLength(0);
    expect(twice.moderationCase.evidenceIds).toEqual(once.moderationCase.evidenceIds);
  });

  it('refuses a report about somebody else', () => {
    const h = harness();
    const opened = openCaseFromReport(h, succeeded(makeReport(h)));
    const stranger = succeeded(
      makeReport(h, {
        subjectId: OTHER_SUBJECT,
        reportId: castId<'ReportId'>('r-stranger'),
        evidence: [messageEvidence({ digest: 'sha256:stranger' })],
      }),
    );
    expect(rejected(mergeReports(h.ctx, opened, [stranger], MODERATOR, CORRELATION)).code).toBe(
      'conflict',
    );
  });

  it('refuses a report that was never triaged', () => {
    const h = harness();
    const opened = openCaseFromReport(h, succeeded(makeReport(h)));
    const untriaged = succeeded(makeReport(h, { reportId: castId<'ReportId'>('r-untriaged') }));

    expect(rejected(mergeReports(h.ctx, opened, [untriaged], MODERATOR, CORRELATION)).code).toBe(
      'invalid_transition',
    );
  });

  it('refuses to take more reports once the case is resolved', () => {
    const h = harness();
    const opened = openCaseFromReport(h, succeeded(makeReport(h)));
    const closed: typeof opened = { ...opened, state: 'resolved' };
    const [first] = threeReports(h);

    expect(rejected(mergeReports(h.ctx, closed, [first!], MODERATOR, CORRELATION)).code).toBe('conflict');
  });

  it('keeps every report individually readable in the audit log', () => {
    const h = harness();
    const opened = openCaseFromReport(h, succeeded(makeReport(h)));
    const reports = threeReports(h);
    succeeded(mergeReports(h.ctx, opened, reports, MODERATOR, CORRELATION));

    for (const report of reports) {
      const rows = h.audit.byEntity('report', report.reportId);
      expect(rows.map((row) => row.action)).toContain('report.submitted');
      const merged = rows.at(-1);
      expect(merged?.action).toBe('report.merged');
      expect(merged?.actorId).toBe(MODERATOR.actorId);
      expect(merged?.caseId).toBe(opened.caseId);
    }
    const summary = h.audit.byEntity('case', opened.caseId).at(-1);
    expect(summary?.action).toBe('case.reports_merged');
    expect(summary?.detail).toMatchObject({ merged: 3, reportTotal: 4 });
  });

  it('will not fold the same report into a second case', () => {
    const h = harness();
    const opened = openCaseFromReport(h, succeeded(makeReport(h)));
    const [first] = threeReports(h);
    const once = succeeded(mergeReports(h.ctx, opened, [first!], MODERATOR, CORRELATION));
    const mergedIntoThisCase = once.mergedReports[0]!;

    // `merged` is terminal on a report, so no second case can claim it.
    const otherCase = { ...opened, caseId: 'case-other' as never };
    expect(
      rejected(mergeReports(h.ctx, otherCase, [mergedIntoThisCase], LEAD, CORRELATION)).code,
    ).toBe('conflict');
  });
});
