import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StoreError, type Transaction } from '@been-there/contracts';
import { type DomainError, type Err, type Result, castId, ok } from '@been-there/core';
import { createServiceHealth } from '../health/service.js';
import { readBody } from './body.js';
import {
  type FailureBody,
  METHOD_NOT_ALLOWED,
  ROUTE_NOT_FOUND,
  failureBodyFromDomain,
  failureBodyFromStore,
  statusForDomainError,
  statusForStoreError,
} from './failure.js';
import { type HttpResponse, type Route, type RouteRequest, matchRoute } from './router.js';
import type { RequestActor, ServiceDependencies } from '../ports.js';

/**
 * The HTTP boundary, on Node's own `http`.
 *
 * ## One transaction per request
 *
 * Every matched request is dispatched inside a single `transaction.run`, and the
 * scoped transaction is handed to the handler rather than to the stores
 * directly. That is a superset of the requirement — "one transaction for
 * anything that writes more than one row" — and it is chosen over the narrower
 * rule for one reason: a rule that says *which* requests need a transaction is a
 * rule somebody has to get right on every future route, and the failure mode of
 * getting it wrong is a like that commits without the match it created. Nothing
 * breaks at the type level, nothing breaks in the tests, and it breaks in
 * production. A read-only request inside `BEGIN`/`COMMIT` costs one connection
 * checkout and buys the guarantee that the rule cannot be forgotten.
 *
 * ## What the boundary is allowed to decide
 *
 * Transport: what the status code is, and how a `StoreError` is kept apart from
 * a domain refusal. Nothing else. Every product decision — eligibility, whether
 * a message may be sent, whether a state transition is legal, whether a human
 * took a decision — is answered by a domain function called inside a handler,
 * and the handler passes the answer straight through.
 */

/** Swappable so a test can assert on what was reported without capturing stdout. */
export interface FailureReporter {
  report(outcome: { readonly status: number; readonly message: string; readonly error: unknown }): void;
}

const stderrReporter: FailureReporter = {
  report(outcome): void {
    const detail = outcome.error instanceof Error ? outcome.error.stack ?? outcome.error.message : '';
    process.stderr.write(`[service] ${outcome.status} ${outcome.message}\n${detail}\n`);
  },
};

export interface ServerOptions {
  readonly routes: readonly Route[];
  readonly onFailure?: FailureReporter;
}

/**
 * The transaction a non-transactional route is handed.
 *
 * It cannot write: `clientOf(tx)` in the database package throws a `StoreError`
 * the moment a handler tries to use it, because the client is `undefined`. A
 * health route that reached for the store by accident should fail loudly rather
 * than silently report itself healthy while every query fails - which is the
 * failure this whole mechanism exists to prevent.
 *
 * It exists for one reason: readiness has to be answerable while the database is
 * unreachable. With a dead pool `transaction.run` throws before a handler is
 * reached, so a readiness probe that took a transaction would answer 503 on a
 * transient database fault and every replica would be restarted, turning a
 * degradation into an outage.
 */
const PASSIVE_TRANSACTION: Transaction = {
  client: undefined,
  run: (body) => body(PASSIVE_TRANSACTION),
};

export function createRequestHandler(
  dependencies: ServiceDependencies,
  options: ServerOptions,
): (message: IncomingMessage, response: ServerResponse) => void {
  const report = options.onFailure ?? stderrReporter;

  return (message, response) => {
    void handle(dependencies, options.routes, report, message, response).catch((error: unknown) => {
      // The last line of defence. A throw that escaped every handler is a defect,
      // and a defect must not be reported to the client as a refusal.
      report.report({ status: 500, message: 'unhandled fault in the request pipeline', error });
      if (!response.headersSent) {
        writeJson(response, 500, {
          error: {
            code: 'internal',
            domain: 'service',
            message: 'the request could not be completed',
            retryable: false,
          },
        } satisfies FailureBody);
      } else {
        response.end();
      }
    });
  };
}

/**
 * The principal a public route runs as.
 *
 * `userId: null` is the load-bearing field: it is the value a staff route
 * reached without a member session already carries, so a public handler that
 * forgets to check gets a refusal from `authorize` rather than a fabricated
 * member, and a handler that does check cannot tell "no session" from "a
 * session belonging to somebody with no id".
 */
/** No member identity. A `Principal` is not nullable, so an anonymous
 * caller carries a sentinel that matches no real user rather than a null. */
const ANONYMOUS_USER_ID = castId<'UserId'>('anonymous');

const ANONYMOUS_ACTOR: RequestActor = {
  userId: null,
  role: 'user',
  // A platform `Principal` is not nullable, so an anonymous caller carries no
  // member identity at all rather than a null one. `authorize` refuses any
  // protected action for a principal with no user id, which is the point:
  // a public route that forgot to check gets a refusal, not a fabricated member.
  principal: { userId: ANONYMOUS_USER_ID, role: 'user' },
  automated: false,
  actorId: castId<'ActorId'>('anonymous'),
};

async function handle(
  dependencies: ServiceDependencies,
  routes: readonly Route[],
  report: FailureReporter,
  message: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(message.url ?? '/', 'http://service.local');
  const match = matchRoute(routes, message.method ?? 'GET', url.pathname);

  const body = await readBody(message);
  if (!body.ok) {
    writeFailure(response, body);
    return;
  }

  // Authenticated after routing, not before it: the three routes a caller
  // cannot present a session to — sign-up, sign-in, recovery — are declared
  // public in the route table, and resolving a session for them would refuse
  // every legitimate first request. A public handler still runs as an
  // anonymous principal, so `request.actor` is never undefined and a handler
  // cannot accidentally treat "unauthenticated" as "member".
  // Async because resolving a bearer token is a database read; see
  // `ActorResolver.resolve` for why a synchronous resolver would be a second
  // source of truth for authentication.
  const actor = await (match.kind === 'matched' && match.route.public
    ? Promise.resolve(ok(ANONYMOUS_ACTOR))
    : dependencies.actors.resolve(message.headers.authorization));
  if (!actor.ok) {
    writeFailure(response, actor);
    return;
  }

  if (match.kind === 'no_such_route') {
    writeFailure(response, ROUTE_NOT_FOUND());
    return;
  }
  if (match.kind === 'method_not_allowed') {
    writeFailure(response, METHOD_NOT_ALLOWED(message.method ?? 'GET'));
    return;
  }

  const now = dependencies.now();
  const requestFor = (tx: Transaction): RouteRequest => ({
    method: message.method ?? 'GET',
    path: url.pathname,
    params: match.params,
    query: url.searchParams,
    body: body.value,
    actor: actor.value,
    now,
    tx,
  });
  let outcome: Result<HttpResponse, DomainError>;
  try {
    // A non-transactional route skips the wrapper so readiness can be answered
    // while the database is unreachable. It is handed `PASSIVE_TRANSACTION`, whose
    // client is `undefined`, so a store call throws rather than silently doing
    // nothing.
    outcome = match.route.transactional
      ? await dependencies.transaction.run(async (tx) => match.route.handle(requestFor(tx)))
      : await match.route.handle(requestFor(PASSIVE_TRANSACTION));
  } catch (thrown) {
    // A `StoreError` is the one failure the store layer classifies for us, so it
    // is the one that is reported as one: 503 when the store says the fault is
    // transient, 500 when it does not, and never a 4xx. Anything else is a
    // defect and falls through to the outer handler as a 500.
    if (!(thrown instanceof StoreError)) {
      throw thrown;
    }
    report.report({ status: statusForStoreError(thrown), message: thrown.message, error: thrown });
    writeJson(response, statusForStoreError(thrown), failureBodyFromStore(thrown));
    return;
  }

  if (outcome.ok) {
    writeJson(response, outcome.value.status, outcome.value.body);
    return;
  }
  writeFailure(response, outcome);
}

function writeFailure(response: ServerResponse, refusal: Err<DomainError>): void {
  writeJson(response, statusForDomainError(refusal.error), failureBodyFromDomain(refusal.error));
}

export function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? {});
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}


export interface RunningService {
  readonly server: Server;
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Starts the service on `port`, or on an ephemeral one when `port` is 0. The
 * test asks for 0 and reads the assigned port back, so a suite never collides
 * with a real instance or with another test file.
 */
export async function startService(
  dependencies: ServiceDependencies,
  options: ServerOptions & { readonly port?: number },
): Promise<RunningService> {
  const server = createServer(createRequestHandler(dependencies, options));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  // A process that has bound its port has finished starting. Before this the
  // route table is mounted but the service is not something to send traffic to,
  // and that window is a real, observable phase rather than one that does not
  // exist — which is what makes a readiness failure during startup diagnosable.
  createServiceHealth(dependencies).lifecycle.beginServing();
  const address = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

