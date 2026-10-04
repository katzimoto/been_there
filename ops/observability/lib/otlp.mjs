/**
 * OTLP/HTTP + JSON: the wire format every one of the three backends here speaks.
 *
 * There is no OpenTelemetry SDK in this repository — only `@opentelemetry/api`,
 * which is an interface and not a pipeline. This module is the small part of the
 * pipeline that is missing: a queue, a batcher, and a `fetch`.
 *
 * Two deliberate properties:
 *
 * 1. **It never throws into the caller.** A request that produced a span must
 *    return its status code whether Tempo is up, down or on fire. The sink
 *    therefore owns its failures, keeps a bounded backlog, and drops the oldest
 *    entries rather than growing without limit.
 * 2. **It never keeps the process alive.** Every timer is unref'd, so the
 *    pending batch cannot delay a shutdown that has already been asked for; the
 *    `beforeExit` hook is what flushes the last batch, because an unref'd timer
 *    means the event loop reaching empty, which is exactly when that hook runs.
 *
 * Encoding is JSON rather than protobuf because all three backends accept it and
 * a local tool with no build step should not need a `.proto` compiler to be
 * legible.
 */

/** How long one push may take before it is treated as a failure. */
const REQUEST_TIMEOUT_MS = 3_000;
/** How many records one flush sends. */
const BATCH = 256;
/** The most records held while a backend is down. */
const MAX_BACKLOG = 1_000;
/** Backoff bounds, so a backend that comes back is picked up quickly. */
const MIN_RETRY_MS = 250;
const MAX_RETRY_MS = 5_000;
/** How often a failing backend is complained about, at most. */
const WARN_INTERVAL_MS = 15_000;

/** An OTLP `AnyValue`. Primitives only, because a trace backend is a third party. */
export function anyValue(value) {
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (typeof value === 'boolean') {
    return { boolValue: value };
  }
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  return { stringValue: String(value) };
}

/** An OTLP `KeyValue` list from a plain attribute object. */
export function attributes(record) {
  return Object.entries(record).map(([key, value]) => ({
    key,
    value: anyValue(value),
  }));
}

/** Nanoseconds since the epoch, as OTLP's 64-bit integers are encoded in JSON. */
export function nowNanos() {
  return String(BigInt(Date.now()) * 1_000_000n);
}

/**
 * One destination: a URL, a bounded queue, and the function that turns a batch of
 * records into the document that backend expects.
 *
 * @param {object} options
 * @param {string} options.name        For diagnostics only: `tempo`, `loki`, …
 * @param {string} options.url         Where the document is POSTed.
 * @param {(batch: unknown[]) => object} options.document Builds the OTLP payload.
 * @param {() => object} options.resource Resource attributes, read at send time.
 */
export function createSink({ name, url, document, resource }) {
  /** @type {unknown[]} */
  let backlog = [];
  let timer = null;
  let inFlight = false;
  let failures = 0;
  let lastWarnedAt = 0;

  function warn(message) {
    const now = Date.now();
    if (now - lastWarnedAt < WARN_INTERVAL_MS) {
      return;
    }
    lastWarnedAt = now;
    process.stderr.write(`[telemetry] ${name}: ${message}\n`);
  }

  async function flush() {
    if (inFlight || backlog.length === 0) {
      return;
    }
    inFlight = true;
    const batch = backlog.splice(0, BATCH);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(document(batch)),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`${url} answered HTTP ${response.status}`);
      }
      if (failures > 0) {
        process.stderr.write(`[telemetry] ${name}: recovered after ${failures} failed batches\n`);
      }
      failures = 0;
    } catch (error) {
      failures += 1;
      // Back to the front of the queue: these records are older than whatever is
      // waiting, and a log backend that receives them out of order still gets
      // them; a trace backend that does not, is not one this stack runs.
      backlog = [...batch, ...backlog].slice(-MAX_BACKLOG);
      warn(`${error instanceof Error ? error.message : String(error)} (${backlog.length} held)`);
      schedule(Math.min(MIN_RETRY_MS * 2 ** Math.min(failures, 5), MAX_RETRY_MS));
    } finally {
      inFlight = false;
      if (backlog.length > 0) {
        schedule(0);
      }
    }
  }

  function schedule(delayMs) {
    if (timer !== null) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
    // Unref'd: a telemetry backlog must never be the reason a service refuses to
    // exit. The `beforeExit` hook covers the final batch instead.
    timer.unref();
  }

  return {
    push(record) {
      backlog.push(record);
      if (backlog.length > MAX_BACKLOG) {
        backlog = backlog.slice(-MAX_BACKLOG);
      }
      // Coalesce for a few milliseconds rather than for a quarter of a second.
      // A service that is killed — the demo journey restarts it, and `make
      // demo-stop` stops it — takes the pending batch with it, and a window wide
      // enough to lose a quarter of a second of requests is wide enough to lose
      // the last few steps of a demonstration. 25ms still coalesces a burst:
      // anything recorded while a push is in flight waits for it and goes out
      // together.
      schedule(backlog.length >= BATCH ? 0 : 25);
    },
    size: () => backlog.length,
    flushNow: () => {
      void flush();
    },
  };
}

/**
 * The block every OTLP document opens with. The three signals share a shape
 * (`resourceSpans` / `resourceLogs` / `resourceMetrics`, each holding scope
 * blocks), so this returns the part that is identical and the call sites spell
 * out the part that is not.
 */
export function resourceBlock(resourceAttributes) {
  return { resource: { attributes: attributes(resourceAttributes()) } };
}