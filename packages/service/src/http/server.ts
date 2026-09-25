import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StoreError } from '@been-there/contracts';
import type { DomainError, Err, Result } from '@been-there/core';
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
import type { ServiceDependencies } from '../ports.js';

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

  const actor = dependencies.actors.resolve(message.headers.authorization);
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
  let outcome: Result<HttpResponse, DomainError>;
  try {
    outcome = await dependencies.transaction.run(async (tx) => {
      const request: RouteRequest = {
        method: message.method ?? 'GET',
        path: url.pathname,
        params: match.params,
        query: url.searchParams,
        body: body.value,
        actor: actor.value,
        now,
        tx,
      };
      return match.route.handle(request);
    });
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

