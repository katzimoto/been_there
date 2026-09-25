import type { ActorId, DomainError, Result, UserId } from '@been-there/core';
import type { Stores, Transaction } from '@been-there/contracts';
import type { Principal, Role } from '@been-there/platform';

/**
 * What the service is given at the edge, and nothing else.
 *
 * The service holds no pool, opens no connection and knows no store
 * implementation. It is handed a `Stores` and a `Transaction`, both from
 * `@been-there/contracts`, and every request runs inside one `transaction.run`.
 * That is the whole wiring surface, and it is why the composition root can live
 * in `@been-there/database` and change without touching a route.
 */

/**
 * Who is calling.
 *
 * `automated` is not decoration. It is the runtime half of commitment 2, and
 * `packages/moderation` says in terms that the caller which resolved the actor's
 * identity is the one that must set it: a non-null actor id is not evidence of a
 * human, because any service can mint one. The service cannot earn this claim on
 * its own, so it is a port — an authentication layer that resolved a session can
 * state it, and nothing else can.
 */
export interface RequestActor {
  /** `null` for a staff route reached without a member session. */
  readonly userId: UserId | null;
  readonly role: Role;
  /**
   * The same identity as a platform `Principal`, for `authorize`. Carried rather
   * than rebuilt at the call site: a service that assembled its own principal
   * from a user id and a role string would be a second authorisation path, and
   * the two would disagree about exactly the case that matters.
   */
  readonly principal: Principal;
  readonly automated: boolean;
  readonly actorId: ActorId;
}

export interface ActorResolver {
  /**
   * Resolves the `Authorization` header. A refusal is a `DomainError` so it
   * reaches the client through the same status table every other refusal uses,
   * rather than through a second, private one.
   */
  resolve(authorization: string | undefined): Result<RequestActor, DomainError>;
}

export interface ServiceDependencies {
  readonly stores: Stores;
  readonly transaction: Transaction;
  readonly actors: ActorResolver;
  /** One clock per request, so a handler's `now` and the domain's `now` agree. */
  readonly now: () => Date;
}
