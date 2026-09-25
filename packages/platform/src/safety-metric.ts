import { type Attributes, type Counter, type Meter, type ObservableGauge } from '@opentelemetry/api';
import { type DomainEvent, type SubjectId } from '@been-there/core';
import { ANALYTICS_FORBIDDEN_PROPERTIES } from './analytics.js';

/**
 * The safety metrics, as OTel instruments rather than as bespoke counters.
 *
 * A metric backend is aggregatable and therefore widely readable, and a metric
 * labelled by anything unique is a per-person time series wearing a dashboard's
 * clothes. So the whole of this file is organised around one rule: a dimension
 * is a *closed vocabulary*, declared per metric, and a name that could be
 * unique is refused at the point the metric is defined — so a high-cardinality
 * label cannot be reintroduced by adding a row.
 *
 * The primary safety metric is a ratio, and a ratio is a **query** here, not an
 * instrument. The numerator and the denominator are two counters, and the
 * percentage is `sum(detected) / sum(confirmed)` in the backend. A ratio
 * computed inside one process and reported as a gauge is the same class of
 * error as an average of averages: the process with the smallest cohort would
 * decide the fleet's number. The observable gauge here is per-process and
 * labelled as such, for one host's own console.
 */

export type MetricInstrument = 'counter' | 'gauge';

export interface MetricDefinition {
  readonly instrument: MetricInstrument;
  /** UCUM unit. `{account}` for a count of accounts, `1` for a dimensionless ratio. */
  readonly unit: string;
  readonly description: string;
  /** The complete set of dimensions this metric may ever be recorded with. */
  readonly dimensions: readonly string[];
}

/**
 * A dimension that could name one thing rather than count many is high
 * cardinality, and a high-cardinality label does not degrade a metrics backend
 * gracefully — it removes the metrics.
 *
 * Two independent rules catch it. The suffix rule is structural: `case_id`,
 * `userId` and `conversationId` are the same mistake spelled three ways, and
 * the shape is the reliable signal. The name rule reuses the analytics
 * catalogue's forbidden list, because the reason a property is refused there —
 * it identifies somebody — is the reason it is refused here, and two lists
 * would drift.
 */
export function isHighCardinalityDimension(name: string): boolean {
  const snake = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  if (/(^|_)ids?$/.test(snake)) {
    return true;
  }
  return ANALYTICS_FORBIDDEN_PROPERTIES.some(
    (forbidden) => forbidden.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase() === snake,
  );
}

/**
 * Declares a metric catalogue, refusing any row whose dimensions could name a
 * person. Throws rather than returning a result: a catalogue is a constant, and
 * a constant that is wrong is a build failure, not a runtime branch.
 */
export function defineMetrics<T extends Readonly<Record<string, MetricDefinition>>>(
  catalogue: T,
): T {
  for (const [name, definition] of Object.entries(catalogue)) {
    for (const dimension of definition.dimensions) {
      if (isHighCardinalityDimension(dimension)) {
        throw new TypeError(
          `metric "${name}" declares high-cardinality dimension "${dimension}": a per-subject label belongs on a span, not on a metric`,
        );
      }
    }
  }
  return catalogue;
}

/**
 * The whole metric surface. Every safety number the product-quality document
 * names as computable from the event stream, and nothing else — a metric with
 * no producer is a promise the bus does not keep.
 */
export const SAFETY_METRICS = defineMetrics({
  /** Denominator of §3.6: accounts that entered the safety record in the window. */
  'safety.confirmed_malicious_accounts': {
    instrument: 'counter',
    unit: '{account}',
    description:
      'Accounts a moderation case was opened about. The denominator of the primary safety metric, and never labelled by anything unique.',
    dimensions: [],
  },
  /** Numerator of §3.6: those whose risk rose before anyone reported them. */
  'safety.detected_before_first_report': {
    instrument: 'counter',
    unit: '{account}',
    description:
      'Accounts whose risk machine first reached high or critical before the first report naming them, and before the case that led to the finding.',
    dimensions: [],
  },
  /** Per-process view of the ratio. The fleet number is the quotient of the two counters. */
  'safety.detection_before_report.ratio': {
    instrument: 'gauge',
    unit: '1',
    description:
      'This process only: detected before first report, divided by confirmed malicious. A per-host tile, never a fleet average.',
    dimensions: [],
  },
  /** Completion rate: §3.1's numerator and denominator share this counter. */
  'verification.attempt.outcome': {
    instrument: 'counter',
    unit: '{attempt}',
    description:
      'A verification attempt resolved. The decision label and nothing else; a confidence score is a per-user value that identifies whoever holds the model.',
    dimensions: ['outcome'],
  },
  /** Error rate: separated from completion so an outage is not read as behaviour. */
  'verification.provider.call': {
    instrument: 'counter',
    unit: '{call}',
    description:
      'A verification provider call, by uniform outcome. Read with the completion counter to tell a broken pipeline from a change in user behaviour.',
    dimensions: ['outcome', 'stage'],
  },
} satisfies Readonly<Record<string, MetricDefinition>>);

export type SafetyMetricName = keyof typeof SAFETY_METRICS;

/** The decision labels `verification.attempt.completed` may publish. */
export const VERIFICATION_OUTCOMES: readonly string[] = [
  'verified',
  'verification_failed',
  'review_required',
  'expired',
];

/** The provider call failures, in the integration port's own taxonomy. */
export const PROVIDER_CALL_OUTCOMES: readonly string[] = [
  'accepted',
  'rejected',
  'timeout',
  'unavailable',
  'rate_limited',
  'malformed_response',
];

export const VERIFICATION_STAGES: readonly string[] = ['document', 'liveness'];

/**
 * The metric sink. Instruments are created once, from the catalogue, so a name
 * that is not in the catalogue cannot be recorded at all and a dimension that
 * is not declared for a metric is refused rather than silently accepted.
 */
export class SafetyMetrics {
  #meter: Meter;
  #counters = new Map<SafetyMetricName, Counter>();
  #ratio: ObservableGauge | undefined;
  #confirmed = 0;
  #detected = 0;

  constructor(meter: Meter) {
    this.#meter = meter;
    for (const name of Object.keys(SAFETY_METRICS) as SafetyMetricName[]) {
      const definition: MetricDefinition = SAFETY_METRICS[name];
      const options = { unit: definition.unit, description: definition.description };
      if (definition.instrument === 'counter') {
        this.#counters.set(name, meter.createCounter(name, options));
      } else {
        this.#ratio = meter.createObservableGauge(name, options);
      }
    }
    // Registered once, at construction, and reading the running totals: the
    // gauge is a snapshot of this process rather than a value recomputed by the
    // collector, so it cannot be silently mis-scoped later.
    const observed = this.#ratio;
    if (observed !== undefined) {
      meter.addBatchObservableCallback((result) => {
        result.observe(observed, this.ratio);
      }, [observed]);
    }
  }

  /** This process's detection-before-report ratio, or 0 with an empty cohort. */
  get ratio(): number {
    return this.#confirmed === 0 ? 0 : this.#detected / this.#confirmed;
  }

  record(name: SafetyMetricName, value: number, dimensions: Attributes = {}): void {
    const declared: readonly string[] = SAFETY_METRICS[name].dimensions;
    for (const dimension of Object.keys(dimensions)) {
      if (!declared.includes(dimension)) {
        throw new TypeError(
          `"${dimension}" is not a declared dimension of "${name}"; the declared set is [${declared.join(', ')}]`,
        );
      }
    }
    this.#counters.get(name)?.add(value, dimensions);
  }

  /**
   * The cohort entry. Called once per account, when the case that confirms it
   * opens — which is also the point at which §3.6's numerator is decidable,
   * because both comparison points have to be known.
   */
  confirm(detectedBeforeFirstReport: boolean): void {
    this.#confirmed += 1;
    if (detectedBeforeFirstReport) {
      this.#detected += 1;
    }
    this.record('safety.confirmed_malicious_accounts', 1);
    if (detectedBeforeFirstReport) {
      this.record('safety.detected_before_first_report', 1);
    }
  }
}

/** What the reduction remembers about one account, and nothing else. */
interface CohortEntry {
  /** `occurredAt` of the first `risk.changed` into high or critical. */
  firstHighRiskAt: number | null;
  /** `occurredAt` of the first `moderation.report_submitted` naming the account. */
  firstReportAt: number | null;
  /** Set when the case has been counted, so a second case is a second fact, not a second unit. */
  counted: boolean;
}

function entry(): CohortEntry {
  return { firstHighRiskAt: null, firstReportAt: null, counted: false };
}

function isHighOrCritical(to: unknown): to is 'high' | 'critical' {
  return to === 'high' || to === 'critical';
}

/**
 * §3.6, reduced from the event stream.
 *
 * The three inputs are the three events that decide the metric:
 * `risk.changed` for the detection, `moderation.report_submitted` for the report
 * it must precede, and `moderation.case_opened` for the cohort entry. The
 * subject id is the reduction's *key* and never an attribute — which is the
 * whole reason this can be computed at all: the join happens here, where the
 * subject is already in hand, and the instrument that leaves the process carries
 * nothing but the count.
 *
 * Ordering is by `occurredAt` and never by arrival, because a late-arriving
 * signal scored as a miss turns a pipeline delay into a safety regression.
 */
export class DetectionBeforeReport {
  #cohorts = new Map<SubjectId, CohortEntry>();
  #metrics: SafetyMetrics;

  constructor(metrics: SafetyMetrics) {
    this.#metrics = metrics;
  }

  /** Accounts currently held open by the reduction. */
  get openCohorts(): number {
    return this.#cohorts.size;
  }

  observe(event: DomainEvent): void {
    if (event.subjectId === undefined) {
      return;
    }
    const current = this.#cohorts.get(event.subjectId) ?? entry();
    // `occurredAt`, not the order events reached this process: a redelivery
    // must not be able to rewrite history, and a late signal must not be scored
    // as a miss.
    const at = event.occurredAt.getTime();

    if (event.type === 'risk.changed' && isHighOrCritical(event.payload['to'])) {
      current.firstHighRiskAt = current.firstHighRiskAt ?? at;
    } else if (event.type === 'moderation.report_submitted') {
      current.firstReportAt = current.firstReportAt ?? at;
    } else if (event.type === 'moderation.case_opened' && !current.counted) {
      this.#cohorts.delete(event.subjectId);
      this.#metrics.confirm(this.#detectedBefore(current, at));
      return;
    }

    this.#cohorts.set(event.subjectId, current);
  }

  /**
   * Whether the risk machine got there on its own, ahead of both the report and
   * the case. A case opened because a moderator read the reports is the system
   * working, not the system noticing, so the case is a comparison point and
   * never a detection.
   */
  #detectedBefore(current: CohortEntry, caseOpenedAt: number): boolean {
    if (current.firstHighRiskAt === null) {
      return false;
    }
    const firstHumanSignal = Math.min(current.firstReportAt ?? caseOpenedAt, caseOpenedAt);
    return current.firstHighRiskAt < firstHumanSignal;
  }
}
