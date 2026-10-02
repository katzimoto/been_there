import { randomUUID } from 'node:crypto';
import { type DomainError, type Result, type UserId, domainError, ok } from '@been-there/core';
import type { SessionRow } from '@been-there/contracts';
import {
  type AuthMethod,
  type Session,
  type SessionRevokeReason,
  enforceSessionLimit,
  issueSession,
  refreshSession,
  revokeSession,
  validateSession,
} from '@been-there/platform';
import { newSessionToken, sessionTokenDigest } from './session-token.js';

/**
 * Sessions, as store rows.
 *
 * `authn.ts` decides *what a session is* — three lifetimes, rotation, the
 * concurrent-session cap — and this module is the only thing that turns one of
 * its `Session` values into a row and back. There is no second policy here: a
 * deadline in this file would be a deadline that could disagree with the one the
 * platform published, and the failure mode is a session that outlives the policy
 * that was meant to bound it.
 *
 * The two conversions are symmetric on purpose. `sessionRowOf` writes every
 * field `issueSession` produced, including the ones that only change on rotation
 * and revocation, and `sessionOf` reads all of them back. A field dropped from
 * either side is a field the next reader believes is absent.
 */

/** The store row, and the platform value, from one issuance. */
export interface IssuedSession {
  /** Returned to the client once. Never stored, never logged. */
  readonly token: string;
  readonly row: SessionRow;
  readonly session: Session;
}

/**
 * Mints a session and the token that resolves to it.
 *
 * The session id and the token are separate values on purpose: the id is what
 * the row is keyed by and what an audit record names, and the token is the secret
 * a caller presents. Reusing one for both would put the lookup key in every log
 * line that mentions a session.
 */
export function issueStoredSession(
  userId: UserId,
  authMethod: AuthMethod,
  now: Date,
): Result<IssuedSession, DomainError> {
  const sessionId = randomUUID();
  const issued = issueSession({
    sessionId: sessionId as Parameters<typeof issueSession>[0]['sessionId'],
    userId,
    authMethod,
    now,
  });
  if (!issued.ok) {
    return issued;
  }
  const token = newSessionToken();
  return ok({
    token,
    session: issued.value,
    row: sessionRowOf(issued.value, sessionTokenDigest(token)),
  });
}

/**
 * A `Session` as a row. The digest travels in rather than being computed, so the
 * caller that minted the token and the row that stores its digest cannot be
 * built from two different hash functions.
 */
export function sessionRowOf(session: Session, tokenDigest: string): SessionRow {
  return {
    sessionId: session.sessionId,
    userId: session.userId,
    authMethod: session.authMethod,
    status: session.status,
    tokenHash: tokenDigest,
    issuedAt: session.issuedAt,
    expiresAt: session.expiresAt,
    refreshableUntil: session.refreshableUntil,
    lastActiveAt: session.lastActiveAt,
    revokedReason: session.revokedReason ?? null,
    supersededBy: session.supersededBy ?? null,
    deviceLabel: null,
    coarseCity: null,
  };
}

/** A row as the `Session` the platform's own functions take. */
export function sessionOf(row: SessionRow): Session {
  return {
    sessionId: row.sessionId as Parameters<typeof issueSession>[0]['sessionId'],
    userId: row.userId,
    authMethod: row.authMethod as AuthMethod,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    refreshableUntil: row.refreshableUntil,
    lastActiveAt: row.lastActiveAt,
    status: row.status as Session['status'],
    ...(row.revokedReason === null ? {} : { revokedReason: row.revokedReason as SessionRevokeReason }),
    ...(row.supersededBy === null
      ? {}
      : { supersededBy: row.supersededBy as Parameters<typeof issueSession>[0]['sessionId'] }),
  };
}

/**
 * The concurrent-session cap, applied to what the store holds.
 *
 * `enforceSessionLimit` returns the kept and evicted sets; this turns that into
 * the rows to write and, when anything was evicted, the fact that the owner has
 * to be told. §6 says the eleventh session evicts the oldest *and notifies the
 * owner*, so the notification is part of this result rather than something the
 * caller remembers to do.
 */
export function applySessionLimit(rows: readonly SessionRow[]): {
  readonly kept: readonly SessionRow[];
  readonly evicted: readonly SessionRow[];
} {
  const limited = enforceSessionLimit(rows.map(sessionOf));
  // `kept` is the whole surviving list — live sessions that made the cap, plus
  // every already-dead one, which is why a superseded row must not be treated as
  // a slot in the cap. Neither set ever contains a session that was not in
  // `rows`, so the row lookup below cannot miss.
  const kept = limited.kept.map((session) => rowById(rows, session.sessionId));
  const evicted = limited.evicted.map((session) => {
    const row = rowById(rows, session.sessionId);
    // Already carries `status: 'revoked'` and `revokedReason: 'session_limit'`:
    // that is the whole of why this branch is not a `revokedRow` call.
    return { ...row, ...sessionRowOf(session, row.tokenHash) };
  });
  return { kept, evicted };
}

function rowById(rows: readonly SessionRow[], sessionId: string): SessionRow {
  const found = rows.find((row) => row.sessionId === sessionId);
  if (found === undefined) {
    // `enforceSessionLimit` only ever returns sessions it was given, so a row
    // that is not here means the two collections came from different reads. That
    // is a defect, and a loud one: a default would silently drop a session the
    // cap just decided to keep.
    throw new Error(
      `session ${sessionId} was returned by the session limit but is not in the rows it was given`,
    );
  }
  return found;
}

/** Whether a session may still authenticate a request, and why not when it may not. */
export function authenticate(row: SessionRow, now: Date): Result<Session, DomainError> {
  return validateSession(sessionOf(row), now);
}

/**
 * Rotation. The old row dies in the same operation that writes the new one, so a
 * stolen token is single-use: the attacker and the legitimate client race, and
 * the second attempt is already superseded.
 */
export function rotateSession(
  row: SessionRow,
  now: Date,
): Result<{ readonly previous: SessionRow; readonly current: SessionRow; readonly token: string }, DomainError> {
  const rotated = refreshSession(sessionOf(row), now, {
    sessionId: randomUUID() as Parameters<typeof issueSession>[0]['sessionId'],
  });
  if (!rotated.ok) {
    return rotated;
  }
  const token = newSessionToken();
  return ok({
    previous: { ...row, ...sessionRowOf(rotated.value.previous, row.tokenHash) },
    current: sessionRowOf(rotated.value.current, sessionTokenDigest(token)),
    token,
  });
}

/**
 * Revocation, as rows.
 *
 * Every path that ends a session goes through here — logout on one device,
 * logout everywhere, recovery, the session cap — so the reason recorded is the
 * reason that happened rather than whatever the call site remembered to pass.
 */
export function revokedRow(row: SessionRow, reason: SessionRevokeReason): SessionRow {
  const revoked = revokeSession(sessionOf(row), reason);
  if (revoked.status === 'superseded') {
    // A rotated-away session stays superseded: `revokeSession` returns it
    // unchanged, and writing a `revoked` status over it would make the history
    // claim it was live when it was not.
    return row;
  }
  return { ...row, ...sessionRowOf(revoked, row.tokenHash) };
}

/** Every session an account holds, as the platform's values. */
export function sessionsOf(rows: readonly SessionRow[]): readonly Session[] {
  return rows.map(sessionOf);
}

/**
 * Revoke every session an account still holds live, for one reason.
 *
 * Used by logout-everywhere and by recovery, and both want the same thing: every
 * live session dead, with the reason recorded so an incident review can tell a
 * voluntary sign-out from a takeover.
 *
 * Returns only the rows that changed, so a caller writes exactly what it revoked.
 * Already-dead rows are skipped rather than re-revoked, because a second
 * revocation of a superseded row would overwrite the reason that explains how it
 * died.
 */
export function revokeAll(
  rows: readonly SessionRow[],
  reason: SessionRevokeReason,
): readonly SessionRow[] {
  return rows.filter((row) => row.status === 'active').map((row) => revokedRow(row, reason));
}