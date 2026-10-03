import { randomUUID } from 'node:crypto';
import { type DomainError, type Result, type UserId, domainError, ok } from '@been-there/core';
import type { SessionRow } from '@been-there/contracts';
import {
  type AuthMethod,
  type Role,
  type Session,
  type SessionRevokeReason,
  type SessionSubject,
  type StaffId,
  enforceSessionLimit,
  isStaffRole,
  issueSession,
  memberSubject,
  refreshSession,
  revokeSession,
  staffIdentityMayAuthenticate,
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
  return issueStoredSessionFor(memberSubject(userId), authMethod, now);
}

/**
 * Mints a session for an explicit subject.
 *
 * The subject-taking form is what makes staff sessions a first-class issuance
 * rather than a special case bolted onto the member one: there is one code path
 * from "a credential was verified" to "a row exists", so a staff session gets the
 * same rotation, the same cap and the same digest handling as a member's, and
 * there is no second place for those rules to be restated.
 */
export function issueStoredSessionFor(
  subject: SessionSubject,
  authMethod: AuthMethod,
  now: Date,
): Result<IssuedSession, DomainError> {
  const sessionId = randomUUID();
  const issued = issueSession({
    sessionId: sessionId as Parameters<typeof issueSession>[0]['sessionId'],
    subject,
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
  const subject = session.subject;
  return {
    sessionId: session.sessionId,
    // Written through the subject rather than off `session.userId`, which no
    // longer exists: a staff session has no member id and a member session has no
    // staff id, and the row's CHECK is what guarantees the pair agrees. Writing
    // both columns from one discriminated value means the row can never disagree
    // with itself.
    userId: subject.kind === 'member' ? subject.userId : null,
    subjectKind: subject.kind,
    staffId: subject.kind === 'staff' ? subject.staffId : null,
    // From the subject, not a constant. A member session is always a person, so
    // this is false on that arm; a staff session carries what its issuer said.
    automated: subject.kind === 'staff' && subject.automated,
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
    subject: subjectOf(row),
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
 * The subject a stored row claims.
 *
 * This is the read side of the one-subject guarantee, and it is deliberately
 * strict. The row's CHECK already makes `user_id IS NULL` and `staff_id IS NULL`
 * impossible together, so a violation here means the row did not come from this
 * schema — a hand-written insert, a restored backup, a future migration that
 * widened the CHECK. Throwing is the right answer to that: the alternative is
 * inventing a subject from half a row and authenticating on it, which is the
 * exact failure this whole design exists to make impossible.
 *
 * A staff row also carries no role, and that is not an omission. The role lives
 * on `staff_identities` and is read fresh by the resolver on every request, so
 * demoting a moderator takes effect immediately rather than whenever their
 * sessions happen to expire. A role cached here would reintroduce the wait.
 *
 * `automated` is read back from the row rather than defaulted, because it is a
 * property of how the credential was presented at issue time and nothing else
 * records it — so a default here would silently reclassify a machine as a person.
 */
function subjectOf(row: SessionRow): SessionSubject {
  if (row.subjectKind === 'staff') {
    if (row.staffId === null || row.userId !== null) {
      throw new Error(
        `account_sessions ${row.sessionId} claims subject_kind 'staff' but its subject columns disagree`,
      );
    }
    // No role, and no placeholder for one. The subject names *who*; the role is
    // read from `staff_identities` by the resolver on every request, which is
    // what makes a demotion immediate rather than effective at token expiry. A
    // role filled in here would be an authority no row can revoke.
    // Read back from the row rather than defaulted. Defaulting to `false` here
    // would read every automated staff session as human, and the domain guard
    // that refuses automation would never fire — the guard would be present,
    // tested, and inert.
    return { kind: 'staff', staffId: castStaffId(row.staffId), automated: row.automated };
  }
  if (row.userId === null || row.staffId !== null) {
    throw new Error(
      `account_sessions ${row.sessionId} claims subject_kind 'member' but its subject columns disagree`,
    );
  }
  return memberSubject(row.userId);
}

function castStaffId(value: string): StaffId {
  return value as StaffId;
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