import {
  type CorrelationId,
  type DomainError,
  type Result,
  type UserId,
  domainError,
  ok,
} from '@been-there/core';
import { type AuditAction, type AuditAppendRequest } from './audit.js';
import { type RecoveryId, type SessionId, asSubjectId } from './ids.js';
import { type ClassifiedRecord, classify } from './redaction.js';

export type SessionStatus = 'active' | 'superseded' | 'revoked';

export type AuthMethod = 'password' | 'passkey' | 'oauth' | 'recovery';

export type SessionRevokeReason =
  | 'user_logout'
  | 'user_requested'
  | 'password_changed'
  | 'recovery_completed'
  | 'moderation_enforcement'
  | 'admin_revocation';

/** Short-lived by design: a leaked access token is useless within a quarter hour. */
export const SESSION_TTL_SECONDS = 15 * 60;
export const REFRESH_WINDOW_SECONDS = 30 * 24 * 60 * 60;

export interface Session {
  readonly sessionId: SessionId;
  readonly userId: UserId;
  readonly authMethod: AuthMethod;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  /** Beyond this, the session is dead and only a fresh credential can revive it. */
  readonly refreshableUntil: Date;
  readonly status: SessionStatus;
  readonly supersededBy?: SessionId;
  readonly revokedReason?: SessionRevokeReason;
}

export interface IssueSessionRequest {
  readonly sessionId: SessionId;
  readonly userId: UserId;
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
    userId: request.userId,
    authMethod: request.authMethod,
    issuedAt: request.now,
    expiresAt: new Date(request.now.getTime() + ttl * 1000),
    refreshableUntil: new Date(request.now.getTime() + refreshWindow * 1000),
    status: 'active',
  });
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
    userId: session.userId,
    authMethod: session.authMethod,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + ttl * 1000),
    // The refresh window is absolute: it does not slide forward on each rotation,
    // otherwise a session that keeps being refreshed would live forever.
    refreshableUntil: session.refreshableUntil,
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
  /** Every session the user held, now dead. */
  readonly sessions: readonly Session[];
  /** The one session that survived: the one recovery just authenticated. */
  readonly session: Session;
}

/**
 * Completing a recovery revokes every session the account had.
 *
 * This is the whole security value of the flow. A password reset that leaves
 * the attacker's cookie alive has reset nothing; the reset is only real when
 * the credential the attacker is using stops working. The new session is minted
 * by the recovery itself, so the owner is not left signed out of their own
 * account.
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
    userId: request.userId,
    authMethod: 'recovery',
    now,
    ...(newSession.ttlSeconds === undefined ? {} : { ttlSeconds: newSession.ttlSeconds }),
  });
  if (!opened.ok) {
    return opened;
  }

  const revokedSessionIds = sessions
    .filter((session) => session.userId === request.userId)
    .map((session) => session.sessionId);

  return ok({
    request: {
      ...request,
      status: 'consumed',
      consumedAt: now,
      revokedSessionIds,
    },
    sessions: sessions.map((session) =>
      session.userId === request.userId
        ? revokeSession(session, 'recovery_completed')
        : session,
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
