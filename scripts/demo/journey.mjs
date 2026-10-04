#!/usr/bin/env node
/**
 * The acceptance walk, driven over HTTP against real Postgres.
 *
 *   npm run demo:journey
 *
 * ## What makes this a demonstration rather than a test
 *
 * It starts the service the way `packages/service/test/support/harness.ts`
 * starts it — `scripts/demo/server.mjs` is that same wiring in a process rather
 * than a `beforeAll` — and then it does the one thing a suite inside that
 * harness cannot: it kills that process and starts a second one, and reads every
 * row back through the new one. Step 11 is a different OS process with no memory
 * of the first, which is the only version of "state is durable" that means
 * anything. Reopening a connection pool would have proved that `pg` works.
 *
 * The service is a child process rather than an in-process import for the same
 * reason: restarting an in-process service would be restarting the walk.
 *
 * ## Why it owns its database
 *
 * The walk creates a database, migrates it, and drops it, so `npm run
 * demo:journey` is repeatable, never touches the seeded development data, and
 * leaves nothing behind. `make demo` serves the seeded dataset instead; the two
 * are independent and neither requires the other.
 *
 * ## Exit status
 *
 * Zero only when all eleven steps completed. Any other outcome prints which step
 * failed and what it expected, and exits 1. A walk that cannot fail is a
 * brochure.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { exit } from 'node:process';
import { REPO_ROOT, demoDatabase, loadDotEnv } from './lib/demo-database.mjs';
import { createClient } from './lib/client.mjs';
import { exitWithFailure, narrator } from './lib/narrative.mjs';
import { STEP_COUNT, STEPS } from './lib/steps.mjs';
import { checkRateLimitBudget } from './lib/preflight.mjs';

const SERVER = join(REPO_ROOT, 'scripts/demo/server.mjs');
const BOOT_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;

/**
 * The moderator: a named human with decision authority, and the only staff token
 * this walk uses. The repository has no staff sign-in, so `scripts/demo/server.mjs`
 * is handed this token as a static caller — the same seam the test harness uses,
 * and the same seam production does not have yet.
 */
const MODERATOR = { token: 'journey-senior-moderator', moderatorId: 'senior_moderator' };

// Everything the signal handlers and the teardown need is declared before the
// first `await`, because the handlers are registered below and before it. The
// unprotected window is the time Node spends loading this module graph, and
// loading `pg` and the built packages is most of it — a signal that arrives
// during that window kills the process outright, and a database created half a
// second earlier outlives it.

/** The walk's own database, once the module graph is loaded. */
let database;

/**
 * The `CREATE DATABASE`, held while it is in flight.
 *
 * Without this the teardown can drop a database that has not finished being
 * created: the DROP runs first, matches nothing, and the CREATE commits
 * afterwards into a process that is on its way out. It reproduces only on a
 * cold start, where `CREATE DATABASE` is slow enough for a signal to land
 * inside it, which is why it looks like an intermittent leak and is not one.
 */
let creating = undefined;

/** Drops the database once any `CREATE DATABASE` in flight has settled. */
async function dropDatabase() {
  if (database === undefined) {
    return;
  }
  if (creating !== undefined) {
    try {
      await creating;
    } catch {
      // A create that failed has nothing to drop.
    }
  }
  await database.drop();
}

/** The process currently serving, so step 11's restart has something to kill. */
let running = undefined;

/**
 * Every service process started and not yet seen exit, with its exit promise.
 *
 * A registry rather than `running` alone, because teardown and the step-11
 * restart race: an interrupt arriving mid-restart finds `running` still
 * pointing at the process being replaced, so killing only that one leaves the
 * replacement — and the database — behind.
 */
const spawned = new Map();

/** Set by the teardown. Nothing starts a service once it is true. */
let stopping = false;

/**
 * The teardown, once.
 *
 * Memoised because it is reachable from three places that can all be live at
 * the same moment — a signal, a step that threw, and the success path — and two
 * of them running concurrently is how this leaked: the second caller returned
 * immediately on the already-set `dropped` flag and exited the process while
 * the first was still waiting for a service to shut down. The database outlived
 * the script that created it, which is the exact failure
 * `scripts/dev/check-no-leaked-databases.mjs` exists to catch.
 */
let teardownOnce;

/** @returns {Promise<void>} the one teardown, whatever asked for it. */
function teardown() {
  teardownOnce ??= performTeardown();
  return teardownOnce;
}

async function performTeardown() {
  stopping = true;
  running = undefined;
  for (const child of spawned.keys()) {
    child.kill('SIGTERM');
  }
  for (const exited of spawned.values()) {
    try {
      await withDeadline(exited, STOP_TIMEOUT_MS, 'the service did not stop');
    } catch {
      // Being killed on the way out anyway. A failure to reap a service is not
      // the walk's failure and must not mask the step that did fail.
    }
  }
  spawned.clear();
  await dropDatabase();
}

function refuseIfStopping(what) {
  if (stopping) {
    throw new Error(`${what}, and the walk was interrupted; nothing more was started`);
  }
}

// A walk that is interrupted — Ctrl-C, a killed pipeline — must not leave a
// database behind. The suites solve this in an exit hook; this is the script
// equivalent, registered as early as the module graph allows. 130 is the
// shell's code for "interrupted", so a caller piping this can tell the two
// apart, and a cleanup that did not finish says so and names the database
// rather than exiting with a code that looks identical either way.
//
// A closed stdout is a killed pipeline too, and a less obvious one: piping the
// walk into `head` or `less` closes the pipe, the next write raises EPIPE, and
// Node terminates the process without unwinding anything. That leaves a service
// process running and its database behind — which is what an orphan with ppid 1
// and a `t_journey_*` database is. Handled here for the same reason the signals
// are: the walk's resources do not belong to whoever reads its output.
process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE' || teardownOnce !== undefined) {
    return;
  }
  void teardown().then(
    () => exit(0),
    () => exit(1),
  );
});
// equivalent, registered as early as the module graph allows. 130 is the
// shell's code for "interrupted", so a caller piping this can tell the two
// apart, and a cleanup that did not finish says so and names the database
// rather than exiting with a code that looks identical either way.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (teardownOnce !== undefined) {
      return;
    }
    void teardown().then(
      () => exit(130),
      (error) => {
        const name = database?.database ?? 'the walk database';
        process.stderr.write(
          `Interrupted, and the cleanup did not finish: ${String(error)}\n` +
            `The database may still exist. To drop it:\n` +
            '  docker compose exec postgres psql -U been_there -d been_there \\\n' +
            `    -c 'DROP DATABASE IF EXISTS ${name} WITH (FORCE)'\n`,
        );
        exit(130);
      },
    );
  });
}

loadDotEnv();

if (!existsSync(join(REPO_ROOT, 'packages/service/dist/index.js'))) {
  process.stderr.write(
    'The packages are not built, so there is no service to walk.\n' +
      'Run `npm run build` first, or `make demo-journey`, which builds for you.\n',
  );
  exit(1);
}

const pg = (await import('pg')).default;
database = demoDatabase(pg, 'journey');
const client = createClient();
const walk = narrator(STEP_COUNT);
const say = walk.say;

try {
  // Held before the await, so an interrupt arriving inside the CREATE cannot let
  // the teardown drop a database that does not exist yet.
  creating = database.create();
  const connectionString = await creating;
  running = await boot('first', connectionString);
  client.base = running.url;

  walk.heading('Been There — the acceptance walk, over HTTP, against real Postgres');
  say(`database ${database.database}, created and migrated for this run`);
  say(`service running as its own process on ${running.url}, pid ${running.pid}`);

  // Before step 1, and outside the numbered steps, because this is a property
  // of the demo's own plumbing rather than a claim about the product. It fails
  // the run rather than a step, so a regression here never reads as a defect
  // in the age gate.
  walk.heading('Preflight: the rate limit the walk depends on');
  await checkRateLimitBudget(client, say);
  client.fromAddress(null);

  const context = { client, say, people: {}, ids: {}, moderator: MODERATOR, restart };

  for (const step of STEPS) {
    await walk.step(step.title, () => step.run(context));
  }

  await teardown();
  report();
  exit(0);
} catch (error) {
  await teardown();
  exitWithFailure(error);
}

/**
 * Kills the serving process, waits for it to be gone, and starts a new one. Step
 * 11 calls this and nothing else does, because a step that restarted the service
 * would be restarting the walk.
 */
async function restart() {
  const old = running;
  if (old === undefined) {
    throw new Error('the restart was asked for before any service was started');
  }
  let drained = false;
  void old.stopped.then(() => {
    drained = true;
  });
  if (!old.child.kill('SIGTERM')) {
    throw new Error(
      `the service process ${old.child.pid} was already gone, so nothing was restarted`,
    );
  }
  // An interrupt during this restart has already begun the teardown, which is
  // dropping the database. Carrying on would start a replacement service against
  // a database that no longer exists.
  refuseIfStopping('the service was being restarted');
  const code = await Promise.race([
    old.exited,
    new Promise((_, giveUp) =>
      setTimeout(
        () =>
          giveUp(
            new Error(
              `the service ignored SIGTERM for ${STOP_TIMEOUT_MS / 1000}s` +
                `${drained ? ' after reporting STOPPED' : ' and never reported STOPPED'}`,
            ),
          ),
        STOP_TIMEOUT_MS,
      ),
    ),
  ]);
  say(`the process exited with code ${code}${drained ? ' after draining its listener and pool' : ''}`);
  if (code !== 0) {
    throw new Error(`the service exited ${code} on SIGTERM`);
  }
  refuseIfStopping('the old service had stopped and the replacement was about to start');
  await assertClosed(old.url);
  say(`pid ${old.pid} is gone and ${old.url} refuses connections`);
  running = await boot('second', database.connectionString);
  client.base = running.url;
  return running.url;
}

/**
 * Starts one service process and resolves once it reports READY. Nothing else
 * counts as ready: the socket is announced by the process that bound it, after
 * the schema has answered a query.
 */
async function boot(label, connectionString) {
  refuseIfStopping('the service was about to start');
  const service = spawn(process.execPath, [SERVER], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DEMO_DATABASE_URL: connectionString,
      // An ephemeral port, so a walk never collides with a `make demo` already
      // running on this machine.
      DEMO_PORT: '0',
      DEMO_STAFF_TOKENS: JSON.stringify([
        { token: MODERATOR.token, role: 'senior_moderator', automated: false },
      ]),
    },
  });
  // Prefixed per line rather than per chunk: a chunk that ends mid-line would
  // otherwise leave the next line looking like the walk's own output.
  service.stderr.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.length > 0) {
        process.stderr.write(`[service ${label}] ${line}\n`);
      }
    }
  });

  const waiters = [];
  let buffer = '';
  service.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      // `[demo]` lines are the server talking to a person; the two structured
      // lines are it talking to this script.
      if (!line.startsWith('[demo] ')) {
        const space = line.indexOf(' ');
        const kind = space === -1 ? line : line.slice(0, space);
        let payload = {};
        try {
          payload = JSON.parse(line.slice(space + 1));
        } catch {
          payload = {};
        }
        const index = waiters.findIndex((waiter) => waiter.kind === kind);
        if (index >= 0) {
          waiters.splice(index, 1)[0].resolve(payload);
        }
      }
      newline = buffer.indexOf('\n');
    }
  });

  const waitFor = (kind) => new Promise((resolve) => waiters.push({ kind, resolve }));
  const exited = new Promise((resolve) => service.once('exit', (code) => resolve(code)));
  // Tracked from the moment the process exists, not from READY: an interrupt
  // during the boot window has to be able to kill a process teardown has never
  // otherwise heard of.
  spawned.set(service, exited);
  service.once('exit', () => spawned.delete(service));

  const ready = await withDeadline(
    Promise.race([
      waitFor('READY'),
      exited.then((code) => {
        throw new Error(`the service exited ${code} before it was ready`);
      }),
    ]),
    BOOT_TIMEOUT_MS,
    `the service was not ready after ${BOOT_TIMEOUT_MS / 1000}s`,
  );
  // Registered after READY is resolved so a stop that beats the boot is not
  // missed: waiters are matched by name and the two lines never collide.
  return {
    child: service,
    exited,
    stopped: waitFor('STOPPED'),
    url: String(ready.url),
    pid: Number(ready.pid),
  };
}

/** Proves the port is closed rather than assuming the process went away. */
async function assertClosed(url) {
  try {
    await fetch(`${url}/v1/health/live`);
  } catch {
    return;
  }
  throw new Error(`${url} still answers, so the old process was never stopped`);
}

function withDeadline(promise, ms, message) {
  return Promise.race([
    promise,
    new Promise((_, giveUp) => setTimeout(() => giveUp(new Error(message)), ms)),
  ]);
}

/** What a reader should not be left believing about the eleven steps above. */
function report() {
  walk.heading(`All ${walk.completed} of ${walk.expected} steps completed.`);
  say('Real: Postgres, the SQL migrations, the service process, every domain transition,');
  say('every row written, and the restart in step 11.');
  walk.heading('Simulated, and what each one costs the demonstration:');
  say('1. Identity verification. There is no identity vendor in this repository and no');
  say('   outbound call to one. The service is wired to the stub provider, which declares');
  say('   a confidence of 0.95 and examines nothing. The identity machine and its 0.9 floor');
  say('   are real. The walk no longer supplies the score: it asks the service, and the');
  say('   service asks its provider. The provider reference written to the database is');
  say('   prefixed stub-session-, and /v1/health/ready reports mode "stub" with a caveat, so');
  say('   this process cannot be mistaken for one that has verified anybody. Before this,');
  say('   the walk posted its own provider result to the endpoint a vendor would use, and a');
  say('   subject could have posted their own and reached verified.');
  say('2. Staff identity. The service is handed one static moderator token. There is no');
  say('   staff login, no SSO and no staff session row, so a real deployment needs that');
  say('   built before a person can moderate anything.');
  say('3. Outbound contact. Recovery codes and sign-out notices are composed by the');
  say('   service and then dropped; no relay is configured. The walk does not use them.');
  say('4. Step 7 deviates from a straight three-person script: Carol completes');
  say('   verification and matches Alice before blocking her, because an unverified');
  say('   account cannot hold a conversation and the block would close nothing. The');
  say('   deviation is printed inside the step.');
  say('5. No UI is started by this walk. It exercises the server and the rules it');
  say('   enforces, driven as a client would drive it. Two clients exist and both are');
  say('   the way to look at this rather than read it: node web/server.mjs, then');
  say('   http://127.0.0.1:5173, and the iOS app over client/BeenThereIos —');
  say('   docs/run-ios.md has the build, the simulator run and the physical phone.');
  say('   Neither is started here. The iOS app talks to this service, not to itself.')
}