import { describe, expect, it } from 'vitest';
import { NOW, at, errorCode, makeSignal, subject } from './support.js';
import {
  type Detector,
  type DetectorContext,
  type Observation,
  MAX_SIGNALS_PER_RUN,
  runDetector,
} from '../src/index.js';

const observation = (overrides: Partial<Observation> = {}): Observation => ({
  kind: 'unmatch.performed',
  occurredAt: at(0, 1),
  actorId: subject('s-1'),
  subjectId: subject('s-1'),
  entityId: 'match-1',
  ...overrides,
});

const unmatchThenReport: Detector = {
  detector: 'interaction.unmatch_report',
  reliability: 'high',
  category: 'interaction',
  detect: (input, context) =>
    context.observations
      .filter((entry) => entry.kind === 'unmatch.performed' && entry.actorId === input.subjectId)
      .map((entry) => ({
        subjectId: input.subjectId,
        actorId: input.subjectId,
        behaviour: { kind: 'unmatch_then_report' as const, entityId: entry.entityId ?? '' },
        occurredAt: entry.occurredAt,
        weight: 0.6,
        facts: { occurrences: 1 },
      })),
};

const input = {
  subjectId: subject('s-1'),
  now: NOW,
  observations: [observation(), observation({ actorId: subject('s-2'), subjectId: subject('s-2') })],
};

/** Wraps a detector so the test can inspect the context it was handed. */
function observing(inner: Detector, capture: (context: DetectorContext) => void): Detector {
  return {
    ...inner,
    detect: (detectorInput, context) => {
      capture(context);
      return inner.detect(detectorInput, context);
    },
  };
}

describe('detector context', () => {
  it('carries only the three fields the port declares, and nothing else', () => {
    let seen: DetectorContext | undefined;
    runDetector(observing(unmatchThenReport, (context) => (seen = context)), input, []);
    expect(Object.keys(seen ?? {}).sort()).toEqual(['now', 'observations', 'priorSignals']);
  });

  it('shows the detector only observations the subject took part in', () => {
    let seen: readonly Observation[] = [];
    runDetector(observing(unmatchThenReport, (context) => (seen = context.observations)), input, []);
    expect(seen.map((entry) => entry.actorId)).toEqual([subject('s-1')]);
  });

  it('shows the detector only signals already raised against the subject', () => {
    let seen: readonly string[] = [];
    runDetector(
      observing(unmatchThenReport, (context) => (seen = context.priorSignals.map((s) => s.subjectId))),
      input,
      [makeSignal({ subjectId: subject('s-1') }), makeSignal({ subjectId: subject('s-2'), detector: 'other.detector' })],
    );
    expect(seen).toEqual([subject('s-1')]);
  });
});

describe('runDetector vetting', () => {
  it('rejects a signal aimed at an account that was never in the input', () => {
    const rogue: Detector = {
      ...unmatchThenReport,
      detect: () => [
        {
          subjectId: subject('somebody-else'),
          actorId: subject('somebody-else'),
          behaviour: { kind: 'unmatch_then_report', entityId: 'match-1' },
          occurredAt: at(0, 1),
          weight: 0.9,
        },
      ],
    };
    expect(errorCode(runDetector(rogue, input, []))).toBe('validation_failed');
  });

  it('turns a throwing detector into an internal error rather than a crash', () => {
    const broken: Detector = {
      ...unmatchThenReport,
      detect: () => {
        throw new Error('detector exploded');
      },
    };
    expect(errorCode(runDetector(broken, input, []))).toBe('internal');
  });

  it('refuses a signal dated after the evaluation moment', () => {
    const prescient: Detector = {
      ...unmatchThenReport,
      detect: () => [
        {
          subjectId: subject('s-1'),
          actorId: subject('s-1'),
          behaviour: { kind: 'unmatch_then_report', entityId: 'match-1' },
          occurredAt: new Date(NOW.getTime() + 60_000),
          weight: 0.6,
        },
      ],
    };
    expect(errorCode(runDetector(prescient, input, []))).toBe('validation_failed');
  });

  it('caps how much one detector may emit in a single run', () => {
    const flood: Detector = {
      ...unmatchThenReport,
      detect: () =>
        Array.from({ length: MAX_SIGNALS_PER_RUN + 1 }, () => ({
          subjectId: subject('s-1'),
          actorId: subject('s-1'),
          behaviour: { kind: 'unmatch_then_report' as const, entityId: 'match-1' },
          occurredAt: at(0, 1),
          weight: 0.6,
        })),
    };
    expect(errorCode(runDetector(flood, input, []))).toBe('validation_failed');
  });

  it('emits nothing when it observed nothing, and the same evidence twice gives the same signals', () => {
    const quiet = runDetector(unmatchThenReport, { subjectId: subject('s-1'), now: NOW, observations: [] }, []);
    expect(quiet.ok && quiet.value).toEqual([]);

    const first = runDetector(unmatchThenReport, input, []);
    const second = runDetector(unmatchThenReport, input, []);
    expect(first.ok && first.value).toHaveLength(1);
    expect(first.ok && first.value).toEqual(second.ok ? second.value : null);
  });
});
