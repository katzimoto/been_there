import { castId, type CorrelationId, type Result, type RiskState, type SubjectId } from '@been-there/core';
import { type AssessmentContext, type RiskRecord, emptyRiskRecord } from '../src/index.js';
import { type DetectorReliability, type Signal, type SignalAuthor, type SignalCategory, type SignalInput, createSignal } from '../src/index.js';
import { sequentialIdFactory } from '../src/index.js';

/** Fixed clock. Every test states its own dates rather than reading the system. */
export const NOW = new Date('2026-03-01T12:00:00.000Z');

export function subject(id: string): SubjectId {
  return castId<'SubjectId'>(id);
}

export function at(days: number, hours = 0): Date {
  return new Date(NOW.getTime() - (days * 24 + hours) * 60 * 60 * 1000);
}

export function assessmentContext(now: Date = NOW): AssessmentContext {
  return { now, correlationId: castId<'CorrelationId'>('corr-1'), ids: sequentialIdFactory() };
}

/** Test seam for the `Result` sum type; mirrors the kernel's own test idiom. */
export function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

export function errorCode<T, E extends { code: string }>(result: Result<T, E>): string {
  return result.ok ? 'ok' : result.error.code;
}

export const DEFAULT_AUTHOR: SignalAuthor = {
  detector: 'interaction.unmatch_report',
  reliability: 'high',
  category: 'interaction',
};

export interface SignalOverrides extends Partial<SignalInput> {
  readonly detector?: string;
  readonly reliability?: DetectorReliability;
  readonly category?: SignalCategory;
}

/** A well-formed signal; tests override exactly the field under examination. */
export function makeSignal(overrides: SignalOverrides = {}): Signal {
  const { detector, reliability, category, ...input } = overrides;
  const author: SignalAuthor = {
    detector: detector ?? DEFAULT_AUTHOR.detector,
    reliability: reliability ?? DEFAULT_AUTHOR.reliability,
    category: category ?? DEFAULT_AUTHOR.category,
  };
  const subjectId = input.subjectId ?? subject('s-1');
  return succeeded(
    createSignal(
      {
        behaviour: { kind: 'unmatch_then_report', entityId: 'match-1' },
        occurredAt: NOW,
        weight: 0.6,
        ...input,
        subjectId,
        actorId: input.actorId ?? subjectId,
      },
      author,
    ),
  );
}

/** A record sitting at a given state, as if a previous cycle had left it there. */
export function recordAt(
  state: RiskState,
  lastSignalAt: Date | null,
  friction: RiskRecord['friction'] = [],
  subjectId: SubjectId = subject('s-1'),
): RiskRecord {
  const base = emptyRiskRecord(subjectId, castId<'RiskAssessmentId'>('risk-1'), NOW);
  return {
    ...base,
    assessment: {
      ...base.assessment,
      state,
      lastSignalAt,
      contributingDetectors: state === 'normal' ? [] : ['interaction.unmatch_report'],
    },
    friction,
  };
}
