/**
 * The smallest thing that satisfies `@opentelemetry/api`'s `TracerProvider`,
 * `Tracer` and `Span`.
 *
 * Why it exists instead of an SDK dependency: this repository has exactly one
 * `@opentelemetry/api` dependency and nothing that implements it. Adding
 * `@opentelemetry/sdk-trace-node` to a workspace would change what the service
 * ships, and the platform's own documentation is explicit that the SDK is a
 * composition-time choice — `packages/platform/src/telemetry.ts`: "Only this
 * file imports `@opentelemetry/api`. … the SDK stays a composition-time choice".
 * So the SDK-shaped code lives outside the workspaces, in `ops/`, and the service
 * runs unchanged when it is absent.
 *
 * What is implemented, and nothing more: mint a trace and span id, hold
 * attributes, hold a status, and hand the finished span to a sink. Everything the
 * platform actually calls is covered — `Telemetry.startRequestSpan` returns a
 * `SpanRecorder`, whose `record` and `end` are the only methods the service
 * reaches. Sampling, batching, context managers and propagation are not
 * implemented and are not needed: one process, one hop, localhost.
 */

import { randomBytes } from 'node:crypto';
import { SpanKind, SpanStatusCode, TraceFlags, trace } from '@opentelemetry/api';
import { attributes, nowNanos } from './otlp.mjs';

/** A W3C trace id is 16 bytes, a span id 8, and neither may be all zeroes. */
function randomId(bytes) {
  const id = randomBytes(bytes).toString('hex');
  return /^0+$/.test(id) ? 'f'.repeat(bytes * 2) : id;
}

/**
 * `@opentelemetry/api`'s `SpanKind` and OTLP's `Span.SpanKind` are both numbered
 * from zero, and they are numbered differently: the API says `SERVER = 1` where
 * OTLP says `SPAN_KIND_SERVER = 2`. Sending the API's number straight through
 * produces a valid span that every backend files as internal, which reads as
 * "Grafana is not grouping by service" for a week.
 */
const SPAN_KINDS = {
  [SpanKind.INTERNAL]: 'SPAN_KIND_INTERNAL',
  [SpanKind.SERVER]: 'SPAN_KIND_SERVER',
  [SpanKind.CLIENT]: 'SPAN_KIND_CLIENT',
  [SpanKind.PRODUCER]: 'SPAN_KIND_PRODUCER',
  [SpanKind.CONSUMER]: 'SPAN_KIND_CONSUMER',
};

/**
 * OpenTelemetry passes an end time as an `HrTime` — `[seconds, nanoseconds]` —
 * and the demo never supplies one. Both shapes are handled because a wrong
 * answer here is a span with an end time of `NaN` in a third party's index.
 */
function toNanos(endTime) {
  if (endTime === undefined) {
    return nowNanos();
  }
  if (Array.isArray(endTime)) {
    return String(BigInt(endTime[0]) * 1_000_000_000n + BigInt(endTime[1]));
  }
  return String(BigInt(endTime) * 1_000_000n);
}

class Span {
  #name;
  #kind;
  #traceId;
  #spanId;
  #parentSpanId;
  #attributes;
  #sink;
  #events = [];
  #status = { code: SpanStatusCode.UNSET };
  #startTimeUnixNano;
  #ended = false;

  constructor(name, { kind, attributes: initial, parent, traceId, sink }) {
    this.#name = name;
    this.#kind = kind;
    this.#traceId = traceId;
    this.#spanId = randomId(8);
    this.#parentSpanId = parent?.spanId;
    this.#attributes = { ...initial };
    this.#sink = sink;
    this.#startTimeUnixNano = nowNanos();
  }

  spanContext() {
    return {
      traceId: this.#traceId,
      spanId: this.#spanId,
      isRemote: false,
      traceFlags: TraceFlags.SAMPLED,
    };
  }

  setAttribute(key, value) {
    this.setAttributes({ [key]: value });
    return this;
  }

  setAttributes(record) {
    // Attributes reach here only from `SpanRecorder.record`, which is the one
    // caller and which redacts before it writes. Nothing else in the process
    // holds a reference to this object.
    Object.assign(this.#attributes, record);
    return this;
  }

  setStatus(status) {
    this.#status = status;
    return this;
  }

  updateName(name) {
    this.#name = name;
    return this;
  }

  addEvent(name, record = {}) {
    this.#events.push({ timeUnixNano: nowNanos(), name, attributes: record });
    return this;
  }

  recordException(exception) {
    this.addEvent('exception', { 'exception.message': String(exception) });
  }

  isRecording() {
    return !this.#ended;
  }

  end(endTime) {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    this.#sink.push({
      traceId: this.#traceId,
      spanId: this.#spanId,
      ...(this.#parentSpanId === undefined ? {} : { parentSpanId: this.#parentSpanId }),
      name: this.#name,
      kind: SPAN_KINDS[this.#kind] ?? 'SPAN_KIND_INTERNAL',
      startTimeUnixNano: this.#startTimeUnixNano,
      endTimeUnixNano: toNanos(endTime),
      attributes: attributes(this.#attributes),
      ...(this.#events.length === 0
        ? {}
        : {
            events: this.#events.map((event) => ({
              timeUnixNano: event.timeUnixNano,
              name: event.name,
              attributes: attributes(event.attributes),
            })),
          }),
      status:
        this.#status.code === undefined || this.#status.code === SpanStatusCode.UNSET
          ? {}
          : {
              code: this.#status.code,
              ...(this.#status.message === undefined ? {} : { message: this.#status.message }),
            },
    });
  }
}

class Tracer {
  #scope;
  #sink;

  constructor(scope, sink) {
    this.#scope = scope;
    this.#sink = sink;
  }

  startSpan(name, options = {}, context) {
    const parent = trace.getSpanContext(context);
    return new Span(name, {
      kind: options.kind ?? SpanKind.INTERNAL,
      attributes: options.attributes ?? {},
      parent,
      traceId: parent?.traceId ?? randomId(16),
      sink: this.#sink,
    });
  }

  startActiveSpan(name, options, context, fn) {
    return fn(this.startSpan(name, options, context));
  }

  /** The scope this tracer was created for; the exporter labels spans with it. */
  get scope() {
    return this.#scope;
  }
}

class TracerProvider {
  #sink;
  #tracers = new Map();

  constructor(sink) {
    this.#sink = sink;
  }

  getTracer(name = 'default', version = '0.0.0') {
    const key = `${name}@${version}`;
    const existing = this.#tracers.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const tracer = new Tracer({ name, version }, this.#sink);
    this.#tracers.set(key, tracer);
    return tracer;
  }
}

/**
 * Registers the provider globally, so `@opentelemetry/api` is no longer an inert
 * registry in this process.
 *
 * Global registration matters even though the HTTP instrumentation passes its
 * tracer in explicitly: the global registry is what any future call site inside
 * the service would reach for, and leaving it inert is what keeps "the platform
 * runs unchanged with no exporter" true in both directions — off without this
 * module, live with it.
 */
export function registerTracerProvider(sink) {
  const provider = new TracerProvider(sink);
  trace.setGlobalTracerProvider(provider);
  return provider;
}