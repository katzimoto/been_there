import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createStores, createTransaction } from '@been-there/database';
import { type DomainError, type Result, domainError } from '@been-there/core';
import {
  type ActorResolver,
  type RequestActor,
  type RunningService,
  type ServiceDependencies,
  createServiceHealth,
  healthRoutes,
  readinessRoutes,
  startService,
} from '@been-there/service';
import { requireDatabase } from './support/harness.js';

/**
 * Readiness and liveness, over HTTP, against a real Postgres — and against a
 * Postgres that is not there.
 *
 * The two probes answer different questions and the whole issue rests on them
 * staying different:
 *
 *  - **readiness** may say no, and says no when the transactional store cannot be
 *    reached, because a process that cannot commit should not be sent traffic;
 *  - **liveness** must never depend on the store, because a restart cannot fix a
 *    database, and a fleet that restarts on one turns a degradation into an
 *    outage.
 *
 * So the assertions that matter are the ones needing a broken database. A suite
 * that only ever ran against a healthy one would pass with the two endpoints
 * implemented as the same function.
 */

/** A pool pointed at a port nothing is listening on. */
const UNREACHABLE = 'postgres://been_there:been_there_local_only@127.0.0.1:1/been_there';

const REFUSES_EVERY_SESSION: ActorResolver = {
  async resolve(): Promise<Result<RequestActor, DomainError>> {
    return domainError('permission_denied', 'service.http', 'this request carries no recognised session', {
      reason: 'unauthenticated',
    });
  },
};

/** The relay seam, which this suite never exercises. */
const CONTACTS = { deliver: async (): Promise<void> => undefined };

function serviceOver(connectionString: string): {
  readonly dependencies: ServiceDependencies;
  readonly close: () => Promise<void>;
} {
  const pool = new pg.Pool({ connectionString });
  const dependencies: ServiceDependencies = {
    stores: createStores(pool),
    transaction: createTransaction(pool),
    actors: REFUSES_EVERY_SESSION,
    contacts: CONTACTS,
    now: () => new Date(),
  };
  return { dependencies, close: async () => pool.end() };
}

async function fetchJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(url);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('readiness and liveness, over real HTTP', () => {
  let reachable: ServiceDependencies;
  let unreachable: ServiceDependencies;
  let closeReachable: () => Promise<void>;
  let closeUnreachable: () => Promise<void>;
  let reachableService: RunningService | undefined;
  let unreachableService: RunningService | undefined;

  beforeAll(async () => {
    const healthy = serviceOver(requireDatabase());
    const broken = serviceOver(UNREACHABLE);
    reachable = healthy.dependencies;
    unreachable = broken.dependencies;
    closeReachable = healthy.close;
    closeUnreachable = broken.close;
    reachableService = await startService(reachable, {
      routes: [...readinessRoutes(reachable), ...healthRoutes(reachable)],
    });
    unreachableService = await startService(unreachable, {
      routes: [...readinessRoutes(unreachable), ...healthRoutes(unreachable)],
    });
  });

  afterAll(async () => {
    await reachableService?.close();
    await unreachableService?.close();
    await closeReachable?.();
    await closeUnreachable?.();
  });

  it('is ready when the transactional store answers', async () => {
    const answer = await fetchJson(`${reachableService?.url}/v1/health/ready`);
    expect(answer.status).toBe(200);
    expect(answer.body['ready']).toBe(true);
    const checks = answer.body['checks'] as readonly { name: string; ok: boolean }[];
    expect(checks.map((check) => check.name)).toEqual(['database']);
    expect(checks[0]?.ok).toBe(true);
  });

  it('is not ready when the store cannot be reached, and says which check failed', async () => {
    const answer = await fetchJson(`${unreachableService?.url}/v1/health/ready`);
    expect(answer.status).toBe(503);
    expect(answer.body['ready']).toBe(false);
    const checks = answer.body['checks'] as readonly { name: string; ok: boolean; detail: string }[];
    expect(checks.map((check) => check.name)).toEqual(['database']);
    expect(checks[0]?.ok).toBe(false);
    // The detail is prose a human reads at 3am. It must not carry the driver's
    // message, which for a connection failure names the host and the port.
    expect(checks[0]?.detail).toContain('unreachable');
    expect(JSON.stringify(answer.body)).not.toContain('127.0.0.1');
  });

  it('stays live when the store cannot be reached, because a restart cannot fix a database', async () => {
    const answer = await fetchJson(`${unreachableService?.url}/v1/health/live`);
    expect(answer.status).toBe(200);
    expect(answer.body['status']).toBe('live');
  });

  it('answers live and not-ready from one process on one dead pool', async () => {
    // The same process, the same connections, at the same moment: one says live
    // and one says not ready. If either had consulted the store for the wrong
    // reason — or if liveness had been derived from readiness — these would agree.
    const [live, ready] = await Promise.all([
      fetchJson(`${unreachableService?.url}/v1/health/live`),
      fetchJson(`${unreachableService?.url}/v1/health/ready`),
    ]);
    expect(live.status).toBe(200);
    expect(ready.status).toBe(503);
  });

  it('stops being ready the instant it starts draining, before anything is released', async () => {
    const health = createServiceHealth(reachable);
    let phaseWhenTheFirstStepRan = '';
    await health.stop([
      {
        name: 'first released resource',
        close: async () => {
          phaseWhenTheFirstStepRan = createServiceHealth(reachable).lifecycle.phase;
        },
      },
    ]);
    expect(phaseWhenTheFirstStepRan).toBe('draining');

    const answer = await fetchJson(`${reachableService?.url}/v1/health/ready`);
    expect(answer.status).toBe(503);
    expect(answer.body['ready']).toBe(false);
    const checks = answer.body['checks'] as readonly { name: string; detail: string }[];
    expect(checks[0]?.name).toBe('lifecycle');
    expect(checks[0]?.detail).toContain('stopped');

    // Still answering, because the process is still running: a drained service is
    // out of rotation, not dead.
    const live = await fetchJson(`${reachableService?.url}/v1/health/live`);
    expect(live.status).toBe(200);
    expect(live.body['phase']).toBe('stopped');
  });
});