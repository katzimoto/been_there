import { describe, expect, it } from 'vitest';
import {
  type Observation,
  type ObservationKind,
  SAFETY_DETECTORS,
  type Signal,
  assessSignal,
  runDetector,
} from '../src/index.js';
import type { RiskState } from '@been-there/core';
import { NOW, at, subject } from './support.js';

/**
 * The implemented catalogue, run through `runDetector` — the port every
 * detector answers to, and the only way a detector's output exists.
 */

const observation = (
  kind: ObservationKind,
  overrides: Partial<Observation> = {},
): Observation => ({
  kind,
  occurredAt: at(0, 1),
  actorId: subject('u-1'),
  subjectId: subject('u-1'),
  ...overrides,
});

/** Every detector in the catalogue, over the same evidence, as one cycle runs it. */
function cycle(subjectId: Observation['subjectId'], observations: readonly Observation[]): readonly Signal[] {
  return SAFETY_DETECTORS.flatMap((detector) => {
    const run = runDetector(detector, { subjectId, now: NOW, observations }, []);
    if (!run.ok) {
      throw new Error(`${detector.detector} failed its own run: ${run.error.code}`);
    }
    return run.value;
  });
}

const repeats = (count: number, entry: (index: number) => Observation): readonly Observation[] =>
  Array.from({ length: count }, entry);

const unmatched = (matcher: string, matchId: string): Observation =>
  observation('unmatch.performed', {
    occurredAt: at(0, 2),
    actorId: subject(matcher),
    subjectId: subject('u-1'),
    entityId: matchId,
  });

const attempt = (occurredAt: Date): Observation =>
  observation('verification.attempt.started', { occurredAt, entityId: 'ver-1' });
const stateChange = (occurredAt: Date): Observation =>
  observation('identity.status_changed', { occurredAt });

/**
 * The evidence each implemented detector needs before it says anything, so the
 * escalation tests below can drive the real catalogue rather than a fixture of it.
 */
const EVIDENCE: Readonly<Record<string, readonly Observation[]>> = {
  'velocity.like_burst': repeats(25, (index) => observation('like.recorded', { counterpartyId: subject(`u-${index}`) })),
  'velocity.message_burst': [observation('communication.message_sent', { entityId: 'conv-1', count: 30 })],
  'dating.profile_churn': repeats(10, () => observation('profile.state_changed')),
  'interaction.unmatch_by_counterparty': [unmatched('u-9', 'match-1')],
  'identity.reuse': [attempt(at(0, 5)), stateChange(at(0, 1))],
  // A report filed against the account under evaluation. The reporter is a
  // different account: `createSignal` refuses `report_against` when the actor
  // and the subject are the same, so evidence that cannot produce a legal signal
  // is not evidence this detector can be driven with.
  'report.pattern.coordinated_target': [
    observation('moderation.report_submitted', {
      actorId: subject('u-9'),
      subjectId: subject('u-1'),
      entityId: 'report-1',
    }),
  ],
};

describe('velocity detectors', () => {
  it('reads a burst of outbound likes as one signal, not one per like', () => {
    const signals = cycle(
      subject('u-1'),
      repeats(25, (index) => observation('like.recorded', { counterpartyId: subject(`u-${index}`) })),
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.detector).toBe('velocity.like_burst');
    expect(signals[0]?.weight).toBe(0.35);
    expect(signals[0]?.reliability).toBe('low');
    expect(signals[0]?.behaviour).toEqual({ kind: 'like_velocity', entityId: 'u-1' });
    expect(signals[0]?.facts).toEqual({ occurrences: 25, windowMinutes: 60, direction: 'outbound' });
  });

  it('stays quiet below the burst threshold and outside the window', () => {
    expect(cycle(subject('u-1'), repeats(24, () => observation('like.recorded')))).toEqual([]);
    const stale = repeats(30, () => observation('like.recorded', { occurredAt: at(0, 3) }));
    expect(cycle(subject('u-1'), stale)).toEqual([]);
  });

  it('scores message volume with the rate the publisher already derived', () => {
    const signals = cycle(
      subject('u-1'),
      [observation('communication.message_sent', { entityId: 'conv-1', count: 30 })],
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.detector).toBe('velocity.message_burst');
    expect(signals[0]?.weight).toBe(0.4);
    expect(signals[0]?.reliability).toBe('medium');
    expect(signals[0]?.behaviour).toEqual({ kind: 'message_velocity', entityId: 'conv-1' });
    expect(signals[0]?.facts).toMatchObject({ occurrences: 30 });

    const quiet = cycle(
      subject('u-1'),
      [observation('communication.message_sent', { entityId: 'conv-1', count: 29 })],
    );
    expect(quiet).toEqual([]);
  });

  it('reads repeated profile rewrites as churn, and one rewrite as filling in a profile', () => {
    const signals = cycle(subject('u-1'), repeats(10, () => observation('profile.state_changed')));

    expect(signals).toHaveLength(1);
    expect(signals[0]?.detector).toBe('dating.profile_churn');
    expect(signals[0]?.behaviour).toEqual({ kind: 'profile_churn', entityId: 'u-1' });
    expect(signals[0]?.facts).toMatchObject({ occurrences: 10, windowMinutes: 10_080 });

    expect(cycle(subject('u-1'), repeats(9, () => observation('profile.state_changed')))).toEqual([]);
    const slowBurn = repeats(12, () => observation('profile.state_changed', { occurredAt: at(9) }));
    expect(cycle(subject('u-1'), slowBurn)).toEqual([]);
  });
});

describe('interaction.unmatch_by_counterparty', () => {

  it('is evidence about the account that was unmatched, keyed on the match', () => {
    const signals = cycle(subject('u-1'), [unmatched('u-9', 'match-1')]);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.subjectId).toBe(subject('u-1'));
    expect(signals[0]?.behaviour).toEqual({ kind: 'unmatch_by_counterparty', entityId: 'match-1' });
    expect(signals[0]?.facts).toEqual({ occurrences: 1, direction: 'inbound' });
  });

  it('says nothing about the account that did the unmatching', () => {
    expect(cycle(subject('u-9'), [unmatched('u-9', 'match-1')])).toEqual([]);
  });

  it('cannot be made to fail by being unmatched by a great many accounts', () => {
    const signals = cycle(
      subject('u-1'),
      repeats(40, (index) => unmatched(`u-${index}`, `match-${index}`)),
    );

    expect(signals).toHaveLength(20);
  });
});

describe('identity.reuse', () => {
  it('is an attempt with a state change behind it, keyed on the attempt', () => {
    const signals = cycle(subject('u-1'), [attempt(at(0, 5)), stateChange(at(0, 1))]);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.detector).toBe('identity.reuse');
    expect(signals[0]?.weight).toBe(0.45);
    expect(signals[0]?.reliability).toBe('medium');
    expect(signals[0]?.behaviour).toEqual({ kind: 'identity_reuse', entityId: 'ver-1' });
  });

  it('is not an attempt nobody followed, and not a state change with no attempt', () => {
    expect(cycle(subject('u-1'), [attempt(at(0, 5))])).toEqual([]);
    expect(cycle(subject('u-1'), [stateChange(at(0, 1))])).toEqual([]);
    // The state change has to come after the attempt, not before it.
    expect(cycle(subject('u-1'), [attempt(at(0, 1)), stateChange(at(0, 5))])).toEqual([]);
  });
});

/**
 * Issue #44: escalation is a two-key system, and every detector in the
 * implemented catalogue holds only the corroboration key. The declaration is on
 * the detector, and the policy reads it — nothing here is a list of names.
 */
describe('what the catalogue declares about escalating', () => {
  /** The real signals a detector emits from the evidence registered for it. */
  function speaks(detector: string): readonly Signal[] {
    const found = SAFETY_DETECTORS.find((entry) => entry.detector === detector);
    if (found === undefined) {
      throw new Error(`no detector called ${detector} in the catalogue`);
    }
    const run = runDetector(found, { subjectId: subject('u-1'), now: NOW, observations: EVIDENCE[detector] ?? [] }, []);
    if (!run.ok) {
      throw new Error(`${detector} failed its own run: ${run.error.code}`);
    }
    return run.value;
  }

  it('declares every implemented detector corroboration_only', () => {
    const escalating = SAFETY_DETECTORS.filter((detector) => detector.escalation !== 'corroboration_only');
    expect(escalating.map((detector) => detector.detector)).toEqual([]);
    // Not vacuous: the catalogue is not empty, and it is not empty by accident.
    expect(SAFETY_DETECTORS.length).toBe(Object.keys(EVIDENCE).length);
  });

  it('carries the declaration onto the signal, which is what the policy reads', () => {
    for (const name of Object.keys(EVIDENCE)) {
      for (const signal of speaks(name)) {
        expect({ detector: signal.detector, escalation: signal.escalation }).toEqual({
          detector: name,
          escalation: 'corroboration_only',
        });
      }
    }
  });

  it('leaves the state where it found it at 40 repeats, from every state it could start in', () => {
    for (const name of Object.keys(EVIDENCE)) {
      const [signal] = speaks(name);
      if (signal === undefined) {
        throw new Error(`${name} emitted nothing from the evidence registered for it`);
      }
      for (const current of ['normal', 'elevated', 'high'] as const satisfies readonly RiskState[]) {
        const decision = assessSignal(
          {
            current,
            signal,
            corroboration: { detectors: [name], independentDetectors: 1, repetitions: 40, massReport: null },
            disputeOpen: false,
          },
          NOW,
        );
        expect({ detector: name, current, next: decision.next, reason: decision.reason }).toEqual({
          detector: name,
          current,
          next: current,
          // Two different refusals, and the difference is the point. A
          // `corroboration_only` detector is scored and then declined for lack of
          // a second detector. A `report_against` signal is never scored at all:
          // `assessSignal` returns before any arithmetic, because a report is an
          // accusation and the account reported keeps whatever risk state it
          // had. Both leave the state exactly where it was found.
          reason: name === 'report.pattern.coordinated_target'
            ? 'report_not_risk_bearing'
            : 'corroboration_required',
        });
      }
    }
  });

  it('reads the declaration rather than a list of names', () => {
    const [unmatch] = speaks('interaction.unmatch_by_counterparty');
    if (unmatch === undefined) {
      throw new Error('interaction.unmatch_by_counterparty emitted nothing');
    }
    // The same detector, the same evidence, the same weight, promoted to `high`
    // reliability so that its own weight clears the gate. The only thing that
    // then differs between the two is what it declared, so the policy cannot be
    // reading a name.
    const promoted: Signal = { ...unmatch, reliability: 'high', escalation: 'self_escalating' };
    const held: Signal = { ...promoted, escalation: 'corroboration_only' };
    const decide = (signal: Signal) =>
      assessSignal(
        {
          current: 'normal',
          signal,
          corroboration: { detectors: [signal.detector], independentDetectors: 1, repetitions: 0, massReport: null },
          disputeOpen: false,
        },
        NOW,
      );

    expect(decide(promoted).next).toBe('elevated');
    expect(decide(held).next).toBe('normal');
    expect(decide(held).reason).toBe('corroboration_required');
  });
});
