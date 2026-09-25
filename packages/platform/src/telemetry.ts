import { createHash } from 'node:crypto';
import {
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  ROOT_CONTEXT,
  metrics as otelMetrics,
  trace as otelTrace,
  type Attributes,
  type AttributeValue,
  type Context,
  type Meter,
  type Span,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api';
import { type Clearance, type CorrelationId, type DomainEvent, type EventId } from '@been-there/core';
import { type JsonValue, type ClassifiedRecord, redact } from './redaction.js';
import { type RequestContext } from './observability.js';

/**
 * Traces, for a product whose most useful question is not "is it up" but "why
 * did this person's account end up in that case, and did anything notice
 * first". The propagation was already here — every `DomainEvent` carries a
 * `correlationId` and a `causationId` — so this file is the mapping from those
 * two fields onto OpenTelemetry's parent/child model, plus the one rule that
 * makes the mapping safe to export to a third party: **a span attribute is
 * redacted at a fixed clearance, exactly as a log line is, and a span attribute
 * can only ever be a primitive.**
 *
 * That last clause is not a style preference. A trace backend is a third party
 * whose access controls are not the moderation console's, and OTel's own
 * attribute type has no room for an object. Together they mean a liveness score
 * cannot ride out inside a "profile" blob even if somebody groups fields for
 * convenience, because there is no shape in which a span could carry it.
 *
 * Only this file imports `@opentelemetry/api`. The six domain packages keep
 * their own observability port, so the SDK stays a composition-time choice and
 * no domain can accidentally hand a payload to an exporter.
 */

/** Instrumentation scope. One tracer, one meter, so a backend sees one library. */
export const TELEMETRY_SCOPE = '@been-there/platform';

/**
 * The clearance every span attribute is written at.
 *
 * Fixed rather than a parameter, for the reason `REQUEST_LOG_CLEARANCE` is
 * fixed: a caller that could pass `{ upTo: 'restricted' }` would be a caller
 * that could put a verification artefact into a third party's index. Traces are
 * a debugging and latency tool; the appeal record is the audit log, and the two
 * have different retention and different access stories.
 */
export const SPAN_SINK_CLEARANCE: Clearance = { upTo: 'internal' };

/** A field's value, once it has survived redaction, in the only shape a span can hold. */
type SpanAttributeValue = AttributeValue;

export interface SpanAttributeRecord {
  readonly attributes: Attributes;
  /**
   * Fields that reached neither the span nor any exporter: above the span
   * clearance, or a value OpenTelemetry cannot carry. Reported so the filter is
   * observable without logging what it filtered, which is the same contract
   * `requestLogEntry` keeps.
   */
  readonly withheldFields: readonly string[];
}

/**
 * Converts one field into a span attribute value, or reports it as withheld.
 *
 * `null`, objects and mixed arrays are all refusable rather than coercible.
 * Stringifying them would put a value in the span that no clearance check ever
 * saw, which is the one transformation that turns this function from a filter
 * into a pass-through.
 */
function toAttributeValue(value: JsonValue): SpanAttributeValue | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  if (value.every((element): element is string => typeof element === 'string')) {
    return [...value];
  }
  if (value.every((element): element is number => typeof element === 'number')) {
    return [...value];
  }
  if (value.every((element): element is boolean => typeof element === 'boolean')) {
    return [...value];
  }
  return undefined;
}

/**
 * The only way a value reaches a span. Reuses `redact` rather than writing a
 * second filter, so the classification of a field means the same thing on the
 * bus, in a log line, in a moderation tool and in a trace.
 */
export function spanAttributes(record: ClassifiedRecord): SpanAttributeRecord {
  const redacted = redact(record, SPAN_SINK_CLEARANCE);
  const attributes: Attributes = {};
  const withheldFields: string[] = [];

  for (const field of redacted.fields) {
    // A nested `ClassifiedRecord` is not a span attribute, and `redact` has
    // already emitted its leaves under dotted names. Delivering the outer field
    // as well would put a value in the span that no clearance check inspected
    // as a whole - which is the one transformation that turns this function
    // from a filter into a pass-through. The leaves are delivered under their
    // own dotted names; the container is withheld.
    const value = redacted.visible[field.name];
    if (typeof value === 'object' && value !== null) {
      withheldFields.push(field.name);
      continue;
    }
    const attribute = field.delivered && value !== undefined ? toAttributeValue(value) : undefined;
    if (attribute === undefined) {
      withheldFields.push(field.name);
      continue;
    }
    attributes[field.name] = attribute;
  }

  return { attributes, withheldFields };
}

/**
 * The trace id for a correlation id. Truncated SHA-256, so it is a valid W3C
 * trace id (32 lowercase hex) and it is a pure function of a field the event
 * spine already carries — the same correlation always lands in the same trace,
 * in this process or another one, which is the property `inheritEventContext`
 * already depends on when it refuses to re-mint.
 */
export function traceIdFor(correlationId: CorrelationId): string {
  return createHash('sha256').update(correlationId).digest('hex').slice(0, 32);
}

/** The 64-bit span id for a causation id, under the same derivation. */
export function spanIdFor(causationId: EventId | CorrelationId): string {
  return createHash('sha256').update(causationId).digest('hex').slice(0, 16);
}

/**
 * The parent a span hangs from.
 *
 * The correlation id becomes the trace id, so every span for one user-visible
 * action is in one trace with no propagation step. The causation id becomes the
 * parent span id, so the parent edge names the event that caused this one and
 * the chain reads as a story rather than a pile.
 *
 * The parent is marked remote because the API package cannot mint a span id of
 * our choosing — only an SDK's `IdGenerator` can — so the edge points at a
 * derived anchor rather than at a span the backend will ever have exported. The
 * `correlation_id` and `causation_id` attributes on every span are what make the
 * chain reconstructible in practice, and the platform document says so rather
 * than implying a propagation that does not exist.
 */
export function parentContextFor(seed: {
  readonly correlationId: CorrelationId;
  readonly causationId?: EventId;
}): Context {
  const parent: SpanContext = {
    traceId: traceIdFor(seed.correlationId),
    spanId: spanIdFor(seed.causationId ?? seed.correlationId),
    isRemote: true,
    traceFlags: TraceFlags.SAMPLED,
  };
  return otelTrace.setSpanContext(ROOT_CONTEXT, parent);
}

/** What a span records when it closes. A `RequestContext` satisfies it as it stands. */
export interface SpanOutcome {
  readonly outcome: 'ok' | 'error' | 'denied';
  readonly durationMs?: number;
  /** Domain error code when the outcome is not `ok`. Never an error message. */
  readonly errorCode?: string;
}

/**
 * One open span.
 *
 * `record` is the only way to add an attribute, and it redacts, so there is no
 * path that writes to a span without passing the sink filter. `end` takes the
 * outcome rather than a status code, because deciding what a refusal means for
 * a span's status is a policy and not a call site's business.
 */
export class SpanRecorder {
  #span: Span;
  #withheldFields: string[] = [];

  constructor(span: Span) {
    this.#span = span;
  }

  get withheldFields(): readonly string[] {
    return this.#withheldFields;
  }

  record(record: ClassifiedRecord): void {
    const { attributes, withheldFields } = spanAttributes(record);
    this.#span.setAttributes(attributes);
    this.#withheldFields.push(...withheldFields);
  }

  end(result: SpanOutcome): void {
    const closing: ClassifiedRecord = [
      { name: 'outcome', sensitivity: 'internal', value: result.outcome },
      ...(result.durationMs === undefined
        ? []
        : [{ name: 'duration_ms', sensitivity: 'internal' as const, value: result.durationMs }]),
      ...(result.errorCode === undefined
        ? []
        : [{ name: 'error_code', sensitivity: 'internal' as const, value: result.errorCode }]),
    ];
    this.record(closing);
    // A refusal is the system working: a moderator declining to lift a ban and
    // the account machine denying a capability are both correct outcomes, and
    // marking them ERROR would put correct behaviour into the error budget.
    // `outcome` carries the signal instead.
    // `message` is `string | undefined` under `exactOptionalPropertyTypes` but
    // `SpanStatus` requires a `string`, so the field is omitted rather than
    // set to undefined. `outcome` already carries the signal; the code is a
    // convenience for whoever reads the span.
    this.#span.setStatus(
      result.outcome === 'error'
        ? {
            code: SpanStatusCode.ERROR,
            ...(result.errorCode === undefined ? {} : { message: result.errorCode }),
          }
        : { code: SpanStatusCode.OK },
    );
    this.#span.end();
  }
}

export interface TelemetryDeps {
  readonly tracer: Tracer;
  readonly meter: Meter;
}

/**
 * The span factory, and the seam the SDK is chosen at.
 *
 * Constructed with no arguments it binds to the global OpenTelemetry
 * providers, which are no-ops until an SDK registers itself — so the platform
 * runs unchanged with no exporter, no collector and no vendor. Constructed with
 * a tracer and a meter it binds to whatever the composition root supplied,
 * which is how a test observes spans without an SDK.
 */
export class Telemetry {
  #tracer: Tracer;
  #meter: Meter;

  constructor(deps: Partial<TelemetryDeps> = {}) {
    this.#tracer = deps.tracer ?? otelTrace.getTracer(TELEMETRY_SCOPE);
    this.#meter = deps.meter ?? otelMetrics.getMeter(TELEMETRY_SCOPE);
  }

  get meter(): Meter {
    return this.#meter;
  }

  /**
   * The span for an inbound request. Root of the trace for its correlation id:
   * everything published while serving it lands underneath, and nothing outside
   * the correlation can join.
   */
  startRequestSpan(context: RequestContext, extra?: ClassifiedRecord): SpanRecorder {
    const span = this.#tracer.startSpan(
      `${context.surface} ${context.operation}`,
      {
        kind: SpanKind.SERVER,
        attributes: spanAttributes(this.#envelope(context, extra)).attributes,
      },
      parentContextFor(context),
    );
    return new SpanRecorder(span);
  }

  /**
   * The span for a published or consumed domain event, parented by the event's
   * causation. The envelope carries the event's identity and its sensitivity
   * class and nothing from its payload: the payload is where a case id, a
   * report subject and a message body live, and none of them belongs here.
   */
  startEventSpan(event: DomainEvent, extra?: ClassifiedRecord): SpanRecorder {
    const envelope: ClassifiedRecord = [
      { name: 'correlation_id', sensitivity: 'internal', value: event.correlationId },
      { name: 'causation_id', sensitivity: 'internal', value: event.causationId ?? 'none' },
      { name: 'event_type', sensitivity: 'internal', value: event.type },
      { name: 'event_sensitivity', sensitivity: 'internal', value: event.sensitivity },
      { name: 'occurred_at', sensitivity: 'internal', value: event.occurredAt.toISOString() },
    ];
    const span = this.#tracer.startSpan(
      event.type,
      {
        kind: SpanKind.PRODUCER,
        attributes: spanAttributes([...envelope, ...(extra ?? [])]).attributes,
      },
      parentContextFor(event),
    );
    return new SpanRecorder(span);
  }

  #envelope(context: RequestContext, extra?: ClassifiedRecord): ClassifiedRecord {
    return [
      { name: 'correlation_id', sensitivity: 'internal', value: context.correlationId },
      {
        name: 'causation_id',
        sensitivity: 'internal',
        value: context.causationId ?? 'none',
      },
      { name: 'surface', sensitivity: 'internal', value: context.surface },
      { name: 'operation', sensitivity: 'internal', value: context.operation },
      ...(extra ?? []),
    ];
  }
}
