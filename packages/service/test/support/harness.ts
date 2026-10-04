/**
 * The service, started for real, against the real database.
 *
 * There is no in-memory double anywhere in this file. The point of the suite is
 * to prove that a request over HTTP reaches Postgres, that the domain refused
 * something it should refuse, and that a refusal which *should* have been a
 * refusal was not reported as an outage. A test that constructed its own stores
 * would prove none of that and would pass whether or not the service runs.
 *
 * `DATABASE_URL` is read the way `packages/database/scripts/migrate.mjs` reads
 * it — from the environment, and from `.env` when it is there. A suite that
 * silently passes because it connected to nothing is the worst outcome
 * available, so the connection is asserted: if the pool cannot answer a query,
 * the suite fails rather than skipping.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage } from 'node:http';
// A .mjs seam on purpose: `requireDatabase` is used by every suite that builds
// its own pool, and the migrations are plain SQL files, so a TypeScript
// module would buy nothing here.
import { type IsolatedDatabase, isolatedDatabase } from './isolation.js';
import { notePrepared } from './reclaim.js';
import pg from 'pg';
import { createStores, createTransaction } from '@been-there/database';
import { hashPassword, type Principal, type Role, type StaffId } from '@been-there/platform';
import { type DomainError, type Result, type UserId, castId, domainError, ok } from '@been-there/core';
import { type Stores, type Transaction } from '@been-there/contracts';
import { HarnessVerificationProvider } from './provider.js';
import type { ContactMessage, RunningService } from '@been-there/service';
import {
  type ActorResolver,
  type RequestActor,
  type ServiceDependencies,
  createSessionActorResolver,
  serviceRoutes,
  startService,
} from '@been-there/service';
import { randomUUID } from 'node:crypto';
import { issueStoredSessionFor } from '../../src/accounts/sessions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function loadDotEnv(): void {
  const file = join(REPO_ROOT, '.env');
  if (!existsSync(file)) {
    return;
  }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    const name = match?.[1];
    const value = match?.[2];
    if (name !== undefined && value !== undefined && process.env[name] === undefined) {
      process.env[name] = value;
    }
  }
}

loadDotEnv();

/**
 * The base connection string, before any isolation.
 *
 * Suites that build their own pools should call `requireDatabase()` instead, so
 * they inherit the per-suite database. This exists for the code paths that need
 * the un-isolated URL deliberately — a check that the isolation itself is
 * working, for instance.
 */
export const CONNECTION_STRING = process.env.DATABASE_URL;

let isolation: IsolatedDatabase | undefined;

/**
 * A connection string pointing at this process's own database, created and
 * migrated on first use.
 *
 * Every suite used to share one database and nothing truncated between runs. It
 * reached 741 cases, 597 open, and two correct moderation suites started failing
 * — a queue test asked for 500 rows and did not get its own, and a service test
 * found 50 cases where it expected one. Both passed alone. A suite whose result
 * depends on what else ran is not a test, and the failure looks like a data
 * problem rather than an isolation one.
 *
 * **The seam is this function, not `startHarness`.** Three suites build their own
 * pools because they need faulted stores or several servers, and one passes the
 * string into spawned child processes. Returning the isolated URL from here is
 * what stops those suites sharing rows with everything else; returning it from
 * `startHarness` would leave the coupling intact in exactly the suites that
 * opted out, with nothing failing to say so.
 *
 * Per-suite **database**, not schema: every store query is qualified `app.`, so
 * `search_path` is bypassed and does not isolate. That was tried and measured.
 */
export function requireDatabase(): string {
  if (CONNECTION_STRING === undefined) {
    throw new Error(
      'DATABASE_URL is not set. Every database suite in this repository runs against real ' +
        'Postgres and will not silently pass without it. Run `cp .env.example .env` then `make up`.',
    );
  }
  return currentIsolation().connectionString;
}

/** Applies the migrations into this process's database. Call once, in `beforeAll`. */
function currentIsolation(): IsolatedDatabase {
  isolation ??= isolatedDatabase('service');
  return isolation;
}

export async function prepareDatabase(): Promise<void> {
  if (prepared) {
    return;
  }
  const database = currentIsolation();
  // Claimed *before* the create, not after. `create()` throws when the
  // migrations do not apply, and a name claimed only on the success path is a
  // name absent from the set exactly when it matters most — the one case where
  // the suite cannot reach its own `afterAll`, because the handle that would
  // have dropped it was never assigned. Claiming a database that has not been
  // created yet is harmless: every drop here is `IF EXISTS`.
  notePrepared(database.database);
  await database.create();
  prepared = true;
}

/**
 * The connection string, preparing the database if this is the first call.
 *
 * A suite that only ever calls `requireDatabase()` should not also have to
 * remember `prepareDatabase()`: the first pool to be opened is the natural
 * moment to create and migrate, and a suite that builds its own pool — because
 * it needs faulted stores or several servers — is exactly the one that would
 * otherwise forget. `startHarness` still calls `prepareDatabase()` explicitly,
 * because it is `await`able and a caller should not depend on pool construction
 * to have run migrations.
 */
let prepared = false;
export async function requireDatabaseReady(): Promise<string> {
  await prepareDatabase();
  return currentIsolation().connectionString;
}

/** How many harnesses in this process still hold the database open. */
let openHarnesses = 0;

/**
 * Drops this process's database, if nothing is still using it.
 *
 * Reference-counted rather than idempotent, because a suite may legitimately run
 * two services against one database — `rate-limit.test.ts` starts a second one
 * with no trusted hop to cover the direct-socket path. Dropping on the first
 * `close()` terminated the second pool's connections mid-suite (`terminating
 * connection due to administrator command`), and re-creating the singleton made
 * it worse: the second harness was then talking to a *different* database than
 * the first, which is the kind of thing that passes.
 *
 * The last harness out drops it. A suite that leaks a harness leaks the
 * database with it, which is the lesser evil — and visible, because the next run
 * finds a database it did not create.
 */
export async function dropDatabase(): Promise<void> {
  if (isolation === undefined || --openHarnesses > 0) {
    return;
  }
  const dropping = isolation;
  isolation = undefined;
  await dropping.drop();
}

/** The database name, for a suite that wants to assert it is not the shared one. */
export function isolatedDatabaseName(): string {
  return isolation?.database ?? 'not created';
}

export interface Harness {
  /** Every message the service tried to deliver, newest last. */
  readonly messages: readonly ContactMessage[];
  /**
   * The verification provider this harness's service is wired to.
   *
   * Exposed so a suite can choose the score the provider reports — a passing one
 * above the 0.9 floor, a borderline one below it, or a deferred one that has not
   * finished. It is the *provider* that is adjustable, never the request body:
   * the service reads a score from here and from nowhere else, and a client that
   * posts one is refused.
   */
  readonly verification: HarnessVerificationProvider;
  readonly url: string;
  readonly stores: Stores;
  readonly pool: pg.Pool;
  /**
   * Presents the next request as coming from `address`, the way a trusted proxy
   * hop would. Null restores the socket address.
   *
   * This is the harness's job and not a service option: every test request
   * arrives from `127.0.0.1`, so without a seam every suite shares one
   * `signup_per_ip` bucket and `profile.test.ts` alone would exhaust it. The
   * service reads the address through `ServerOptions.peerAddressFrom` — the same
   * hook a production proxy deployment installs — so the code under test is the
   * code that ships rather than a test-only branch.
   *
   * **`startHarness` installs the hop; a suite that calls `startService` itself
   * does not get one.** A suite assembling its own service — because it needs
   * faulted stores, several servers, or a child process — must pass
   * `peerAddressFrom` to `startService` itself, or there is no seam and every
   * request is stuck on the socket address with no way to vary it. Three suites
   * have now been bitten by this and the symptom is not an error: the suite
   * simply cannot present a distinct address, so a per-address limit refuses the
   * sixth sign-up and the failure lands in an unrelated test looking like a data
   * problem. If a suite finds itself out of `fromAddress` calls it does not
   * recognise, this is why.
   */
  fromAddress(address: string | null): void;
  /**
   * Swaps the resolver's caller list while the service keeps running.
   *
   * A staff identity cannot exist before the service starts — provisioning one
   * needs the database, and the session it mints is resolved by the running
   * service — so a suite that wants a *real* moderator has to start the harness,
   * provision, and then register. The list is captured per resolve rather than at
   * construction for exactly this reason; this method exists so the swap is
   * explicit at the call site instead of the harness guessing.
   */
  reloadCallers(callers: readonly Caller[]): void;
  /**
   * The service's own transaction runner, exposed so a suite can read the
   * records a request wrote — the audit trail in particular is only observable
   * through a store method, and a property that is only true in the response
   * body is not the property that matters.
   */
  readonly transaction: Transaction;
  /**
   * The `ServiceDependencies` the server was started with.
   *
   * Exposed because `createServiceSafety` memoises on this object's identity: a
   * suite that assembled its own dependencies would get a *different* recorder
   * from the one the routes use, and would assert against a recorder no request
   * ever touched — a suite that passes without testing anything.
   *
   * Optional because three suites hand-build a `Harness` to inject faulted
   * stores, and they have no single set of dependencies to hand back. It is set
   * whenever `startHarness` built the server, so a caller that got one from here
   * always has it; the optionality is for the hand-built shape.
   */
  readonly dependencies?: ServiceDependencies;
  close(): Promise<void>;
}

/**
 * A resolved caller.
 *
 * `userId` is mutable and set *after* the account is created, because the account
 * id is the database's to mint. Seeding a fixed uuid instead would have made every
 * request act as a user who does not exist, and the first foreign-key violation
 * would have looked like a service bug rather than a harness one.
 */
export interface Caller {
  readonly token: string;
  userId: UserId | null;
  readonly role: Role;
  readonly automated: boolean;
  /**
   * Set when this caller is backed by a REAL staff identity rather than a token
   * in a table.
   *
   * Its presence is what tells the resolver to hand the request to production.
   * Without it the harness would resolve the caller itself and set
   * `actorId = token`, which is precisely the lie this change removes: the
   * decision log would record a bearer token where it must record a person. So a
   * caller carrying a real identity is *not* answered from this table at all — it
   * goes through `createSessionActorResolver`, which reads the session row and
   * `staff_identities`, and the resulting `actorId` is the staff id.
   */
  readonly realStaff?: boolean;
}

export function member(token: string): Caller {
  return { token, userId: null, role: 'user', automated: false };
}

/**
 * A staff caller. `senior_moderator` rather than `moderator` because
 * `PROTECTED_ACTIONS['case.open']` requires `restricted` clearance and only the
 * senior role carries it — a fact about the platform's authorisation matrix, not
 * a convenience, and the suite would be wrong to pretend otherwise.
 */
export function moderator(token: string, automated = false): Caller {
  return staff(token, 'senior_moderator', automated);
}

/**
 * A staff caller in a named role.
 *
 * The role is the whole point of the workspace suite: the properties there are
 * about the difference between `moderator` and `senior_moderator`, and a
 * harness that could only mint the senior one would make every one of them
 * vacuous — a refusal would be indistinguishable from a refusal for the wrong
 * reason.
 */
export function staff(token: string, role: Role, automated = false): Caller {
  return { token, userId: null, role, automated };
}

function principalOf(caller: Caller, actorId: string): Principal {
  return {
    userId: caller.userId ?? castId<'UserId'>(actorId),
    role: caller.role,
  };
}

/**
 * A real staff identity, with a real session and a real bearer token.
 *
 * ## Why this exists
 *
 * The static `staff(token, role)` table above is the thing this whole change is
 * about: it manufactures a moderator out of a string, with `actorId` set to the
 * token. A test using it proves the *routes* work while proving nothing about
 * whether a human can reach them.
 *
 * So a suite that needs a genuine moderator provisions one here: a row in
 * `staff_identities`, a password, and a session minted by the same
 * `issueStoredSessionFor` production uses. The returned token is resolved by the
 * production resolver, which is the point — the actor id the test then asserts on
 * is a staff identity id that the database minted, not a literal.
 *
 * `automated` is a field of the issued session subject rather than something the
 * resolver invents, which is what lets the "automation may not decide" refusal be
 * exercised against a real identity instead of a fabricated one.
 */
export interface StaffIdentity {
  readonly token: string;
  readonly staffId: string;
  /** The credentials the sign-in route verifies against, so a suite can sign in over HTTP. */
  readonly contact: string;
  readonly password: string;
  readonly role: Role;
  readonly displayName: string;
  readonly sessionId: string;
  readonly caller: Caller;
}

/**
 * Provisions a staff identity and signs it in.
 *
 * `suffix` makes the contact unique per call; the store refuses a duplicate
 * contact, and two suites sharing a harness must not collide on one.
 */
export async function staffIdentity(
  harness: Harness,
  role: Role,
  options: { readonly automated?: boolean; readonly suffix?: string; readonly displayName?: string } = {},
): Promise<StaffIdentity> {
  const suffix = options.suffix ?? Math.random().toString(36).slice(2, 10);
  const contact = `mod-${suffix}@been-there.test`;
  const displayName = options.displayName ?? `Moderator ${suffix}`;
  const password = 'staff-password-for-tests';
  const passwordHash = await hashPassword(password);
  const staffId = randomUUID();

  await harness.transaction.run((tx) =>
    harness.stores.staff.insertStaff(
      {
        staffId,
        contactKind: 'email',
        contactIdentifier: contact,
        passwordHash,
        displayName,
        role,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      tx,
    ),
  );

  const issued = issueStoredSessionFor(
    { kind: 'staff', staffId: castId<'StaffId'>(staffId), automated: options.automated === true },
    'staff_password',
    new Date(),
  );
  if (!issued.ok) {
    throw new Error(`harness could not issue a staff session: ${issued.error.message}`);
  }
  await harness.transaction.run((tx) => harness.stores.accounts.insertSession(issued.value.row, tx));

  return {
    token: issued.value.token,
    staffId,
    contact,
    password,
    role,
    displayName,
    sessionId: issued.value.row.sessionId,
    // `realStaff` routes this token to the production resolver rather than the
    // table above. Without it the harness would answer the request itself and
    // stamp `actorId = token`, and the suite would be asserting against a
    // credential dressed up as a person.
    caller: {
      token: issued.value.token,
      userId: null,
      role,
      automated: options.automated === true,
      realStaff: true,
    },
  };
}

/**
 * The actor resolver, as a real one would be: a bearer token names a session, and
 * the session says who the caller is and whether they are a machine.
 *
 * `automated` comes from the *session*, never from the request — that is the whole
 * of the runtime half of commitment 2, and a resolver that let a header claim it
 * would make every enforcement guarantee a suggestion.
 */
/**
 * Resolves a bearer token to a session.
 *
 * The token table is rebuilt per request rather than captured once, so a suite
 * can register a caller after the server has started — which it has to, because
 * the account id is the database's to mint and only exists after the create call.
 */
/**
 * Static callers first, then a real session lookup.
 *
 * The fallback is what makes "an unauthenticated request is refused" an honest
 * assertion rather than "a token nobody registered is refused": a suite that
 * signs in obtains a real token, and this resolves it the way production does.
 */
export function resolverFor(
  initialCallers: readonly Caller[],
  stores?: Stores,
  transaction?: Transaction,
  /**
   * The cell the caller owns. Passing it in rather than returning a setter keeps
   * one source of truth for the list: the harness holds it, `reloadCallers`
   * writes it, and the resolver reads it per request.
   */
  cell?: { current: readonly Caller[] },
): ActorResolver {
  // Read per request through the cell rather than captured, so `reloadCallers`
  // works: a staff identity is minted *after* the service starts, and a resolver
  // holding a captured list would never learn about it.
  const current = (): readonly Caller[] => cell?.current ?? initialCallers;
  const staticTable: ActorResolver = {
    async resolve(authorization: string | undefined): Promise<Result<RequestActor, DomainError>> {
      const token = bearerOf(authorization);
      const caller =
        token === undefined ? undefined : current().find((entry) => entry.token === token);
      // A real staff identity is deliberately NOT answered here. This table can
      // only produce `actorId = token`, and a token is not a person: answering
      // from it would make every assertion about "the decision names the
      // moderator" pass while the recorded actor was still a credential. Refusing
      // hands the request to production, which reads the session row.
      if (caller?.realStaff === true) {
        return domainError(
          'permission_denied',
          'service.http',
          'this request carries no recognised session',
          { reason: 'unauthenticated' },
        );
      }
      if (caller === undefined) {
        return domainError(
          'permission_denied',
          'service.http',
          'this request carries no recognised session',
          { reason: 'unauthenticated' },
        );
      }
      const actorId = caller.userId ?? caller.token;
      return ok({
        userId: caller.userId,
        role: caller.role,
        principal: principalOf(caller, actorId),
        automated: caller.automated,
        actorId: castId<'ActorId'>(actorId),
        sessionId: null,
      });
    },
  };

  if (stores === undefined || transaction === undefined) {
    return staticTable;
  }
  const live = createSessionActorResolver({ stores, transaction, now: () => new Date() });

  return {
    async resolve(authorization: string | undefined): Promise<Result<RequestActor, DomainError>> {
      const caller = await staticTable.resolve(authorization);
      if (caller.ok) {
        return caller;
      }
      // Anything the static table does not know goes through the production
      // resolver, which applies `validateSession`.
      //
      // An earlier version of this harness did the token lookup itself and
      // returned an actor for any row it found, so a revoked, superseded or
      // expired token authenticated: a bare lookup answers "was this token ever
      // issued", which is not the question. The check belongs in the resolver
      // because the router resolves an actor *before* opening the request
      // transaction, and a handler that trusted the actor was trusting a value
      // whose meaning depended on who produced it.
      return live.resolve(authorization);
    },
  };
}

function bearerOf(authorization: string | undefined): string | undefined {
  return authorization?.startsWith('Bearer ') === true ? authorization.slice(7) : undefined;
}

export interface HarnessOptions {
  /**
   * Whether to install `peerAddressFrom`, the trusted-hop seam.
   *
   * True — the default — is the deployment behind a proxy, and the only shape in
   * which every request in this repository can present a distinct address: they
   * all arrive over one loopback socket. False is the deployment with nothing in
   * front of the service, where `request.clientAddress` can only be
   * `message.socket.remoteAddress`. Both are production paths, and a suite that
   * only ever exercises the seam cannot tell whether the socket path works.
   */
  readonly trustedHop?: boolean;
}

export async function startHarness(
  callers: readonly Caller[],
  options: HarnessOptions = {},
): Promise<Harness> {
  // Before `requireDatabase()`: the connection string names this process's own
  // database, and that database does not exist until it has been created and
  // migrated. Connecting first would fail with "database does not exist" and
  // read as a broken environment rather than an un-prepared one.
  await prepareDatabase();
  openHarnesses += 1;
  const connectionString = requireDatabase();
  const pool = new pg.Pool({ connectionString });
  // Everything from here on can throw — `startService` builds the route table,
  // so a bad route surfaces here and nowhere else — and a caller that threw has
  // no harness to close, because the value carrying `close` is what never
  // arrives. A pool left open and a database left behind are invisible until
  // someone runs out of connections, so a partial start is unwound here rather
  // than trusted to a teardown that cannot run.
  let running: RunningService | undefined;
  try {
    // Assert the connection rather than assuming it. A pool that cannot answer a
    // query would otherwise surface as a confusing StoreError inside the first
    // request instead of as "the database is not there".
    await pool.query('SELECT 1');
    const stores: Stores = createStores(pool);
    const transaction = createTransaction(pool);
    const messages: ContactMessage[] = [];
    // One provider per harness, shared by every suite that starts one. Held in a
    // local rather than constructed inline so a suite can reach it through
    // `Harness.verification` and move the score across the 0.9 floor without
    // rebuilding a service.
    const provider = new HarnessVerificationProvider();
    // One cell, owned here and written by `reloadCallers`, read by the resolver
    // on every request. That is the whole of the seam.
    const callerCell: { current: readonly Caller[] } = { current: callers };
    const dependencies: ServiceDependencies = {
      stores,
      transaction,
      actors: resolverFor(callers, stores, transaction, callerCell),
      // Captures rather than sends, so a suite can read the verification code or
      // reset link. It must not throw and must not reach a relay.
      contacts: {
        deliver: async (message: ContactMessage) => {
          messages.push(message);
        },
      },
      // The verification provider, and the reason a suite cannot post its own
      // score: `verification` is a required dependency and this is the adapter
      // that fills it. `support/provider.ts` documents why it exists and what it
      // deliberately does not do.
      verification: provider,
      now: () => new Date(),
    };
    const trustedHop = options.trustedHop ?? true;
    // The proxy seam, read per request rather than captured once, so a suite can
    // change the presented address between calls. `null` falls through to the
    // socket address, which is the direct-deployment path.
    let presentedAddress: string | null = null;
    running = await startService(dependencies, {
      routes: serviceRoutes(dependencies),
      // Absent rather than returning `null` when the seam is switched off. A
      // `peerAddressFrom` that answers null is still a hop the address came
      // through, and the branch under test — `?? message.socket.remoteAddress` —
      // would never run.
      ...(trustedHop
        ? {
            peerAddressFrom: (message: IncomingMessage) =>
              presentedAddress ?? message.socket.remoteAddress ?? null,
          }
        : {}),
    });
    return {
      url: running.url,
      stores,
      pool,
      transaction,
      dependencies,
      /**
       * Registers callers minted after the service started.
       *
       * The seam exists for real staff identities: provisioning one needs the
       * database, and the session it mints is only usable if the running
       * resolver can see it. A static-token harness never needed this because it
       * invented the token it was about to present.
       */
      reloadCallers(next: readonly Caller[]): void {
        callerCell.current = next;
      },
      /** Every message the service tried to deliver, newest last. */
      messages,

      /**
       * The verification provider this harness's service is wired to, so a suite
       * can move the score across the 0.9 floor without rebuilding a service.
       * A suite wanting a borderline result calls `scoreAs(0.72)`; there is
       * deliberately no way to make the *client* supply one.
       */
      verification: provider,
      /**
       * Presents every subsequent request as arriving from `address`, or
       * refuses: a harness with no trusted hop has no seam to present one
       * through, and a silently-ignored call would let a suite believe it was
       * varying the address when every request was arriving from the same
       * socket.
       */
      fromAddress: trustedHop
        ? (address: string | null) => {
            presentedAddress = address;
          }
        : socketAddressOnly,
      close: async () => {
        if (running === undefined) {
          throw domainError('internal', 'harness.close', 'harness closed before the service started');
        }
        await running.close();
        await pool.end();
        // The database goes with the harness. Not doing this leaked 161 of them
        // during development, which is invisible until someone runs out of
        // connections or disk — and a leaked database still holds its rows, so a
        // later run against it would quietly see old data.
        await dropDatabase();
      },
    };
  } catch (error) {
    // Unwound in reverse: the listener, then the pool, then the database, so
    // nothing downstream of a half-built harness outlives the attempt.
    await running?.close();
    await pool.end();
    await dropDatabase();
    throw error;
  }
}

/**
 * The `fromAddress` of a harness that runs no trusted hop.
 *
 * Exported for the suites that assemble their own `Harness` because they inject
 * faulted stores rather than the production wiring. Those suites have no hop to
 * present an address through, so this is the honest implementation for them — and
 * it is exported rather than defaulted so that saying so stays a visible act. A
 * harness that could present an address only by accident would let a suite
 * believe it was varying the address when every request was in fact arriving
 * from the same socket.
 */
export function socketAddressOnly(): void {
  // Deliberately does nothing: this harness has no seam, so every request takes
  // `message.socket.remoteAddress`, which is the direct-deployment path.
}

export interface JsonResponse {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/**
 * One request. Deliberately thin: the suite talks to the service the way a client
 * would, so anything the service does not expose cannot be reached from here.
 */
export async function call(
  harness: Harness,
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<JsonResponse> {
  const response = await fetch(`${harness.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}
