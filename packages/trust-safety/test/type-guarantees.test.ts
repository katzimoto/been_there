import { describe, expect, it } from 'vitest';
import type { DetectorContext, Signal, SignalInput } from '../src/index.js';

/**
 * Structural guarantees, asserted at compile time.
 *
 * The type aliases below are the tests. `npx tsc -p packages/trust-safety/test/tsconfig.json`
 * fails if a field with enforcement vocabulary is ever added to the surface a
 * detector can reach; no runtime assertion can catch that.
 */

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
type Forbidden<T, V extends string> = Extract<keyof T, V> extends never ? true : false;

/** The words that would turn a detector into an enforcement engine. */
type EnforcementVocabulary =
  | 'accountState'
  | 'account'
  | 'state'
  | 'caseId'
  | 'moderatorId'
  | 'capabilities'
  | 'enforcement'
  | 'suspend'
  | 'ban'
  | 'restrict'
  | 'sanction'
  | 'verdict'
  | 'riskState';

// The context a detector runs against is exactly these three fields.
type _contextShape = Assert<
  Equals<keyof DetectorContext, 'now' | 'observations' | 'priorSignals'>
>;

// Nothing in it can express account standing or an enforcement handle.
type _contextIsClean = Assert<Equals<Forbidden<DetectorContext, EnforcementVocabulary>, true>>;

// The only thing a detector returns is evidence.
type _draftIsClean = Assert<Equals<Forbidden<SignalInput, EnforcementVocabulary>, true>>;

// A signal carries no account vocabulary either: the same rule one layer up.
type _signalIsClean = Assert<Equals<Forbidden<Signal, EnforcementVocabulary>, true>>;

describe('detector surface', () => {
  it('is three fields wide and carries no account state', () => {
    const context: DetectorContext = { now: new Date(), observations: [], priorSignals: [] };
    expect(Object.keys(context).sort()).toEqual(['now', 'observations', 'priorSignals']);
  });
});
