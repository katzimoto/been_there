import type { DomainError, Ok, Result } from '@been-there/core';
import { ok } from '@been-there/core';
import type { RequestActor } from '../ports.js';
import type { Transaction } from '@been-there/contracts';

/**
 * A route table, matched by hand.
 *
 * Node's `http` server has no router and the brief rules out adding a framework
 * to solve one, so this is the whole of it: an ordered list of method + path
 * patterns, and a matcher that walks the segments. A list rather than a lookup
 * table because the route set is fixed at startup and small, and because a
 * `Map` keyed by a path string is a second place where the set of endpoints is
 * written down — the one that would not be checked against the handlers.
 *
 * The matcher distinguishes "no such path" from "that path, wrong verb", because
 * collapsing them to 404 would tell a client its URL was wrong when its method
 * was, and the two have completely different fixes.
 */

export interface RouteRequest {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  /** The parsed JSON body. An empty object for a request that carried none. */
  readonly body: Readonly<Record<string, unknown>>;
  readonly actor: RequestActor;
  readonly now: Date;
  /**
   * The request's transaction. Handed to every store method the handler calls,
   * so a handler that writes two rows cannot accidentally put them in two
   * transactions — the unit of work is the request, not the method.
   */
  readonly tx: Transaction;
  /**
   * The peer's address, for the per-address rate limits the account spec
   * requires (`signup_per_ip`, `recovery_per_source`).
   *
   * Taken from the socket, never from a header a client can set: an
   * `X-Forwarded-For` a caller controls is not a rate-limit key, it is a
   * suggestion. A deployment behind a proxy that does not terminate the
   * connection sees the proxy's address, which fails *closed* — everyone
   * shares one bucket — rather than open, which is the failure that matters
   * for an abuse control.
   *
   * Optional because a non-transactional route has no connection to read it
   * from; a handler that needs it should treat its absence as "no key", which
   * the rate-limit code decides.
   */
  readonly clientAddress: string | null;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export type RouteHandler = (request: RouteRequest) => Promise<Result<HttpResponse, DomainError>>;

export interface Route {
  readonly method: string;
  /** Literal segments, or `:name` for a captured one. */
  readonly pattern: readonly string[];
  readonly handle: RouteHandler;
  /**
   * Reached without a session. Sign-up, sign-in and recovery are the three
   * routes a caller cannot present a session to, because holding one is the
   * thing they are trying to get, or to get back.
   *
   * It is a property of the route rather than something a request can claim, so
   * no client can opt itself out of authentication: the only way to reach a
   * protected handler without a session is for that handler to be declared
   * public in this table, which is a reviewed line rather than a header.
   */
  readonly public: boolean;
  /**
   * Whether the request runs inside `transaction.run`.
   *
   * False exists for exactly one reason: readiness has to be answerable *while*
   * the database is unreachable. With a dead pool, `transaction.run` throws
   * before a handler is reached, so a readiness probe that took a transaction
   * would answer 503 on a transient database fault and every replica would be
   * restarted — turning a degradation into an outage.
   *
   * A non-transactional route is handed `PASSIVE_TRANSACTION`, whose client is
   * `undefined`, so a store call from one throws rather than silently doing
   * nothing. The flag is opt-out and defaults true: a new route is transactional
   * unless someone deliberately decides otherwise, which is a reviewed line.
   */
  readonly transactional: boolean;
}

export interface RouteOptions {
  readonly transactional?: boolean;
}

function routeOf(
  method: string,
  pattern: string,
  handle: RouteHandler,
  isPublic: boolean,
  transactional: boolean,
): Route {
  return {
    method,
    pattern: pattern.split('/').filter((segment) => segment.length > 0),
    handle,
    public: isPublic,
    transactional,
  };
}

export function route(
  method: string,
  pattern: string,
  handle: RouteHandler,
  options: RouteOptions = {},
): Route {
  return routeOf(method, pattern, handle, false, options.transactional ?? true);
}

/**
 * A route reached without a session.
 *
 * Separate from `route` rather than a fourth argument, because "this endpoint is
 * deliberately unauthenticated" is the fact a reviewer needs to see at the call
 * site and an optional boolean is the fact they will not.
 */
export function publicRoute(
  method: string,
  pattern: string,
  handle: RouteHandler,
  options: RouteOptions = {},
): Route {
  return routeOf(method, pattern, handle, true, options.transactional ?? true);
}

export type RouteMatch =
  | { readonly kind: 'matched'; readonly route: Route; readonly params: Readonly<Record<string, string>> }
  | { readonly kind: 'method_not_allowed' }
  | { readonly kind: 'no_such_route' };

function segmentsOf(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

/**
 * `params` is `Readonly<Record<string, string>>`, and `noUncheckedIndexedAccess`
 * means a lookup is `string | undefined` even though the matcher only ever fills
 * a key it just matched a `:name` against. A handler that reads a parameter that
 * was not in its own pattern is a routing bug, so it fails loudly rather than
 * receiving an empty string and phoning home with it.
 */
function capture(pattern: readonly string[], actual: readonly string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index];
    const received = actual[index];
    if (expected === undefined || received === undefined) {
      return null;
    }
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(received);
      continue;
    }
    if (expected !== received) {
      return null;
    }
  }
  return params;
}

export function matchRoute(routes: readonly Route[], method: string, path: string): RouteMatch {
  const segments = segmentsOf(path);
  let pathMatched = false;
  for (const candidate of routes) {
    const params = capture(candidate.pattern, segments);
    if (params === null) {
      continue;
    }
    pathMatched = true;
    if (candidate.method === method) {
      return { kind: 'matched', route: candidate, params };
    }
  }
  return pathMatched ? { kind: 'method_not_allowed' } : { kind: 'no_such_route' };
}

/**
 * A handler answers with a `Result`, not with a status code.
 *
 * A domain refusal is an expected outcome, and the kernel's whole reason for
 * existing is that a caller is *forced* to handle the failure branch. So a
 * handler returns `Result<HttpResponse, DomainError>` and the dispatcher owns
 * the one place where a `DomainError` becomes a status. No handler writes its
 * own status switch, which is what stops "this particular refusal is special"
 * from accumulating into a second, private error vocabulary.
 */

export function okResponse(status: number, body: unknown): Ok<HttpResponse> {
  return ok({ status, body });
}
