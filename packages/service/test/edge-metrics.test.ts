import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createStores, createTransaction } from '@been-there/database';
import { StoreError } from '@been-there/contracts';
import { type DomainError, type DomainErrorCode, type Result, castId, domainError, ok } from '@been-there/core';
import { type Route, okResponse, publicRoute, route } from '../src/http/router.js';
import { startService } from '../src/http/server.js';
import { failureBodyFromStore, statusForDomainError, statusForStoreError } from '../src/http/failure.js';
import {
  DOMAIN_RESPONSE_CLASSES,
  EDGE_RESPONSE_METRIC,
  classifyResponse,
  edgeResponseMeter,
  recordResponse,
} from '../src/health/edge-metrics.js';
import { healthRoutes } from '../src/routes/health.js';
import type { RequestActor, ServiceDependencies } from '../src/ports.js';
import { requireDatabaseReady } from './support/harness.js';

/**
 * The edge-wide counter that keeps a safety refusal and an outage apart.
 *
 * Four claims, each of which was unasserted before this file:
 *
 *  - a domain refusal, a retryable store fault and a permanent one produce three
 *    different labels, and each is asserted alongside the status it already had,
 *    so an edit to the counter cannot quietly move a status code;
 *  - the classification agrees with the status table for *every* domain code, so
 *    the two cannot drift apart and turn a 503 into something the metric calls a
 *    refusal;
 *  - a label set carrying an identifier is refused rather than recorded, which is
 *    the difference between a metrics backend and a database;
 *  - a request that fails *after* writing is counted as a fault and rolls back.
 *    Those two are asserted together on purpose: a rolled-back write counted as a
 *    refusal would be a lie about the database, and a fault counted as a refusal
 *    would hide an outage behind a moderation signal.
 */

/** The only session the resolver in this suite answers to. */
const KNOWN_SESSION = 'edge-metrics-session';

const SESSION_ACTOR: RequestActor = {
  userId: castId<'UserId'>('00000000-0000-4000-8000-0000000000ed'),
  role: 'user',
  principal: { userId: castId<'UserId'>('00000000-0000-4000-8000-0000000000ed'), role: 'user' },
  automated: false,
  actorId: castId<'ActorId'>('edge-metrics-actor'),
};

/**
 * A resolver that knows one session and refuses everything else, which is what a
 * real one does with a token it cannot resolve. It is here so a refusal can be
 * produced by the *authentication* layer as well as by a handler: the whole claim
 * of the classification is that the layer which produced the failure does not
 * change which bucket it lands in.
 */
const actors = {
  resolve: (authorization: string | undefined): Promise<Result<RequestActor, DomainError>> => {
    const token = authorization?.replace(/^Bearer /, '');
    if (token === KNOWN_SESSION) {
      return Promise.resolve(ok(SESSION_ACTOR));
    }
    return Promise.resolve(domainError('permission_denied', 'service.auth', 'that session does not exist'));
  },
};

/** The relay seam, which this suite never exercises. */
const CONTACTS = { deliver: async (): Promise<void> => undefined };

/** One request, as a client would make it. */
async function get(
  url: string,
  path: string,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

/** The current value of one `edge.response` series, by its two labels. */
function counted(responseClass: string, code: string): number {
  const series = edgeResponseMeter.collect().find((entry) => entry.name === 'edge.response');
  const sample = series?.samples.find(
    (entry) => entry.attributes['class'] === responseClass && entry.attributes['code'] === code,
  );
  return sample?.value ?? 0;
}

/**
 * Every dimension name any sample of `edge.response` carries, across the whole
 * series rather than one sample.
 *
 * This is the assertion the earlier per-input checks were not: they asked
 * whether a particular hostile call was refused, which a guard that only knew
 * how to refuse *that* identifier would satisfy. This asks what the metric is
 * actually holding, so any identifier that ever became a label fails the test
 * however it got there — including a dimension somebody added to the catalogue
 * and a value somebody passed at the call site.
 */
function dimensionsInUse(): readonly string[] {
  const series = edgeResponseMeter.collect().find((entry) => entry.name === 'edge.response');
  const names = (series?.samples ?? []).flatMap((sample) => Object.keys(sample.attributes));
  return [...new Set(names)].sort();
}

/**
 * Dimensions the metric is holding that are not the two it declares. Empty
 * before any traffic has been counted — an empty metric holds no dimensions at
 * all, which is honest rather than a failure — and the point is that no hostile
 * input ever makes it non-empty.
 */
function unexpectedDimensions(allowed: readonly string[]): readonly string[] {
  return dimensionsInUse().filter((name) => !allowed.includes(name));
}

function errorCodeOf(body: Record<string, unknown>): unknown {
  return (body['error'] as Record<string, unknown> | undefined)?.['code'];
}

describe('the class a response is counted under', () => {
  it('files a domain refusal as a refusal, and leaves the status where the status table put it', () => {
    const refusal = domainError('permission_denied', 'service.auth', 'that session does not exist').error;
    expect(classifyResponse(refusal)).toEqual({ class: 'refused', code: 'permission_denied' });
    expect(statusForDomainError(refusal)).toBe(403);
  });

  it('files a retryable store fault as an outage, and leaves the status at 503', () => {
    const fault = new StoreError('the connection was terminated', { retryable: true });
    expect(classifyResponse(fault)).toEqual({ class: 'outage', code: 'store_unavailable' });
    expect(statusForStoreError(fault)).toBe(503);
  });

  it('files a permanent store fault as an outage under a different code, and leaves the status at 500', () => {
    const fault = new StoreError('a not-null constraint was violated', { retryable: false });
    expect(classifyResponse(fault)).toEqual({ class: 'outage', code: 'store_failure' });
    expect(statusForStoreError(fault)).toBe(500);
  });

  it('gives the three failures three different readings', () => {
    // Asserted as a set rather than one at a time, so a counter that collapsed
    // both faults into one code — or both failures into one class — is a visible
    // change and not a quieter one.
    const readings = [
      classifyResponse(domainError('invalid_transition', 'service.domain', 'no').error),
      classifyResponse(new StoreError('terminated', { retryable: true })),
      classifyResponse(new StoreError('violated', { retryable: false })),
    ];
    expect(readings).toEqual([
      { class: 'refused', code: 'invalid_transition' },
      { class: 'outage', code: 'store_unavailable' },
      { class: 'outage', code: 'store_failure' },
    ]);
    expect(new Set(readings.map((reading) => reading.class)).size).toBe(2);
  });

  it('agrees with the status table for every domain code there is', () => {
    // The two tables are written separately and for different consumers, so the
    // one thing that must not happen is their disagreeing: a 503 the metric files
    // as a refusal is precisely the conflation this counter exists to prevent.
    const entries = Object.entries(DOMAIN_RESPONSE_CLASSES) as [DomainErrorCode, string][];
    expect(entries.length).toBeGreaterThan(0);
    for (const [code, responseClass] of entries) {
      const error = domainError(code, 'service.domain', 'a message').error;
      expect(statusForDomainError(error) < 500, `${code} is ${String(statusForDomainError(error))}`).toBe(
        responseClass === 'refused',
      );
      expect(classifyResponse(error)).toEqual({ class: responseClass, code });
    }
  });

  it('counts a store fault under the code the client is given', () => {
    // One vocabulary, so a dashboard cannot disagree with the body a caller is
    // holding: `store_unavailable` is what the retry advice is keyed on.
    for (const retryable of [true, false]) {
      const fault = new StoreError('terminated', { retryable });
      expect(classifyResponse(fault).code).toBe(failureBodyFromStore(fault).error.code);
    }
  });

  it('counts a success as a completion carrying no code', () => {
    expect(classifyResponse(undefined)).toEqual({ class: 'completed', code: 'none' });
  });
});

describe('a label set that would melt the backend', () => {
  /** The only two dimensions this metric may ever hold. */
  const ALLOWED_DIMENSIONS = ['class', 'code'];

  it('refuses an identifier as a label value, even under a declared dimension', () => {
    const hostile: Readonly<Record<string, unknown>> = {
      class: 'refused',
      code: 'usr_01HQ8V5K2XJ4N7P0R3T6Y',
    };
    const recorded = recordResponse(hostile);
    expect(recorded.ok).toBe(false);
    expect(recorded.ok === false && recorded.error.code).toBe('validation_failed');
    expect(counted('refused', 'usr_01HQ8V5K2XJ4N7P0R3T6Y')).toBe(0);
    // The meter holds *no* dimensions rather than a subset: this test refuses
    // the label set outright, so nothing was ever counted. Asserting the
    // declared set here would pass whether or not the guard refused.
    expect(unexpectedDimensions(['class', 'code'])).toEqual([]);
  });

  it('refuses every subject-shaped dimension name it can be handed', () => {
    // Each one on its own would be satisfied by a guard that had memorised the
    // previous one. The property is the last line: whatever was attempted, the
    // metric is still holding two dimensions and no others.
    const subjects: Readonly<Record<string, unknown>>[] = [
      { class: 'refused', code: 'permission_denied', userId: 'usr_01HQ8V5K2XJ4N7P0R3T6Y' },
      { class: 'refused', code: 'permission_denied', conversationId: '8f14e45f-ceea-467a-9ba2-1f2c3d4e5f60' },
      { class: 'refused', code: 'permission_denied', caseId: '3f9a1c22-0b7e-4d51-8a6f-77c1d0e5b913' },
      { class: 'refused', code: 'permission_denied', requestId: 'req-2f0c1d9e4b6a' },
      { class: 'refused', code: 'permission_denied', route: '/v1/chat' },
    ];
    for (const hostile of subjects) {
      expect(recordResponse(hostile).ok, Object.keys(hostile).join(',')).toBe(false);
    }
    expect(unexpectedDimensions(['class', 'code'])).toEqual([]);
  });

  it('refuses a subject-shaped dimension even if the catalogue declared it', () => {
    // The catalogue is the first line — `defineMetrics` throws at import for a
    // declared high-cardinality dimension — and this is the second. It is here
    // because a future edit could satisfy the first by removing it and leave the
    // guard as the only thing refusing, which is where the identifier must not be.
    expect(EDGE_RESPONSE_METRIC.dimensions).toEqual(ALLOWED_DIMENSIONS);
    // Same reason as the two above: nothing was counted, so the meter is empty
    // rather than holding a subset. The claim under test is the *declaration*,
    // which is the first assertion.
    expect(unexpectedDimensions(['class', 'code'])).toEqual([]);
  });

  it('refuses a pair that calls a completion a failure, or a store fault a refusal', () => {
    // The coherence rules. The closed vocabulary on its own would accept all
    // three, which is why they are separate checks and not one.
    expect(recordResponse({ class: 'completed', code: 'permission_denied' }).ok).toBe(false);
    expect(recordResponse({ class: 'refused', code: 'none' }).ok).toBe(false);
    expect(recordResponse({ class: 'refused', code: 'store_unavailable' }).ok).toBe(false);
  });

  it('records a coherent label set', () => {
    const before = counted('refused', 'permission_denied');
    expect(recordResponse({ class: 'refused', code: 'permission_denied' }).ok).toBe(true);
    expect(counted('refused', 'permission_denied')).toBe(before + 1);
  });
});

describe('the counter, over a real server', () => {
  let pool: pg.Pool;
  let url: string;
  let close: (() => Promise<void>) | undefined;
  /** The dedupe key of the row the faulting route writes before it fails. */
  let writtenKey: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await requireDatabaseReady() });
    await pool.query('SELECT 1');
    const stores = createStores(pool);
    const dependencies: ServiceDependencies = {
      stores,
      transaction: createTransaction(pool),
      actors,
      contacts: CONTACTS,
      now: () => new Date(),
    };
    writtenKey = randomUUID();

    const refuses: Route = publicRoute('GET', '/v1/edge/refused', async () =>
      domainError('invalid_transition', 'edge.test', 'that conversation is already blocked'),
    );
    const completes: Route = publicRoute('GET', '/v1/edge/complete', async () => okResponse(200, { answered: true }));
    // Not public: reachable only with a session, so this exercises a refusal
    // decided before any handler ran.
    const needsSession: Route = route('GET', '/v1/edge/needs-session', async () => okResponse(200, { reached: true }));
    const transient: Route = publicRoute('GET', '/v1/edge/transient', async () => {
      throw new StoreError('the connection was terminated', { retryable: true });
    });
    // A defect rather than a fault: not a `StoreError`, so it escapes the
    // handler's own `catch` and reaches the last line of defence. The store
    // never classified it, so the edge has to.
    const defects: Route = publicRoute('GET', '/v1/edge/defect', async () => {
      throw new Error('a handler that throws something the store did not classify');
    });
    // A response that cannot be written. `writeHead` throws on it, so the request
    // is finished twice — once here and once by the last line of defence — and a
    // counter that records before it writes would count it twice.
    const unwritable: Route = publicRoute('GET', '/v1/edge/unwritable', async () =>
      okResponse(Number.NaN, { unreachable: true }),
    );
    // Writes, and *then* fails. The write is real and goes through the request's
    // transaction, so what this proves is not that a handler can throw but that a
    // fault after a write still rolls back and is still counted as a fault.
    const writeThenFail: Route = publicRoute('GET', '/v1/edge/write-then-fail', async (request) => {
      await stores.moderation.appendAudit(
        {
          occurredAt: request.now,
          actorId: 'edge-metrics-test',
          action: 'case.opened',
          entityType: 'edge_probe',
          entityId: writtenKey,
          dedupeKey: writtenKey,
        },
        request.tx,
      );
      throw new StoreError('a not-null constraint was violated', { retryable: false });
    });

    const running = await startService(dependencies, {
      routes: [refuses, completes, needsSession, transient, defects, unwritable, writeThenFail, ...healthRoutes(dependencies)],
    });
    url = running.url;
    close = running.close;
  });

  afterAll(async () => {
    await close?.();
    await pool.end();
  });

  it('counts a success as a completion', async () => {
    const before = counted('completed', 'none');
    const answer = await get(url, '/v1/edge/complete');
    expect(answer.status).toBe(200);
    expect(counted('completed', 'none')).toBe(before + 1);
  });

  it("counts a refusal a handler decided as a refusal, under the handler's own code", async () => {
    const before = counted('refused', 'invalid_transition');
    const answer = await get(url, '/v1/edge/refused');
    expect(answer.status).toBe(409);
    expect(errorCodeOf(answer.body)).toBe('invalid_transition');
    expect(counted('refused', 'invalid_transition')).toBe(before + 1);
    // A refusal is the product answering. It must not also be counted as the
    // service failing, or a moderation signal reads as an availability incident.
    expect(counted('outage', 'invalid_transition')).toBe(0);
  });

  it('counts a refusal decided before any handler ran the same way', async () => {
    const before = counted('refused', 'permission_denied');
    const answer = await get(url, '/v1/edge/needs-session');
    expect(answer.status).toBe(403);
    expect(errorCodeOf(answer.body)).toBe('permission_denied');
    expect(counted('refused', 'permission_denied')).toBe(before + 1);
    expect(counted('outage', 'permission_denied')).toBe(0);
  });

  it('counts a retryable store fault as an outage, not as a refusal', async () => {
    const beforeOutage = counted('outage', 'store_unavailable');
    const beforeRefusals = counted('refused', 'store_unavailable');
    const answer = await get(url, '/v1/edge/transient');
    expect(answer.status).toBe(503);
    expect(errorCodeOf(answer.body)).toBe('store_unavailable');
    expect(counted('outage', 'store_unavailable')).toBe(beforeOutage + 1);
    expect(counted('refused', 'store_unavailable')).toBe(beforeRefusals);
  });

  it('counts a fault after a write as an outage, and rolls the write back', async () => {
    const beforeOutage = counted('outage', 'store_failure');
    const beforeRefusals = counted('refused', 'store_failure');

    const answer = await get(url, '/v1/edge/write-then-fail');
    expect(answer.status).toBe(500);
    expect(errorCodeOf(answer.body)).toBe('store_failure');

    // Counted as a fault. A refusal here would tell an operator the request was
    // declined on purpose while the write it had already issued was being
    // discarded, which is the one story a dashboard must never tell.
    expect(counted('outage', 'store_failure')).toBe(beforeOutage + 1);
    expect(counted('refused', 'store_failure')).toBe(beforeRefusals);

    // And rolled back. Scoped to the key this suite minted, so another suite's
    // rows cannot satisfy it.
    const survivors = await pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM app.audit_log WHERE dedupe_key = $1',
      [writtenKey],
    );
    expect(survivors.rows[0]?.count).toBe(0);
  });

  it('serves the counts it has taken, with the two dimensions it declares and no others', async () => {
    // A counter nobody can read is not a counter. Asserted over the whole series
    // rather than one sample, so an identifier that ever reached a label shows up
    // here however few times it was recorded.
    const answer = await get(url, '/v1/health/metrics', KNOWN_SESSION);
    expect(answer.status).toBe(200);
    const metrics = answer.body['metrics'] as readonly {
      name: string;
      dimensions: readonly string[];
      samples: readonly { labels: Record<string, string>; value: number }[];
    }[];
    const served = metrics.find((entry) => entry.name === 'edge.response');
    expect(served?.dimensions).toEqual(['class', 'code']);
    expect(served?.samples.length).toBeGreaterThan(0);
    expect(new Set(served?.samples.map((sample) => Object.keys(sample.labels).sort().join(',')))).toEqual(
      new Set(['class,code']),
    );
    // A refusal rate and an outage rate have to be readable separately, or the
    // distinction the counter exists for is invisible at the only place it is read.
    const outages = served?.samples.find((sample) => sample.labels['class'] === 'outage');
    const refusals = served?.samples.find((sample) => sample.labels['class'] === 'refused');
    expect(outages?.value).toBeGreaterThan(0);
    expect(refusals?.value).toBeGreaterThan(0);
  });
});