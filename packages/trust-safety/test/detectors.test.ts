import { describe, expect, it } from 'vitest';
import {
  type Observation,
  type ObservationKind,
  type Signal,
  SAFETY_DETECTORS,
  runDetector,
} from '../src/index.js';
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
  const unmatched = (matcher: string, matchId: string): Observation =>
    observation('unmatch.performed', {
      occurredAt: at(0, 2),
      actorId: subject(matcher),
      subjectId: subject('u-1'),
      entityId: matchId,
    });

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
  const attempt = (occurredAt: Date): Observation =>
    observation('verification.attempt.started', { occurredAt, entityId: 'ver-1' });
  const stateChange = (occurredAt: Date): Observation =>
    observation('identity.status_changed', { occurredAt });

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
