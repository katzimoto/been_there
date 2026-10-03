import type { ActorId, DomainError, EventPublisher, Result, UserId } from '@been-there/core';
import type { Stores, Transaction } from '@been-there/contracts';
import type { Principal, Role, SessionId } from '@been-there/platform';
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
export interface ContactMessage {
  readonly userId: UserId;
  readonly channel: 'email' | 'sms';
  /** The address or number, already normalised. */
  readonly address: string;
  readonly subject: string;
  readonly body: string;
  /** Correlates the message with the verification or recovery row it belongs to. */
  readonly referenceId: string;
  readonly secret: string;
}

export interface ContactDelivery {
  deliver(message: ContactMessage): Promise<void>;
}

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
  /**
   * Whether this caller is a service rather than a person. The flag is
   * self-declared and is the weaker half of commitment 2's enforcement; the
   * stronger half is that enforcement transitions require a human actor id
   * nobody but a person-facing entry point can mint.
   */
  readonly automated: boolean;
  readonly actorId: ActorId;
  /**
   * The session this actor was resolved from, or `null` for a caller that had
   * none (the anonymous actor on a public route).
   *
   * Carried so that work already in flight can be abandoned when the credential
   * behind it dies. `resolve` runs in its own transaction *before* the request's,
   * which is right for deciding whether a request may proceed but means a session
   * revoked one millisecond later would otherwise keep authorising until the
   * request finished. A moderator whose access is withdrawn mid-decision must not
   * land that decision, so the handlers re-check this id inside their own
   * transaction. `null` for anonymous callers is honest: there is no session to
   * re-check, which is exactly why a public route cannot be the subject of the
   * revocation race.
   */
  readonly sessionId: SessionId | null;
}

/**
 * A message that carries a credential, and the seam that sends it.
 *
 * A verification code and a reset link are the two messages in the product
 * whose whole content is a secret. They are composed here and handed to the
 * edge, because the service knows what the message must say and the edge is
 * the only place that knows which relay, which sandbox and which retry policy
 * are in play. The secret crosses this boundary exactly once and is never
 * stored: `secretHash` goes to the database, `secret` goes to the relay, and
 * nothing in this process holds both for longer than the request.
 */


export interface ActorResolver {
  /**
   * Resolves the `Authorization` header. A refusal is a `DomainError` so it
   * reaches the client through the same status table every other refusal uses,
   * rather than through a second, private one.
   */
  /**
   * Resolves the `Authorization` header.
   *
   * Async because a real session cannot be resolved any other way: the only
   * thing that maps a bearer token to a caller is a database read. An in-memory
   * session cache would be a second source of truth for authentication, and the
   * two would disagree about exactly the case that matters — a session revoked a
   * millisecond ago. A resolver that trusted a caller-supplied user id would be
   * the thing the `automated` and `principal` fields exist to prevent.
   */
  resolve(authorization: string | undefined): Promise<Result<RequestActor, DomainError>>;
}

export interface ServiceDependencies {
  readonly stores: Stores;
  readonly transaction: Transaction;
  readonly actors: ActorResolver;
  /**
   * The relay for the two messages that carry a credential. Injected rather
   * than constructed because which SMTP host, which SMS gateway, and whether
   * the environment is a sandbox are decisions the edge makes, and a service
   * that opened its own connection would be a second answer to them.
   */
  readonly contacts: ContactDelivery;
  /** One clock per request, so a handler's `now` and the domain's `now` agree. */
  readonly now: () => Date;
}
