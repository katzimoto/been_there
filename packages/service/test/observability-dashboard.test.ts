import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { metricCatalogue } from '../src/health/metrics.js';

/**
 * The dashboard is provisioned as a file, so it is reviewable — which is the
 * only reason a dashboard built by clicking would be a problem at all. This
 * suite is what makes that review enforceable rather than aspirational.
 *
 * A Grafana panel whose PromQL names a metric nothing publishes does not fail.
 * It renders an empty graph, in the same colour as a panel that is working, and
 * the person looking at it has no way to tell "no traffic" from "no such
 * metric". That is the specific way this dashboard could lie: not by asserting
 * something false, but by showing an absence that looks like a measurement.
 *
 * So every metric name a panel references is checked here against the catalogue
 * the service actually serves. The mapping is the bridge's own
 * (`ops/observability/metrics-exporter.mjs`): dots become underscores, and a
 * counter gains `_total`. It is restated here rather than imported, because that
 * file is plain JavaScript outside the workspace graph — so a change to one and
 * not the other fails this suite instead of silently emptying a panel.
 */

/** The provisioned dashboard, as Grafana reads it. */
const DASHBOARD = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'ops',
  'observability',
  'provisioning',
  'grafana',
  'dashboards',
  'been-there-service.json',
);

/**
 * A panel, as much of its shape as this suite reads. Deliberately narrow: the
 * dashboard is external data, so it is parsed into something with a checked
 * shape rather than asserted into whatever the file happens to contain.
 */
interface Panel {
  type: string;
  title: string;
  description?: string;
  editable?: boolean;
  gridPos?: { h: number; w: number; x: number; y: number };
  targets?: readonly { expr?: string }[];
  options?: { noValue?: string; content?: string };
  panels?: readonly Panel[];
}

interface Dashboard {
  uid: string;
  editable?: boolean;
  panels: readonly Panel[];
}

const RAW = JSON.parse(readFileSync(DASHBOARD, 'utf8')) as Partial<Dashboard>;
const dashboard: Dashboard = {
  uid: typeof RAW.uid === 'string' ? RAW.uid : '',
  ...(typeof RAW.editable === 'boolean' ? { editable: RAW.editable } : {}),
  panels: Array.isArray(RAW.panels) ? RAW.panels : [],
};

/**
 * The reachability verdict, which the bridge derives from the `detection` object
 * the service serves beside its catalogue. Not catalogue instruments — they
 * exist to make the unreachable safety metric readable, and the names are fixed
 * in `metrics-exporter.mjs` so a panel need not read the catalogue first.
 */
const REACHABILITY_METRICS: Record<string, true> = {
  safety_detected_before_first_report_measurable: true,
  safety_detected_before_first_report_measurable_info: true,
};

/** Every panel, flattened, so a panel nested in a row cannot hide from the checks. */
function allPanels(panels: readonly Panel[]): readonly Panel[] {
  return panels.flatMap((panel) => [panel, ...allPanels(panel.panels ?? [])]);
}

/** Metrics the bridge publishes about itself, rather than the service's catalogue. */
const BRIDGE_METRICS: Record<string, true> = {
  been_there_metrics_exporter_scrape_success: true,
  been_there_metrics_exporter_scrape_duration_seconds: true,
  been_there_metrics_exporter_last_success_timestamp_seconds: true,
};

/**
 * Request rate and latency, which the HTTP instrumentation times and pushes as
 * OTLP. Absent from the catalogue on purpose: the service records no duration
 * of its own, because the HTTP boundary finalises a response without timing it.
 */
const EDGE_METRICS: Record<string, true> = {
  http_server_requests_total: true,
  http_server_request_duration_seconds_bucket: true,
  http_server_request_duration_seconds_sum: true,
  http_server_request_duration_seconds_count: true,
};

/** `edge.response` is a valid OpenMetrics name and an invalid Prometheus one. */
function toPrometheusName(name: string, instrument: string): string {
  const sanitised = name.replace(/[^a-zA-Z0-9_:]/g, '_');
  return instrument === 'counter' && !sanitised.endsWith('_total') ? `${sanitised}_total` : sanitised;
}

/** Every metric name the service's catalogue can reach Prometheus under. */
function publishedNames(): ReadonlySet<string> {
  const names = new Set<string>([...Object.keys(BRIDGE_METRICS), ...Object.keys(REACHABILITY_METRICS)]);
  for (const definition of metricCatalogue()) {
    names.add(toPrometheusName(definition.name, definition.instrument));
  }
  return names;
}

/** PromQL functions and keywords, which are not metric names. */
const PROMQL_KEYWORDS: Record<string, true> = {
  rate: true,
  sum: true,
  histogram_quantile: true,
  topk: true,
  by: true,
  without: true,
  le: true,
  and: true,
  or: true,
  unless: true,
  offset: true,
};

/**
 * Metric identifiers in a PromQL expression.
 *
 * Aggregation labels are stripped first: in `sum by (class) (rate(x[2m]))` the
 * `class` is a label, not a series, and reading it as one would report a metric
 * named `class` that nothing publishes. What remains is the series position
 * only — an identifier followed by a range vector, a label selector, or the end
 * of a grouping.
 */
function referencedNames(expr: string): readonly string[] {
  const withoutAggregationLabels = expr.replace(/\b(?:by|without)\s*\([^)]*\)/g, ' ');
  const found = new Set<string>();
  for (const match of withoutAggregationLabels.matchAll(/\b([a-zA-Z_:][a-zA-Z0-9_:]*)\s*(?:\{[^}]*\})?\s*(?:\[|\)|,|$)/g)) {
    const name = match[1]!;
    if (PROMQL_KEYWORDS[name] === undefined) {
      found.add(name);
    }
  }
  return [...found];
}

/**
 * Label values a panel filters on, where the product fixes the vocabulary.
 *
 * A metric name can be right while the selector is wrong, and the failure is the
 * same silent empty graph: `{result="degraded"}` on `readiness.probe` names a
 * series that cannot exist. Only values the product declares are listed — an
 * open vocabulary is not checkable, and inventing entries for one would fail
 * panels that are perfectly correct.
 *
 * `readiness.probe`'s dimension is `ProbeResult`, declared in
 * `packages/service/src/health/metrics.ts` as exactly `'up' | 'down'`.
 */
const KNOWN_LABEL_VALUES: Record<string, Record<string, true>> = {
  readiness_probe_total: { up: true, down: true },
};

const panels = allPanels(dashboard.panels);
const prometheusPanels = panels.filter((panel) =>
  (panel.targets ?? []).some((target) => target.expr !== undefined),
);

describe('the provisioned Grafana dashboard', () => {
  it('is a file Grafana can provision, with a stable uid', () => {
    expect(dashboard.uid).toBe('been-there-service');
    expect(panels.length).toBeGreaterThan(0);
    // `allowUiUpdates: false` in dashboards.yml is what makes a click-made edit
    // impossible rather than merely discouraged; `editable: false` is the
    // in-file half of the same statement.
    expect(dashboard.editable).toBe(false);
  });

  it('references only metrics something actually publishes', () => {
    const published = publishedNames();
    const invented: string[] = [];
    for (const panel of prometheusPanels) {
      for (const target of panel.targets ?? []) {
        for (const name of referencedNames(target.expr ?? '')) {
          if (!published.has(name) && EDGE_METRICS[name] === undefined) {
            invented.push(`${panel.title} -> ${name}`);
          }
        }
      }
    }
    expect(invented).toEqual([]);
  });

  it('reads the product instruments the brief names, not only edge instrumentation', () => {
    const queried = new Set<string>();
    for (const panel of prometheusPanels) {
      for (const target of panel.targets ?? []) {
        for (const name of referencedNames(target.expr ?? '')) {
          queried.add(name);
        }
      }
    }
    // Each of these is a declared instrument, so a panel on it has a producer.
    expect(queried).toContain('safety_detected_before_first_report_total');
    expect(queried).toContain('safety_detection_before_report_ratio');
    expect(queried).toContain('safety_confirmed_malicious_accounts_total');
    expect(queried).toContain('edge_response_total');
    expect(queried).toContain('readiness_probe_total');
  });

  /**
   * The one panel that would lie by omission.
   *
   * `safety.detected_before_first_report` is causally unreachable: every
   * detector able to reach `high` requires a report already filed naming the
   * account, and the counter counts detection *before* that first report. So the
   * comparison can never come out true, and the counter's zero is arithmetic
   * rather than a failure.
   *
   * A bare zero with nothing attached reads as "detection is broken" — the
   * opposite of the truth, and the single easiest way for this dashboard to lie.
   * So the zero never stands alone: the reachability flag sits beside it as
   * data, and the reason is read from the service's own `_info` series rather
   * than written into this file where it could outlive the fact it explains.
   */
  it('shows the unreachable safety metric with its reason attached, not as a bare number', () => {
    // Exact set membership rather than `includes`: `_measurable` is a prefix of
    // `_measurable_info`, so a substring search finds the wrong panel and then
    // asserts the wrong thing about it — which is how "remove the flag panel"
    // passed this test the first time it was written.
    const querying = (metric: string) =>
      panels.filter((entry) =>
        (entry.targets ?? []).some((target) => referencedNames(target.expr ?? '').includes(metric)),
      );

    const counter = querying('safety_detected_before_first_report_total');
    expect(counter).toHaveLength(1);
    expect(counter[0]?.description ?? '').toMatch(/MEASURABLE/);

    // The verdict, as a panel of its own and not as prose on the counter's.
    const flag = querying('safety_detected_before_first_report_measurable');
    expect(flag).toHaveLength(1);
    expect(flag[0]?.title).not.toBe(counter[0]?.title);

    // The reason, read from the service rather than restated in this file: a
    // hand-written explanation outlives the fact it explains.
    const reason = querying('safety_detected_before_first_report_measurable_info');
    expect(reason).toHaveLength(1);
    expect(reason[0]?.type).toBe('table');

    // And a panel carrying the reasoning in prose, so the table has a
    // human-readable explanation beside it.
    const note = panels.find(
      (entry) => entry.type === 'text' && /broken panel/i.test(entry.options?.content ?? ''),
    );
    expect(note).toBeDefined();
    expect(note?.options?.content ?? '').toMatch(/RISK_PAIRING_SECRET/);
  });

  it('filters only on label values the product declares', () => {
    const impossible: string[] = [];
    for (const panel of prometheusPanels) {
      for (const target of panel.targets ?? []) {
        const expr = target.expr ?? '';
        for (const metric of referencedNames(expr)) {
          const vocabulary = KNOWN_LABEL_VALUES[metric];
          if (vocabulary === undefined) {
            continue;
          }
          const body = new RegExp(`\\b${metric}\\s*\\{([^}]*)\\}`).exec(expr)?.[1] ?? '';
          // Group 1 is the label name and group 2 the value; reading group 1
          // would check every selector against its own key.
          for (const match of body.matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) {
            const value = match[2];
            if (value !== undefined && vocabulary[value] === undefined) {
              impossible.push(`${panel.title} -> ${metric}{${value}}`);
            }
          }
        }
      }
    }
    expect(impossible).toEqual([]);
  });

  /**
   * The counter is blue rather than red.
   *
   * Red asserts a failure. There is no failure here — there is a metric whose
   * definition cannot be satisfied — and colouring it as an alarm would train
   * whoever is watching to ignore it, which is how a real fault gets missed.
   */
  it('does not colour the unreachable counter as a failure', () => {
    const counter = panels.filter((entry) =>
      (entry.targets ?? []).some((target) =>
        referencedNames(target.expr ?? '').includes('safety_detected_before_first_report_total'),
      ),
    );
    expect(counter).toHaveLength(1);
    expect(JSON.stringify(counter[0] ?? {})).not.toMatch(/"red"/);
  });

  it('does not fabricate a zero for an instrument with no series', () => {
    // `absent()`, `vector(0)` or a bare `or 0` over a product instrument would
    // turn "nothing recorded this" into a number that reads as a measurement.
    const fabricated = prometheusPanels
      .map((panel) => (panel.targets ?? []).map((target) => target.expr ?? '').join(' '))
      .filter((expr) => /safety_|verification_|readiness_/.test(expr))
      .filter((expr) => /\b(absent|vector)\s*\(|\bor\s+(vector\s*\(0\)|0)\b/.test(expr));
    expect(fabricated).toEqual([]);
  });

  it('gives every Prometheus panel a title and a description', () => {
    const undocumented = prometheusPanels
      .filter((panel) => panel.title.trim().length === 0 || (panel.description ?? '').trim().length === 0)
      .map((panel) => panel.title);
    expect(undocumented).toEqual([]);
  });

  it('lays panels out without overlap, so none is silently hidden', () => {
    const occupied = new Map<string, string>();
    const clashes: string[] = [];
    for (const panel of panels) {
      const { x = 0, y = 0, w = 24, h = 1 } = panel.gridPos ?? {};
      if (x + w > 24) {
        clashes.push(`${panel.title}: x+w=${x + w} exceeds 24 columns`);
      }
      for (let row = y; row < y + h; row += 1) {
        for (let column = x; column < x + w; column += 1) {
          const cell = `${column},${row}`;
          const held = occupied.get(cell);
          if (held !== undefined) {
            clashes.push(`${panel.title} overlaps ${held} at ${cell}`);
          }
          occupied.set(cell, panel.title);
        }
      }
    }
    expect(clashes).toEqual([]);
  });
});