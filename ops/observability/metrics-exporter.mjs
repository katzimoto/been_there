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

function render() {
  const lines = [];
  const emitted = new Set();
  for (const metric of snapshot) {
    const name = metricName(metric.name, metric.instrument);
    const type = metric.instrument === 'counter' ? 'counter' : 'gauge';
    if (!emitted.has(name)) {
      emitted.add(name);
      lines.push(`# HELP ${name} ${escapeHelp(metric.description)}`);
      lines.push(`# TYPE ${name} ${type}`);
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