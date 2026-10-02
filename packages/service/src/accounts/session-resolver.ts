import { type DomainError, type Result, castId, domainError, ok } from '@been-there/core';
import type { Stores, Transaction } from '@been-there/contracts';
import type { ActorResolver, RequestActor } from '../ports.js';
import { sessionTokenDigest } from './session-token.js';
import { authenticate } from './sessions.js';

/**
 * The actor resolver, backed by the session table.
 *
 * This is the missing half of the authentication surface. `AccountPlatformStore`
 * has a `findSessionByToken` and `ActorResolver` says it resolves the
 * `Authorization` header — and between them, until now, there was nothing: no
 * production code read a session, so no route could be authenticated at all.
 *
 * ## Why the check is here and not in the router
 *
 * A revoked session must not authenticate. That check lives here, once, rather
 * than in each handler or in `handle()`: the router resolves an actor and then
 * runs the handler, so a handler that trusted the actor was trusting a value
 * whose meaning depended on who produced it. One resolver, one predicate —
 * `authenticate`, the platform's own `validateSession` — means "live" has exactly
 * one answer in the system.
 *
 * ## Why it opens its own transaction
 *
 * `ActorResolver.resolve` is called before the request's transaction is opened,
 * because the actor is what decides whether the request is allowed to have one.
 * The read therefore runs in a transaction of its own, which is correct rather
 * than a workaround: the session must be read at a moment in time, and reusing
 * the handler's transaction would mean holding a connection open across the
 * authentication decision for no benefit.
 *
 * ## What it does not do
 *
 * It does not read account standing. §6's post-login check is a *product
 * surface* decision — a `banned` account lands on the closure notice and a
 * `suspended` one on the suspension notice — and a banned user must still be able
 * to reach the appeal and delete-account surfaces, so refusing at the resolver
 * would lock them out of the only routes that help them.
 */
export interface SessionResolverDependencies {
  readonly stores: Stores;
  readonly transaction: Transaction;
  /** One clock, so the resolver and the request agree on "now". */
  readonly now: () => Date;
}

export function createSessionActorResolver(
  dependencies: SessionResolverDependencies,
): ActorResolver {
  return {
    async resolve(authorization: string | undefined): Promise<Result<RequestActor, DomainError>> {
      const token = bearerTokenOf(authorization);
      if (token === null) {
        return unauthenticated();
      }
      const now = dependencies.now();
      const row = await dependencies.transaction.run((tx) =>
        dependencies.stores.accounts.findSessionByToken(sessionTokenDigest(token), tx),
      );
      if (row === null) {
        return unauthenticated();
      }
      const live = authenticate(row, now);
      if (!live.ok) {
        // §9's row: a session that cannot authenticate reads as signed out, and
        // the copy says so rather than exposing which of revoked, superseded and
        // expired it was — those are different reasons to the same answer, and a
        // client that could tell them apart could probe for live sessions.
        return domainError('permission_denied', 'service.accounts', 'this session is no longer valid', {
          reason: 'session_not_live',
          detail: live.error.details?.['reason'] ?? null,
        });
      }
      const userId = live.value.userId;
      return ok({
        userId,
        role: 'user',
        principal: { userId, role: 'user' },
        // From the session, never from the request. That is the runtime half of
        // commitment 2: a resolver that let a header claim it would make every
        // enforcement guarantee a suggestion.
        automated: false,
        actorId: castId<'ActorId'>(userId),
      });
    },
  };
}

/**
 * The bearer token, or `null`.
 *
 * The scheme is matched case-insensitively because RFC 7235 says it is, and a
 * client sending `bearer` has still sent a bearer token — refusing it would be a
 * refusal no user could act on.
 */
function bearerTokenOf(authorization: string | undefined): string | null {
  if (authorization === undefined) {
    return null;
  }
  const separator = authorization.indexOf(' ');
  if (separator < 0 || authorization.slice(0, separator).toLowerCase() !== 'bearer') {
    return null;
  }
  const token = authorization.slice(separator + 1).trim();
  return token.length === 0 ? null : token;
}

/**
 * The refusal for a request that carries no session at all.
 *
 * One shape for "no header", "wrong scheme" and "unknown token", so a caller
 * cannot distinguish an empty `Authorization` from a forged one — which is the
 * same "not an oracle" rule the recovery path follows for a different reason.
 */
function unauthenticated(): Result<RequestActor, DomainError> {
  return domainError('permission_denied', 'service.accounts', 'this request carries no recognised session', {
    reason: 'unauthenticated',
  });
}