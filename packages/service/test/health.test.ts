import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createStores, createTransaction } from '@been-there/database';
import { StoreError, type InteractionStore, type Stores } from '@been-there/contracts';
import { type CorrelationId, type DomainEvent, type SubjectId, type UserId, castId } from '@been-there/core';
import {
  type ServiceDependencies,
  type ServiceHealth,
  createServiceHealth,
  okResponse,
  publicRoute,
  serviceRoutes,
  startService,
} from '@been-there/service';
import {
  type Caller,
  type Harness,
  call,
  member,
  requireDatabaseReady,
  resolverFor,
  socketAddressOnly,
} from './support/harness.js';
import { type Created, COMPLETE_PROFILE, PASSING_RESULT, verify } from './support/fixtures.js';
import { reclaimPrepared } from './support/reclaim.js';
import { harnessVerificationProvider } from './support/provider.js';

/**
 * One teardown for the whole file, not one per `describe`.
 *
 * Both describes below share this process's single per-suite database — it is
 * created once and prepared once — so a `reclaimPrepared()` in the first
 * describe's `afterAll` drops it before the second describe's `beforeAll` runs,
 * and that setup fails against a database that is no longer there. The
 * teardown belongs after everything that uses it.
 */
const closers: (() => Promise<void>)[] = [];

afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
  // `startHarnessWith` assembles its own service and closes only its own
  // listener and pool, so nothing outside this file drops the per-suite database
  // it prepared. Reached whether or not any setup completed.
  reclaimPrepared();
});

/**
 * The metrics the service serves, and the error taxonomy it serves them beside.
 *
 * Two claims are tested here that no unit test in this repository has made:
 *
 *  - **a metric label cannot name a thing.** `packages/platform` declares that
 *    rule and enforces it when the catalogue is built; this asserts the rule
 *    survives the trip through an HTTP request, which is where somebody would
 *    actually reach for `?label=userId:...`.
 *  - **a refusal is not an outage, and an outage is not a refusal.** They are
 *    asserted separately and deliberately never in the same test. A suite that
 *    only checked "the status is 4xx or 5xx" would pass against a service that
 *    reported every safety refusal as a database outage, which is the exact
 *    conflation `packages/database/src/errors.ts` exists to prevent.
 */

const ALICE = 'alice-token';
const BOB = 'bob-token';

/** The relay seam, which this suite never exercises. */
const CONTACTS = { deliver: async (): Promise<void> => undefined };

interface ServiceHarness extends Harness {
  readonly dependencies: ServiceDependencies;
  readonly health: ServiceHealth;
}

/**
 * The same service four times over: once healthy, three times with one store
 * method replaced. The faults are thrown at the store boundary because that is
 * where a transient fault actually originates; the transaction, the routing, the
 * status table and the response body are all the real ones.
 */
async function startHarnessWith(callers: readonly Caller[], fault?: Partial<InteractionStore>): Promise<ServiceHarness> {
  const pool = new pg.Pool({ connectionString: await requireDatabaseReady() });
  await pool.query('SELECT 1');
  const stores: Stores = createStores(pool);
  // One instance, wired into the service and handed back on the harness, so a
  // suite moves the score the service actually reads rather than a copy.
  const provider = harnessVerificationProvider();
  // The cell the resolver reads per request, so `reloadCallers` is a real swap
  // rather than a method the type requires and the suite never needs.
  const cell: { current: readonly Caller[] } = { current: callers };
  const dependencies: ServiceDependencies = {
    stores: fault === undefined ? stores : { ...stores, interaction: withFault(stores.interaction, fault) },
    transaction: createTransaction(pool),
    actors: resolverFor(callers, undefined, undefined, cell),
    contacts: CONTACTS,
    verification: provider,
    now: () => new Date(),
  };
  const running = await startService(dependencies, { routes: serviceRoutes(dependencies) });
  return {
    url: running.url,
    stores: dependencies.stores,
    messages: [],
    pool,
    transaction: dependencies.transaction,
    dependencies,
    verification: provider,
    health: createServiceHealth(dependencies),
    reloadCallers: (next: readonly Caller[]) => {
      cell.current = next;
    },
    // No trusted hop is installed above, so every request takes its socket
    // address and there is nothing to present a different one through.
    fromAddress: socketAddressOnly,
    close: async () => {
      await running.close();
      await pool.end();
    },
  };
}

/**
 * A store with one method replaced.
 *
 * The real store is kept as the prototype rather than spread, because spreading
 * a class instance copies only its own properties and silently drops every
 * method defined on its prototype — a fault harness that lost `findLikesFor`
 * would be testing a store that does not exist.
 */
function withFault(store: InteractionStore, fault: Partial<InteractionStore>): InteractionStore {
  return Object.assign(Object.create(store) as InteractionStore, fault);
}

/**
 * A real sign-up.
 *
 * `POST /v1/accounts` takes a contact identifier, a password, a date of birth and
 * the accepted terms version, so an account is created with all four rather than
 * with an empty body. A contact unique to each call, because one verified contact
 * identifier is one account.
 */
async function signUp(harness: ServiceHarness, token: string, label: string): Promise<Created> {
  // The contact is unique per run because the database is not: one verified
  // contact identifier is one account, and a second run would get the
  // indistinguishable-by-design `check_your_contact` answer instead of an id.
  const response = await call(harness, 'POST', '/v1/accounts', token, {
    contact: `${label}-${randomUUID()}@example.test`,
    password: 'correct-horse-battery-staple',
    dateOfBirth: '1994-04-01',
    termsVersion: '2026-09-01',
  });
  if (response.status !== 201) {
    throw new Error(`signing up ${label} returned ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return {
    userId: castId<'UserId'>(String(response.body['userId'])),
    accountId: String(response.body['accountId']),
  };
}

interface MetricSeriesBody {
  readonly name: string;
  readonly dimensions: readonly string[];
  readonly samples: readonly { labels: Record<string, string>; value: number }[];
}

function seriesOf(body: Record<string, unknown>, name: string): MetricSeriesBody {
  const metrics = body['metrics'] as readonly MetricSeriesBody[];
  const found = metrics.find((series) => series.name === name);
  if (found === undefined) {
    throw new Error(`no series named ${name} in the served catalogue: ${metrics.map((entry) => entry.name).join(', ')}`);
  }
  return found;
}

function event(overrides: {
  readonly type: string;
  readonly subjectId: SubjectId;
  readonly occurredAt: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}): DomainEvent {
  return {
    eventId: castId<'EventId'>(randomUUID()),
    type: overrides.type,
    version: 1,
    occurredAt: new Date(overrides.occurredAt),
    actorId: castId<'ActorId'>('system'),
    subjectId: overrides.subjectId,
    correlationId: castId<'CorrelationId'>(`corr-${overrides.type}`),
    sensitivity: 'restricted',
    payload: overrides.payload ?? {},
  };
}

describe('the metrics the service serves', () => {
  const alice = member(ALICE);
  const bob = member(BOB);
  const callers: Caller[] = [alice, bob];
  let harness: ServiceHarness;
  // Recorded the moment the harness exists rather than read back out of the
  // variable at teardown time: `harness` is unassigned when `startHarnessWith`
  // throws — which is exactly where a migration failure surfaces — and reaching
  // into it then throws a `TypeError` that displaces the real cause.

  beforeAll(async () => {
    harness = await startHarnessWith(callers);
    closers.push(harness.close);
    alice.userId = (await signUp(harness, ALICE, 'metrics-alice')).userId;
    bob.userId = (await signUp(harness, BOB, 'metrics-bob')).userId;
  });


  it('refuses the metrics body to a caller with no session', async () => {
    const anonymous = await call(harness, 'GET', '/v1/health/metrics', 'not-a-session');
    expect(anonymous.status).toBe(403);
    expect((anonymous.body['error'] as Record<string, unknown>)['code']).toBe('permission_denied');
  });

  it('serves every metric in the safety catalogue, with the dimensions it declares', async () => {
    const answer = await call(harness, 'GET', '/v1/health/metrics', ALICE);
    expect(answer.status).toBe(200);
    const names = (answer.body['metrics'] as readonly MetricSeriesBody[]).map((series) => series.name);
    expect(names).toContain('safety.detection_before_report.ratio');
    expect(names).toContain('safety.confirmed_malicious_accounts');
    expect(names).toContain('safety.detected_before_first_report');
    expect(names).toContain('verification.attempt.outcome');
    expect(names).toContain('readiness.probe');
    // The declared dimensions travel with the series, so a dashboard can tell
    // which labels it may group by without reading this repository.
    expect(seriesOf(answer.body, 'verification.attempt.outcome').dimensions).toEqual(['outcome']);
  });

  it('computes the detection-before-report ratio from the events it is fed', async () => {
    const detected = castId<'SubjectId'>('subj-detected');
    const reported = castId<'SubjectId'>('subj-reported-first');
    // One account whose risk rose before anyone reported it, one that was
    // reported first. Ordered by `occurredAt` and not by arrival, exactly as the
    // platform's reduction requires.
    harness.health.metrics.observe(
      event({
        type: 'risk.changed',
        subjectId: detected,
        occurredAt: '2026-03-01T12:00:00.000Z',
        payload: { to: 'critical' },
      }),
    );
    harness.health.metrics.observe(
      event({ type: 'moderation.case_opened', subjectId: detected, occurredAt: '2026-03-01T13:00:00.000Z' }),
    );
    harness.health.metrics.observe(
      event({
        type: 'moderation.report_submitted',
        subjectId: reported,
        occurredAt: '2026-03-01T12:00:00.000Z',
      }),
    );
    harness.health.metrics.observe(
      event({ type: 'moderation.case_opened', subjectId: reported, occurredAt: '2026-03-01T13:00:00.000Z' }),
    );

    const answer = await call(harness, 'GET', '/v1/health/metrics', ALICE);
    const ratio = seriesOf(answer.body, 'safety.detection_before_report.ratio').samples[0];
    expect(ratio?.value).toBe(0.5);
    expect(seriesOf(answer.body, 'safety.confirmed_malicious_accounts').samples[0]?.value).toBe(2);
    expect(seriesOf(answer.body, 'safety.detected_before_first_report').samples[0]?.value).toBe(1);
    // Neither counter carries a subject: the id is the reduction's key, and a
    // label carrying it would be the mistake this endpoint exists to prevent.
    expect(ratio?.labels).toEqual({});
  });

  it('narrows a series by a declared dimension without inventing one', async () => {
    harness.health.metrics.record('verification.attempt.outcome', 1, { outcome: 'verified' });
    harness.health.metrics.record('verification.attempt.outcome', 1, { outcome: 'review_required' });

    const verified = await call(harness, 'GET', '/v1/health/metrics?label=outcome:verified', ALICE);
    expect(verified.status).toBe(200);
    const samples = seriesOf(verified.body, 'verification.attempt.outcome').samples;
    expect(samples).toHaveLength(1);
    expect(samples[0]?.labels).toEqual({ outcome: 'verified' });
  });

  it('refuses a label that would name one thing rather than count many', async () => {
    for (const dimension of ['userId', 'caseId', 'conversationId']) {
      const answer = await call(harness, 'GET', `/v1/health/metrics?label=${dimension}:anything`, ALICE);
      expect(answer.status).toBe(400);
      const error = answer.body['error'] as Record<string, unknown>;
      expect(error['code']).toBe('validation_failed');
      expect(error['domain']).toBe('service.health');
      expect(String(error['message'])).toContain('cannot be a metric label');
    }
  });

  it('refuses a label that is not a declared dimension of any served metric', async () => {
    const answer = await call(harness, 'GET', '/v1/health/metrics?label=endpoint:/v1/matches', ALICE);
    expect(answer.status).toBe(400);
    expect(String((answer.body['error'] as Record<string, unknown>)['message'])).toContain('not a declared dimension');
  });

  it('refuses a malformed label rather than guessing which half was meant', async () => {
    const answer = await call(harness, 'GET', '/v1/health/metrics?label=outcome', ALICE);
    expect(answer.status).toBe(400);
    expect(String((answer.body['error'] as Record<string, unknown>)['message'])).toContain('dimension:value');
  });
});

describe('the error taxonomy in production', () => {
  const alice = member(ALICE);
  const bob = member(BOB);
  const callers: Caller[] = [alice, bob];
  let healthy: ServiceHarness;
  let retryableFault: ServiceHarness;
  let fatalFault: ServiceHarness;
  let rollbackFault: ServiceHarness;

  beforeAll(async () => {
    healthy = await startHarnessWith(callers);
    closers.push(healthy.close);
    const aliceAccount: Created = await signUp(healthy, ALICE, 'taxonomy-alice');
    const bobAccount: Created = await signUp(healthy, BOB, 'taxonomy-bob');
    alice.userId = aliceAccount.userId;
    bob.userId = bobAccount.userId;
    await verify(healthy, ALICE, aliceAccount.userId, PASSING_RESULT);
    await verify(healthy, BOB, bobAccount.userId, PASSING_RESULT);
    for (const [token, account] of [
      [ALICE, aliceAccount] as const,
      [BOB, bobAccount] as const,
    ]) {
      const profile = await call(healthy, 'PUT', `/v1/accounts/${account.userId}/profile`, token, {
        ...COMPLETE_PROFILE,
        displayName: token === ALICE ? 'Alice' : 'Bob',
      });
      expect(profile.status).toBe(200);
    }

    retryableFault = await startHarnessWith(callers, {
      appendLike: async () => {
        throw new StoreError('the connection went away mid-statement', { retryable: true });
      },
    });
    closers.push(retryableFault.close);
    fatalFault = await startHarnessWith(callers, {
      appendLike: async () => {
        throw new StoreError('a constraint the service cannot satisfy', { retryable: false });
      },
    });
    closers.push(fatalFault.close);
    // Thrown *after* the like and the match have been written inside the
    // request's transaction, so the request has something to lose.
    rollbackFault = await startHarnessWith(callers, {
      updateLike: async () => {
        throw new StoreError('the ledger could not be updated', { retryable: false });
      },
    });
    closers.push(rollbackFault.close);
  });


  function like(harness: ServiceHarness, from: Caller, to: Caller) {
    return call(harness, 'POST', '/v1/interactions/likes', from.token, { toUserId: to.userId });
  }

  it('reports a domain refusal as a 4xx carrying the domain’s own code', async () => {
    // An unverified stranger asking to like somebody is a refusal, not a fault.
    // It sits here, beside the store faults below, precisely so that nobody can
    // later "simplify" the two into one path.
    const stranger = member('stranger-token');
    callers.push(stranger);
    stranger.userId = (await signUp(healthy, stranger.token, 'taxonomy-stranger')).userId;

    const answer = await like(healthy, stranger, bob);
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(answer.status).toBeLessThan(500);
    const error = answer.body['error'] as Record<string, unknown>;
    expect(typeof error['code']).toBe('string');
    expect(String(error['code'])).not.toMatch(/^store_/);
    expect(error['retryable']).toBe(false);
  });

  it('reports a retryable store fault as a 503 and says it may be retried', async () => {
    const answer = await like(retryableFault, alice, bob);
    expect(answer.status).toBe(503);
    const error = answer.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('store_unavailable');
    expect(error['domain']).toBe('service.store');
    expect(error['retryable']).toBe(true);
    // The driver's message named the statement; the body must not.
    expect(String(error['message'])).not.toContain('connection went away');
  });

  it('reports a store fault the store does not call retryable as a 500', async () => {
    const answer = await like(fatalFault, alice, bob);
    expect(answer.status).toBe(500);
    const error = answer.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('store_failure');
    expect(error['retryable']).toBe(false);
  });

  it('leaves nothing behind when a request fails after it has already written', async () => {
    // Bob likes first, so Alice's like is the one that resolves into a match.
    // Without that, the request would stop at `awaiting_counterpart` and never
    // reach the write the fault is aimed at.
    const first = await like(healthy, bob, alice);
    expect(first.status).toBe(201);
    expect(first.body['resolution']).toBe('awaiting_counterpart');

    // `recordLikeFor` writes the like, upserts the match, then updates each like's
    // state. The fault lands on the last of those, so a request that did not roll
    // back would leave a like with no matching state and a match with no liker.
    const answer = await like(rollbackFault, alice, bob);
    expect(answer.status).toBe(500);

    // Alice's own ledger: Bob's like is legitimately in it, hers is not. Asserting
    // on the rows rather than on a count, because a count alone is also satisfied
    // by a rollback that left two rows and deleted the wrong one.
    const aliceId = alice.userId as UserId;
    const ledger = await healthy.transaction.run((tx) => healthy.stores.interaction.findLikesFor(aliceId, tx));
    expect(ledger.map((row) => row['from'])).toEqual([bob.userId]);

    const matches = await call(healthy, 'GET', '/v1/matches', ALICE);
    expect(matches.status).toBe(200);
    expect(matches.body['matches']).toEqual([]);

    // And the like is genuinely absent rather than merely invisible: the same
    // like, sent again, is created rather than replayed.
    const retry = await like(healthy, alice, bob);
    expect(retry.status).toBe(201);
    expect(retry.body['created']).toBe(true);
  });
});

describe('a route that takes no transaction', () => {
  it('fails loudly when its handler reaches for the store anyway', async () => {
    // The health routes skip the request transaction so they stay answerable while
    // the store is unreachable. A handler on such a route that reaches for the
    // store must get a `StoreError`, not a silent no-op — a write that quietly
    // disappears is worse than one that fails.
    const pool = new pg.Pool({ connectionString: await requireDatabaseReady() });
    const stores = createStores(pool);
    const dependencies: ServiceDependencies = {
      stores,
      transaction: createTransaction(pool),
      actors: resolverFor([]),
      contacts: CONTACTS,
      verification: harnessVerificationProvider(),
      now: () => new Date(),
    };
    const reported: unknown[] = [];
    const probe = publicRoute(
      'GET',
      '/v1/health/passive-probe',
      async (request) => {
        await stores.moderation.appendAudit({ action: 'case.opened' }, request.tx);
        return okResponse(200, { written: true });
      },
      { transactional: false },
    );
    const running = await startService(dependencies, {
      routes: [probe],
      onFailure: { report: (outcome) => reported.push(outcome.error) },
    });
    try {
      const response = await fetch(`${running.url}/v1/health/passive-probe`);
      expect(response.status).toBe(500);
      expect(reported).toHaveLength(1);
      expect(reported[0]).toBeInstanceOf(StoreError);
      expect(String((reported[0] as StoreError).message)).toContain('does not carry a database client');
      // Non-retryable, because retrying a handler that has no client will not
      // conjure one.
      expect((reported[0] as StoreError).retryable).toBe(false);
    } finally {
      await running.close();
      await pool.end();
    }
  });
});