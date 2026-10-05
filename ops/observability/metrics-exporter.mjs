#!/usr/bin/env node
/**
 * The metrics bridge: the service's own metric catalogue, in Prometheus's
 * exposition format, on a port Prometheus can scrape.
 *
 *   node ops/observability/metrics-exporter.mjs
 *
 * ## Why this process exists
 *
 * The service records its catalogue in an in-process `InMemoryMeter` and serves
 * it as JSON at `GET /v1/health/metrics`
 * (`packages/service/src/routes/health.ts`). That route is deliberately *not*
 * public — a metrics body is a map of what this system watches, and an
 * anonymous reader learns the shape of the safety pipeline for nothing. But
 * Prometheus speaks the text exposition format, not JSON, and a scraper cannot
 * authenticate.
 *
 * So the bridge reads the route the way an authorised client would, and
 * republishes what it read. It does not loosen the route, does not add a
 * token-printing endpoint, and does not reach into the service's memory: if the
 * service decides tomorrow that `edge.response` needs a staff clearance, this
 * process fails to read it, which is the correct outcome for a process whose only
 * job is to be honest about what the service already publishes.
 *
 * ## Authentication
 *
 * It signs in as the demo moderator over the service's own
 * `POST /v1/staff-sessions`, using the same environment variables and the same
 * local-only defaults as `scripts/demo/server.mjs`. A second issuance path would
 * be a way to hold a session the service did not mint.
 *
 * ## Configuration
 *
 *   BEEN_THERE_SERVICE_URL   default http://127.0.0.1:$DEMO_PORT (or 8787)
 *   OBS_EXPORTER_PORT        default 9099
 *   OBS_EXPORTER_BIND        default 0.0.0.0 — Prometheus reaches it through the
 *                            container gateway, which is not 127.0.0.1
 *   OBS_EXPORTER_INTERVAL_MS default 5000
 *   DEMO_STAFF_CONTACT       default moderator@demo.localhost
 *   DEMO_STAFF_PASSWORD      default demo-staff-local-only
 */
import { createServer } from 'node:http';

const SERVICE_URL = (
  process.env['BEEN_THERE_SERVICE_URL'] ?? `http://127.0.0.1:${process.env['DEMO_PORT'] ?? '8787'}`
).replace(/\/$/, '');
const PORT = Number(process.env['OBS_EXPORTER_PORT'] ?? '9099');
const BIND = process.env['OBS_EXPORTER_BIND'] ?? '0.0.0.0';
const INTERVAL_MS = Number(process.env['OBS_EXPORTER_INTERVAL_MS'] ?? '5000');
const STAFF_CONTACT = process.env['DEMO_STAFF_CONTACT'] ?? 'moderator@demo.localhost';
const STAFF_PASSWORD = process.env['DEMO_STAFF_PASSWORD'] ?? 'demo-staff-local-only';

const say = (message) => process.stdout.write(`[metrics-exporter] ${message}\n`);

/**
 * The last successful read, and whether the most recent attempt succeeded. The
 * snapshot is served either way: a stale value with `scrape_success 0` beside it
 * is honest, and a dashboard that empties the moment the service restarts is not.
 */
let snapshot = [];
/**
 * The reachability verdict the same route serves beside the catalogue
 * (`body.detection`): whether `safety.detected_before_first_report` can be
 * non-zero at all, and why not when it cannot.
 *
 * Held beside the snapshot rather than recomputed, and served stale in the same
 * way, because a reachability answer invented from nothing would be a guess
 * about the detector catalogue dressed as a measurement.
 */
let detection = null;
let scrapeSuccess = false;
let scrapeDurationSeconds = 0;
let lastSuccessAt = 0;
let token = null;
let tokenExpiresAt = 0;

/** Sign in as the demo moderator, reusing the service's own staff route. */
async function signIn() {
  const response = await fetch(`${SERVICE_URL}/v1/staff-sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contact: STAFF_CONTACT, password: STAFF_PASSWORD }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new Error(`staff sign-in answered HTTP ${response.status}`);
  }
  const body = await response.json();
  token = body.token;
  // A margin, so a session that is valid now is not rejected mid-scrape. If the
  // service ever stops sending `expiresAt`, assume a quarter of an hour.
  const expiresAt = Date.parse(body.expiresAt ?? '');
  tokenExpiresAt = Number.isNaN(expiresAt) ? Date.now() + 900_000 : expiresAt - 30_000;
  say(`signed in as ${body.displayName} (${body.role})`);
  return token;
}

async function authorisedFetch(path) {
  if (token === null || Date.now() >= tokenExpiresAt) {
    await signIn();
  }
  const response = await fetch(`${SERVICE_URL}${path}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 401 || response.status === 403) {
    // A revoked or evicted session is the documented behaviour of this service,
    // not an error: sign in again and take the one retry.
    token = null;
    await signIn();
    return fetch(`${SERVICE_URL}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
  }
  return response;
}

async function poll() {
  const startedAt = process.hrtime.bigint();
  try {
    const response = await authorisedFetch('/v1/health/metrics');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = await response.json();
    snapshot = body.metrics ?? [];
    // The verdict is a sibling of the catalogue in the same body. Reading
    // `body.metrics` and discarding `body.detection` is what left a permanently
    // zero metric reaching Prometheus with nothing on the dashboard able to say
    // the zero is the arithmetic rather than a failure.
    detection = body.detection ?? null;
    scrapeSuccess = true;
    lastSuccessAt = Date.now();
  } catch (error) {
    scrapeSuccess = false;
    say(`read failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    scrapeDurationSeconds = Number((process.hrtime.bigint() - startedAt) / 1_000n) / 1_000_000;
  }
}

/** `edge.response` is a valid OpenMetrics name and an invalid Prometheus one. */
function metricName(name, instrument) {
  const sanitised = name.replace(/[^a-zA-Z0-9_:]/g, '_');
  // Prometheus appends `_total` to a counter it imports; doing it here keeps the
  // dashboard's `rate(edge_response_total[…])` the same shape as any other
  // counter in the interface.
  return instrument === 'counter' && !sanitised.endsWith('_total') ? `${sanitised}_total` : sanitised;
}

const escapeHelp = (text) => String(text ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
const escapeLabel = (value) => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/**
 * The one metric whose standing zero is a property of the detector catalogue
 * rather than a wiring failure. See `unreachabilityReason` for why it is the
 * only one.
 */
const REACHABILITY_TARGET = 'safety.detected_before_first_report';

/** Fixed, so a panel can name it without reading the catalogue first. */
const MEASURABLE_METRIC = 'safety_detected_before_first_report_measurable';

/** The verdict, or `null` while it is unknown (never successfully read). */
function verdict() {
  return detection !== null && typeof detection === 'object' ? detection : null;
}

/**
 * Why this metric cannot be non-zero, or `null` when it is measurable and the
 * number should be read as a number.
 *
 * Only ever non-null for `REACHABILITY_TARGET`, and only when the service has
 * said so. A second metric that turned out to be permanently zero would need
 * the same treatment; guessing which ones those are is how a dashboard ends up
 * explaining a metric that was merely quiet.
 */
function unreachabilityReason(name) {
  if (metricName(REACHABILITY_TARGET, 'counter') !== name) {
    return null;
  }
  const served = verdict();
  if (served === null || served.measurable === true) {
    return null;
  }
  return typeof served.reason === 'string' && served.reason.length > 0 ? served.reason : null;
}

/**
 * The HELP text, carrying the reason when there is one.
 *
 * The service describes what a metric measures; that description is the same
 * whether or not the metric can move. The verdict is a separate fact, so it is
 * appended rather than written over — which means someone reading the raw
 * exposition with `curl` sees why the number is zero, and not only someone who
 * happened to open the dashboard.
 */
function helpFor(metric, reason) {
  return reason === null ? metric.description : `${metric.description} NOT MEASURABLE IN THIS DEPLOYMENT: ${reason}`;
}

/**
 * The verdict as two metrics rather than as a dashboard comment.
 *
 * A panel can show the flag as a number and quote the reason beside it, and both
 * move when the catalogue moves: a detector that fires without a prior report
 * flips `measurable` to 1 and the reason disappears with it, rather than
 * outliving the fact it explained.
 */
function renderReachability(lines) {
  const served = verdict();
  if (served === null) {
    return;
  }
  const measurable = served.measurable === true;
  lines.push(
    `# HELP ${MEASURABLE_METRIC} Whether safety.detected_before_first_report can be non-zero at all. 1 when some detector both reaches a counted state and can fire without a prior report; 0 when the metric's comparison is unsatisfiable by construction. A 0 is a property of the detector catalogue, not a broken pipeline.`,
    `# TYPE ${MEASURABLE_METRIC} gauge`,
    `${MEASURABLE_METRIC} ${measurable ? 1 : 0}`,
  );
  if (measurable) {
    return;
  }
  // The explanation rides as labels on a value-1 "info" metric, which is the
 // OpenTelemetry convention for a state whose content is the interesting part.
 // The label values are fixed by the detector catalogue rather than by traffic,
 // so this is at most one series — the opposite of the per-subject label that
 // `defineMetrics` refuses at construction time in `packages/platform`.
  const info = `${MEASURABLE_METRIC}_info`;
  const labels = [
    `reason="${escapeLabel(typeof served.reason === 'string' ? served.reason : 'unspecified')}"`,
    `below_threshold="${escapeLabel((served.belowThreshold ?? []).join(','))}"`,
    `report_dependent="${escapeLabel((served.reportDependent ?? []).join(','))}"`,
    `detector_count="${Array.isArray(served.detectors) ? served.detectors.length : 0}"`,
  ].join(',');
  lines.push(
    `# HELP ${info} Why safety.detected_before_first_report reads zero, published as data so the explanation tracks the detector catalogue instead of rotting in a dashboard comment. Present only when the metric is unmeasurable.`,
    `# TYPE ${info} gauge`,
    `${info}{${labels}} 1`,
  );
}

function render() {
  const lines = [];
  const emitted = new Set();
  for (const metric of snapshot) {
    const name = metricName(metric.name, metric.instrument);
    const type = metric.instrument === 'counter' ? 'counter' : 'gauge';
    // A counter that declares no dimensions has exactly one series, and until
    // something records one it is zero — not absent. Absence is what made a
    // dashboard render "No data", which nobody can tell apart from a broken
    // pipeline, for a counter that is simply quiet.
    //
    // A counter that DOES declare dimensions is left absent on purpose. Its
    // series are keyed by label values this process has not produced, and
    // publishing an unlabelled zero would assert a series the product can never
    // legitimately record — which is the "invented a metric to fill a panel"
    // failure wearing a zero's clothes.
    const emptyCounter =
      metric.samples.length === 0 && type === 'counter' && (metric.dimensions ?? []).length === 0;

    if (!emitted.has(name)) {
      emitted.add(name);
      lines.push(`# HELP ${name} ${escapeHelp(helpFor(metric, unreachabilityReason(name)))}`);
      lines.push(`# TYPE ${name} ${type}`);
    }
    if (emptyCounter) {
      lines.push(`${name} 0`);
      continue;
    }
    for (const sample of metric.samples) {
      const suffix = sample.statistic === 'value' ? '' : `_${sample.statistic}`;
      const labels = Object.entries(sample.labels ?? {})
        .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
        .join(',');
      lines.push(
        `${name}${suffix}${labels.length === 0 ? '' : `{${labels}}`} ${Number(sample.value)}`,
      );
    }
  }

  renderReachability(lines);

  // The bridge's own numbers. `scrape_success 0` with the service's last known
  // series still listed above is the shape that says "the service is down" rather
  // than "the dashboard is broken".
  lines.push(
    '# HELP been_there_metrics_exporter_scrape_success Whether the last read of the service catalogue succeeded.',
    '# TYPE been_there_metrics_exporter_scrape_success gauge',
    `been_there_metrics_exporter_scrape_success ${scrapeSuccess ? 1 : 0}`,
    '# HELP been_there_metrics_exporter_scrape_duration_seconds How long the last read of the service catalogue took.',
    '# TYPE been_there_metrics_exporter_scrape_duration_seconds gauge',
    `been_there_metrics_exporter_scrape_duration_seconds ${scrapeDurationSeconds}`,
    '# HELP been_there_metrics_exporter_last_success_timestamp_seconds When the service catalogue was last read successfully.',
    '# TYPE been_there_metrics_exporter_last_success_timestamp_seconds gauge',
    `been_there_metrics_exporter_last_success_timestamp_seconds ${Math.floor(lastSuccessAt / 1000)}`,
  );
  return `${lines.join('\n')}\n`;
}

createServer((request, response) => {
  if (request.url === '/metrics') {
    const body = render();
    response.writeHead(200, {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    });
    response.end(body);
    return;
  }
  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  response.end('This bridge serves /metrics and nothing else.\n');
}).listen(PORT, BIND, () => {
  say(`serving ${SERVICE_URL}'s catalogue for Prometheus on http://${BIND}:${PORT}/metrics`);
});

await poll();
setInterval(() => void poll(), INTERVAL_MS);