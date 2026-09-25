import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AUTHOR,
  errorCode,
  makeSignal,
  subject,
  succeeded,
} from './support.js';
import {
  type SignalFacts,
  type SignalInput,
  SIGNAL_FACT_KEYS,
  createSignal,
  sameBehaviour,
} from '../src/index.js';

const input = (overrides: Partial<SignalInput> = {}): SignalInput => ({
  subjectId: subject('s-1'),
  actorId: subject('s-1'),
  behaviour: { kind: 'unmatch_then_report', entityId: 'match-1' },
  occurredAt: new Date('2026-03-01T12:00:00.000Z'),
  weight: 0.6,
  ...overrides,
});

describe('signal construction', () => {
  it('accepts a bounded weight and rejects anything above one', () => {
    expect(succeeded(createSignal(input({ weight: 1 }), DEFAULT_AUTHOR)).weight).toBe(1);
    expect(errorCode(createSignal(input({ weight: 1.01 }), DEFAULT_AUTHOR))).toBe('validation_failed');
  });

  it('refuses a zero, negative or non-finite weight', () => {
    expect(errorCode(createSignal(input({ weight: 0 }), DEFAULT_AUTHOR))).toBe('validation_failed');
    expect(errorCode(createSignal(input({ weight: -0.2 }), DEFAULT_AUTHOR))).toBe('validation_failed');
    expect(errorCode(createSignal(input({ weight: Number.NaN }), DEFAULT_AUTHOR))).toBe('validation_failed');
  });

  it('refuses a signal whose fact is not in the closed vocabulary', () => {
    const smuggled = { messageBody: 'meet me at the usual place' } as unknown as SignalFacts;
    const result = createSignal(input({ facts: smuggled }), DEFAULT_AUTHOR);
    expect(errorCode(result)).toBe('validation_failed');
    expect(!result.ok && result.error.details?.field).toBe('messageBody');
  });

  it('refuses a fact that is out of range rather than trusting the detector', () => {
    expect(errorCode(createSignal(input({ facts: { occurrences: 0 } }), DEFAULT_AUTHOR))).toBe(
      'validation_failed',
    );
    expect(errorCode(createSignal(input({ facts: { windowMinutes: 60 * 24 * 400 } }), DEFAULT_AUTHOR))).toBe(
      'validation_failed',
    );
    expect(succeeded(createSignal(input({ facts: { occurrences: 12, windowMinutes: 60 } }), DEFAULT_AUTHOR))
      .facts.occurrences).toBe(12);
  });

  it('exposes a fact vocabulary that can carry no content at all', () => {
    expect([...SIGNAL_FACT_KEYS].sort()).toEqual([
      'cluster',
      'direction',
      'distinctCounterparties',
      'humanPaced',
      'occurrences',
      'windowMinutes',
    ]);
  });

  it('rejects a detector name that is not a dotted identifier', () => {
    expect(
      errorCode(createSignal(input(), { ...DEFAULT_AUTHOR, detector: 'Interaction Detector!!' })),
    ).toBe('validation_failed');
    expect(errorCode(createSignal(input(), { ...DEFAULT_AUTHOR, detector: '' }))).toBe('validation_failed');
  });

  it('rejects an invalid observation date instead of storing a broken signal', () => {
    expect(errorCode(createSignal(input({ occurredAt: new Date('nonsense') }), DEFAULT_AUTHOR))).toBe(
      'validation_failed',
    );
  });
});

describe('signal attribution', () => {
  it('requires a report_against signal to name somebody other than its subject', () => {
    const selfReported = input({
      behaviour: { kind: 'report_against', entityId: 's-9' },
      subjectId: subject('s-9'),
      actorId: subject('s-9'),
    });
    expect(errorCode(createSignal(selfReported, DEFAULT_AUTHOR))).toBe('validation_failed');

    const thirdParty = input({
      behaviour: { kind: 'report_against', entityId: 's-9' },
      subjectId: subject('s-9'),
      actorId: subject('s-2'),
    });
    expect(succeeded(createSignal(thirdParty, DEFAULT_AUTHOR)).actorId).toBe(subject('s-2'));
  });

  it('requires every other behaviour to be self-attributed', () => {
    const shifted = input({ actorId: subject('s-2') });
    expect(errorCode(createSignal(shifted, DEFAULT_AUTHOR))).toBe('validation_failed');
  });
});

describe('corroboration keys', () => {
  it('matches only on the same behaviour of the same entity', () => {
    const a = makeSignal().behaviour;
    expect(sameBehaviour(a, { kind: 'unmatch_then_report', entityId: 'match-1' })).toBe(true);
    expect(sameBehaviour(a, { kind: 'unmatch_then_report', entityId: 'match-2' })).toBe(false);
    expect(sameBehaviour(a, { kind: 'message_velocity', entityId: 'match-1' })).toBe(false);
  });
});
