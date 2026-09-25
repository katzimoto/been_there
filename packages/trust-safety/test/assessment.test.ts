import { describe, expect, it } from 'vitest';
import { NOW, assessmentContext, at, makeSignal, recordAt, subject, succeeded } from './support.js';
import {
  EMPTY_LEDGER,
  type ReversibleFriction,
  type RiskDispute,
  type RiskRecord,
  type RiskTransition,
  applyDecay,
  applyDispute,
  applySignal,
  reassessByHuman,
} from '../src/index.js';
import { castId, type RiskState } from '@been-there/core';

const context = assessmentContext();

function activeFriction(kind: ReversibleFriction['kind']): ReversibleFriction {
  return {
    kind,
    subjectId: subject('s-1'),
    reason: 'interaction.unmatch_report observed unmatch_then_report',
    raisedAt: at(1),
    expiresAt: at(-10),
    reversible: true,
  };
}

const dispute = (): RiskDispute => ({
  disputeId: castId<'EventId'>('evt-dispute-1'),
  subjectId: subject('s-1'),
  assessmentId: castId<'RiskAssessmentId'>('risk-1'),
  disputedState: 'high',
  raisedAt: NOW,
  statedReason: 'I did not do that',
  resolvedAt: null,
});

describe('applySignal', () => {
  it('records the detector, the clock and a risk.changed event when the state moves', () => {
    const transition = succeeded(applySignal(recordAt('normal', null), makeSignal({ weight: 0.6 }), EMPTY_LEDGER, context));
    expect(transition.record.assessment.state).toBe('elevated');
    expect(transition.record.assessment.contributingDetectors).toEqual(['interaction.unmatch_report']);
    expect(transition.record.assessment.lastSignalAt?.toISOString()).toBe(NOW.toISOString());
    expect(transition.events.map((event) => event.type)).toEqual(['risk.changed', 'friction.proposed']);
  });

  it('refuses a signal that belongs to a different account than the record', () => {
    const result = applySignal(
      recordAt('normal', null),
      makeSignal({ subjectId: subject('someone-else') }),
      EMPTY_LEDGER,
      context,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('validation_failed');
  });

  it('keeps the newest signal time when a late one arrives out of order', () => {
    const transition = succeeded(
      applySignal(recordAt('normal', at(2)), makeSignal({ occurredAt: at(5) }), EMPTY_LEDGER, context),
    );
    expect(transition.record.assessment.lastSignalAt?.toISOString()).toBe(at(2).toISOString());
  });

  it('publishes nothing but internal, system-actor events', () => {
    const transition = succeeded(
      applySignal(recordAt('normal', null), makeSignal({ weight: 0.95 }), EMPTY_LEDGER, context),
    );
    expect(transition.events.length).toBeGreaterThan(0);
    for (const event of transition.events) {
      expect(event.sensitivity).toBe('internal');
      expect(event.actorId).toBe('system');
    }
  });

  it('opens a review candidate exactly when the subject reaches high', () => {
    const escalated = succeeded(
      applySignal(recordAt('elevated', at(1)), makeSignal({ weight: 0.9 }), EMPTY_LEDGER, context),
    );
    expect(escalated.record.assessment.state).toBe('high');
    expect(escalated.record.candidate?.origin).toBe('detection');
    expect(escalated.events.map((event) => event.type)).toContain('review_candidate.raised');

    const later = succeeded(
      applySignal(escalated.record, makeSignal({ weight: 0.95 }), escalated.ledger ?? EMPTY_LEDGER, context),
    );
    expect(later.events.map((event) => event.type)).not.toContain('review_candidate.raised');
    expect(later.record.candidate?.raisedAt).toBe(escalated.record.candidate?.raisedAt);
  });

  it('does not re-propose friction the current state no longer justifies', () => {
    const record = recordAt('high', at(1), [
      activeFriction('rate_limit'),
      activeFriction('reverification_request'),
    ]);
    const transition = succeeded(applySignal(record, makeSignal({ weight: 0.8 }), EMPTY_LEDGER, context));
    expect(transition.record.friction.map((entry) => entry.kind)).toEqual([
      'rate_limit',
      'human_review_candidate',
    ]);
  });
});

describe('a retaliatory mass reporting campaign', () => {
  const report = (reporter: string, hoursAgo: number) =>
    makeSignal({
      detector: 'report.coordinated_target',
      category: 'report_pattern',
      subjectId: subject('victim-1'),
      actorId: subject(reporter),
      behaviour: { kind: 'report_against', entityId: 'victim-1' },
      occurredAt: at(0, hoursAgo),
      weight: 0.9,
    });

  const victimRecord = (state: RiskState, lastSignalAt: Date | null) =>
    recordAt(state, lastSignalAt, [], subject('victim-1'));

  /** Three accounts report the same target in turn; the third completes the campaign. */
  const campaign = (victim: RiskRecord) => {
    let record = victim;
    let ledger = EMPTY_LEDGER;
    const transitions: RiskTransition[] = [];
    for (const [index, reporter] of ['r-1', 'r-2', 'r-3'].entries()) {
      const transition = succeeded(applySignal(record, report(reporter, 3 - index), ledger, context));
      transitions.push(transition);
      record = transition.record;
      ledger = transition.ledger ?? ledger;
    }
    return { record, ledger, last: transitions[transitions.length - 1]! };
  };

  it('leaves the victim exactly as it found them', () => {
    const victim = victimRecord('normal', null);
    const { record, last } = campaign(victim);
    expect(record.assessment.state).toBe('normal');
    expect(record.assessment.contributingDetectors).toEqual([]);
    expect(record.assessment.lastSignalAt).toBeNull();
    expect(record.friction).toEqual([]);
    expect(last.record.assessment.state).toBe('normal');
    expect(last.record.candidate).toBeNull();
  });

  it('raises the reporters as a cluster, not the account they targeted', () => {
    const { last } = campaign(victimRecord('normal', null));
    const target = last.raised?.target;
    expect(target?.kind).toBe('cluster');
    expect(target?.kind === 'cluster' && target.members).toEqual([
      subject('r-1'),
      subject('r-2'),
      subject('r-3'),
    ]);
    expect(last.raised?.origin).toBe('mass_report_attack');
  });

  it('keeps the campaign in the ledger, because that is what makes it visible', () => {
    const { ledger } = campaign(victimRecord('normal', null));
    expect(ledger.entries).toHaveLength(3);
  });

  it('does not reset the victim decay clock', () => {
    const victim = victimRecord('high', at(20));
    const { record } = campaign(victim);
    expect(record.assessment.lastSignalAt?.toISOString()).toBe(at(20).toISOString());
  });
});

describe('decay releases what the raised state justified', () => {
  it('drops the re-verification request and closes the queue entry on the way down', () => {
    const critical = recordAt('critical', at(31), [
      activeFriction('rate_limit'),
      activeFriction('reverification_request'),
    ]);
    const decayed = succeeded(applyDecay(critical, context));
    expect(decayed.record.assessment.state).toBe('high');
    expect(decayed.record.friction.map((entry) => entry.kind)).toEqual(['rate_limit']);
    expect(decayed.record.candidate).toBeNull();
    expect(decayed.events[0]?.payload).toMatchObject({ from: 'critical', to: 'high', reason: 'decay' });
  });

  it('refuses to decay before the shared machine allows it', () => {
    const decayed = applyDecay(recordAt('elevated', at(2)), context);
    expect(decayed.ok).toBe(false);
    expect(decayed.ok === false && decayed.error.code).toBe('validation_failed');
  });

  it('expires friction nobody renewed', () => {
    const stale = recordAt('normal', at(1), [
      { ...activeFriction('rate_limit'), expiresAt: at(1) },
    ]);
    const transition = succeeded(applySignal(stale, makeSignal({ weight: 0.3 }), EMPTY_LEDGER, context));
    expect(transition.record.friction).toEqual([]);
  });
});

describe('dispute handling', () => {
  const frictioned = (): RiskRecord => {
    const escalated = succeeded(
      applySignal(recordAt('elevated', at(1)), makeSignal({ weight: 0.9 }), EMPTY_LEDGER, context),
    );
    return escalated.record;
  };

  it('lifts every proposal, leaves the risk state alone and queues a human', () => {
    const record = frictioned();
    expect(record.friction.length).toBeGreaterThan(1);
    const transition = applyDispute(record, dispute(), context);
    expect(transition.record.friction).toEqual([]);
    expect(transition.record.assessment.state).toBe('high');
    expect(transition.record.candidate?.origin).toBe('dispute');
    expect(transition.events.map((event) => event.type)).toEqual(['review_candidate.raised']);
  });

  it('suppresses new friction for as long as the dispute is open', () => {
    const disputed = applyDispute(frictioned(), dispute(), context);
    const after = succeeded(applySignal(disputed.record, makeSignal({ weight: 0.9 }), EMPTY_LEDGER, context));
    expect(after.record.friction).toEqual([]);
  });

  it('resumes friction once a human has closed the dispute', () => {
    const disputed = applyDispute(frictioned(), dispute(), context);
    const settled = succeeded(reassessByHuman(disputed.record, 'mod-3', context));
    expect(settled.record.disputes.every((entry) => entry.resolvedAt !== null)).toBe(true);
    const after = succeeded(applySignal(settled.record, makeSignal({ weight: 0.9 }), EMPTY_LEDGER, context));
    expect(after.record.friction.length).toBeGreaterThan(0);
  });
});

describe('human reassessment', () => {
  it('refuses to run without a named assessor', () => {
    const result = reassessByHuman(recordAt('critical', at(1)), '', context);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('permission_denied');
  });

  it('clears the state, the friction and the queue entry in one recorded move', () => {
    const transition = succeeded(reassessByHuman(recordAt('critical', at(1)), 'mod-3', context));
    expect(transition.record.assessment.state).toBe('normal');
    expect(transition.record.friction).toEqual([]);
    expect(transition.record.candidate).toBeNull();
    expect(transition.events[0]?.payload).toMatchObject({
      from: 'critical',
      to: 'normal',
      reason: 'human_reassess',
    });
  });
});
