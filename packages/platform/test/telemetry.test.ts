import { describe, expect, it } from 'vitest';
import {
  type Attributes,
  type SpanAttributeValue,
  type SpanContext,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import { castId, type ActorId, type EventId, type UserId } from '@been-there/core';
import {
  SPAN_SINK_CLEARANCE,
  Telemetry,
  classify,
  completeRequest,
  newRequestTrace,
  parentContextFor,
  requestLogEntry,
  spanAttributes,
  spanIdFor,
  traceIdFor,
  type ClassifiedRecord,
  type RequestContext,
  type SpanRecorder,
} from '../src/index.js';
import { correlationId, domainEvent, subjectId } from './helpers.js';

const ALICE = castId<'UserId'>('u-alice') as UserId;
const ACTOR = castId<'ActorId'>('u-alice') as ActorId;

// The values that must never reach a span. Chosen as literals, not read from a
// constant the production code also reads: a test that shares its fixture with
// the implementation pins the implementation, not the rule.
const LIFENESS_SCORE = 0.9137;
const ID_DOCUMENT_URL = 's3://vault/u-42/id-front.png';
const EXACT_LOCATION = '52.5200,13.4050';
const MODERATOR_NOTE = 'appears to be the same person as u-42';
const MESSAGE_BODY = 'here is my address, come over';
const REPORT_SUBJECT = 'u-99';
const CASE_ID = 'case-7731';

/**
 * A recording tracer. Not a mock of our own code — an implementation of the
 * OpenTelemetry `Tracer` interface, so the test exercises the same call shape a
 * real SDK would, and no exporter is involved anywhere.
 */
class RecordingSpan {
  attributes: Attributes = {};
  status: { code: number; message?: string } | undefined;
  ended = false;
  #counter: number;
  readonly recorded: RecordedSpan;

  constructor(
    readonly name: string,
    readonly kind: number,
    attributes: Attributes,
    readonly parent: SpanContext | undefined,
    counter: number,
    recorded: RecordedSpan,
  ) {
    this.attributes = { ...attributes };
    this.recorded = recorded;
    this.#counter = counter;
  }

  spanContext(): SpanContext {
    return {
      traceId: this.parent?.traceId ?? '0'.repeat(32),
      spanId: this.#counter.toString(16).padStart(16, '0'),
      traceFlags: 1,
    };
  }

  setAttribute(key: string, value: SpanAttributeValue): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Attributes): this {
    Object.assign(this.attributes, attributes);
    return this;
  }

  setStatus(status: { code: number; message?: string }): this {
    this.status = status;
    return this;
  }

  end(): void {
    this.ended = true;
  }

  isRecording(): boolean {
    return true;
  }
}

interface RecordedSpan {
  readonly name: string;
  readonly kind: number;
  readonly attributes: Attributes;
  readonly parentTraceId: string | undefined;
  readonly parentSpanId: string | undefined;
  readonly status: { code: number; message?: string } | undefined;
  readonly ended: boolean;
}

function recordingTracer(): { tracer: Tracer; spans: RecordingSpan[] } {
  const spans: RecordingSpan[] = [];
  let counter = 0;
  const tracer: Tracer = {
    startSpan(name, options, context) {
      counter += 1;
      // `trace.getSpanContext` is the supported accessor. Reading the context
      // key by its string form works only while the implementation happens to
      // use that symbol, and returns an empty object when it does not - which
      // is how a correct parent link can look absent.
      const parent = context === undefined ? undefined : trace.getSpanContext(context);
      const span = new RecordingSpan(name, options?.kind ?? 0, options?.attributes ?? {}, parent, counter, {
        name,
        kind: options?.kind ?? 0,
        attributes: {},
        parentTraceId: parent?.traceId,
        parentSpanId: parent?.spanId,
        status: undefined,
        ended: false,
      });
      span.recorded.attributes = span.attributes;
      spans.push(span);
      return span as unknown as ReturnType<Tracer['startSpan']>;
    },
    startActiveSpan: ((_name: string, ...rest: unknown[]) =>
      (rest.find((argument) => typeof argument === 'function') as (span: never) => unknown)?.(
        undefined as never,
      )) as Tracer['startActiveSpan'],
  };
  return { tracer, spans };
}

function contextFor(operation: string, overrides: Partial<RequestContext> = {}): RequestContext {
  const trace = newRequestTrace({
    actorId: ACTOR,
    surface: 'moderation_console',
    operation,
    correlationId: correlationId('trace'),
  });
  return {
    ...completeRequest(trace, { durationMs: 12, outcome: 'ok', subjectId: subjectId(ALICE) }),
    ...overrides,
  };
}

/** The evidence a restricted read returns, classified the way the audit sink classifies it. */
function restrictedEvidenceRead(): ClassifiedRecord {
  return [
    classify('case_id', 'restricted', CASE_ID),
    classify('report_subject', 'restricted', REPORT_SUBJECT),
    classify('message_body', 'restricted', MESSAGE_BODY),
    classify('liveness_score', 'sensitive', LIFENESS_SCORE),
    classify('id_document_url', 'sensitive', ID_DOCUMENT_URL),
    classify('exact_location', 'sensitive', EXACT_LOCATION),
    classify('moderator_note', 'restricted', MODERATOR_NOTE),
    classify('case_origin', 'internal', 'user_report'),
  ];
}

/** Everything a restricted value could possibly have leaked as, if it had leaked. */
function serialised(spans: readonly RecordingSpan[]): string {
  return JSON.stringify(spans.map((span) => ({ name: span.name, attributes: span.attributes })));
}

describe('span attributes are redacted at the sink', () => {
  it('drops every field a restricted-evidence read would not put in a log line', () => {
    // The rule stated as the test: what a span may hold is what a log line at
    // the same clearance may hold. Not "is not readable" — is not in the bytes
    // the exporter receives.
    const { tracer, spans } = recordingTracer();
    const context = contextFor('case.decide');
    const telemetry = new Telemetry({ tracer });

    const span: SpanRecorder = telemetry.startRequestSpan(context, restrictedEvidenceRead());
    span.end(context);

    expect(spans).toHaveLength(1);
    const body = serialised(spans);
    for (const secret of [
      LIFENESS_SCORE,
      ID_DOCUMENT_URL,
      EXACT_LOCATION,
      MODERATOR_NOTE,
      MESSAGE_BODY,
      REPORT_SUBJECT,
      CASE_ID,
    ]) {
      expect(body).not.toContain(String(secret));
    }
    for (const field of [
      'liveness_score',
      'id_document_url',
      'exact_location',
      'moderator_note',
      'message_body',
      'report_subject',
      'case_id',
    ]) {
      expect(body).not.toContain(field);
    }
  });

  it('keeps exactly the fields the request log keeps, so the two sinks cannot disagree', () => {
    const record = restrictedEvidenceRead();
    const context = contextFor('case.decide');

    // Compared like for like: both sinks receive the *envelope plus* the same
    // classified record. Comparing a bare span against a log that already
    // includes its envelope compares two different things and fails for the
    // wrong reason.
    const { tracer, spans } = recordingTracer();
    const telemetry = new Telemetry({ tracer });
    const span: SpanRecorder = telemetry.startRequestSpan(context, record);
    span.end(context);

    const asSpan = spans[0]?.attributes ?? {};
    const asLog = JSON.parse(requestLogEntry(context, record).body) as Record<string, unknown>;
    expect(Object.keys(asSpan).toSorted()).toEqual(Object.keys(asLog).toSorted());
    expect(asSpan['case_origin']).toBe('user_report');
  });

  it('names the fields it withheld, so the filter is observable without the values', () => {
    const span = spanAttributes(restrictedEvidenceRead());

    expect(span.withheldFields).toEqual([
      'case_id',
      'report_subject',
      'message_body',
      'liveness_score',
      'id_document_url',
      'exact_location',
      'moderator_note',
    ]);
  });

  it('refuses a value shape OpenTelemetry cannot carry rather than stringifying it', () => {
    // A nested record survives redaction as an object; an object is not a
    // span attribute. Coercing it to JSON would put bytes in the span that no
    // clearance check ever saw, which is the one transformation that turns the
    // filter into a pass-through.
    const nested = [classify('profile', 'internal', [classify('display_name', 'public', 'Robin')])];

    const span = spanAttributes(nested);

    expect(span.attributes).toEqual({});
    // Both the container and the leaf it flattened into are withheld. The leaf
    // is the interesting one: it passed the clearance check on its own, so a
    // filter that only looked at the top level would have delivered it, and a
    // dotted name is the shape that leaks a structure nobody inspected whole.
    expect(span.withheldFields).toEqual(['profile.display_name', 'profile']);
  });

  it('writes at a clearance the caller cannot raise', () => {
    // Fixed at `internal`, for the reason REQUEST_LOG_CLEARANCE is fixed: a
    // caller that could pass `{ upTo: 'restricted' }` would be a caller that
    // could put a liveness artefact in a third party's index.
    expect(SPAN_SINK_CLEARANCE).toEqual({ upTo: 'internal' });
    expect(spanAttributes([classify('moderator_note', 'restricted', MODERATOR_NOTE)]).attributes).toEqual({});
  });
});

describe('the correlation chain becomes the trace', () => {
  it('puts the case, the risk assessment and the request in one trace with the right parents', () => {
    const { tracer, spans } = recordingTracer();
    const telemetry = new Telemetry({ tracer });
    const context = contextFor('report.submit');

    const request = telemetry.startRequestSpan(context);
    const risk = telemetry.startEventSpan(
      domainEvent({
        type: 'risk.changed',
        sensitivity: 'internal',
        id: 'evt-risk',
        correlationId: context.correlationId,
        subjectId: subjectId(ALICE),
        payload: { to: 'high', effectiveScore: 0.81 },
      }),
    );
    const moderationCase = telemetry.startEventSpan(
      domainEvent({
        type: 'moderation.case_opened',
        sensitivity: 'restricted',
        id: 'evt-case',
        correlationId: context.correlationId,
        causationId: 'evt-risk',
        subjectId: subjectId(ALICE),
        payload: { caseId: CASE_ID, origin: 'risk_escalation' },
      }),
    );
    request.end(context);
    risk.end({ outcome: 'ok', durationMs: 3 });
    moderationCase.end({ outcome: 'ok', durationMs: 40 });

    expect(spans.map((span) => span.name)).toEqual([
      'moderation_console report.submit',
      'risk.changed',
      'moderation.case_opened',
    ]);
    const traceIds = new Set(spans.map((span) => span.recorded.parentTraceId));
    expect(traceIds).toEqual(new Set([traceIdFor(context.correlationId)]));
    // The case hangs off the risk assessment, which is the causation edge the
    // event spine already carried.
    expect(spans[2]?.recorded.parentSpanId).toBe(spanIdFor(castId<'EventId'>('evt-risk')));
  });

  it('derives the same trace id from the same correlation and a different one otherwise', () => {
    const first = traceIdFor(correlationId('a'));
    const second = traceIdFor(correlationId('b'));

    expect(first).toBe(traceIdFor(correlationId('a')));
    expect(first).not.toBe(second);
    // A W3C trace id is 32 lowercase hex; a span id is 16. A derived id that
    // fails either shape is a trace the backend silently drops.
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(spanIdFor(correlationId('a'))).toMatch(/^[0-9a-f]{16}$/);
  });

  it('roots a span with no causation under its own correlation', () => {
    const context = parentContextFor({ correlationId: correlationId('solo') });
    const value = trace.getSpanContext(context);

    expect(value?.spanId).toBe(spanIdFor(correlationId('solo')));
    expect(value?.isRemote).toBe(true);
  });

  it('carries the event identity on the span and nothing from its payload', () => {
    const { tracer, spans } = recordingTracer();
    const telemetry = new Telemetry({ tracer });
    const event = domainEvent({
      type: 'moderation.case_opened',
      sensitivity: 'restricted',
      id: 'evt-case',
      correlationId: correlationId('trace'),
      subjectId: subjectId(ALICE),
      payload: { caseId: CASE_ID, origin: 'user_report', moderatorNotes: MODERATOR_NOTE },
    });

    telemetry.startEventSpan(event).end({ outcome: 'ok' });

    expect(Object.keys(spans[0]?.attributes ?? {}).toSorted()).toEqual([
      'causation_id',
      'correlation_id',
      'event_sensitivity',
      'event_type',
      'occurred_at',
      'outcome',
    ]);
    expect(spans[0]?.attributes['event_sensitivity']).toBe('restricted');
  });
});

describe('span closure carries the outcome and not the error text', () => {
  it('records a domain error code and marks a failure as an error', () => {
    const { tracer, spans } = recordingTracer();
    const context = contextFor('case.decide', { outcome: 'error', errorCode: 'not_found' });

    new Telemetry({ tracer }).startRequestSpan(context).end(context);

    expect(spans[0]?.status).toEqual({ code: 2, message: 'not_found' });
    expect(spans[0]?.attributes['error_code']).toBe('not_found');
    expect(spans[0]?.ended).toBe(true);
  });

  it('does not put a denial into the error budget', () => {
    // A moderator declining to lift a ban and the account machine refusing a
    // capability are both the system working. Marking them ERROR would make
    // correct behaviour consume the budget an SLO breach has to spend.
    const { tracer, spans } = recordingTracer();
    const context = contextFor('case.decide', { outcome: 'denied', errorCode: 'permission_denied' });

    new Telemetry({ tracer }).startRequestSpan(context).end(context);

    expect(spans[0]?.status).toEqual({ code: 1 });
    expect(spans[0]?.attributes['outcome']).toBe('denied');
  });
});
