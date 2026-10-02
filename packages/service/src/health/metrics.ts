import type { Attributes, Counter } from '@opentelemetry/api';
import { type DomainError, type DomainEvent, type Result, domainError, ok } from '@been-there/core';
import {
  DetectionBeforeReport,
  SAFETY_METRICS,
  type MetricDefinition,
  type SafetyMetricName,
  SafetyMetrics,
  defineMetrics,
  isHighCardinalityDimension,
} from '@been-there/platform';
import { EDGE_RESPONSE_METRIC, edgeResponseMeter } from './edge-metrics.js';
import { InMemoryMeter, type MetricSeries } from './meter.js';
/**
 * The metrics this service records about itself, on top of the safety catalogue
 * it inherits from `packages/platform`.
 *
 * `defineMetrics` is the same declaration function the platform uses and it throws
 * on a high-cardinality dimension, so the rule that a `caseId` may not become a
 * label is enforced by the catalogue's own construction rather than by a review
 * comment. That is why the list is one entry: it is not a wish list, it is the
 * whole of what the health surface records about itself, and every row is
 * produced by a request that actually happens.
 */
export const HEALTH_METRICS = defineMetrics({
  'readiness.probe': {
    instrument: 'counter',
    unit: '{probe}',
    description:
      'A readiness probe answered, by whether the transactional store was reachable. A rising count of `down` beside a flat count of `up` is the shape of a database fault, which is the one thing liveness deliberately does not report.',
    dimensions: ['result'],
  },
  'edge.response': EDGE_RESPONSE_METRIC,
} satisfies Readonly<Record<string, MetricDefinition>>);

/** The two values `readiness.probe`'s only dimension can take. */
export type ProbeResult = 'up' | 'down';

/** Every metric this process serves, from both catalogues. */
export function metricCatalogue(): readonly (MetricDefinition & { readonly name: string })[] {
  return Object.entries({ ...SAFETY_METRICS, ...HEALTH_METRICS }).map(([name, definition]) => ({
    name,
    ...definition,
  }));
}

/**
 * A requested label, and the rule that decides whether it is allowed.
 *
 * A label is a *filter* over the series the process holds: `label=outcome:verified`
 * narrows `verification.attempt.outcome` to the verified series. Two rules apply,
 * and they are not the same rule, so both are checked rather than one standing in
 * for the other:
 *
 *  - it must be a declared dimension of some metric in the catalogue, or it is a
 *    name no instrument will ever carry;
 *  - it must not be high-cardinality, which is what would melt a metrics backend
 *    even if it *were* declared — and `caseId`, `userId` and `conversationId` are
 *    all names somebody will reach for.
 */
export interface MetricLabel {
  readonly dimension: string;
  readonly value: string;
}

/** The separator between a label's dimension and its value. */
const LABEL_SEPARATOR = ':';

export function parseMetricLabels(raw: readonly string[]): Result<readonly MetricLabel[], DomainError> {
  const declared = metricCatalogue().flatMap((definition) => definition.dimensions);
  const labels: MetricLabel[] = [];
  for (const entry of raw) {
    const at = entry.indexOf(LABEL_SEPARATOR);
    if (at <= 0 || at === entry.length - 1) {
      return domainError('validation_failed', 'service.health', 'a metric label is written as dimension:value', {
        label: entry,
      });
    }
    const dimension = entry.slice(0, at);
    if (isHighCardinalityDimension(dimension)) {
      return domainError(
        'validation_failed',
        'service.health',
        `"${dimension}" names one thing rather than counting many, so it cannot be a metric label`,
        { label: dimension },
      );
    }
    if (!declared.includes(dimension)) {
      return domainError('validation_failed', 'service.health', `"${dimension}" is not a declared dimension of any served metric`, {
        label: dimension,
      });
    }
    labels.push({ dimension, value: entry.slice(at + 1) });
  }
  return ok(labels);
}

/**
 * The process's metric surface.
 *
 * One instance per running service. It owns the in-memory `Meter`, the platform's
 * `SafetyMetrics` over it, and the `DetectionBeforeReport` reduction that decides
 * §3.6's numerator — so the ratio served at the metrics endpoint is computed by
 * the domain's own rule from the events it was fed, and is not assembled by the
 * HTTP layer from whatever it happened to see.
 */
export class ServiceMetrics {
  readonly #meter = new InMemoryMeter();
  readonly #safety: SafetyMetrics;
  readonly #detection: DetectionBeforeReport;
  readonly #probes: Counter;

  constructor() {
    this.#safety = new SafetyMetrics(this.#meter);
    this.#detection = new DetectionBeforeReport(this.#safety);
    const probe: MetricDefinition = HEALTH_METRICS['readiness.probe'];
    this.#probes = this.#meter.createCounter('readiness.probe', {
      unit: probe.unit,
      description: probe.description,
    });
  }

  /** The safety instruments, for a caller that records one by name. */
  get safety(): SafetyMetrics {
    return this.#safety;
  }

  /** This process's detection-before-report ratio; 0 with an empty cohort. */
  get detectionBeforeReportRatio(): number {
    return this.#safety.ratio;
  }

  /** Feeds the §3.6 reduction. The subject id is the reduction's key, never a label. */
  observe(event: DomainEvent): void {
    this.#detection.observe(event);
  }

  record(name: SafetyMetricName, value = 1, dimensions: Attributes = {}): void {
    this.#safety.record(name, value, dimensions);
  }

  recordProbe(result: ProbeResult): void {
    this.#probes.add(1, { result });
  }

  /**
   * Everything this process holds, narrowed to the requested labels.
   *
   * A label selects series, it does not create them: requesting `outcome:expired`
   * when nothing has expired returns that metric with no samples, which is an
   * honest zero rather than a fabricated one.
   */
  snapshot(labels: readonly MetricLabel[] = []): readonly MetricSeries[] {
    // The edge counter is a process-wide meter rather than a field on this
    // instance, because it is written where the response is finalised and read
    // here. Merging here rather than in the HTTP layer keeps one place that
    // decides what this process serves.
    const series = [...edgeResponseMeter.collect(), ...this.#meter.collect()];
    return series.map((entry) => ({
      ...entry,
      samples: entry.samples.filter((sample) =>
        labels.every((label) => {
          const actual = sample.attributes[label.dimension];
          return actual === undefined || actual === label.value;
        }),
      ),
    }));
  }
}