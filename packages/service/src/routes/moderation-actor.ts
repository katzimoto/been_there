import { type ActorId, type DomainError, type Result, castId, domainError, ok } from '@been-there/core';
import { MISSING_FIELD } from '../http/failure.js';
import { readString } from '../http/body.js';
import type { RouteRequest } from '../http/router.js';

/**
 * Who took a moderation action, resolved from the session rather than the body.
 *
 * ## The hole this closes
 *
 * Every case-opening and decision route used to take `moderatorId` from the
 * request body and pass it straight through as `ModeratorActor.actorId` — which
 * is the value written to `cases.opened_by`, `cases.assigned_moderator_id` and
 * `decisions.moderator_id`, and which every audit row on that action names. So
 * the "named human" the decision recorded was a string the caller typed. Any
 * authenticated moderator could attribute a ban to a colleague who had never
 * opened the case, and the record would say that colleague did it.
 *
 * That was survivable only while "authenticated moderator" meant "holder of a
 * shared secret", where there was no individual to impersonate. Now that a
 * moderator is a real named identity, it is the *only* remaining way to make the
 * decision log lie, and it would have made the new identity worthless: a log that
 * records the wrong human is worse than no log, because it is believed.
 *
 * ## Why the body field is compared rather than simply ignored
 *
 * Refusing every request that omits `moderatorId` would be a gratuitous break for
 * clients that send it, and silently ignoring it would leave a caller believing it
 * chose the actor when it did not. So the body value is honoured as a *claim*:
 * it must equal the authenticated identity or the request is refused. A client
 * that sends the right value is unaffected; one that sends someone else's name
 * gets told so rather than quietly overridden.
 *
 * The authenticated identity always wins. The claim can corroborate; it can never
 * substitute.
 */
export function namedModerator(request: RouteRequest): Result<ActorId, DomainError> {
  // From the session, which is the only thing that can say who is calling.
  const actorId = request.actor.actorId;

  const claimed = readString(request.body, 'moderatorId');
  if (!claimed.ok) {
    // Omitting it is a refusal rather than a default. The named-human guard is
    // load-bearing precisely because a decision must name someone, and a handler
    // that quietly filled in the actor would mean the body field was never
    // actually required — which is the state this route is leaving.
    return MISSING_FIELD('moderatorId');
  }

  if (claimed.value !== actorId) {
    return domainError(
      'permission_denied',
      'service.moderation',
      'the moderator named in the request is not the moderator this session belongs to',
      { reason: 'moderator_mismatch' },
    );
  }

  return ok(actorId);
}

/**
 * Casts a caller-supplied string to the actor brand, for the one case where the
 * string has already been proved equal to the session's identity.
 *
 * Kept as a function so the cast appears once. `namedModerator` returns the
 * session's `actorId` already branded, so this exists for callers that have an id
 * in hand from elsewhere and want the brand without restating why it is safe.
 */
export function asActorIdOf(value: string): ActorId {
  return castId<'ActorId'>(value);
}
