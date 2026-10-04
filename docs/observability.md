# Observability

> Local stack for the running service: a log backend, a metrics store, a trace
> backend, and one dashboard. Everything here runs on this machine with Docker
> against the same Postgres `make demo` uses. No account, no key, no SaaS.
>
> Executable form: [`../ops/observability`](../ops/observability). The service
> side of it is [`packages/platform/src/telemetry.ts`](../packages/platform/src/telemetry.ts)
> and [`packages/platform/src/redaction.ts`](../packages/platform/src/redaction.ts);
> nothing under `packages/` changes to make this work.

## 1. What each component is for, and why these four

| Component | Image | Port | Job |
|-----------|-------|------|-----|
| **Grafana** | `grafana/grafana:11.6.0` | 3001 | The only thing a person opens. Reads the other three and links them together. |
| **Prometheus** | `prom/prometheus:v3.5.0` | 9090 | Metric store. Holds the service's own catalogue and the request rate and latency the instrumentation times. |
| **Loki** | `grafana/loki:3.5.1` | 3100 | Log store, one line per request. |
| **Tempo** | `grafana/tempo:2.7.2` | 3200 (query), 4318 (OTLP) | Trace store, one span per request. |

**Why four and not a collector between them.** Tempo, Loki and Prometheus each
accept OTLP/HTTP directly, and Prometheus 3 has its own OTLP write receiver, so
a collector would rename fields and forward them — a fifth process to configure,
debug and keep alive for no gain at this scale.

**Why four and not one.** Logs, metrics and traces are different storage
engines with different query languages, and no single free tool does all three.
Grafana is the one process that speaks all three, which is what makes the join
between them possible at all.

## 2. Bring it up

```sh
# 1. The stores and the dashboard (starts four containers, waits for health).
node ops/observability/stack.mjs up
#    Grafana    http://localhost:3001
#    Prometheus http://localhost:9090
#    Loki       http://localhost:3100
#    Tempo      http://localhost:3200

# 2. The metrics bridge, in its own terminal. The service's metric catalogue is
#    served as JSON over an authenticated route, and Prometheus speaks only the
#    text exposition format; this reads that route with a real staff session and
#    republishes it on port 9099.
node ops/observability/metrics-exporter.mjs

# 3. The service, instrumented. The flag is the only thing that turns
#    instrumentation on; without it this process is byte-for-byte the process
#    `make demo` starts.
BEEN_THERE_OBSERVABILITY=1 node --import ./ops/observability/instrumentation.mjs scripts/demo/server.mjs

# 4. Traffic. Either the acceptance walk, which needs the flag and the preload
#    exported so its own child service is instrumented too:
BEEN_THERE_OBSERVABILITY=1 NODE_OPTIONS="--import file://$PWD/ops/observability/instrumentation.mjs" npm run demo:journey
#    …or a few requests by hand:
curl -s http://127.0.0.1:8787/v1/health/live
curl -s -X POST -H 'content-type: application/json' \
  -d '{"contact":"you@example.test","password":"correct-horse-battery-staple-42","dateOfBirth":"1990-06-15","termsVersion":"2026-09-01"}' \
  http://127.0.0.1:8787/v1/accounts
```

Open <http://localhost:3001> and you land on the **Been There — service**
dashboard: Grafana is provisioned as files, so there is nothing to click first
and no dashboard to import.

`make demo` also works with the flag, as long as the preload reaches the process
it starts:

```sh
BEEN_THERE_OBSERVABILITY=1 NODE_OPTIONS="--import file://$PWD/ops/observability/instrumentation.mjs" make demo
```

### Ports and names

Every host port is overridable, which is the first thing to reach for when
something on your machine already answers on one:

```sh
OBS_GRAFANA_PORT=3010 OBS_PROMETHEUS_PORT=9091 OBS_LOKI_PORT=3101 OBS_TEMPO_PORT=3201 \
  node ops/observability/stack.mjs up
```

Grafana is on **3001** rather than 3000 because a developer's machine frequently
already has something there, and the symptom of a clash is a container that will
not start. All four ports are bound to `127.0.0.1` only.

The stack is a **second Compose project**, `been-there-observability`, not an
extension of the root `docker-compose.yml` that owns Postgres. `stack.mjs`
passes `-p` explicitly so a `COMPOSE_PROJECT_NAME` in your shell cannot merge
the two projects. Under the hood it is:

```sh
docker compose -p been-there-observability -f ops/observability/docker-compose.yml up -d --wait
```

### Configuration

| Variable | Default | Read by | Meaning |
|----------|---------|---------|---------|
| `BEEN_THERE_OBSERVABILITY` | unset | instrumentation | `1`, `true` or `yes` turns instrumentation on. Anything else, including unset, leaves the process untouched. |
| `OBS_TRACES_URL` | `http://127.0.0.1:4318/v1/traces` | instrumentation | Where spans go. |
| `OBS_LOGS_URL` | `http://127.0.0.1:3100/otlp/v1/logs` | instrumentation | Where log lines go. |
| `OBS_METRICS_URL` | `http://127.0.0.1:9090/api/v1/otlp/v1/metrics` | instrumentation | Where request metrics go. |
| `OTEL_SERVICE_NAME` | `been-there-service` | instrumentation | The `service.name` resource attribute, and the label every dashboard query filters on. |
| `BEEN_THERE_SERVICE_URL` | `http://127.0.0.1:$DEMO_PORT` (8787) | exporter | Which service to read the catalogue from. |
| `OBS_EXPORTER_PORT` | `9099` | exporter | The port Prometheus scrapes. |
| `OBS_EXPORTER_BIND` | `0.0.0.0` | exporter | Bound to loopback by default; change only if you are running Prometheus somewhere other than this machine's Docker network. |
| `OBS_EXPORTER_INTERVAL_MS` | `5000` | exporter | How often to read the catalogue. |
| `DEMO_STAFF_CONTACT`, `DEMO_STAFF_PASSWORD` | `moderator@demo.localhost`, `demo-staff-local-only` | both | The demo moderator. The exporter and the service must agree: a service started with a different `DEMO_STAFF_CONTACT` gets a sign-in the exporter cannot answer. |

## 3. What the instrumentation does, and through which seam

The platform already decided what a request's trace looks like.
[`Telemetry`](../packages/platform/src/telemetry.ts) is the span factory,
`newRequestTrace` mints the correlation id at the edge, `completeRequest`
finishes the context, `requestLogEntry` serialises the log line at a fixed
`internal` clearance, and `SpanRecorder.record` is the only way a value reaches
a span. `instrumentation.mjs` calls those five and **adds no filter of its own**,
which is why the attributes on a span and the fields in a log line are the same
set — a property the platform's own
[`telemetry.test.ts`](../packages/platform/test/telemetry.test.ts) asserts.

The HTTP boundary is observed by wrapping the `request` listener the server
registers: the same seam `@opentelemetry/instrumentation-http` uses, and the
reason no file under `packages/` has to change. It is the only place in this
stack that knows anything about HTTP.

Three details worth knowing before reading a trace:

- **Outcome comes from the status code.** The service's own counter classifies
  responses by domain error code, and that classification is authoritative. At
  the HTTP boundary the code is inside the response body, and reading a response
  body to classify a span is a redaction hole dressed up as telemetry. So the
  boundary uses 2xx/3xx → `ok`, 4xx → `denied`, 5xx → `error`, and says so.
- **Every span is a child of a span nobody exported.**
  [`parentContextFor`](../packages/platform/src/telemetry.ts) derives the parent
  from the correlation id because `@opentelemetry/api` cannot mint a span id of a
  chosen value. Tempo therefore reports each request's root service as
  `<root span not yet received>`, and a trace has one span. This is the
  platform's design and it is documented in that file; search traces by resource
  attribute (`{ resource.service.name="been-there-service" }`), not by service
  map.
- **`trace_id` is the correlation id, hashed.**
  [`traceIdFor`](../packages/platform/src/telemetry.ts) derives the W3C trace id
  from the correlation id as a truncated SHA-256, so a log line's `trace_id`
  attribute *is* the trace it belongs to. That is the whole of the
  logs-to-traces wiring below — there is no mapping table anywhere.

## 4. Reading the dashboard

**Been There — service**, at <http://localhost:3001/d/been-there-service>.

| Panel | Reads | How to read it |
|-------|-------|----------------|
| **Requests / min** | `http_server_requests_total` | Everything the service answered, per minute. A flat line with traffic means the instrumentation is off, not that the service is idle. |
| **Refusals / min** | same, `outcome="denied"` | 4xx. A refusal is the safety system working: a capability denied, an unverified account refused, a token rejected. Rising refusals are a fact about traffic, not an incident. |
| **5xx / min** | same, `outcome="error"` | The service failing. Nothing else on this dashboard should move before this one does. |
| **p95 latency** | `http_server_request_duration_seconds_bucket` | Read the shape first. A p99 that rises alone is one slow route, and *Requests by route* names it. |
| **Catalogue scrape** | `been_there_metrics_exporter_scrape_success` | `UP` means the bridge read the service's catalogue within the last poll. `DOWN` with the `edge_response_*` panels empty means the bridge or the service stopped — **not** that the traffic stopped. |
| **Responses by class** | `edge_response_total` | The service's own counter: `completed` (the service answered), `refused` (the refusal was the answer), `outage` (it could not answer at all). Keeping these apart is the point of the counter; averaging them gives a number that means nothing. |
| **Refusals by domain code** | same, sliced by `code` | The domain's own error code rather than the HTTP status. A flat count with a moving mix is a behaviour change. |
| **Latency quantiles** | the histogram, p50/p90/p99 | The service records no duration of its own; this is the boundary's measurement. |
| **Requests by route** | `http_server_requests_total` by `route` | Route *templates*. Every path segment that is not a route word is reduced to `{id}` before it leaves the process, so this panel cannot become a list of account identifiers. |
| **Request log** | Loki, `{service_name="been-there-service"}` | One line per request. Click the `trace_id` in a line to open its trace. |

## 5. Log and trace exploration

**Logs — Grafana → Explore → Loki**

```logql
{service_name="been-there-service"}
```

```logql
{service_name="been-there-service"} |~ "outcome\":\"(denied|error)\""
```

```logql
{service_name="been-there-service"} |= "POST /v1/reports"
```

```logql
sum by (operation) (count_over_time({service_name="been-there-service"}[15m]))
```

or straight from the shell:

```sh
curl -sG http://127.0.0.1:3100/loki/api/v1/query_range \
  --data-urlencode 'query={service_name="been-there-service"}' --data-urlencode 'limit=20'
```

**Traces — Grafana → Explore → Tempo**, or the shell:

```sh
curl -sG http://127.0.0.1:3200/api/search \
  --data-urlencode 'q={ resource.service.name="been-there-service" }'
curl -s http://127.0.0.1:3200/api/traces/<traceID>
```

```traceql
{ resource.service.name="been-there-service" && name="http POST /v1/reports" }
{ resource.service.name="been-there-service" && span.http.response.status_code >= 500 }
```

**The two together.** In the Tempo datasource, *Trace to logs* is configured on
the span attribute `trace_id`; in the Loki datasource, `TraceID` is a derived
field that turns the `trace_id` in a log line into a link to the trace. Click
either way.

**Metrics straight from Prometheus**, when you want the number rather than the
picture:

```sh
curl -sG http://127.0.0.1:9090/api/v1/query \
  --data-urlencode 'query=sum by (class) (rate(edge_response_total[5m]))'
curl -s http://127.0.0.1:9099/metrics | grep edge_response
```

## 6. What is deliberately not collected, and why

This is the part of the stack with the least room for judgement, so it is
enumerated rather than summarised.

| Not collected | Why |
|---------------|-----|
| Request and response bodies | The only field in an HTTP exchange that reliably carries a contact address, a date of birth, a message, a selfie reference or a token. Nothing here reads either buffer. |
| Query strings | The one part of a URL in this API where a credential or an identifier can appear. `routeOf()` splits on `?` and drops the rest without parsing it. |
| Path parameters | Every path segment that is not a documented lowercase route word becomes `{id}` — that covers UUIDs, ULIDs, email addresses and anything base64 a future route might put in a path. |
| Header values, cookies, bearer tokens | A header is where a credential lives. The instrumentation reads the request's method, URL and HTTP version and nothing else. |
| Anything classified above `internal` | `requestLogEntry` and `SpanRecorder.record` both redact at a fixed `internal` clearance before serialising. The *names* of the fields they dropped travel with the log line (`redacted_fields`) so the filter is observable without the values — the platform's own `RequestLogEntry.redactedFields`, used as designed. |
| A subject, an actor, a user id | The trace seed at the edge uses `actorId: 'system'` because the HTTP boundary cannot know the caller without re-implementing authentication. Nothing reads it into a field. |
| Response bodies, to classify errors | See §3. The domain error code is authoritative and lives in the body; the boundary uses the status code instead of opening the body to look. |
| Correlation ids as metric labels | `traceIdFor` and `correlationId` are on every span and every log line, which is where a correlation belongs. On a metric they would be a high-cardinality label, and `defineMetrics` refuses one at construction time. |

Anything this stack stores was produced by a classified record that the platform
cleared at the sink. There is no path from a request to a log line, a span or a
metric that does not pass through `redact()`.

## 7. Teardown

```sh
node ops/observability/stack.mjs down      # stop, keep the volumes
node ops/observability/stack.mjs reset     # stop and delete every volume
```

`reset` is the one to reach for when a dashboard is empty and you cannot work
out why: a stale Loki or Tempo volume is the usual reason a report is not
reproducible. Neither command touches the root `docker-compose.yml` project, so
`make down` and Postgres are unaffected.

The two host processes stop with their terminals; `make demo-stop` stops the
service the way it always did.

## 8. Files

| Path | What it is |
|------|------------|
| `ops/observability/docker-compose.yml` | The four containers. |
| `ops/observability/stack.mjs` | `up`, `status`, `down`, `reset`. |
| `ops/observability/instrumentation.mjs` | The preload: the HTTP seam, the redaction path, the three sinks. |
| `ops/observability/metrics-exporter.mjs` | The metrics bridge: authenticated JSON → exposition text. |
| `ops/observability/lib/otlp.mjs` | Batched OTLP/HTTP + JSON sink. |
| `ops/observability/lib/tracer.mjs` | The minimal `TracerProvider` / `Tracer` / `Span`. |
| `ops/observability/lib/edge-metrics.mjs` | The request counter and the latency histogram. |
| `ops/observability/provisioning/` | Prometheus, Loki, Tempo and Grafana configuration, and the dashboard JSON. |

## 9. Known limits

Stated plainly, because each one is a thing somebody will otherwise discover.

- **Tempo reports every trace's root service as `<root span not yet received>`.**
  `parentContextFor` derives a parent span id the platform cannot export, so
  each trace holds one span with a parent that is not there. Search by
  `resource.service.name`; do not expect a service map.
- **A killed process can lose its last 25 ms of records.** Records coalesce for
  25 ms before a push, and a `SIGKILL` takes that window with it. `SIGTERM`
  flushes first, which covers `make demo-stop`; the acceptance walk kills its
  child and loses at most its last request or two.
- **The metrics bridge holds a staff session.** It signs in as the demo
  moderator through the service's own `POST /v1/staff-sessions`, and signs in
  again if the session is evicted. If the service is restarted with a different
  `DEMO_STAFF_CONTACT`, the bridge must be restarted with the same one.
- **`npm run demo:journey` fails at step 11 on this repository, with or without
  this stack.** The walk restarts its service against the same database, and
  `provisionStaff` inserts a staff identity unconditionally, so the second
  process dies on `staff_identities_by_contact` (`scripts/demo/server.mjs`).
  Steps 1–10 complete and their traffic is fully observable here. It is a
  pre-existing break, reproduced with no instrumentation at all.