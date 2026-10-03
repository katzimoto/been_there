import { describe, expect, it } from 'vitest';
import type { RiskState } from '@been-there/core';
import { NOW, errorCode, makeSignal, selfEscalating, subject, succeeded } from './support.js';
import {
  type Corroboration,
  type Detector,
  ESCALATION_GATE,
  EMPTY_LEDGER,
  type Signal,
  type SignalAuthor,
  appendSignal,
  assessSignal,
  corroborate,
  createSignal,
  runDetector,
  unaidedScore,
} from '../src/index.js';

/**
 * Issue #44: escalation is a two-key system, and the policy reads a detector's
 * own declaration of which key it holds.
 *
 * Every detector in the implemented catalogue is `corroboration_only`, so the
 * properties pinned here were false and untested: that a corroboration-only
 * detector cannot move a subject at any weight and any repetition count, and
 * that a `self_escalating` declaration nobody can back is an error rather than
 * a detector that quietly never fires.
 */

const corroboration = (overrides: Partial<Corroboration> = {}): Corroboration => ({
  detectors: ['interaction.unmatch_report'],
  independentDetectors: 1,
  repetitions: 0,
  massReport: null,
  ...overrides,
});

const decide = (current: RiskState, signal: Signal, overrides: Partial<Corroboration> = {}) =>
  assessSignal({ current, signal, corroboration: corroboration(overrides), disputeOpen: false }, NOW);

/** Far more repeats than the multiplier pays for. */
const LOUD = 40;

/** A well-formed draft, so each test states only the weight it is about. */
function draft(weight: number) {
  return {
    subjectId: subject('s-1'),
    actorId: subject('s-1'),
    behaviour: { kind: 'identity_reuse' as const, entityId: 'ver-1' },
    occurredAt: NOW,
    weight,
  };
}

/** N signals from one detector about one behaviour, a minute apart. */
function repeatedFrom(detector: string, count: number): readonly Signal[] {
  return Array.from({ length: count }, (_entry, index) =>
    makeSignal({
      detector,
      behaviour: { kind: 'unmatch_then_report', entityId: 'match-1' },
      occurredAt: new Date(NOW.getTime() - index * 60_000),
    }),
  );
}

describe('a corroboration_only detector may not move a subject on its own', () => {
  it('holds the state at normal at every weight, reliability and repetition count', () => {
    for (const weight of [ESCALATION_GATE, 0.7, 0.9, 1]) {
      for (const reliability of ['low', 'medium', 'high'] as const) {
        for (const repetitions of [0, 3, 5, LOUD]) {
          const decision = decide('normal', makeSignal({ weight, reliability }), { repetitions });
          expect({ weight, reliability, repetitions, next: decision.next, reason: decision.reason }).toEqual({
            weight,
            reliability,
            repetitions,
            next: 'normal',
            reason: 'corroboration_required',
          });
        }
      }
    }
  });

  it('does not let one climb a subject it has already raised either', () => {
    for (const current of ['normal', 'elevated', 'high'] as const) {
      const decision = decide(current, makeSignal({ weight: 1, reliability: 'high' }), { repetitions: LOUD });
      expect({ current, next: decision.next, changed: decision.changed, candidate: decision.candidate }).toEqual({
        current,
        next: current,
        changed: false,
        candidate: null,
      });
    }
  });

  it('reports the evidence honestly rather than discounting what it is worth', () => {
    const decision = decide('normal', makeSignal({ weight: 1, reliability: 'high' }), { repetitions: LOUD });
    expect(decision.effectiveScore).toBe(0.85);
    expect(decision.next).toBe('normal');
  });

  it('still keeps the signal, and a second detector can build on it', () => {
    const held = makeSignal({ detector: 'interaction.unmatch_by_counterparty', weight: 0.5, reliability: 'low' });
    const second = makeSignal({ detector: 'identity.reuse', weight: 0.45 });
    const support = corroborate(appendSignal(EMPTY_LEDGER, held), second);
    expect(support.independentDetectors).toBe(2);
    expect(decide('normal', second, support).next).toBe('elevated');
  });
});

describe('a self_escalating detector acts on its own evidence', () => {
  it('takes a normal subject to elevated by itself', () => {
    const decision = decide('normal', selfEscalating({ weight: 0.6 }));
    expect(decision.next).toBe('elevated');
    expect(decision.reason).toBe('escalated_by_signal');
    expect(decision.effectiveScore).toBeCloseTo(unaidedScore(0.6, 'high'), 5);
  });

  it('is still bounded by the single-detector ceiling, so it reaches no further than high', () => {
    const decision = decide('high', selfEscalating({ weight: 1 }), { repetitions: LOUD });
    expect(decision.effectiveScore).toBe(0.85);
    expect(decision.next).toBe('high');
  });

  it('needs no repetition: the declaration and the arithmetic have to agree', () => {
    for (const [weight, reliability] of [
      [ESCALATION_GATE, 'high'],
      [0.6, 'medium'],
      [1, 'high'],
    ] as const) {
      expect(unaidedScore(weight, reliability)).toBeGreaterThanOrEqual(ESCALATION_GATE);
      expect(decide('normal', selfEscalating({ weight, reliability }), { repetitions: 0 }).next).toBe('elevated');
    }
  });
});

describe('a declaration nobody can back is an error, not a detector that never fires', () => {
  const AUTHOR = {
    detector: 'identity.provider_anomaly',
    reliability: 'medium',
    category: 'identity',
    escalation: 'self_escalating',
    // A provider anomaly is the shape of evidence that is a fact about a
    // person rather than a pattern, and it is *not* downstream of a report —
    // which is exactly what `safety.detected_before_first_report` would need.
    dependsOnReports: false,
  } as const satisfies SignalAuthor;

  /** The provider attributes this anomaly at 0.4, which is 0.34 after the discount. */
  const anomaly: Detector = {
    ...AUTHOR,
    detect: (input) => [{ ...draft(0.4), subjectId: input.subjectId, occurredAt: input.now }],
  };

  it('rejects a self_escalating signal whose own evidence cannot clear the gate', () => {
    expect(errorCode(createSignal(draft(0.4), AUTHOR))).toBe('validation_failed');
  });

  it('rejects the run of such a detector rather than dropping its signals quietly', () => {
    const run = runDetector(anomaly, { subjectId: subject('s-1'), now: NOW, observations: [] }, []);
    expect(errorCode(run)).toBe('validation_failed');
  });

  it('names the declaration and the shortfall, so the mistake is fixable where it is made', () => {
    const refusal = createSignal(draft(0.4), AUTHOR);
    expect(refusal.ok === false && refusal.error.details).toMatchObject({
      detector: 'identity.provider_anomaly',
      escalation: 'self_escalating',
      gate: ESCALATION_GATE,
    });
  });

  it('accepts the same detector once its evidence clears the gate unaided', () => {
    const strong: Detector = {
      ...anomaly,
      detect: (input) => [{ ...draft(0.6), subjectId: input.subjectId, occurredAt: input.now }],
    };
    const [signal] = succeeded(runDetector(strong, { subjectId: subject('s-1'), now: NOW, observations: [] }, []));
    if (signal === undefined) {
      throw new Error('a self_escalating detector whose evidence clears the gate emitted nothing');
    }
    expect(signal.escalation).toBe('self_escalating');
    expect(decide('normal', signal).next).toBe('elevated');
  });

  it('is the discount that makes a weight un-backable, not the weight alone', () => {
    // 0.5 at `low` reliability is 0.35, so the same weight that is enough at
    // `high` is a mis-declaration here.
    expect(errorCode(createSignal(draft(ESCALATION_GATE), { ...AUTHOR, reliability: 'low' }))).toBe(
      'validation_failed',
    );
    expect(errorCode(createSignal(draft(ESCALATION_GATE), { ...AUTHOR, reliability: 'high' }))).toBe('ok');
  });
});

describe('repetition is a different axis from corroboration', () => {
  it('counts one detector once, however many times it speaks', () => {
    let ledger = EMPTY_LEDGER;
    for (const signal of repeatedFrom('interaction.unmatch_by_counterparty', 30)) {
      ledger = appendSignal(ledger, signal);
    }
    const incoming = makeSignal({
      detector: 'interaction.unmatch_by_counterparty',
      behaviour: { kind: 'unmatch_then_report', entityId: 'match-1' },
    });
    const support = corroborate(ledger, incoming);
    expect(support.detectors).toEqual(['interaction.unmatch_by_counterparty']);
    expect(support.independentDetectors).toBe(1);
    expect(support.repetitions).toBe(30);
  });

  it('cannot buy the critical branch, which wants two detectors and not two signals', () => {
    let ledger = EMPTY_LEDGER;
    for (const signal of repeatedFrom('interaction.unmatch_by_counterparty', 30)) {
      ledger = appendSignal(ledger, signal);
    }
    const loudest = succeeded(
      createSignal(draft(1), {
        detector: 'interaction.unmatch_by_counterparty',
        reliability: 'high',
        category: 'interaction',
        escalation: 'self_escalating',
        dependsOnReports: false,
      }),
    );
    const support = corroborate(ledger, loudest);
    expect(support.independentDetectors).toBe(1);
    const decision = decide('high', loudest, { ...support, repetitions: LOUD });
    expect(decision.effectiveScore).toBe(0.85);
    expect(decision.next).toBe('high');
  });
});

describe('two independent detectors escalate, so the engine is not inert', () => {
  const identityReuse = makeSignal({ detector: 'identity.reuse', weight: 0.45, reliability: 'medium' });
  const profileChurn = makeSignal({
    detector: 'dating.profile_churn',
    weight: 0.3,
    reliability: 'low',
    behaviour: { kind: 'profile_churn', entityId: 's-1' },
  });

  it('moves a subject that neither of them could move alone', () => {
    const support = corroborate(appendSignal(EMPTY_LEDGER, profileChurn), identityReuse);
    expect(support.independentDetectors).toBe(2);

    // Four earlier repeats of the same identity behaviour reach 0.459 on their
    // own — under the gate. Corroborated, that same evidence is 0.528.
    const repeats = { ...support, repetitions: 4 };
    expect(decide('normal', identityReuse, { ...repeats, independentDetectors: 1 }).next).toBe('normal');
    const corroborated = decide('normal', identityReuse, repeats);
    expect(corroborated.next).toBe('elevated');
    expect(corroborated.reason).toBe('escalated_by_corroboration');
  });

  it('is not automatic: a quiet pair buys a second look, not a state', () => {
    const support = corroboration({
      detectors: ['identity.reuse', 'dating.profile_churn'],
      independentDetectors: 2,
    });
    const decision = decide('normal', identityReuse, support);
    expect(decision.next).toBe('normal');
    expect(decision.reason).toBe('below_threshold');
  });

  it('reaches critical from high, which is where a human is asked to look', () => {
    const support = corroboration({
      detectors: ['identity.reuse', 'dating.profile_churn'],
      independentDetectors: 2,
    });
    expect(decide('high', identityReuse, support).next).toBe('critical');
  });
});

describe('the same arithmetic over a day', () => {
  it('does not let a stale repeat keep speaking for a detector that has gone quiet', () => {
    const stale = makeSignal({
      detector: 'interaction.unmatch_by_counterparty',
      occurredAt: new Date(NOW.getTime() - 25 * 3_600_000),
    });
    const support = corroborate(appendSignal(EMPTY_LEDGER, stale), makeSignal({ detector: 'identity.reuse' }));
    expect(support.independentDetectors).toBe(2);
    expect(support.repetitions).toBe(0);
  });

  it('counts a detector from another account as no support at all', () => {
    const elsewhere = makeSignal({ detector: 'dating.profile_churn', subjectId: subject('s-2') });
    const support = corroborate(appendSignal(EMPTY_LEDGER, elsewhere), makeSignal({ detector: 'identity.reuse' }));
    expect(support.independentDetectors).toBe(1);
    expect(support.repetitions).toBe(0);
    expect(decide('normal', makeSignal({ detector: 'identity.reuse', weight: 0.45 }), support).reason).toBe(
      'corroboration_required',
    );
  });
});

