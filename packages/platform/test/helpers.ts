import {
  type CorrelationId,
  type DataSensitivity,
  type DomainEvent,
  type Result,
  type SubjectId,
  castId,
} from '@been-there/core';

/**
 * Test seams for the Result sum type. Reading `.value` directly is a type
 * error by design; these make a test fail with the error code instead.
 */
export function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

export function rejected<T, E extends { code: string }>(result: Result<T, E>): E {
  if (result.ok) {
    throw new Error(`expected rejection, got ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

export function correlationId(seed: string): CorrelationId {
  return castId<'CorrelationId'>(`corr-${seed}`);
}

export function subjectId(seed: string): SubjectId {
  return castId<'SubjectId'>(`subj-${seed}`);
}

/** A minimal, well-formed envelope. Tests vary one field at a time. */
export function domainEvent(overrides: {
  readonly type: string;
  readonly sensitivity: DataSensitivity;
  readonly id?: string;
  readonly actorId?: string;
  readonly subjectId?: SubjectId;
  readonly correlationId?: CorrelationId;
  readonly causationId?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}): DomainEvent {
  return {
    eventId: castId<'EventId'>(overrides.id ?? `evt-${overrides.type}`),
    type: overrides.type,
    version: 1,
    occurredAt: new Date('2026-03-01T12:00:00.000Z'),
    actorId: (overrides.actorId ?? 'system') as DomainEvent['actorId'],
    ...(overrides.subjectId === undefined ? {} : { subjectId: overrides.subjectId }),
    correlationId: overrides.correlationId ?? correlationId(overrides.type),
    ...(overrides.causationId === undefined
      ? {}
      : { causationId: castId<'EventId'>(overrides.causationId) }),
    sensitivity: overrides.sensitivity,
    payload: overrides.payload ?? {},
  };
}
