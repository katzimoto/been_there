import {
  type CorrelationId,
  type DomainError,
  type Result,
  type UserId,
  domainError,
  ok,
} from '@been-there/core';
import { type AuditAction, type AuditAppendRequest } from './audit.js';
import { type Role } from './authz.js';
import { type RecoveryId, type SessionId, type StaffId, asSubjectId } from './ids.js';
import { type ClassifiedRecord, classify } from './redaction.js';

export type SessionStatus = 'active' | 'superseded' | 'revoked';

/**
 * `staff_password` is named separately rather than reusing `password`. A reader
 * asking "was this a person signing in, or a moderator signing in" gets the
 * answer from the row, and an audit that filed a staff sign-in under an ordinary
 * password sign-in would hide the rarer and more interesting event behind the
 * common one.
 */
export type AuthMethod = 'password' | 'passkey' | 'oauth' | 'recovery' | 'staff_password';

/**
 * What a session authenticates *as*.
 *
 * A discriminated pair rather than a nullable `userId`, and the reason is
 * reachability. `userId: UserId | null` cannot say "no member, and this
 * moderator instead": it permits both nulls, which is a session belonging to
 * nobody, and it permits a populated id, which is a session belonging to a
 * member — so every reader downstream has to work out which case it is in, and
 * the ones that guess wrong are the ones that matter. `routes/account-sessions.ts`
 * had exactly that shape: it read a member id off a session a staff member was
 * holding, which is a member's sign-out revoking a moderator's session. Naming
 * the two cases makes that state unrepresentable instead of merely discouraged.
 *
 * `automated` is a field of the subject rather than of the request because it is
 * a fact about the *credential*, and the moment a session is minted is the last
 * moment it is knowable. Carrying it here is what lets
 * `moderation.decision`'s refusal — which is stated in terms of a caller having
 * to *claim* to be human — still be checked against something that was recorded
 * rather than asserted.
 *
 * ## Why the staff arm carries no role
 *
 * It is tempting to put the role here, beside the identity that holds it. That
 * would be wrong, and the reason is revocation latency rather than tidiness.
 *
 * A role on the session is a role *as of issue time*: writing `role:
 * 'senior_moderator'` onto the row means every live session of that moderator
 * carries the old role until it expires, so demoting them does nothing for as
 * long as their refresh window stays open — up to thirty days. The window in
 * which you most need a demotion to have taken effect is exactly the window a
 * cached role defeats.
 *
 * So the role lives on `staff_identities` and the resolver reads it on every
 * request. The session says *who*; the identity says *what they may do now*.
 * Splitting those is what makes suspension and demotion immediate, and it is why
 * there is deliberately no field here for a value this module cannot keep true.
 *
 * The same reasoning says the resolver must never fall back to a role derived
 * from the subject when the identity row is unreadable. A default is a fabricated
 * authority, and a fabricated authority in an enforcement path is worse than a
 * refusal — so an unreadable identity refuses (see `actorFor`).
 */
export type SessionSubject =
  | { readonly kind: 'member'; readonly userId: UserId }
  | { readonly kind: 'staff'; readonly staffId: StaffId; readonly automated: boolean };

export function memberSubject(userId: UserId): SessionSubject {
  return { kind: 'member', userId };
}

/**
 * The member a session belongs to, or `null` when it belongs to a staff
 * identity.
 *
 * A function rather than a bare `.userId` because the property does not exist on
 * the staff arm: reading `subject.userId` would not compile, which is the point.
 * Every caller that wants the member has to say it wants the member, and the one
 * place that must not have a member — signing a staff session out "everywhere" —
 * gets `null` and has to handle it.
 */
export function memberIdOf(subject: SessionSubject): UserId | null {
  return subject.kind === 'member' ? subject.userId : null;
}

/**
 * Roles a staff identity may hold.
 *
 * `user` is absent because a staff session is not a member session, and `system`
 * because that is the automation role: a directory of humans must not be able to
 * mint a machine, or "a decision requires a person" becomes a directory-management
 * decision rather than an authentication one. This is the same list as the `role`
 * CHECK on `staff_identities`, and a test compares the two rather than leaving
 * the agreement to review.
 */
export const STAFF_ROLES: readonly Role[] = [
  'moderator',
  'senior_moderator',
  'support',
  'identity_privacy_officer',
];

/**
 * The same list as a lookup set. Membership is asked once per authenticated
 * staff request, and a linear scan over a list that exists mainly to be compared
 * against a SQL CHECK is the wrong shape for it. The array stays exported and
 * ordered because that is what the comparison test walks.
 */
const STAFF_ROLE_SET: ReadonlySet<string> = new Set<string>(STAFF_ROLES);

/**
 * Narrows a stored role string to the staff vocabulary.
 *
 * A type guard rather than a cast because the column is `text`: a row written by
 * a migration, a seed, or a future console could hold anything, and a role the
 * platform does not recognise must be refused rather than carried into an
 * authorisation decision as though it meant something.
 */
export function isStaffRole(role: string): role is Role {
  return STAFF_ROLE_SET.has(role);
}

/**
 * Whether a staff identity may hold a session right now.
 *
 * Separate from the session's own status because they are different switches: a
 * session expires on a clock, an identity is suspended by a person deciding they
 * should no longer be trusted. Only the second one has to be immediate, and
 * checking it here is what makes it immediate — every request resolves through
 * this, so a suspension takes effect on the next request rather than whenever the
 * session's refresh window happens to close.
 */
export function staffIdentityMayAuthenticate(status: string): boolean {
  return status === 'active';
}

export type SessionRevokeReason =
  | 'user_logout'
  | 'user_requested'
  | 'password_changed'
  | 'recovery_completed'
  | 'moderation_enforcement'
  | 'session_limit'
  | 'admin_revocation';

/**
 * Three lifetimes, not one. They answer three different questions, and
 * conflating them is how a session policy ends up meaning nothing:
 *
 * - **Access token** — `SESSION_TTL_SECONDS`. Short by design: a leaked access
 *   token is useless within a quarter hour, and every request re-mints it.
 * - **Refresh window** — `REFRESH_WINDOW_SECONDS`. Absolute, and deliberately
 *   *not* sliding. A rolling window refreshed on activity is a session that
 *   never ends: the one credential an attacker stole keeps working as long as the
 *   legitimate owner keeps using the product.
 * - **Idle timeout** — `SESSION_IDLE_TIMEOUT_SECONDS`. The half-life of the
 *   window: a session nobody has touched for a fortnight is dead whatever the
 *   window says. This is the rule that makes an absolute window compatible with
 *   "refreshed on activity" — activity refreshes the *token*, not the window.
 */
export const SESSION_TTL_SECONDS = 15 * 60;
export const REFRESH_WINDOW_SECONDS = 30 * 24 * 60 * 60;
export const SESSION_IDLE_TIMEOUT_SECONDS = 14 * 24 * 60 * 60;

/**
 * Concurrent sessions per account. Past the cap the least recently active
 * session is evicted, because the credential that has been the quiet longest is
 * the one least likely to be a person at the keyboard.
 */
export const MAX_CONCURRENT_SESSIONS = 10;

export interface Session {
  readonly sessionId: SessionId;
  /**
   * Whose session this is. Never derived from the request, never widened, and
   * never a nullable id — see `SessionSubject` for why that last part is the
   * load-bearing one.
   */
  readonly subject: SessionSubject;
  readonly authMethod: AuthMethod;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /** Beyond this, the session is dead and only a fresh credential can revive it. */
  readonly refreshableUntil: Date;
  /** Last request this session authenticated. Sliding; the idle clock. */
  readonly lastActiveAt: Date;
  readonly status: SessionStatus;
  readonly supersededBy?: SessionId;
  readonly revokedReason?: SessionRevokeReason;
}

export interface IssueSessionRequest {
  readonly sessionId: SessionId;
  readonly subject: SessionSubject;
  readonly authMethod: AuthMethod;
  readonly now: Date;
  readonly ttlSeconds?: number;
  readonly refreshWindowSeconds?: number;
}

/**
 * Mints a session. There is no "remember me" path that produces a longer-lived
 * refresh window: a remembered login is a separate credential decision that
 * would need its own audit action, and inventing one here would make the
 * window a value anyone can pass.
 */
export function issueSession(request: IssueSessionRequest): Result<Session, DomainError> {
  const ttl = request.ttlSeconds ?? SESSION_TTL_SECONDS;
  const refreshWindow = request.refreshWindowSeconds ?? REFRESH_WINDOW_SECONDS;
  if (ttl <= 0) {
    return domainError('validation_failed', 'platform', 'session ttl must be positive', {
      ttlSeconds: ttl,
    });
  }
  if (ttl > refreshWindow) {
    return domainError('validation_failed', 'platform', 'session ttl may not exceed the refresh window', {
      ttlSeconds: ttl,
      refreshWindowSeconds: refreshWindow,
    });
  }
  return ok({
    sessionId: request.sessionId,
    subject: request.subject,
    authMethod: request.authMethod,
    issuedAt: request.now,
    expiresAt: new Date(request.now.getTime() + ttl * 1000),
    refreshableUntil: new Date(request.now.getTime() + refreshWindow * 1000),
    lastActiveAt: request.now,
    status: 'active',
  });
}

/**
 * Applies the concurrent-session cap. The eleventh live session evicts the
 * least recently active one rather than refusing the newcomer, so a user who
 * signs in on a new device is not locked out of the old ones they still want —
 * and the sessions that survive are the ten a person actually uses.
 *
 * Evicted sessions come back revoked, so the caller can notify the owner on the
 * channel they are still signed in on: an unexplained sign-out is the only
 * signal they get that a session limit exists.
 *
 * Note the cap counts sessions, not subjects. A staff identity signing in on a
 * second device evicts its own oldest session, which is the intended behaviour:
 * the alternative is a cap that a staff member can grow by rotating identities.
 */
export function enforceSessionLimit(sessions: readonly Session[]): {
  readonly kept: readonly Session[];
  readonly evicted: readonly Session[];
} {
  const live = sessions
    .filter((session) => session.status === 'active')
    .sort((left, right) => right.lastActiveAt.getTime() - left.lastActiveAt.getTime());
  const kept = live.slice(0, MAX_CONCURRENT_SESSIONS);
  const evicted = live
    .slice(MAX_CONCURRENT_SESSIONS)
    .map((session) => revokeSession(session, 'session_limit'));
  const keptIds = new Set(kept.map((session) => session.sessionId));
  return {
    kept: sessions.filter((session) => session.status !== 'active' || keptIds.has(session.sessionId)),
    evicted,
  };
}

/**
 * A session authenticates a request only while it is `active` and unexpired.
 * Revoked and superseded sessions are refused for the same reason — the caller
 * is not authenticated — but the reason detail differs so a support console can
 * tell "signed out" from "still open, just idle".
 */
export function validateSession(session: Session, now: Date): Result<Session, DomainError> {
  if (session.status === 'revoked') {
    return domainError('permission_denied', 'platform', 'session was revoked', {
      reason: session.revokedReason ?? 'revoked',
    });
  }
  if (session.status === 'superseded') {
    return domainError('permission_denied', 'platform', 'session was rotated away', {
      reason: 'superseded',
    });
  }
  if (now.getTime() >= session.expiresAt.getTime()) {
    return domainError('permission_denied', 'platform', 'session expired', { reason: 'expired' });
  }
  return ok(session);
}

export interface RefreshOutcome {
  readonly current: Session;
  readonly previous: Session;
}

/**
 * Refresh is rotation, always. The old session dies in the same operation that
 * issues the new one, so a stolen refresh token is single-use: the attacker and
 * the legitimate client race, and the second attempt is already dead.
 *
 * The subject is copied rather than re-resolved, and that is deliberate on the
 * staff side. Re-reading the identity's role here would make a refresh a moment
 * where a moderator's authority could change; carrying the subject forward makes
 * rotation purely about the credential, with authority settled on every request
 * by the resolver. A demotion therefore cannot be undone by holding an old token.
 */
export function refreshSession(
  session: Session,
  now: Date,
  next: { readonly sessionId: SessionId; readonly ttlSeconds?: number },
): Result<RefreshOutcome, DomainError> {
  const live = validateSessionRefreshable(session, now);
  if (!live.ok) {
    return live;
  }
  const ttl = next.ttlSeconds ?? SESSION_TTL_SECONDS;
  if (ttl > REFRESH_WINDOW_SECONDS) {
    return domainError('validation_failed', 'platform', 'refreshed ttl may not exceed the refresh window', {
      ttlSeconds: ttl,
    });
  }
  const refreshed: Session = {
    sessionId: next.sessionId,
    subject: session.subject,
    authMethod: session.authMethod,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + ttl * 1000),
    // The refresh window is absolute: it does not slide forward on each rotation,
    // otherwise a session that keeps being refreshed would live forever. Activity
    // does slide — that is the whole of what "refreshed on activity" means.
    refreshableUntil: session.refreshableUntil,
    lastActiveAt: now,
    status: 'active',
  };
  const previous: Session = {
    ...session,
    status: 'superseded',
    supersededBy: next.sessionId,
  };
  return ok({ current: refreshed, previous });
}

function validateSessionRefreshable(session: Session, now: Date): Result<true, DomainError> {
  if (session.status !== 'active') {
    return domainError('permission_denied', 'platform', `session is ${session.status}`, {
      reason: session.status,
    });
  }
  if (now.getTime() >= session.refreshableUntil.getTime()) {
    return domainError('permission_denied', 'platform', 'refresh window closed', {
      reason: 'refresh_window_closed',
    });
  }
  if (now.getTime() - session.lastActiveAt.getTime() >= SESSION_IDLE_TIMEOUT_SECONDS * 1000) {
    // The idle clock, which is what makes an absolute window survivable. It is
    // checked here and not in `validateSession` because a fortnight is also
    // fifty-eight thousand access tokens: by then the token is long expired, so
    // "idle" would be a reason no caller could ever observe. The two refusals
    // stay distinct because one is routine and the other is a signal.
    return domainError('permission_denied', 'platform', 'session went idle', { reason: 'idle' });
  }
  return ok(true);
}

export function revokeSession(
  session: Session,
  reason: SessionRevokeReason,
): Session {
  if (session.status === 'superseded') {
    // A rotated-away session stays superseded; the revocation is a no-op so the
    // history does not claim it was live when it was not.
    return session;
  }
  return { ...session, status: 'revoked', revokedReason: reason };
}

export type RecoveryMethod = 'email' | 'sms' | 'device_code';

export type RecoveryStatus = 'pending' | 'consumed' | 'expired' | 'locked';

export const RECOVERY_TTL_SECONDS = 30 * 60;

export interface RecoveryRequest {
  readonly recoveryId: RecoveryId;
  readonly userId: UserId;
  readonly method: RecoveryMethod;
  readonly requestedAt: Date;
  readonly expiresAt: Date;
  readonly status: RecoveryStatus;
  readonly attempts: number;
  readonly consumedAt?: Date;
  /** Sessions this recovery killed, kept so the takeover point is reconstructable. */
  readonly revokedSessionIds: readonly SessionId[];
}

export function beginRecovery(
  request: {
    readonly recoveryId: RecoveryId;
    readonly userId: UserId;
    readonly method: RecoveryMethod;
    readonly now: Date;
  },
): RecoveryRequest {
  return {
    recoveryId: request.recoveryId,
    userId: request.userId,
    method: request.method,
    requestedAt: request.now,
    expiresAt: new Date(request.now.getTime() + RECOVERY_TTL_SECONDS * 1000),
    status: 'pending',
    attempts: 0,
    revokedSessionIds: [],
  };
}

export interface RecoveryOutcome {
  readonly request: RecoveryRequest;
  /** Every session the account had, now dead. */
  readonly sessions: readonly Session[];
  /** The one session that survived: the one recovery just authenticated. */
  readonly session: Session;
}

/**
 * Completing a recovery revokes every session the account had.
 *
 * This is the whole security value of the flow. A password reset that leaves the
 * attacker's cookie alive has reset nothing; the reset is only real when the
 * credential the attacker is using stops working. The new session is minted by
 * the recovery itself, so the owner is not left signed out of their own account.
 *
 * The comparison is on the member arm of the subject. A member recovering their
 * account must not revoke a moderator's session — that would make "forgot my
 * password" a way to lock a colleague out of the queue — and matching on a
 * nullable `userId` could not have said so, because a staff session and a
 * not-yet-minted one are both "no user id". Naming the arm is what makes the
 * difference expressible.
 */
export function completeRecovery(
  request: RecoveryRequest,
  sessions: readonly Session[],
  now: Date,
  newSession: { readonly sessionId: SessionId; readonly ttlSeconds?: number },
): Result<RecoveryOutcome, DomainError> {
  if (request.status !== 'pending') {
    return domainError('invalid_transition', 'platform', `recovery is ${request.status}`, {
      status: request.status,
    });
  }
  if (now.getTime() >= request.expiresAt.getTime()) {
    return domainError('invalid_transition', 'platform', 'recovery request expired', {
      status: 'expired',
    });
  }
  const opened = issueSession({
    sessionId: newSession.sessionId,
    subject: memberSubject(request.userId),
    authMethod: 'recovery',
    now,
    ...(newSession.ttlSeconds === undefined ? {} : { ttlSeconds: newSession.ttlSeconds }),
  });
  if (!opened.ok) {
    return opened;
  }

  const isRecoveredAccount = (session: Session): boolean =>
    session.subject.kind === 'member' && session.subject.userId === request.userId;

  const revokedSessionIds = sessions.filter(isRecoveredAccount).map((session) => session.sessionId);

  return ok({
    request: {
      ...request,
      status: 'consumed',
      consumedAt: now,
      revokedSessionIds,
    },
    sessions: sessions.map((session) =>
      isRecoveredAccount(session) ? revokeSession(session, 'recovery_completed') : session,
    ),
    session: opened.value,
  });
}

export function recordFailedRecoveryAttempt(request: RecoveryRequest, maxAttempts: number): RecoveryRequest {
  const attempts = request.attempts + 1;
  return {
    ...request,
    attempts,
    status: attempts >= maxAttempts ? 'locked' : request.status,
  };
}

/**
 * Recovery is a security event, so the audit fields it contributes are built
 * here rather than at whichever call site remembered. Note what is absent: no
 * email address, no phone number, no token — only the fact, the method, and the
 * blast radius. Those three are what an incident review needs.
 */
export function recoveryAuditFields(
  request: RecoveryRequest,
  outcome?: { readonly revokedSessionIds: readonly SessionId[] },
): ClassifiedRecord {
  return [
    classify('recovery_id', 'internal', request.recoveryId),
    classify('method', 'internal', request.method),
    classify('status', 'internal', request.status),
    classify('attempts', 'internal', request.attempts),
    classify('revoked_session_count', 'internal', outcome?.revokedSessionIds.length ?? 0),
  ];
}

export function recoveryAuditRequest(
  action: Extract<AuditAction, `auth.recovery_${string}`>,
  request: RecoveryRequest,
  occurredAt: Date,
  correlationId: CorrelationId,
  outcome?: { readonly revokedSessionIds: readonly SessionId[] },
): AuditAppendRequest {
  return {
    action,
    actorId: 'system',
    subjectId: asSubjectId(request.userId),
    occurredAt,
    correlationId,
    fields: recoveryAuditFields(request, outcome),
  };
}
