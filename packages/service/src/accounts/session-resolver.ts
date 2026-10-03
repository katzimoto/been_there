import {
  type ActorId,
  type DomainError,
  type Result,
  type UserId,
  castId,
  domainError,
  ok,
} from '@been-there/core';
import type { Stores, Transaction } from '@been-there/contracts';
import {
  isStaffRole,
  staffIdentityMayAuthenticate,
  type Session,
} from '@been-there/platform';
import type { ActorResolver, RequestActor } from '../ports.js';
import { sessionTokenDigest } from './session-token.js';
import { authenticate } from './sessions.js';

/**
 * The actor resolver, backed by the session table.
 *
 * ## The one answer to "who is calling"
 *
 * This is the only place a bearer token becomes an identity. Every route's
 * authorisation descends from the `RequestActor` built here, so a caller that
 * wanted a moderator role had to produce a *session row* saying so — and before
 * staff sessions existed, no such row could exist and the role was hardcoded to
 * `user` one line below. Moderation was reachable only because a composition
 * root compared a string before delegating here, which is a second answer to the
 * authentication question living outside the service that enforces it.
 *
 * The role is read from `staff_identities` on **every** request rather than
 * trusted from the session row. That is what makes revocation immediate: a
 * suspension or a demotion writes one row, and the next request reads it. Were
 * the role cached in the session, a demoted moderator would keep working until
 * their token expired — up to the refresh window, which is precisely the window
 * in which you most need the demotion to have happened.
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
      return actorFor(live.value, dependencies, now);
    },
  };
}

/**
 * The `RequestActor` a live session resolves to.
 *
 * The two arms are the whole of the change. A member session yields role `user`
 * and a member principal; a staff session yields the role its identity currently
 * holds, no member principal at all, and an `actorId` that is the staff identity
 * rather than the token that presented it. That last point is what turns an audit
 * row from "someone with the shared secret" into a name.
 */
async function actorFor(
  session: Session,
  dependencies: SessionResolverDependencies,
  now: Date,
): Promise<Result<RequestActor, DomainError>> {
  const subject = session.subject;

  if (subject.kind === 'member') {
    const userId = subject.userId;
    return ok({
      userId,
      role: 'user',
      principal: { userId, role: 'user' },
      // From the session, never from the request. That is the runtime half of
      // commitment 2: a resolver that let a header claim it would make every
      // enforcement guarantee a suggestion.
      automated: false,
      actorId: castId<'ActorId'>(userId),
      sessionId: session.sessionId,
    });
  }

  // A staff session resolves against the identity row, every time. Two refusals
  // live here and nowhere else, because this is the only point where a session
  // and the human behind it are both in hand:
  //
  //  - A suspended identity is refused. This is the switch that does not wait for
  //    a token to expire, and it works precisely because it is read per request.
  //  - A role the platform does not recognise is refused rather than passed to
  //    `authorize`, which would otherwise index `PERMISSIONS_BY_ROLE` with a
  //    string no row defines and answer `undefined.includes(...)` — a crash in
  //    the authorisation path, or worse, a `PERMISSIONS_BY_ROLE` entry added by a
  //    later migration quietly granting a role nobody reviewed for this subject.
  const identity = await dependencies.transaction.run((tx) =>
    dependencies.stores.staff.findStaff(subject.staffId, tx),
  );
  if (identity === null) {
    return staffRefused('this staff identity no longer exists');
  }
  if (!staffIdentityMayAuthenticate(identity.status)) {
    return staffRefused('this staff identity is suspended');
  }
  if (!isStaffRole(identity.role)) {
    return staffRefused('this staff identity holds a role this service does not recognise');
  }

  return ok({
    // No member id, and deliberately not a fabricated one. `Principal` is not
    // nullable, so a staff actor carries a sentinel that matches no real account —
    // the same shape an anonymous caller has. A member route that reads
    // `actor.userId` gets `null` and must handle it, which is the correct answer;
    // a sentinel that *looked* like a user id would not be.
    userId: null,
    role: identity.role,
    principal: { userId: castId<'UserId'>(subject.staffId), role: identity.role },
    // Recorded on the session at issue, not read from the request. A staff
    // identity that is a machine integration must still be refused by
    // `moderation.decision`, and that refusal can only fire if this is honest.
    automated: subject.automated,
    // The identity, never the token. `decisions.moderator_id` and every audit row
    // derive from this, and a value that changes when the token rotates would
    // make the log record credentials rather than people.
    actorId: castId<'ActorId'>(subject.staffId),
    sessionId: session.sessionId,
  });
}

/**
 * The refusal for a staff session that cannot authenticate.
 *
 * Deliberately the same shape as the live-session refusal rather than a new
 * status: from the caller's side "this session is no longer valid" is the whole
 * of what they learn. Which of revoked, suspended, deleted or misconfigured it
 * was goes in the details for an operator reading logs, not in the body a caller
 * can poll to discover whether a given moderator exists.
 */
function staffRefused(detail: string): Result<RequestActor, DomainError> {
  return domainError('permission_denied', 'service.accounts', 'this session is no longer valid', {
    reason: 'session_not_live',
    detail,
  });
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
