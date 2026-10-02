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
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createStores, createTransaction } from '@been-there/database';
import type { Principal, Role } from '@been-there/platform';
import { type DomainError, type Result, type UserId, castId, domainError, ok } from '@been-there/core';
import { type Stores, type Transaction } from '@been-there/contracts';
import type { ContactMessage } from '@been-there/service';
import { type ActorResolver, type RequestActor, type ServiceDependencies, serviceRoutes, startService } from '@been-there/service';

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

export const CONNECTION_STRING = process.env.DATABASE_URL;

/**
 * Fails loudly rather than skipping.
 *
 * A skipped suite reads as a passing one in CI, and a service that cannot reach
 * its database is exactly the situation where a green tick is most damaging.
 */
export function requireDatabase(): string {
  if (CONNECTION_STRING === undefined) {
    throw new Error(
      'DATABASE_URL is not set. The service suite runs against real Postgres and will not ' +
        'silently pass without it. Run `cp .env.example .env` then `make up`.',
    );
  }
  return CONNECTION_STRING;
}

export interface Harness {
  /** Every message the service tried to deliver, newest last. */
  readonly messages: readonly ContactMessage[];
  readonly url: string;
  readonly stores: Stores;
  readonly pool: pg.Pool;
  /**
   * The service's own transaction runner, exposed so a suite can read the
   * records a request wrote — the audit trail in particular is only observable
   * through a store method, and a property that is only true in the response
   * body is not the property that matters.
   */
  readonly transaction: Transaction;
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
  callers: readonly Caller[],
  stores?: Stores,
  transaction?: Transaction,
): ActorResolver {
  const staticTable: ActorResolver = {
    async resolve(authorization: string | undefined): Promise<Result<RequestActor, DomainError>> {
      const token = bearerOf(authorization);
      const caller = token === undefined ? undefined : callers.find((entry) => entry.token === token);
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

export async function startHarness(callers: readonly Caller[]): Promise<Harness> {
  const connectionString = requireDatabase();
  const pool = new pg.Pool({ connectionString });
  // Assert the connection rather than assuming it. A pool that cannot answer a
  // query would otherwise surface as a confusing StoreError inside the first
  // request instead of as "the database is not there".
  await pool.query('SELECT 1');
  const stores: Stores = createStores(pool);
  const transaction = createTransaction(pool);
  const messages: ContactMessage[] = [];
  const dependencies: ServiceDependencies = {
    stores,
    transaction,
    actors: resolverFor(callers, stores, transaction),
    // Captures rather than sends, so a suite can read the verification code or
    // reset link. It must not throw and must not reach a relay.
    contacts: {
      deliver: async (message: ContactMessage) => {
        messages.push(message);
      },
    },
    now: () => new Date(),
  };
  const running = await startService(dependencies, { routes: serviceRoutes(dependencies) });
  return {
    url: running.url,
    stores,
    pool,
    transaction,
    /** Every message the service tried to deliver, newest last. */
    messages,
    close: async () => {
      await running.close();
      await pool.end();
    },
  };
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
