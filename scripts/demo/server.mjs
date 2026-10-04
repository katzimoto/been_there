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

/**
 * The demo moderator, as a real identity.
 *
 * `DEMO_STAFF_TOKENS` used to be a JSON array of `{token, role, automated}`
 * compared inside an `ActorResolver` wrapper in this file, with `actorId` set to
 * the token string. That made a shared secret the acting identity of every
 * decision the walk took, and it let `role` and `automated` be set by
 * configuration — so the walk could "prove" the automation refusal by declaring
 * an actor automated.
 *
 * Now the walk signs in over `POST /v1/staff-sessions` like any other client, and
 * the service derives the role from the identity row. `DEMO_STAFF_CONTACT` /
 * `DEMO_STAFF_PASSWORD` exist so the journey can sign in deterministically; they
 * are a local demo credential, hashed on the way in.
 */
const STAFF_CONTACT = process.env['DEMO_STAFF_CONTACT'] ?? 'moderator@demo.localhost';
const STAFF_PASSWORD = process.env['DEMO_STAFF_PASSWORD'] ?? 'demo-staff-local-only';
const STAFF_DISPLAY_NAME = process.env['DEMO_STAFF_NAME'] ?? 'Demo Moderator';

const pg = (await import('pg')).default;
const { createStores, createTransaction } = await import('@been-there/database');
const { ok } = await import('@been-there/core');
const { stubProvider } = await import('@been-there/identity');
const { hashPassword } = await import('@been-there/platform');
const { randomUUID } = await import('node:crypto');
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
  // The production resolver, unmodified. A moderator is a session, so this file
  // no longer wraps it in a token comparison — that wrapper was a second
  // authentication path, and the one the demo was actually exercising.
  actors: createSessionActorResolver({ stores, transaction, now: () => new Date() }),
  // The verification provider, constructed explicitly rather than defaulted.
  //
  // There is no vendor in this repository and no decision has been taken to buy
  // one, so the score is asserted. Naming it here is the point: `verification` is
  // a required dependency, so a composition root that forgot it fails to
  // construct rather than quietly serving a route that reads a score off the
  // wire.
  //
  // `mode: 'stub'` is reported at `/v1/health/ready`, and every provider
  // reference this writes is prefixed `stub-session-`, so a row created by this
  // process stays identifiable without asking the process that made it.
  verification: stubProvider({
    confidence: 0.95,
    referenceSuffix: 'demo',
    sessionTtlMs: 30 * 60 * 1000,
  }),
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
  // The trusted-hop seam: this deployment is a service behind a reverse proxy,
  // so the caller's address arrives in `X-Forwarded-For` and the socket's own
  // address is the proxy's. Installed rather than omitted, and read per request
  // rather than captured once.
  //
  // The reason is concrete, not tidiness. `SIGNUP_PER_IP_PER_HOUR` is 5
  // (`packages/service/src/accounts/rate-limit.ts`), and without this seam every
  // request in the demo arrives over one loopback socket and so shares one
  // bucket. The acceptance walk creates four accounts, which would leave it four
  // of five with nothing spare — and a fifth sign-up anywhere in it would fail
  // the demo for a reason that has nothing to do with what the walk shows.
  // `packages/service/test/support/harness.ts` solves the same problem by
  // exposing `fromAddress()` and rotating; this is the production spelling of
  // that seam, and the walk presents addresses the way a proxy would.
  //
  // **It must not be removed, and the limit must not be raised to make the
  // walk pass.** Raising `SIGNUP_PER_IP_PER_HOUR` would delete the very limit
  // the demo exists to show. `scripts/demo/lib/preflight.mjs` asserts both
  // halves — the sixth sign-up from one address is refused, a sign-up from a
  // second address is admitted — so removing this seam or raising the limit
  // turns the walk red rather than quietly weakening it.
  peerAddressFrom: (message) => firstForwardedFor(message.headers['x-forwarded-for']),
});
const health = createServiceHealth(dependencies);

say(`Been There is serving at ${running.url}`);
say(`database ${redact(connectionString)}`);
// Signed in over HTTP so the token is one the service minted. A token built in
// this file would be a second issuance path, and this file used to have three.
const staffSession = await provisionStaff(stores, transaction, running.url);
say(
  `moderator signed in: ${staffSession.displayName} (${staffSession.role}), ` +
    `staff id ${staffSession.staffId}`,
);
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
/**
 * Provisions the demo moderator and signs them in, returning `{ token, staffId }`.
 *
 * The sign-in goes over HTTP rather than being assembled here, so the token is one
 * the service minted and would accept. Building a session directly in this file
 * would be a second issuance path — the thing this file no longer has.
 *
 * @param {import('@been-there/contracts').Stores} storesForStaff
 * @param {import('@been-there/contracts').Transaction} transactionForStaff
 * @param {string} baseUrl
 */
async function provisionStaff(storesForStaff, transactionForStaff, baseUrl) {
  const now = new Date();
  // Hashed before the transaction rather than inside it: scrypt is deliberately
  // slow, and holding a transaction open across it would pin a connection for
  // every demo boot.
  const passwordHash = await hashPassword(STAFF_PASSWORD);
  const row = {
    staffId: randomUUID(),
    contactKind: 'email',
    contactIdentifier: STAFF_CONTACT,
    passwordHash,
    displayName: STAFF_DISPLAY_NAME,
    role: 'senior_moderator',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  // Insert once, reuse afterwards. This used to insert unconditionally, and
  // `staff_identities_by_contact` is unique — so the *second* `make demo` against
  // the same database died with a constraint violation, after the HTTP server had
  // already bound its port. The shape of that failure was the worst part: the
  // port answered for a moment and then connection-refused, which reads as a
  // client problem rather than a duplicate moderator.
  //
  // Reuse rather than update: the password hash is the same constant either way,
  // and a moderator whose stored hash predates a change to `STAFF_PASSWORD`
  // should fail the sign-in below loudly rather than have its credential
  // silently rewritten by a demo boot. A deactivated moderator is reactivated,
  // because that is the state a demo cannot work around.
  const existing = await transactionForStaff.run((tx) =>
    storesForStaff.staff.findStaffByContact(STAFF_CONTACT, tx),
  );
  if (existing === null) {
    await transactionForStaff.run((tx) => storesForStaff.staff.insertStaff(row, tx));
  } else if (existing.status !== 'active') {
    await transactionForStaff.run((tx) =>
      storesForStaff.staff.updateStaffStatus(existing.staffId, 'active', now, tx),
    );
  }
  const response = await fetch(`${baseUrl}/v1/staff-sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ contact: STAFF_CONTACT, password: STAFF_PASSWORD }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`demo staff sign-in failed: ${response.status} ${JSON.stringify(body)}`);
  }
  // `token` is included because the walk drives the service the way a client
  // does, and a client signs in to get one. It is a local demo credential minted
  // seconds earlier against a database this process created and will drop.
  emit('staff', {
    staffId: body.staffId,
    role: body.role,
    displayName: body.displayName,
    token: body.token,
  });
  return body;
}

function say(text) {
  process.stdout.write(`[demo] ${text}\n`);
}

/**
 * The caller's address, from the first entry of `X-Forwarded-For`.
 *
 * The first entry is the only one a trusted hop may believe: every proxy in the
 * chain appends, so the leftmost is the one the hop that actually received the
 * connection wrote. A header a client can set is not a rate-limit key, which is
 * why this exists only where the hop in front is trusted — the condition
 * `ServerOptions.peerAddressFrom` documents.
 *
 * `null` rather than a guess when the header is absent or unparseable, so the
 * service falls back to the socket address instead of inventing one.
 */
function firstForwardedFor(header) {
  if (typeof header !== 'string') {
    return null;
  }
  const first = header.split(',')[0].trim();
  return /^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?$/.test(first) ? first : null;
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