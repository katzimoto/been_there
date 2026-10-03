import { type DomainError, type Result } from '@been-there/core';
import { type HttpResponse, type Route, type RouteRequest, okResponse, publicRoute, route } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { metricCatalogue, parseMetricLabels } from '../health/metrics.js';
import { createServiceHealth } from '../health/service.js';
import { createServiceSafety } from '../wiring/safety.js';

/**
 * Liveness and metrics.
 *
 * Both are non-transactional. That is not an optimisation: `handle()` opens the
 * request's transaction *before* a handler runs, so on a route that took one, a
 * process whose database is unreachable would answer 503 to its own liveness probe
 * and every replica would be restarted by a database fault that restarting cannot
 * fix. Liveness has to be answerable from inside the failure.
 *
 * The metrics route is **not** public, and that is a decision rather than an
 * omission. A metrics body is a map of what this system watches, and a safety
 * ratio is a statement that a detection pipeline exists and how well it is
 * working. Anonymous read access to it tells an unauthenticated caller that much,
 * for no operational gain: the endpoint a scraper needs is reachable by any
 * session, and the endpoint an outsider wants is reachable by none.
 */

/** The declared dimension set per served metric name. Constant: both catalogues are. */
const DECLARED_DIMENSIONS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  metricCatalogue().map((definition) => [definition.name, definition.dimensions]),
);

export function healthRoutes(dependencies: ServiceDependencies): readonly Route[] {
  const health = createServiceHealth(dependencies);
  return [
    publicRoute('GET', '/v1/health/live', async () => okResponse(200, health.liveness()), {
      transactional: false,
    }),
    route(
      'GET',
      '/v1/health/metrics',
      async (request: RouteRequest): Promise<Result<HttpResponse, DomainError>> => {
        const labels = parseMetricLabels(request.query.getAll('label'));
        if (!labels.ok) {
          return labels;
        }
        // Why `safety.detected_before_first_report` reads zero, served with it
        // rather than left to be inferred from the number. A counter pinned at
        // zero is indistinguishable from detection working, and reading it that
        // way is the failure this declaration exists to prevent.
        //
        // Computed from the detectors this process is actually running, so it
        // changes when the catalogue does. With the verification provider a
        // stub, every detector loud enough to reach `high` is downstream of a
        // report, and the metric compares a detection against the first report
        // — so the comparison cannot be satisfied and no configuration changes
        // that. This is not a reduced mode: at full strength the answer is
        // still "not measurable", and saying so is the honest report.
        const reach = createServiceSafety(dependencies).detectorReach;
        const detection = {
          measurable: reach.measurable,
          ...(reach.measurable
            ? {}
            : {
                reason:
                  'no detector in this catalogue can reach high or critical without a report already filed against the subject, so this metric counts a detection that is causally downstream of the report it must precede',
                belowThreshold: reach.belowThreshold,
                reportDependent: reach.reportDependent,
              }),
          detectors: reach.detectors,
        };
        return okResponse(200, {
          collectedAt: request.now.toISOString(),
          detection,
          metrics: health.metrics.snapshot(labels.value).map((series) => ({
            name: series.name,
            instrument: series.instrument,
            unit: series.unit,
            description: series.description,
            dimensions: DECLARED_DIMENSIONS[series.name] ?? [],
            samples: series.samples.map((entry) => ({
              labels: Object.fromEntries(
                Object.entries(entry.attributes).map(([name, value]) => [name, String(value)] as const),
              ),
              statistic: entry.statistic,
              value: entry.value,
            })),
          })),
        });
      },
      { transactional: false },
    ),
  ];
}