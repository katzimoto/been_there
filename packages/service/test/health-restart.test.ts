import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type ChildProcess, spawn } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createStores, createTransaction } from '@been-there/database';
import type { Stores, Transaction } from '@been-there/contracts';
import { type UserId, castId } from '@been-there/core';
import {
  type ServiceDependencies,
  createServiceHealth,
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
import { COMPLETE_PROFILE, PASSING_RESULT, verify } from './support/fixtures.js';
import { reclaimPrepared } from './support/reclaim.js';
import { harnessVerificationProvider } from './support/provider.js';

/**
 * What survives a restart, and what does not — proved by actually restarting.
 *
 * ADR 0001 commits to a local transaction rather than a saga, and the claim it
 * makes is specific: a like, the match it becomes and the conversation that
 * opens commit together or not at all. That claim had never been tested through
 * a process boundary, and it is the claim the whole monolith decision rests on,
 * so this suite tests it the only way that means anything — by killing a real
 * process with `SIGKILL` and starting another one to read the database.
 *
 * Each child is a separate Node process running the real composition: real pool,
 * real stores, real `serviceRoutes`, real HTTP. Nothing is stubbed except the
 * session resolver, which is given the ids the parent already minted because a
 * restart test is not a session test.
 *
 * The three properties, deliberately separate:
 *
 *  1. committed work survives a hard kill — the write was acknowledged, so it
 *     must be there for a process that never saw the one that wrote it;
 *  2. work left uncommitted does not — a transaction open when the process dies
 *     must leave no row, or a killed pod resurrects a like nobody made;
 *  3. a fresh process reports ready and shuts down in order — the readiness
 *     surface `make check` gates on is exercised by starting a process, not by
 *     calling a function.
 */

const ALICE = 'alice-token';
const BOB = 'bob-token';
const CAROL = 'carol-token';
const DAVE = 'dave-token';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

/**
 * The child program.
 *
 * Written to a temporary file at run time rather than committed, because it is a
 * fixture and not a second entry point: nothing in the repository should be able
 * to depend on it. Everything it imports is the built package, which is the same
 * code the suites and the running service load.
 *
 * Its module specifiers arrive in the config at runtime, so `import()` is the
 * only option: the point of the fixture is to load the *built* packages by
 * resolved path in a fresh process, which a static import cannot express.
 * to depend on it. Everything it imports is the built package, which is the same
 * code the suites and the running service load.
 */
const CHILD_PROGRAM = `
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const pg = (await import(pathToFileURL(config.pgModule).href)).default;
const database = await import(pathToFileURL(config.databaseModule).href);
const service = await import(pathToFileURL(config.serviceModule).href);
const identity = await import(pathToFileURL(config.identityModule).href);

const say = (kind, payload) => process.stdout.write(kind + ' ' + JSON.stringify(payload) + '\\n');

const pool = new pg.Pool({ connectionString: config.connectionString });
const dependencies = {
  stores: database.createStores(pool),
  transaction: database.createTransaction(pool),
  actors: {
    async resolve(authorization) {
      const token = authorization && authorization.startsWith('Bearer ') ? authorization.slice(7) : undefined;
      const caller = config.callers.find((entry) => entry.token === token);
      if (caller === undefined) {
        return {
          ok: false,
          error: { code: 'permission_denied', domain: 'service.child', message: 'no session', retryable: false },
        };
      }
      return {
        ok: true,
        value: {
          userId: caller.userId,
          role: 'user',
          principal: { userId: caller.userId, role: 'user' },
          automated: false,
          actorId: caller.userId,
        },
      };
    },
  },
  contacts: { deliver: async () => undefined },
  // The child is a separate OS process and cannot reach this suite's test
  // helpers, so it builds the *production* stub from the built package. That is
  // the point of the restart test: step two must serve through the same adapter
  // step one did, not through a fixture that merely agrees with it. The dynamic
  // import is the file's established convention, not an oversight — see the
  // module docstring above: every specifier here arrives resolved at runtime.
  verification: identity.stubProvider(),
  now: () => new Date(),
};

const running = await service.startService(dependencies, { routes: service.serviceRoutes(dependencies) });
const health = service.createServiceHealth(dependencies);
say('READY', { url: running.url, phase: health.lifecycle.phase });

for (const step of config.steps) {
  if (step.kind === 'request') {
    const response = await fetch(running.url + step.path, {
      method: step.method,
      headers: {
        authorization: 'Bearer ' + step.token,
        ...(step.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(step.body === undefined ? {} : { body: JSON.stringify(step.body) }),
    });
    const text = await response.text();
    say('RESULT', { name: step.name, status: response.status, body: text.length === 0 ? {} : JSON.parse(text) });
  } else if (step.kind === 'conversation') {
    const found = await dependencies.transaction.run((tx) =>
      dependencies.stores.conversations.findByMatch(step.matchId, step.userId, tx),
    );
    say('RESULT', { name: step.name, conversationId: found === null ? null : found.conversationId });
  } else if (step.kind === 'openTransaction') {
    // A transaction the service's own request pipeline would have opened, writing
    // the same rows a like writes, and then never committing. The process is
    // about to be killed. What the database does with this is the whole test.
    void dependencies.transaction.run(async (tx) => {
      await dependencies.stores.interaction.appendLike(
        { likeId: step.likeId, from: step.from, to: step.to, createdAt: new Date(), state: 'live', supersededPassId: null },
        tx,
      );
      say('OPEN', { name: step.name });
      await new Promise(() => {});
    });
  }
}

process.on('SIGTERM', () => {
  void health
    .stop([
      { name: 'http', close: () => service.drainServer(running.server, 2000) },
      { name: 'pool', close: async () => pool.end() },
    ])
    .then(
      () => {
        say('STOPPED', {});
        process.exit(0);
      },
      () => process.exit(1),
    );
});
`;

interface ChildResult {
  readonly name: string;
  readonly status?: number;
  readonly body?: Record<string, unknown>;
  readonly conversationId?: string | null;
}

interface ChildStep {
  readonly kind: 'request' | 'conversation' | 'openTransaction';
  readonly name: string;
  readonly method?: string;
  readonly path?: string;
  readonly token?: string;
  readonly body?: unknown;
  readonly matchId?: string;
  readonly userId?: string;
  readonly likeId?: string;
  readonly from?: string;
  readonly to?: string;
}

interface RunningChild {
  readonly process: ChildProcess;
  readonly url: string;
  expect(kind: 'READY' | 'RESULT' | 'OPEN' | 'STOPPED', name?: string): Promise<ChildResult>;
  signal(signal: NodeJS.Signals): void;
  exited(): Promise<number | null>;
}

const workspace = mkdtempSync(join(tmpdir(), 'been-there-restart-'));
const programPath = join(workspace, 'service-child.mjs');
writeFileSync(programPath, CHILD_PROGRAM);

function modulePath(request: string): string {
  return createRequire(import.meta.url).resolve(request);
}

/**
 * One child process, with its output read as a line stream.
 *
 * A waiter is resolved by a line rather than by a poll, so a test never waits
 * longer than the process takes and never observes a half-written line.
 */
async function startChild(steps: readonly ChildStep[], callers: readonly { token: string; userId: string }[]): Promise<RunningChild> {
  const configPath = join(workspace, `config-${randomUUID()}.json`);
  writeFileSync(
    configPath,
    JSON.stringify({
      connectionString: await requireDatabaseReady(),
      pgModule: modulePath('pg'),
      databaseModule: modulePath('@been-there/database'),
      serviceModule: modulePath('@been-there/service'),
      identityModule: modulePath('@been-there/identity'),
      callers,
      steps,
    }),
  );
  const child = spawn(process.execPath, [programPath, configPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', (chunk: Buffer) => process.stderr.write(`[child] ${chunk.toString()}`));

  const waiters: { kind: string; name?: string; resolve: (result: ChildResult) => void }[] = [];
  let readyUrl = '';
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const kind = line.slice(0, line.indexOf(' '));
      const payload = JSON.parse(line.slice(line.indexOf(' ') + 1)) as ChildResult & { url?: string };
      if (kind === 'READY') {
        readyUrl = payload.url ?? '';
      }
      const at = waiters.findIndex(
        (waiter) => waiter.kind === kind && (waiter.name === undefined || waiter.name === payload.name),
      );
      if (at >= 0) {
        waiters.splice(at, 1)[0]?.resolve(payload);
      }
      newline = buffer.indexOf('\n');
    }
  });

  return {
    process: child,
    get url() {
      return readyUrl;
    },
    expect(kind, name) {
      const { promise, resolve } = Promise.withResolvers<ChildResult>();
      waiters.push({ kind, ...(name === undefined ? {} : { name }), resolve });
      return promise;
    },
    signal(signal) {
      child.kill(signal);
    },
    exited() {
      const { promise, resolve } = Promise.withResolvers<number | null>();
      child.once('exit', (code) => resolve(code));
      return promise;
    },
  };
}

interface ServiceHarness extends Harness {
  readonly pool: pg.Pool;
  readonly stores: Stores;
  readonly transaction: Transaction;
  readonly dependencies: ServiceDependencies;
}

const CONTACTS = { deliver: async (): Promise<void> => undefined };

describe('committed work across a process restart', () => {
  const alice = member(ALICE);
  const bob = member(BOB);
  const carol = member(CAROL);
  const dave = member(DAVE);
  const callers: Caller[] = [alice, bob, carol, dave];
  let harness: ServiceHarness;
  let aliceId = '';
  let bobId = '';

  beforeAll(async () => {
    const pool = new pg.Pool({ connectionString: await requireDatabaseReady() });
    const stores = createStores(pool);
    const transaction = createTransaction(pool);
    // One provider, wired into the service and handed back on the harness, so a
    // suite moves the score the service actually reads rather than a copy.
    const provider = harnessVerificationProvider();
    // The cell the resolver reads per request, so `reloadCallers` is a real swap
    // rather than a method the type requires and the suite never needs.
    const cell: { current: readonly Caller[] } = { current: callers };
    const dependencies: ServiceDependencies = {
      stores,
      transaction,
      actors: resolverFor(callers, undefined, undefined, cell),
      contacts: CONTACTS,
      verification: provider,
      now: () => new Date(),
    };
    const running = await startService(dependencies, { routes: serviceRoutes(dependencies) });
    harness = {
      url: running.url,
      messages: [],
      pool,
      stores,
      transaction,
      dependencies,
      verification: provider,
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

    for (const [token, label] of [
      [ALICE, 'restart-alice'],
      [BOB, 'restart-bob'],
      [CAROL, 'restart-carol'],
      [DAVE, 'restart-dave'],
    ] as const) {
      const created = await call(harness, 'POST', '/v1/accounts', token, {
        contact: `${label}-${randomUUID()}@example.test`,
        password: 'correct-horse-battery-staple',
        dateOfBirth: '1994-04-01',
        termsVersion: '2026-09-01',
      });
      expect(created.status).toBe(201);
      const caller = callers.find((entry) => entry.token === token);
      caller?.userId && (caller.userId = caller.userId);
      const userId = castId<'UserId'>(String(created.body['userId']));
      if (caller !== undefined) {
        caller.userId = userId;
      }
      if (token === ALICE) {
        aliceId = userId;
      }
      if (token === BOB) {
        bobId = userId;
      }
      const profile = await call(harness, 'PUT', `/v1/accounts/${userId}/profile`, token, {
        ...COMPLETE_PROFILE,
        displayName: label,
      });
      expect(profile.status).toBe(200);
      if (token === ALICE || token === BOB) {
        await verify(harness, token, userId, PASSING_RESULT);
      }
    }
  });

  afterAll(async () => {
    await harness?.close();
    // This suite assembles its own service and its close covers only the
    // listener and the pool it made for itself, so nothing outside this file
    // drops the per-suite database it prepared. Reached whether or not setup
    // completed.
    //
    // The child processes below run against this same database, so this line
    // depends on them having exited — they have, because `afterAll` runs after
    // every test in the file and each waits on its child. What makes it safe
    // anyway is the pid in the database name: `reclaimPrepared` drops only the
    // names this process claimed, so it cannot reach a sibling process's
    // database even while that one is still migrating. **If the names ever stop
    // carrying the pid, or reclaim widens to names it did not create, this line
    // becomes unsafe and the assumption has to be re-established before it
    // moves.** The alternative is a certain leak on every passing run, which is
    // the worse of the two.
    reclaimPrepared();
  });

  function childCallers(): { token: string; userId: string }[] {
    return callers.map((caller) => ({ token: caller.token, userId: String(caller.userId) }));
  }

  it('keeps a like, the match it became and the conversation it opened, across a hard kill', async () => {
    // Process one: the first half of the match, acknowledged and then killed
    // without a chance to release anything.
    const first = await startChild(
      [{ kind: 'request', name: 'like', method: 'POST', path: '/v1/interactions/likes', token: ALICE, body: { toUserId: bobId } }],
      childCallers(),
    );
    const firstResult = await first.expect('RESULT', 'like');
    expect(firstResult.status).toBe(201);
    expect(firstResult.body?.['resolution']).toBe('awaiting_counterpart');
    first.signal('SIGKILL');
    await first.exited();

    // Process two: the reciprocal like, which resolves into a match and opens a
    // conversation — all inside one request's transaction. Acknowledged, then
    // killed the same way.
    const second = await startChild(
      [{ kind: 'request', name: 'like', method: 'POST', path: '/v1/interactions/likes', token: BOB, body: { toUserId: aliceId } }],
      childCallers(),
    );
    const secondResult = await second.expect('RESULT', 'like');
    expect(secondResult.status).toBe(201);
    expect(secondResult.body?.['resolution']).toBe('match_created');
    const matchId = String(secondResult.body?.['match']);
    const conversationId = String(secondResult.body?.['conversationId']);
    second.signal('SIGKILL');
    await second.exited();

    // Process three: never saw either of the writes. It reads the match over
    // HTTP and the conversation through the store, so the assertion is about
    // what survived rather than about what a response body claimed.
    const third = await startChild(
      [
        { kind: 'request', name: 'matches', method: 'GET', path: '/v1/matches', token: ALICE },
        { kind: 'conversation', name: 'conversation', matchId, userId: aliceId },
      ],
      childCallers(),
    );
    const matches = await third.expect('RESULT', 'matches');
    expect(matches.status).toBe(200);
    expect(JSON.stringify(matches.body)).toContain(matchId);
    const conversation = await third.expect('RESULT', 'conversation');
    expect(conversation.conversationId).toBe(conversationId);

    const ledger = await harness.transaction.run((tx) => harness.stores.interaction.findLikesFor(aliceId as UserId, tx));
    expect(ledger).toHaveLength(2);
    expect(ledger.every((row) => row['state'] === 'matched')).toBe(true);

    third.signal('SIGKILL');
    await third.exited();
  }, 60_000);

  it('leaves nothing behind when the process dies with a transaction still open', async () => {
    const carolId = String(callers.find((caller) => caller.token === CAROL)?.userId);
    const daveId = String(callers.find((caller) => caller.token === DAVE)?.userId);
    const likeId = randomUUID();

    const child = await startChild([{ kind: 'openTransaction', name: 'uncommitted', likeId, from: carolId, to: daveId }], childCallers());
    await child.expect('OPEN', 'uncommitted');
    // The row is written inside the transaction and has never been committed.
    child.signal('SIGKILL');
    await child.exited();

    const ledger = await harness.transaction.run((tx) => harness.stores.interaction.findLikesFor(carolId as UserId, tx));
    expect(ledger).toHaveLength(0);
    const matches = await harness.transaction.run((tx) =>
      harness.stores.interaction.findMatchesFor(daveId as UserId, { limit: 50, offset: 0 }, tx),
    );
    expect(matches.total).toBe(0);
  }, 60_000);

  it('reports ready on a fresh start and drains in order when told to stop', async () => {
    const child = await startChild(
      [{ kind: 'request', name: 'ready', method: 'GET', path: '/v1/health/ready', token: ALICE }],
      childCallers(),
    );
    await child.expect('READY');
    // The process bound a port and reported itself serving, which is the whole of
    // what `make check` needs to be able to gate on.
    expect(child.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const answer = await child.expect('RESULT', 'ready');
    expect(answer.status).toBe(200);
    expect(answer.body?.['ready']).toBe(true);

    const stopped = child.exited();
    child.signal('SIGTERM');
    await child.expect('STOPPED');
    expect(await stopped).toBe(0);
  }, 60_000);
});