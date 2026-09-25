import {
  type ActorId,
  type CorrelationId,
  type DataSensitivity,
  type DomainEvent,
  type EventId,
  type SubjectId,
  castId,
} from '@been-there/core';
import { type ClassifiedRecord, classify, redact } from './redaction.js';

/**
 * Observability without a second copy of the data. Request logs are the most
 * common accidental leak in a service — somebody adds a field to a debug line
 * and the redaction is three directories away in a call site nobody re-reads —
 * so the line is assembled here, from a classified record, against a clearance
 * the caller cannot choose.
 */

export const REQUEST_LOG_CLEARANCE = { upTo: 'internal' } as const satisfies {
  readonly upTo: DataSensitivity;
};

/** Mints the correlation id once, at the edge, and is then carried read-only. */
export interface RequestTrace {
  readonly correlationId: CorrelationId;
  readonly actorId: ActorId | 'system';
  /** Surface, e.g. `api`, `worker`, `moderation_console`. */
  readonly surface: string;
  readonly operation: string;
}

export interface RequestContext extends RequestTrace {
  readonly durationMs: number;
  readonly outcome: 'ok' | 'error' | 'denied';
  readonly causationId?: EventId;
  readonly subjectId?: SubjectId;
  /** Domain error code when the outcome is not `ok`. Never an error message. */
  readonly errorCode?: string;
}

export interface RequestLogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly message: string;
  readonly body: string;
  /** Names of the fields the sink dropped, so the filter is itself observable. */
  readonly redactedFields: readonly string[];
}

export function newRequestTrace(seed: {
  readonly actorId: ActorId | 'system';
  readonly surface: string;
  readonly operation: string;
  readonly correlationId?: CorrelationId;
}): RequestTrace {
  return {
    correlationId: seed.correlationId ?? castId<'CorrelationId'>(crypto.randomUUID()),
    actorId: seed.actorId,
    surface: seed.surface,
    operation: seed.operation,
  };
}

export function completeRequest(
  trace: RequestTrace,
  result: {
    readonly durationMs: number;
    readonly outcome: 'ok' | 'error' | 'denied';
    readonly errorCode?: string;
    readonly subjectId?: SubjectId;
    readonly causationId?: EventId;
  },
): RequestContext {
  return {
    ...trace,
    durationMs: result.durationMs,
    outcome: result.outcome,
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    ...(result.subjectId === undefined ? {} : { subjectId: result.subjectId }),
    ...(result.causationId === undefined ? {} : { causationId: result.causationId }),
  };
}

/**
 * Serialises one request log. The clearance is fixed at the sink rather than
 * taken as a parameter: a caller that could pass `{upTo: 'restricted'}` would be
 * a caller that could log a liveness artefact.
 */
export function requestLogEntry(
  context: RequestContext,
  extra: ClassifiedRecord,
): RequestLogEntry {
  const envelope: ClassifiedRecord = [
    classify('correlation_id', 'internal', context.correlationId),
    classify('causation_id', 'internal', context.causationId ?? 'none'),
    classify('surface', 'internal', context.surface),
    classify('operation', 'internal', context.operation),
    classify('duration_ms', 'internal', context.durationMs),
    classify('outcome', 'internal', context.outcome),
  ];
  const redacted = redact([...envelope, ...extra], REQUEST_LOG_CLEARANCE);
  return {
    level: context.outcome === 'ok' ? 'info' : context.outcome === 'denied' ? 'warn' : 'error',
    message: `${context.surface} ${context.operation}`,
    body: JSON.stringify(redacted.visible),
    redactedFields: redacted.fields.filter((field) => !field.delivered).map((field) => field.name),
  };
}

/**
 * Propagates a request context into a published event. Correlation is the id
 * that follows one user-visible action across every service it touched —
 * publish, projection, notification, audit append — while causation names the
 * single event that immediately caused this one. A chain carrying both reads as
 * a story; one carrying only a correlation id is a pile.
 */
export function inheritEventContext<P>(
  event: DomainEvent<P>,
  context: RequestContext,
  overrides: {
    readonly type: string;
    readonly sensitivity: DataSensitivity;
    readonly subjectId?: SubjectId;
    readonly payload: P;
  },
): DomainEvent<P> {
  return {
    ...event,
    type: overrides.type,
    sensitivity: overrides.sensitivity,
    actorId: context.actorId,
    // The subject defaults to the request's subject: an event published while
    // serving a request is about that request's user unless it says otherwise.
    ...(overrides.subjectId ?? context.subjectId) === undefined
      ? {}
      : { subjectId: overrides.subjectId ?? context.subjectId },
    // Inherited, never re-minted: re-minting is how a cross-domain trace
    // silently splits in two.
    correlationId: context.correlationId,
    causationId: event.eventId,
    payload: overrides.payload,
  };
}
