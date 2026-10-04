/**
 * Request rate and latency, as OTLP metrics.
 *
 * These are the two numbers the service does not already record. Its own
 * catalogue (`/v1/health/metrics`, read by `metrics-exporter.mjs`) counts
 * responses by class and domain code, which is the right shape for "is the
 * safety system working". It records no duration, because the HTTP boundary
 * finalises a response without timing it, and a dashboard that cannot answer
 * "is it getting slower" is half a dashboard.
 *
 * So the instrumentation times each request here, with the label set that
 * survives a cardinality review: method, route template, status code, outcome.
 * Never a correlation id, never a body, never a path parameter — see `routeOf()`
 * in `instrumentation.mjs`, which is the reason `route` is a template.
 *
 * The aggregation is a plain histogram with explicit bucket boundaries, in
 * seconds. Prometheus's OTLP write receiver turns it into a classic
 * `_bucket` / `_sum` / `_count` triple, which is what the dashboard's
 * `histogram_quantile` reads.
 */

import { attributes, nowNanos } from './otlp.mjs';

/**
 * Bucket edges in seconds. Chosen around what this service actually does: a
 * liveness probe and a sign-up are two orders of magnitude apart, and a quantile
 * over boundaries that do not straddle that gap reports a number nobody asked the
 * question about.
 */
const DURATION_BUCKETS_S = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

const seriesKey = (record) =>
  JSON.stringify(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));

/** A monotonic counter over one label set. */
class Counter {
  #name;
  #description;
  #unit;
  #values = new Map();

  constructor(name, description, unit) {
    this.#name = name;
    this.#description = description;
    this.#unit = unit;
  }

  add(record, amount) {
    const key = seriesKey(record);
    const existing = this.#values.get(key);
    this.#values.set(key, { attributes: record, value: (existing?.value ?? 0) + amount });
  }

  toOtlp() {
    const time = nowNanos();
    return {
      name: this.#name,
      description: this.#description,
      unit: this.#unit,
      sum: {
        aggregationTemporality: 2,
        isMonotonic: true,
        dataPoints: [...this.#values.values()].map((entry) => ({
          attributes: attributes(entry.attributes),
          startTimeUnixNano: '0',
          timeUnixNano: time,
          asInt: String(entry.value),
        })),
      },
    };
  }

}

/** A histogram over one label set, with explicit bucket boundaries. */
class Histogram {
  #name;
  #description;
  #unit;
  #buckets;
  #series = new Map();

  constructor(name, description, unit, buckets) {
    this.#name = name;
    this.#description = description;
    this.#unit = unit;
    this.#buckets = buckets;
  }

  record(record, value) {
    const key = seriesKey(record);
    const existing =
      this.#series.get(key) ?? {
        attributes: record,
        counts: new Array(this.#buckets.length).fill(0),
        count: 0,
        sum: 0,
      };
    existing.count += 1;
    existing.sum += value;
    // OTLP's `bucket_counts` are the counts *of each bucket*, not of everything
    // at or below its bound: bucket i holds the values in
    // `(bounds[i-1], bounds[i]]`, and they sum to `count`. Prometheus's OTLP
    // receiver accumulates them into the cumulative `_bucket` series the
    // dashboard reads, so a cumulative reading here double-counts every sample
    // and reports a p95 of seconds for a service whose requests take
    // milliseconds. Values above the last bound land in no bucket, which is
    // exactly what the `+Inf` bucket is for.
    let lowerBound = Number.NEGATIVE_INFINITY;
    for (const [index, bound] of this.#buckets.entries()) {
      if (value > lowerBound && value <= bound) {
        existing.counts[index] += 1;
      }
      lowerBound = bound;
    }
    this.#series.set(key, existing);
  }

  toOtlp() {
    const time = nowNanos();
    return {
      name: this.#name,
      description: this.#description,
      unit: this.#unit,
      histogram: {
        aggregationTemporality: 2,
        dataPoints: [...this.#series.values()].map((entry) => ({
          attributes: attributes(entry.attributes),
          startTimeUnixNano: '0',
          timeUnixNano: time,
          count: String(entry.count),
          sum: entry.sum,
          bucketCounts: entry.counts.map((count) => String(count)),
          explicitBounds: this.#buckets,
        })),
      },
    };
  }
}

/**
 * The edge instruments, built per process rather than as module constants: a
 * module-level counter would survive a second HTTP server in the same process
 * and report both under one label set.
 */
export function createEdgeMetrics() {
  const requests = new Counter(
    'http.server.requests',
    'Responses the HTTP boundary finished writing, by method, route template, status code and outcome. ' +
      'The classification is the service status code, which is the only thing the boundary can observe ' +
      'without re-implementing authentication or reading a response body.',
    '{request}',
  );
  const duration = new Histogram(
    'http.server.request.duration',
    'Wall-clock seconds from a request arriving to its response finishing, by method and route template.',
    's',
    DURATION_BUCKETS_S,
  );
  return {
    record({ method, route, statusCode, outcome, seconds }) {
      requests.add({ method, route, status_code: statusCode, outcome }, 1);
      duration.record({ method, route }, seconds);
    },
    toOtlp: () => [requests.toOtlp(), duration.toOtlp()],
  };
}