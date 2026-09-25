import { describe, expect, it } from 'vitest';
import { NOW, at, makeSignal, subject } from './support.js';
import type { RiskState } from '@been-there/core';
import {
  type Corroboration,
  type Signal,
  CORROBORATION_FAST_PATH_SCORE,
  SINGLE_DETECTOR_SCORE_CEILING,
  assessDecay,
  assessHumanReassessment,
  assessSignal,
} from '../src/index.js';

const corroboration = (overrides: Partial<Corroboration> = {}): Corroboration => ({
  detectors: ['interaction.unmatch_report'],
  independentDetectors: 1,
  repetitions: 0,
  massReport: null,
  ...overrides,
});

const decide = (current: RiskState, signal: Signal, overrides: Partial<Corroboration> = {}, disputeOpen = false) =>
  assessSignal({ current, signal, corroboration: corroboration(overrides), disputeOpen }, NOW);

describe('escalation thresholds', () => {
  it('ignores a single weak signal from normal', () => {
    const decision = decide('normal', makeSignal({ weight: 0.49 }));
    expect(decision.next).toBe('normal');
    expect(decision.reason).toBe('below_threshold');
    expect(decision.changed).toBe(false);
  });

  it('takes a normal subject to elevated on a first signal worth half', () => {
    const decision = decide('normal', makeSignal({ weight: 0.5 }));
    expect(decision.next).toBe('elevated');
    expect(decision.reason).toBe('escalated_by_signal');
  });

  it('requires a stronger signal to climb from elevated to high', () => {
    expect(decide('elevated', makeSignal({ weight: 0.69 })).next).toBe('elevated');
    expect(decide('elevated', makeSignal({ weight: 0.7 })).next).toBe('high');
  });

  it('discounts a low reliability detector instead of silencing it', () => {
    const low = decide('normal', makeSignal({ weight: 0.8, reliability: 'low' }));
    expect(low.effectiveScore).toBeCloseTo(0.56, 5);
    const high = decide('normal', makeSignal({ weight: 0.8, reliability: 'high' }));
    expect(high.effectiveScore).toBeCloseTo(0.8, 5);
  });
});

describe('corroboration is required for the highest escalation', () => {
  it('holds a single detector below critical however loudly it repeats itself', () => {
    const decision = decide(
      'high',
      makeSignal({ weight: 1 }),
      corroboration({ repetitions: 40 }),
    );
    expect(decision.effectiveScore).toBe(SINGLE_DETECTOR_SCORE_CEILING);
    expect(decision.next).toBe('high');
    expect(decision.reason).toBe('below_threshold');
  });

  it('reaches critical on a second independent detector even with a weak score', () => {
    const decision = decide('high', makeSignal({ weight: 0.4 }), corroboration({
      detectors: ['interaction.unmatch_report', 'network.device_cluster'],
      independentDetectors: 2,
    }));
    expect(decision.next).toBe('critical');
    expect(decision.reason).toBe('escalated_by_corroboration');
  });

  it('takes a corroborated subject straight to high from normal', () => {
    const decision = decide(
      'normal',
      makeSignal({ weight: CORROBORATION_FAST_PATH_SCORE }),
      corroboration({
        detectors: ['interaction.unmatch_report', 'identity.reuse'],
        independentDetectors: 2,
      }),
    );
    expect(decision.event).toBe('threshold_crossed');
    expect(decision.next).toBe('high');
  });

  it('does not take the corroborated fast path from high, which would skip the guard', () => {
    const decision = decide(
      'high',
      makeSignal({ weight: 0.95 }),
      corroboration({
        detectors: ['interaction.unmatch_report', 'network.device_cluster'],
        independentDetectors: 2,
      }),
    );
    expect(decision.event).toBe('signal_observed');
    expect(decision.next).toBe('critical');
  });

  it('stays put at critical however strong the new evidence is', () => {
    const decision = decide('critical', makeSignal({ weight: 1 }), corroboration({
      detectors: ['a.detector', 'b.detector'],
      independentDetectors: 2,
    }));
    expect(decision.event).toBeNull();
    expect(decision.next).toBe('critical');
    expect(decision.reason).toBe('already_critical');
  });
});

describe('repetition', () => {
  it('adds a little to each repeat and then stops paying', () => {
    const scoreAt = (repetitions: number) =>
      decide('elevated', makeSignal({ weight: 0.6 }), corroboration({ repetitions })).effectiveScore;
    expect(scoreAt(0)).toBeCloseTo(0.6, 5);
    expect(scoreAt(4)).toBeCloseTo(0.72, 5);
    expect(scoreAt(20)).toBeCloseTo(0.75, 5);
  });

  it('cannot be moved by a hundred unrelated matchers, however they are weighted', () => {
    const score = decide(
      'normal',
      makeSignal({ weight: 0.5, reliability: 'low', category: 'interaction' }),
      corroboration({ repetitions: 0 }),
    );
    expect(score.effectiveScore).toBeCloseTo(0.35, 5);

    const evenAsRepeats = decide(
      'normal',
      makeSignal({ weight: 0.5, reliability: 'low' }),
      corroboration({ repetitions: 100 }),
    );
    expect(evenAsRepeats.effectiveScore).toBeLessThan(0.5);
    expect(evenAsRepeats.next).toBe('normal');
  });
});

describe('friction follows the risk state', () => {
  const kindsAt = (state: RiskState, weight = 0.6, disputeOpen = false) =>
    decide(state, makeSignal({ weight }), corroboration({ repetitions: 0 }), disputeOpen).friction.map(
      (entry) => entry.kind,
    );

  it('proposes nothing while the subject stays at normal', () => {
    expect(kindsAt('normal', 0.4)).toEqual([]);
  });

  it('friction follows the state the signal leaves behind, not the one it found', () => {
    expect(kindsAt('normal', 0.6)).toEqual(['rate_limit']);
  });

  it('adds the human review candidate at high and re-verification at critical', () => {
    expect(kindsAt('high')).toEqual(['rate_limit', 'human_review_candidate']);
    expect(kindsAt('critical')).toEqual(['rate_limit', 'reverification_request', 'human_review_candidate']);
  });

  it('gives every proposal an expiry and marks it reversible', () => {
    for (const entry of decide('critical', makeSignal({ weight: 0.6 })).friction) {
      expect(entry.reversible).toBe(true);
      expect(entry.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it('proposes no friction while a dispute is open, but still moves the risk state', () => {
    const decision = decide('elevated', makeSignal({ weight: 0.9 }), corroboration(), true);
    expect(decision.friction).toEqual([]);
    expect(decision.next).toBe('high');
  });
});

describe('a coordinated reporting campaign', () => {
  const cluster = (): Corroboration => ({
    detectors: ['report.coordinated_target'],
    independentDetectors: 1,
    repetitions: 0,
    massReport: {
      key: { kind: 'report_against', entityId: 'victim-1' },
      targetId: subject('victim-1'),
      reporters: [subject('r-1'), subject('r-2'), subject('r-3')],
    },
  });

  const report = (reporter: string) =>
    makeSignal({
      subjectId: subject('victim-1'),
      actorId: subject(reporter),
      behaviour: { kind: 'report_against', entityId: 'victim-1' },
      weight: 1,
    });

  it('never moves the victim and never proposes friction against them', () => {
    const decision = decide('normal', report('r-3'), cluster());
    expect(decision.discarded).toBe(true);
    expect(decision.next).toBe('normal');
    expect(decision.effectiveScore).toBe(0);
    expect(decision.friction).toEqual([]);
    expect(decision.reason).toBe('mass_report_quarantined');
  });

  it('queues the reporters as a cluster instead of the victim', () => {
    const decision = decide('normal', report('r-3'), cluster());
    expect(decision.candidate?.target).toEqual({
      kind: 'cluster',
      key: { kind: 'report_against', entityId: 'victim-1' },
      members: [subject('r-1'), subject('r-2'), subject('r-3')],
    });
    expect(decision.candidate?.origin).toBe('mass_report_attack');
  });

  it('treats a report as an accusation rather than evidence, even a lone one', () => {
    const decision = decide('normal', report('r-1'), corroboration({ massReport: null }));
    expect(decision.discarded).toBe(true);
    expect(decision.reason).toBe('report_not_risk_bearing');
    expect(decision.next).toBe('normal');
    expect(decision.candidate).toBeNull();
  });
});

describe('decay', () => {
  it('refuses to decay before the quiet period the shared machine requires', () => {
    expect(assessDecay('elevated', at(3), NOW).ok).toBe(false);
    expect(assessDecay('high', at(13), NOW).ok).toBe(false);
    expect(assessDecay('critical', at(29), NOW).ok).toBe(false);
  });

  it('decays one step at the documented thresholds', () => {
    const step = (state: RiskState, days: number) => {
      const result = assessDecay(state, at(days), NOW);
      return result.ok ? result.value : 'rejected';
    };
    expect(step('elevated', 7)).toBe('normal');
    expect(step('high', 14)).toBe('elevated');
    expect(step('critical', 30)).toBe('high');
  });

  it('never skips a level, however long the silence', () => {
    const result = assessDecay('critical', at(365), NOW);
    expect(result.ok && result.value).toBe('high');
  });

  it('decays a subject that never produced a timestamped signal', () => {
    const result = assessDecay('elevated', null, NOW);
    expect(result.ok && result.value).toBe('normal');
  });
});

describe('only a human lowers risk by decision', () => {
  it('rejects an assessment with no named assessor', () => {
    const result = assessHumanReassessment('critical', '');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('permission_denied');
  });

  it('lets a named assessor clear a subject from any state', () => {
    const result = assessHumanReassessment('critical', 'mod-7');
    expect(result.ok && result.value).toBe('normal');
  });
});
