#!/usr/bin/env node
/**
 * Instrumentation for the Been There service, as a Node preload module.
 *
 *   BEEN_THERE_OBSERVABILITY=1 node --import ./ops/observability/instrumentation.mjs scripts/demo/server.mjs
 *
 * ## Off unless asked for
 *
 * `BEEN_THERE_OBSERVABILITY=1` is the only thing that turns this on. Without it
 * the module returns before importing anything, so the process is the process it
 * would otherwise have been: no timer, no socket, no patched prototype, no
 * second copy of the request. Nothing here changes a status code, and the
 * service's own suites do not load this file.
 *
 * ## What it instruments, and through which seam
 *
 * The platform already owns the shape of a request's trace. `Telemetry`
 * (`packages/platform/src/telemetry.ts`) is the span factory, `newRequestTrace`
 * mints the correlation id at the edge, `completeRequest` finishes the context,
 * `requestLogEntry` serialises the log line at a fixed `internal` clearance, and
 * `SpanRecorder.record` is the only way a value reaches a span. This file calls
 * those five and adds no filter of its own: the attributes on a span and the
 * fields in a log line come from the same classified record, which is a property
 * `packages/platform/test/telemetry.test.ts` already asserts.
 *
 * The HTTP boundary is observed by wrapping the `request` listener the server
 * registers — the same seam `@opentelemetry/instrumentation-http` uses, and the
 * reason no file under `packages/` has to change. The route is derived from the
 * path rather than read from the route table, because the table needs live
 * dependencies to construct and a path that cannot carry a value out of the
 * process is worth more than a route's declared name.
 *
 * ## What it does not send
 *
 * No request body, no response body, no query string, no header value, no
 * cookie, no session token, no path parameter. `routeOf()` reduces every path
 * segment that is not a documented lowercase route word to `{id}`, which covers
 * identifiers, email addresses, tokens and anything base64 a future route might
 * put in a path. Anything the platform classifies above `internal` never reaches
 * this file, because the platform's filter runs first; the *names* of the fields
 * it dropped travel with the log line, which is what `RequestLogEntry
 * .redactedFields` is for.
 */
import http from 'node:http';
import { hostname } from 'node:os';

const ENABLED = ['1', 'true', 'yes'].includes(
  (process.env['BEEN_THERE_OBSERVABILITY'] ?? '').toLowerCase(),
);

if (ENABLED) {
  await install();
}

async function install() {
  const {
    TELEMETRY_SCOPE,
    Telemetry,
    classify,
    completeRequest,
    newRequestTrace,
    requestLogEntry,
    traceIdFor,
  } = await import('@been-there/platform');
  const { createEdgeMetrics } = await import('./lib/edge-metrics.mjs');
  const { attributes, createSink, nowNanos, resourceBlock } = await import('./lib/otlp.mjs');
  const { registerTracerProvider } = await import('./lib/tracer.mjs');

  const serviceName = process.env['OTEL_SERVICE_NAME'] ?? 'been-there-service';
  const resource = () => ({
    'service.name': serviceName,
    'service.namespace': 'been-there',
    'service.version': '0.0.1',
    'deployment.environment.name': 'local',
    // One demo run starts more than one service process — `make demo` serves
    // one, and the acceptance walk starts its own — and they report the same
    // cumulative counters under the same name. Without a per-process identity
    // their numbers interleave in one series, and a counter that restarts at
    // zero every few seconds is a counter `rate()` cannot read. Prometheus maps
    // this attribute onto its `instance` label, which is what keeps two
    // processes two series.
    'service.instance.id': `${hostname()}:${process.pid}`,
  });
  const scope = { name: TELEMETRY_SCOPE, version: '0.0.1' };

  const traces = createSink({
    name: 'tempo',
    url: process.env['OBS_TRACES_URL'] ?? 'http://127.0.0.1:4318/v1/traces',
    resource,
    document: (spans) => ({
      resourceSpans: [{ ...resourceBlock(resource), scopeSpans: [{ scope, spans }] }],
    }),
  });
  const logs = createSink({
    name: 'loki',
    url: process.env['OBS_LOGS_URL'] ?? 'http://127.0.0.1:3100/otlp/v1/logs',
    resource,
    document: (records) => ({
      resourceLogs: [{ ...resourceBlock(resource), scopeLogs: [{ scope, logRecords: records }] }],
    }),
  });
  const edgeMetrics = createEdgeMetrics();
  const metrics = createSink({
    name: 'prometheus',
    url: process.env['OBS_METRICS_URL'] ?? 'http://127.0.0.1:9090/api/v1/otlp/v1/metrics',
    resource,
    document: (series) => ({
      resourceMetrics: [{ ...resourceBlock(resource), scopeMetrics: [{ scope, metrics: series.flat() }] }],
    }),
  });

  const provider = registerTracerProvider({ push: (span) => traces.push(span) });
  const telemetry = new Telemetry({ tracer: provider.getTracer(TELEMETRY_SCOPE) });

  /**
   * The path, reduced to something that can be a metric label and cannot be a
   * value. A segment that is not a short lowercase word is replaced, so a UUID, a
   * ULID, an address or a token all become the same token in every span, log and
   * metric. The query string is dropped rather than parsed: it is the one part of
   * a URL in this API where a credential or an identifier can appear, and there
   * is no reason to send either to a third-party index.
   */
  function routeOf(rawUrl) {
    const path = String(rawUrl ?? '/').split('#')[0].split('?')[0];
    const reduced = path
      .split('/')
      .map((segment) => (segment === '' || /^[a-z][a-z0-9_-]{0,31}$/.test(segment) ? segment : '{id}'))
      .join('/');
    return reduced === '' ? '/' : reduced;
  }

  /**
   * The outcome, from the one thing the boundary can see.
   *
   * The service's own counter classifies responses by domain error code, and
   * that classification is the authoritative one. At the HTTP boundary the code
   * is inside the response body, and reading a response body to classify a span
   * is a redaction hole dressed up as telemetry — so the boundary uses the status
   * code and says so, rather than inventing a second answer.
   */
  function outcomeFor(statusCode) {
    return statusCode >= 500 ? 'error' : statusCode >= 400 ? 'denied' : 'ok';
  }

  const severity = { info: 9, warn: 13, error: 17 };

  function observe(request, response, listener) {
    const startedAt = process.hrtime.bigint();
    const route = routeOf(request.url);
    const trace = newRequestTrace({ actorId: 'system', surface: 'http', operation: `${request.method} ${route}` });

    // `startRequestSpan` is the seam: it mints the span, applies
    // `SPAN_SINK_CLEARANCE` through `spanAttributes`, and returns a recorder
    // whose only writer is that filter. Nothing is set on the span except
    // through `record`.
    const recorder = telemetry.startRequestSpan(completeRequest(trace, { durationMs: 0, outcome: 'ok' }));
    recorder.record([
      classify('http.request.method', 'internal', request.method),
      classify('http.route', 'internal', route),
      classify('network.protocol.version', 'internal', request.httpVersion),
      // The correlation id is hashed into the trace id by `traceIdFor`, and a
      // trace is found by its id: carrying it as an attribute too is what makes
      // the span findable from a trace id and the log findable from a span.
      classify('trace_id', 'internal', traceIdFor(trace.correlationId)),
    ]);

    let done = false;
    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      const statusCode = response.statusCode;
      const outcome = outcomeFor(statusCode);
      const context = completeRequest(trace, { durationMs, outcome });
      const classified = [
        classify('http.request.method', 'internal', request.method),
        classify('http.route', 'internal', route),
        classify('http.response.status_code', 'internal', statusCode),
        classify('trace_id', 'internal', traceIdFor(trace.correlationId)),
      ];

      recorder.record([classify('http.response.status_code', 'internal', statusCode)]);
      recorder.end(context);

      const entry = requestLogEntry(context, classified);
      const record = {
        timeUnixNano: nowNanos(),
        observedTimeUnixNano: nowNanos(),
        severityNumber: severity[entry.level],
        severityText: entry.level.toUpperCase(),
        // The body is `requestLogEntry`'s output, which is the redacted record
        // and nothing else. It is not re-serialised, parsed and re-escaped here.
        body: { stringValue: entry.body },
        attributes: [
          ...attributes({ ...JSON.parse(entry.body), trace_id: traceIdFor(trace.correlationId) }),
          ...(entry.redactedFields.length === 0
            ? []
            : attributes({ redacted_fields: entry.redactedFields.join(',') })),
        ],
        traceId: traceIdFor(trace.correlationId),
      };
      logs.push(record);

      // The same line to stdout, so `.demo/service.log` and the terminal show
      // what Loki holds. The demo's own `[demo]` and `READY` lines are untouched.
      process.stdout.write(
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level: entry.level,
          ...JSON.parse(entry.body),
          ...(entry.redactedFields.length === 0
            ? {}
            : { redacted_fields: entry.redactedFields.join(',') }),
        })}\n`,
      );

      edgeMetrics.record({
        method: request.method,
        route,
        statusCode: String(statusCode),
        outcome,
        seconds: Number((process.hrtime.bigint() - startedAt) / 1_000_000n) / 1000,
      });
    };

    response.on('finish', finish);
    response.on('close', finish);
    listener.call(this, request, response);
  }

  const originalOn = http.Server.prototype.on;
  http.Server.prototype.on = function on(event, listener) {
    if (event !== 'request' || typeof listener !== 'function') {
      return originalOn.call(this, event, listener);
    }
    return originalOn.call(this, event, function instrumented(request, response) {
      observe(request, response, listener);
    });
  };

  // Metrics are pushed on their own cadence rather than per request: the series
  // are cumulative, so a five-second push reports the same numbers a per-request
  // push would and costs a fifth as much. Unref'd, so it cannot hold the process
  // open.
  const metricTimer = setInterval(() => {
    const series = edgeMetrics.toOtlp();
    if (series.length > 0) {
      metrics.push(series);
    }
  }, 5_000);
  metricTimer.unref();

  const flush = () => {
    traces.flushNow();
    logs.flushNow();
    metrics.flushNow();
  };
  // `beforeExit` runs when an unref'd event loop empties, which is the only
  // moment a last batch can still be pushed. The signal handler covers the other
  // exit: the service is draining its own connections at that point, and the
  // push needs the loop the drain is still using.
  process.on('beforeExit', flush);
  process.on('SIGTERM', flush);
  process.on('SIGINT', flush);

  process.stderr.write(
    `[telemetry] observing: traces -> ${process.env['OBS_TRACES_URL'] ?? 'http://127.0.0.1:4318/v1/traces'}, ` +
      `logs -> ${process.env['OBS_LOGS_URL'] ?? 'http://127.0.0.1:3100/otlp/v1/logs'}, ` +
      `metrics -> ${process.env['OBS_METRICS_URL'] ?? 'http://127.0.0.1:9090/api/v1/otlp/v1/metrics'}\n`,
  );
}