#!/usr/bin/env node
/**
 * The service, started the way `packages/service/test/support/harness.ts`
 * starts it: real Postgres, real stores, real transaction runner, the production
 * session resolver for members, and `serviceRoutes` mounted on `startService`.
 * There is no in-memory double anywhere below. The only thing that differs from
 * the test harness is that this file is a process rather than a `beforeAll`.
 *
 * Two callers:
 *
 *   `make demo`                    — serves the seeded development dataset on
 *                                    127.0.0.1:8787 and prints the URL, for a
 *                                    person driving it by hand.
 *   `scripts/demo/journey.mjs`     — spawns it twice over one throwaway database
 *                                    so the walk can kill the process and read
 *                                    the rows back out of a fresh one.
 *
 * ## The one thing this file adds that production has not
 *
 * A staff bearer-token table. The repository has no staff sign-in — every live
 * session resolves to `role: 'user'` — so a moderation decision cannot be made
 * over HTTP without one. It is the same seam `resolverFor` gives the suites, and
 * it is printed at startup rather than left for a reader to discover. Members are
 * unaffected: an unrecognised token falls through to
 * `createSessionActorResolver`, which reads the session table and applies
 * `validateSession`, so a revoked token is still refused.
 *
 * ## Contract with its caller
 *
 * One `READY {json}` line on stdout once the socket is bound and the schema has
 * answered a query. One `STOPPED {}` line after a signal has drained the server
 * and the pool, then exit 0. Everything else it says is prefixed `[demo]` and is
 * for a person.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, loadDotEnv } from './lib/demo-database.mjs';

const SERVICE_ENTRY = join(REPO_ROOT, 'packages/service/dist/index.js');
if (!existsSync(SERVICE_ENTRY)) {
  process.stderr.write(
    'The packages are not built, so there is no service to run.\n' +
      'Run `make demo` (which builds first) or `npm run build`.\n',
  );
  process.exit(1);
}

loadDotEnv();

const connectionString = process.env['DEMO_DATABASE_URL'] ?? process.env['DATABASE_URL'];
if (connectionString === undefined) {
  process.stderr.write(
    'DATABASE_URL is not set. The demo service runs against real Postgres and will not run ' +
      'against something else. Run `cp .env.example .env` then `make up`.\n',
  );
  process.exit(1);
}

const port = Number(process.env['DEMO_PORT'] ?? '8787');
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  process.stderr.write(`DEMO_PORT must be a port number, received "${process.env['DEMO_PORT']}".\n`);
  process.exit(1);
}

/**
 * The one version string the demo hard-codes. `packages/service` does not export
 * it, and a wrong one produces a 400 that names the current one — which is a
 * perfectly good error message for a newcomer reading the curl below.
 */
const DEMO_TERMS_VERSION = '2026-09-01';

const staff = parseStaff(process.env['DEMO_STAFF_TOKENS']);

const pg = (await import('pg')).default;
const { createStores, createTransaction } = await import('@been-there/database');
const { ok } = await import('@been-there/core');
const {
  createServiceHealth,
  createSessionActorResolver,
  drainServer,
  serviceRoutes,
  startService,
} = await import('@been-there/service');

const pool = new pg.Pool({ connectionString });
const stores = createStores(pool);
const transaction = createTransaction(pool);
const dependencies = {
  stores,
  transaction,
  actors: actorsFor(staff, stores, transaction),
  // Composed here and never sent: there is no relay in this repository, and a
  // demo that quietly posted mail to a sandbox would be an outbound side effect
  // nobody asked for. The message is reported so its existence stays visible.
  contacts: {
    deliver: async (message) => {
      say(
        `contact message to ${message.address}: "${message.subject}" ` +
          `(reference ${message.referenceId}) — composed, not sent: no relay is configured`,
      );
    },
  },
  now: () => new Date(),
};

// Assert the schema before binding the port. A service answering traffic
// against a database it cannot read looks healthy and then fails on the first
// real request, which is the worst moment to find out.
await pool.query('SELECT 1 FROM app.users LIMIT 0');

const running = await startService(dependencies, {
  routes: serviceRoutes(dependencies),
  port,
});
const health = createServiceHealth(dependencies);

say(`Been There is serving at ${running.url}`);
say(`database ${redact(connectionString)}`);
for (const entry of staff) {
  say(`staff bearer token (${entry.role}): ${entry.token}`);
}
say(`liveness:  curl -s ${running.url}/v1/health/live`);
say(`readiness: curl -s ${running.url}/v1/health/ready`);
say('sign up (the token in the response is the bearer for everything else):');
say(`  curl -s -X POST -H 'content-type: application/json' \\`);
say(
  `    ${running.url}/v1/accounts \\\n` +
    `    -d '{"contact":"you@example.test","password":"correct-horse-battery-staple-42",` +
    `"dateOfBirth":"1990-06-15","termsVersion":"${DEMO_TERMS_VERSION}"}'`,
);
say('stop with: make demo-stop');
emit('READY', { url: running.url, pid: process.pid, port: Number(new URL(running.url).port) });

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (stopping) {
      return;
    }
    stopping = true;
    void health
      .stop([
        { name: 'http', close: () => drainServer(running.server, 2000) },
        { name: 'pool', close: async () => pool.end() },
      ])
      .then(
        () => {
          emit('STOPPED', { url: running.url, pid: process.pid });
          process.exit(0);
        },
        (error) => {
          process.stderr.write(`draining failed: ${String(error)}\n`);
          process.exit(1);
        },
      );
  });
}

/**
 * @param {string | undefined} raw
 * @returns {readonly { token: string, role: string, automated: boolean }[]}
 */
function parseStaff(raw) {
  if (raw === undefined || raw === '') {
    return [{ token: 'demo-senior-moderator', role: 'senior_moderator', automated: false }];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`DEMO_STAFF_TOKENS is not JSON: ${String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('DEMO_STAFF_TOKENS must be a JSON array of { token, role, automated }.');
  }
  return parsed;
}

/**
 * Static staff first, then the production session resolver. The order matters:
 * it is what makes "an unrecognised token is refused" an honest statement about
 * sessions rather than about a table of three names.
 */
function actorsFor(staffEntries, storesForActors, transactionForActors) {
  const table = new Map(staffEntries.map((entry) => [entry.token, entry]));
  const live = createSessionActorResolver({
    stores: storesForActors,
    transaction: transactionForActors,
    now: () => new Date(),
  });
  return {
    async resolve(authorization) {
      const token =
        authorization?.startsWith('Bearer ') === true ? authorization.slice(7) : undefined;
      const caller = token === undefined ? undefined : table.get(token);
      if (caller !== undefined) {
        return ok({
          userId: null,
          role: caller.role,
          principal: { userId: null, role: caller.role },
          automated: caller.automated === true,
          actorId: caller.token,
        });
      }
      return live.resolve(authorization);
    },
  };
}

function say(text) {
  process.stdout.write(`[demo] ${text}\n`);
}

function emit(kind, payload) {
  process.stdout.write(`${kind} ${JSON.stringify(payload)}\n`);
}

function redact(connectionStringToRedact) {
  try {
    const url = new URL(connectionStringToRedact);
    const credentials = url.password === '' ? '' : `:***`;
    return `${url.protocol}//${url.username}${credentials}@${url.host}${url.pathname}`;
  } catch {
    return '(unparseable connection string)';
  }
}