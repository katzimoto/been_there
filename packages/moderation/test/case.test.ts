import { describe, expect, it } from 'vitest';
import { assertMachineIsTotal } from '@been-there/core';
import {
  type Case,
  assignCase,
  caseMachine,
  canWorkCase,
  decide,
  escalateCase,
  mergeReports,
  openCase,
  reopenCase,
} from '../src/index.js';
import {
  CORRELATION,
  LEAD,
  MODERATOR,
  SUBJECT,
  caseInReview,
  harness,
  identityIntake,
  makeReport,
  openCaseFromReport,
  rejected,
  succeeded,
  submitAndTriage,
  trustSafetyIntake,
} from './support.js';

describe('the authority gate refuses automated actors', () => {
  const reviewedCase = () => {
    const h = harness();
    return { h, moderationCase: caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h)))) };
  };

  it('rejects a case worked by a service holding a moderator-shaped id', () => {
    const { moderationCase } = reviewedCase();
    // Same id, same seniority, same privacy appointment — the only difference
    // is that nothing human is behind it.
    expect(canWorkCase(moderationCase, { ...LEAD, automated: true }).ok).toBe(false);
  });

  it('permits the very same actor once it is a person', () => {
    const { moderationCase } = reviewedCase();
    expect(canWorkCase(moderationCase, { ...LEAD, automated: false }).ok).toBe(true);
  });

  it('refuses a decision attributed to automation even on a reviewed case', () => {
    const { h, moderationCase } = reviewedCase();
    const outcome = decide(h.ctx, {
      moderationCase,
      actor: { ...LEAD, automated: true },
      action: 'ban',
      rationale: 'decided by a service, not a person',
      currentAccountState: 'active',
      correlationId: CORRELATION,
    });
    expect(rejected(outcome)).not.toBeNull();
  });
});

describe('case lifecycle table', () => {
  it('is total, and leaves `resolved` with exactly one way back out', () => {
    expect(() => assertMachineIsTotal(caseMachine)).not.toThrow();
    expect(caseMachine.legalEvents('resolved')).toEqual(['reopen']);
  });

  it('will not resolve a case without a recorded decision', () => {
    expect(rejected(caseMachine.next('in_review', 'resolve', { moderatorId: 'm-1' })).code).toBe(
      'validation_failed',
    );
    expect(
      succeeded(caseMachine.next('in_review', 'resolve', { moderatorId: 'm-1', decisionId: 'd-1' })),
    ).toBe('resolved');
  });

  it('will not escalate or reopen without a stated reason', () => {
    expect(rejected(caseMachine.next('open', 'escalate', { moderatorId: 'm-1' })).code).toBe(
      'validation_failed',
    );
    expect(rejected(caseMachine.next('resolved', 'reopen', { moderatorId: 'm-1' })).code).toBe(
      'validation_failed',
    );
  });

  it('never reopens a case that is not resolved', () => {
    expect(caseMachine.legalEvents('in_review')).not.toContain('reopen');
    expect(caseMachine.legalEvents('resolved')).toContain('reopen');
  });
});

describe('the three intake paths', () => {
  it('produce the same case record, differing only in how it was found', () => {
    const h = harness();
    const fromReport = openCaseFromReport(h, succeeded(makeReport(h)));
    const fromRisk = succeeded(openCase(h.ctx, trustSafetyIntake())).moderationCase;
    const fromIdentity = succeeded(openCase(h.ctx, identityIntake())).moderationCase;

    for (const opened of [fromReport, fromRisk, fromIdentity]) {
      expect(opened.state).toBe('open');
      expect(opened.subjectId).toBe(SUBJECT);
      expect(opened.assignedModeratorId).toBeNull();
      expect(opened.resolutionDecisionId).toBeNull();
      expect(opened.evidenceIds.length).toBeGreaterThan(0);
      expect(opened.caseId).not.toBe('');
    }
    expect(
      [fromReport.origin.source, fromRisk.origin.source, fromIdentity.origin.source].sort(),
    ).toEqual(['identity_anomaly', 'trust_safety_review', 'user_report']);
  });

  it('run the same review and decision sequence whatever the intake path was', () => {
    const h = harness();
    const cases: Case[] = [
      openCaseFromReport(h, succeeded(makeReport(h))),
      succeeded(openCase(h.ctx, trustSafetyIntake())).moderationCase,
      succeeded(openCase(h.ctx, identityIntake())).moderationCase,
    ];

    const chains = cases.map((opened) => {
      const reviewed = caseInReview(h, opened);
      const outcome = succeeded(
        decide(h.ctx, {
          moderationCase: reviewed,
          actor: MODERATOR,
          action: 'suspend',
          rationale: 'Repeated threats after an explicit request to stop.',
          currentAccountState: 'active',
          correlationId: CORRELATION,
        }),
      );
      // Compare from the moment the case existed: evidence captured before
      // intake belongs to a report, and has no case to hang off.
      const openedAt = h.audit.byEntity('case', opened.caseId)[0]?.sequence ?? 0;
      return {
        caseState: outcome.moderationCase.state,
        accountState: outcome.accountState,
        decisionCaseId: outcome.decision.caseId,
        actions: h.audit
          .forCase(opened.caseId)
          .filter((entry) => entry.sequence >= openedAt)
          .map((entry) => entry.action),
      };
    });

    for (const chain of chains) {
      expect(chain.caseState).toBe('resolved');
      expect(chain.accountState).toBe('suspended');
      expect(chain.decisionCaseId).not.toBe('');
      expect(chain.actions).toContain('case.opened');
      expect(chain.actions).toContain('case.assigned');
      expect(chain.actions).toContain('case.review_started');
      expect(chain.actions).toContain('decision.recorded');
      expect(chain.actions).toContain('case.resolved');
    }
    for (const chain of chains.slice(1)) {
      expect(chain.actions).toEqual(chains[0]?.actions);
    }
  });

  it('records the triggering fact as evidence at intake, not as a live question', () => {
    const h = harness();
    const opened = succeeded(openCase(h.ctx, identityIntake()));

    expect(opened.evidence).toHaveLength(1);
    expect(opened.evidence[0]?.kind).toBe('identity_anomaly');
    expect(opened.evidence[0]?.sourceDomain).toBe('identity');
    expect(opened.evidence[0]?.capture).toEqual({ at: 'case_intake', caseId: opened.moderationCase.caseId });
    expect(opened.evidence[0]?.redactedSummary).toBe('Identity anomaly: liveness provider disagreement');
  });

  it('refuses a case when risk is still `normal`', () => {
    const h = harness();
    const error = rejected(openCase(h.ctx, trustSafetyIntake('normal')));
    expect(error.code).toBe('not_eligible');
  });


  it('refuses an identity anomaly that does not say what the anomaly is', () => {
    const h = harness();
    expect(rejected(openCase(h.ctx, identityIntake('  '))).code).toBe('validation_failed');
  });

  it('refuses to open a second case for a report already merged into one', () => {
    const h = harness();
    const opened = openCaseFromReport(h, succeeded(makeReport(h)));
    const other = submitAndTriage(h);
    const merged = succeeded(
      mergeReports(h.ctx, opened, [other], MODERATOR, CORRELATION),
    ).mergedReports[0];

    expect(merged?.mergedCaseId).toBe(opened.caseId);
    expect(
      rejected(
        openCase(h.ctx, {
          source: 'user_report',
          report: { ...merged!, state: 'merged' },
          openedBy: MODERATOR.actorId,
          correlationId: CORRELATION,
        }),
      ).code,
    ).toBe('conflict');
  });
});

describe('queue, priority and assignment', () => {
  it('sets priority and clock from the reason, and pulls the deadline in', () => {
    const h = harness();
    const urgent = openCaseFromReport(h, succeeded(makeReport(h, { reason: 'threats_or_violence' })));
    const low = openCaseFromReport(h, succeeded(makeReport(h, { reason: 'spam' })));

    expect(urgent.priority).toBe('urgent');
    expect(urgent.dueAt.getTime() - urgent.openedAt.getTime()).toBe(4 * 60 * 60 * 1000);
    expect(low.priority).toBe('low');
    expect(low.dueAt.getTime() - low.openedAt.getTime()).toBe(72 * 60 * 60 * 1000);
  });

  it('maps risk state onto the same priority vocabulary', () => {
    const h = harness();
    const elevated = succeeded(openCase(h.ctx, trustSafetyIntake('elevated'))).moderationCase;
    const critical = succeeded(openCase(h.ctx, trustSafetyIntake())).moderationCase;

    expect(elevated.priority).toBe('normal');
    expect(critical.priority).toBe('urgent');
  });

  it('never lets an identity anomaly sit below `high`', () => {
    const h = harness();
    expect(succeeded(openCase(h.ctx, identityIntake())).moderationCase.priority).toBe('high');
    expect(succeeded(openCase(h.ctx, identityIntake())).moderationCase.queue).toBe('identity_integrity');
  });

  it('keeps an escalated case out of a plain reviewer’s hands', () => {
    const h = harness();
    const opened = openCaseFromReport(h, succeeded(makeReport(h, { reason: 'non_consensual_intimacy' })));
    const escalated = succeeded(
      escalateCase(h.ctx, {
        moderationCase: opened,
        actor: MODERATOR,
        reason: 'Possible non-consensual imagery; needs a lead and legal review.',
        correlationId: CORRELATION,
      }),
    );

    expect(escalated.state).toBe('escalated');
    expect(rejected(assignCase(h.ctx, { moderationCase: escalated, actor: MODERATOR, correlationId: CORRELATION })).code).toBe(
      'permission_denied',
    );
    expect(
      succeeded(assignCase(h.ctx, { moderationCase: escalated, actor: LEAD, correlationId: CORRELATION }))
        .assignedModeratorId,
    ).toBe(LEAD.actorId);
  });

  it('clears the resolution when a case is reopened, keeping the history', () => {
    const h = harness();
    const reviewed = caseInReview(h, openCaseFromReport(h, succeeded(makeReport(h))));
    const outcome = succeeded(
      decide(h.ctx, {
        moderationCase: reviewed,
        actor: MODERATOR,
        action: 'restrict',
        rationale: 'Harassment pattern across three conversations.',
        currentAccountState: 'active',
        removedCapabilities: ['send_message'],
        correlationId: CORRELATION,
      }),
    );
    const reopened = succeeded(
      reopenCase(h.ctx, {
        moderationCase: outcome.moderationCase,
        actor: LEAD,
        reason: 'User contests the restriction; new evidence supplied.',
        correlationId: CORRELATION,
      }),
    );

    expect(reopened.state).toBe('open');
    expect(reopened.resolutionDecisionId).toBeNull();
    expect(h.audit.byEntity('decision', outcome.decision.decisionId)).toHaveLength(1);
  });
});
