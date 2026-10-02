import type {
  Attributes,
  BatchObservableCallback,
  BatchObservableResult,
  Counter,
  Gauge,
  Histogram,
  Meter,
  MetricOptions,
  Observable,
  ObservableCallback,
  ObservableCounter,
  ObservableGauge,
  ObservableResult,
  ObservableUpDownCounter,
  UpDownCounter,
} from '@opentelemetry/api';

/**
 * A `Meter` that keeps its numbers in this process, so the service can *serve*
 * its metrics.
 *
 * ## Why this exists rather than an exporter
 *
 * `packages/platform` builds the safety instruments from an OpenTelemetry `Meter`
 * and deliberately leaves the SDK to the composition root — a process with no
 * collector registered gets the no-op meter and the instruments vanish, which is
 * the right default for a library. But "the metrics exist and nothing serves
 * them" is not a deployable state: the numbers issue #43 asks for are only
 * observable if something inside the process can read them.
 *
 * This is an implementation of the OpenTelemetry `Meter` interface, not a mock
 * of our own code, so `SafetyMetrics` makes the same `createCounter` /
 * `createObservableGauge` calls a real SDK would see. Point the composition root
 * at a collector later and this file becomes redundant rather than wrong.
 */

/** The instruments `Meter` creates, as this class records them. */
export type InstrumentKind =
  | 'counter'
  | 'up_down_counter'
  | 'histogram'
  | 'gauge'
  | 'observable_counter'
  | 'observable_up_down_counter'
  | 'observable_gauge';

/**
 * How a sample was derived. A counter and a gauge both report one `value`; a
 * histogram reports a `count` and a `sum`, and reporting only the sum would make
 * a latency tile average its way to a number nobody asked for.
 */
export type Statistic = 'value' | 'count' | 'sum';

export interface MetricSample {
  readonly attributes: Attributes;
  readonly statistic: Statistic;
  readonly value: number;
}

export interface MetricSeries {
  readonly name: string;
  readonly instrument: InstrumentKind;
  readonly unit: string;
  readonly description: string;
  readonly samples: readonly MetricSample[];
}

interface Registration extends Observable {
  readonly name: string;
  readonly instrument: InstrumentKind;
  readonly unit: string;
  readonly description: string;
  readonly samples: Map<string, MetricSample>;
  readonly callbacks: ObservableCallback[];
}

/**
 * The label set as a stable key.
 *
 * Sorted, because two call sites that build the same labels in a different
 * order must land on one series — a backend that received both would count the
 * same fact twice. And `JSON.stringify`, because a plain join would let
 * `{a: "1", b: "23"}` and `{a: "12", b: "3"}` collide.
 */
function seriesKey(attributes: Attributes): string {
  return JSON.stringify(Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right)));
}

/** A number recorded at one label set, replacing whatever was there. */
function sample(attributes: Attributes, statistic: Statistic, value: number): MetricSample {
  return { attributes, statistic, value };
}

/**
 * `Counter.add` and `UpDownCounter.add` accumulate; `Gauge.record` replaces.
 *
 * The distinction is not cosmetic: a counter that replaced its value would report
 * `1` however many times it was recorded, and every rate built from it would be
 * silently wrong rather than obviously broken.
 */
function accumulate(registration: Registration, value: number, attributes?: Attributes): void {
  const attributes_ = attributes ?? {};
  const key = seriesKey(attributes_);
  const existing = registration.samples.get(key);
  registration.samples.set(key, sample(attributes_, 'value', (existing?.value ?? 0) + value));
}

export class InMemoryMeter implements Meter {
  #registrations = new Map<Observable, Registration>();
  #batches: { callback: BatchObservableCallback; observables: readonly Observable[] }[] = [];

  #register(instrument: InstrumentKind, name: string, options: MetricOptions | undefined): Registration {
    const registration: Registration = {
      name,
      instrument,
      unit: options?.unit ?? '',
      description: options?.description ?? '',
      samples: new Map(),
      callbacks: [],
      addCallback(callback: ObservableCallback): void {
        if (!registration.callbacks.includes(callback)) {
          registration.callbacks.push(callback);
        }
      },
      removeCallback(callback: ObservableCallback): void {
        const at = registration.callbacks.indexOf(callback);
        if (at >= 0) {
          registration.callbacks.splice(at, 1);
        }
      },
    };
    this.#registrations.set(registration, registration);
    return registration;
  }

  createCounter(name: string, options?: MetricOptions): Counter {
    const registration = this.#register('counter', name, options);
    return { add: (value: number, attributes?: Attributes): void => accumulate(registration, value, attributes) };
  }

  createUpDownCounter(name: string, options?: MetricOptions): UpDownCounter {
    const registration = this.#register('up_down_counter', name, options);
    return { add: (value: number, attributes?: Attributes): void => accumulate(registration, value, attributes) };
  }

  createGauge(name: string, options?: MetricOptions): Gauge {
    const registration = this.#register('gauge', name, options);
    return {
      record: (value: number, attributes?: Attributes): void => {
        registration.samples.set(seriesKey(attributes ?? {}), sample(attributes ?? {}, 'value', value));
      },
    };
  }

  createHistogram(name: string, options?: MetricOptions): Histogram {
    const registration = this.#register('histogram', name, options);
    return {
      record: (value: number, attributes?: Attributes): void => {
        const attributes_ = attributes ?? {};
        const key = seriesKey(attributes_);
        const counted = registration.samples.get(key);
        const summed = registration.samples.get(`${key}|sum`);
        registration.samples.set(key, sample(attributes_, 'count', (counted?.value ?? 0) + 1));
        registration.samples.set(`${key}|sum`, sample(attributes_, 'sum', (summed?.value ?? 0) + value));
      },
    };
  }

  createObservableGauge(name: string, options?: MetricOptions): ObservableGauge {
    return this.#register('observable_gauge', name, options);
  }

  createObservableCounter(name: string, options?: MetricOptions): ObservableCounter {
    return this.#register('observable_counter', name, options);
  }

  createObservableUpDownCounter(name: string, options?: MetricOptions): ObservableUpDownCounter {
    return this.#register('observable_up_down_counter', name, options);
  }

  addBatchObservableCallback(callback: BatchObservableCallback, observables: Observable[]): void {
    this.#batches.push({ callback, observables: [...observables] });
  }

  removeBatchObservableCallback(callback: BatchObservableCallback, observables: Observable[]): void {
    const at = this.#batches.findIndex(
      (batch) =>
        batch.callback === callback &&
        batch.observables.length === observables.length &&
        batch.observables.every((entry, index) => entry === observables[index]),
    );
    if (at >= 0) {
      this.#batches.splice(at, 1);
    }
  }

  /**
   * Runs every registered observable callback and returns what this process
   * currently holds.
   *
   * Run at scrape time rather than on every write, which is what makes an
   * observable gauge a snapshot taken when somebody asked for it rather than a
   * value frozen at the moment the instrument was created.
   */
  collect(): readonly MetricSeries[] {
    for (const batch of this.#batches) {
      batch.callback(this.#batchResultFor(batch.observables));
    }
    for (const registration of this.#registrations.values()) {
      for (const callback of [...registration.callbacks]) {
        callback(this.#resultFor(registration));
      }
    }
    return [...this.#registrations.values()].map((registration) => ({
      name: registration.name,
      instrument: registration.instrument,
      unit: registration.unit,
      description: registration.description,
      samples: [...registration.samples.values()].sort((left, right) =>
        seriesKey(left.attributes).localeCompare(seriesKey(right.attributes)),
      ),
    }));
  }

  /** The receiver a single-observable callback observes through. */
  #resultFor(registration: Registration): ObservableResult {
    const put = (value: number, attributes?: Attributes): void => {
      registration.samples.set(seriesKey(attributes ?? {}), sample(attributes ?? {}, 'value', value));
    };
    return {
      // `observe` declares an explicit `this` because the OpenTelemetry interface
      // declares it that way, and an arrow property cannot satisfy it.
      observe(this: ObservableResult, value: number, attributes?: Attributes): void {
        put(value, attributes);
      },
    };
  }

  /**
   * The receiver a batch callback observes through.
   *
   * A batch callback may only observe the observables it was registered with.
   * Honouring that rather than recording everything is what stops one
   * instrument's callback from writing into another's series — the mistake that
   * produces a metric nobody can account for.
   */
  #batchResultFor(allowed: readonly Observable[]): BatchObservableResult {
    // Captured before the object literal, because `observe` overrides `this` with
    // the OpenTelemetry receiver, which is not this meter.
    const registrations = this.#registrations;
    return {
      observe(this: BatchObservableResult, metric: Observable, value: number, attributes?: Attributes): void {
        const registration = registrations.get(metric);
        if (registration !== undefined && allowed.includes(metric)) {
          registration.samples.set(seriesKey(attributes ?? {}), sample(attributes ?? {}, 'value', value));
        }
      },
    };
  }
}