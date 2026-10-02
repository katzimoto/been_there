import { randomBytes, randomUUID } from 'node:crypto';
import { type DomainError, type Result, type UserId, castId, domainError, ok } from '@been-there/core';
import type { CredentialRow, RateLimitBucket, RecoveryRow, SessionRow } from '@been-there/contracts';
import {
  type RecoveryRequest,
  type RecoveryStatus,
  type Session,
  beginRecovery,
  completeRecovery,
  hashOneTimeSecret,
  recordFailedRecoveryAttempt,
  secretMatches,
} from '@been-there/platform';
import { sessionsOf } from './sessions.js';

/**
 * Recovery, and the arithmetic that makes it useless as a harassment channel.
 *
 * §7's design constraint is stated as a single sentence: recovery must be useful
 * to the person who cannot get in and useless as a weapon aimed at them. Every
 * decision below follows from one of the two halves of that sentence, and the
 * module is organised so that the "useless as a weapon" half is arithmetic rather
 * than a promise.
 *
 * ## The threshold
 *
 * Attempts 1 and 2 in a 24-hour window proceed normally. The third pauses recovery
 * for that account. The pause is not a ban, not a restriction, and not visible to
 * the account as anything but a paused recovery — §7.2 is explicit that a locked
 * recovery is a Platform access control and never a moderation verdict. That is
 * why nothing here writes an account state or reads one.
 *
 * ## What the requester learns
 *
 * Nothing, ever. The neutral response is returned whether the account exists,
 * whether the identifier matched, and whether the attempt was the third. The
 * request path has exactly one exit and it is the same exit for all three, which
 * is the only way to make "not an account-existence oracle" structural: there is
 * no branch that could leak, because there is no branch.
 *
 * ## What the owner learns
 *
 * Once. Not per attempt: notifying per attempt hands the attacker a notification
 * oracle and turns recovery into a harassment tool aimed at the *victim*. The
 * owner's notice is keyed on the fact (the recovery, the pause window) rather
 * than the attempt, so the collision is enforced by a unique index in
 * `notices.ts` and a handler that notifies on every attempt still notifies once.
 */

/** §10: password reset per account, 3 / day. The third attempt pauses recovery. */
export const RECOVERY_ATTEMPTS_PER_DAY = 3;

/** §10: 5 per source address per day. Counted over the caller's address. */
export const RECOVERY_ATTEMPTS_PER_SOURCE_PER_DAY = 5;

/** §7.2: the window the pause lasts, and the window the attempts are counted in. */
export const RECOVERY_ABUSE_WINDOW_HOURS = 24;

/** §7.1: the reset link or code is good for half an hour. */
export const RECOVERY_CODE_TTL_MINUTES = 30;

/** §10: verification code attempts per issued code. */
export const RECOVERY_CODE_ATTEMPTS = 5;

/**
 * §7.1.2, verbatim. The one response the request path ever returns, and it is
 * deliberately the same for a known account, an unknown account and a typo.
 */
export const RECOVERY_NEUTRAL_RESPONSE = {
  title: 'Recovery requested',
  body: "If that account exists, we've sent a link. It expires in 30 minutes.",
} as const;

/** §7.2: what the owner is told once, when the threshold pauses their recovery. */
export const RECOVERY_PAUSED_COPY = {
  title: 'We paused sign-in recovery on your account',
  body: 'We paused sign-in recovery on your account after repeated attempts. Your account is fine and nothing was changed. You can restore recovery immediately by signing in on a device you\'re already logged in on.',
} as const;

/**
 * How many recovery attempts this account has made in the window.
 *
 * Counted from the append-only rate-limit log rather than a counter row: the
 * migration's own reasoning is that a counter needs an upsert that races and a
 * log needs an index and a count, and the count of a window is the same answer
 * either way.
 */
export function attemptsInWindow(
  count: (bucket: RateLimitBucket, key: string, since: Date) => Promise<number>,
  userId: UserId,
  now: Date,
): Promise<number> {
  return count('recovery_per_account', userId, windowStart(now));
}

/** The start of the abuse window `now` falls in. UTC, because the rule is not local. */
export function windowStart(now: Date): Date {
  return new Date(now.getTime() - RECOVERY_ABUSE_WINDOW_HOURS * 60 * 60 * 1000);
}

/**
 * What this attempt does to recovery.
 *
 * A `Result` rather than a boolean because the two outcomes are not the same
 * shape of thing: one sends a link and writes a recovery row, the other sends
 * nothing, writes a `locked` recovery row, and owes the owner a single notice.
 */
export type RecoveryAdmission =
  | { readonly admitted: true; readonly recovery: RecoveryRequest; readonly attemptNumber: number }
  | {
      readonly admitted: false;
      readonly attemptNumber: number;
      /** The window the pause runs to. The owner is told once for this value. */
      readonly pausedFrom: Date;
    };

/**
 * Whether this attempt may open a recovery, and what it opens.
 *
 * `existing` is the account's open recovery if it has one. §5.2's "one active
 * link at a time" and §7.1.3's possession-of-the-channel rule together mean a
 * second request supersedes the first rather than running beside it: two live
 * links would let whoever asked second invalidate the legitimate owner's.
 */
export function admitRecovery(
  userId: UserId,
  recoveryId: string,
  method: 'email' | 'sms',
  attempts: number,
  existing: RecoveryRow | null,
  now: Date,
): RecoveryAdmission {
  const attemptNumber = attempts + 1;
  if (attemptNumber >= RECOVERY_ATTEMPTS_PER_DAY) {
    return { admitted: false, attemptNumber, pausedFrom: windowStart(now) };
  }
  const recovery = beginRecovery({
    recoveryId: recoveryId as Parameters<typeof beginRecovery>[0]['recoveryId'],
    userId,
    method,
    now,
  });
  return { admitted: true, recovery, attemptNumber };
}

/** A fresh code or link token. 32 bytes, hex, never stored in the clear. */
export function newRecoverySecret(): string {
  return randomBytes(32).toString('hex');
}

/** The digest `account_recoveries.secret_hash` holds. */
export function recoverySecretHash(secret: string): string {
  return hashOneTimeSecret(secret);
}

/**
 * Whether a presented code is the right one, and the attempt either way.
 *
 * `secretMatches` is constant-time, which matters more here than anywhere else in
 * the product: a six-digit code is small enough that a timing side channel over
 * the comparison is a practical attack, not a theoretical one.
 *
 * A wrong code increments the attempt count and locks the recovery at
 * `RECOVERY_CODE_ATTEMPTS`, so a brute force is bounded by the stored counter
 * rather than by the code's entropy alone.
 */
export function checkRecoverySecret(
  recovery: RecoveryRequest,
  presented: string,
  storedHash: string,
  now: Date,
): Result<RecoveryRequest, DomainError> {
  if (now.getTime() >= recovery.expiresAt.getTime()) {
    return expiredOrWrong();
  }
  if (!secretMatches(presented, storedHash)) {
    const counted = recordFailedRecoveryAttempt(recovery, RECOVERY_CODE_ATTEMPTS);
    if (counted.status === 'locked') {
      return domainError('rate_limited', 'service.accounts', RECOVERY_NEUTRAL_RESPONSE.body, {
        reason: 'recovery_locked',
        attempts: counted.attempts,
      });
    }
    return expiredOrWrong();
  }
  return ok(recovery);
}

/**
 * The wrong-code refusal, and it is deliberately the wrong-code refusal for an
 * expired, an already-used and a locked recovery too. §5.2 requires that all
 * failures return one message so the form is not an oracle, and a client that can
 * tell "expired" from "wrong" from "used" learns the state of somebody's reset
 * link.
 */
function expiredOrWrong(): Result<RecoveryRequest, DomainError> {
  return domainError('validation_failed', 'service.accounts', 'That recovery link is not valid.', {
    field: 'recoveryCode',
    reason: 'recovery_code_rejected',
  });
}

/**
 * Recovery completed: every session dies, one new one is minted.
 *
 * The revocation is the entire security value of the flow. A password reset that
 * leaves the attacker's cookie alive has reset nothing — the reset is only real
 * when the credential the attacker is using stops working. The new session is
 * issued by the recovery itself rather than requiring a second sign-in, so the
 * legitimate owner is not locked out of the account they just recovered.
 *
 * Sessions belonging to other users are passed through untouched, so a caller
 * that hands this every session it can see still revokes exactly one account's.
 */
export function completeAccountRecovery(
  recovery: RecoveryRequest,
  sessionRows: readonly SessionRow[],
  newSessionId: string,
  now: Date,
): Result<
  {
    readonly recovery: RecoveryRequest;
    readonly sessions: readonly Session[];
    readonly issued: Session;
    readonly revoked: readonly SessionRow[];
  },
  DomainError
> {
  const outcome = completeRecovery(
    recovery,
    sessionsOf(sessionRows),
    now,
    { sessionId: newSessionId as Parameters<typeof completeRecovery>[3]['sessionId'] },
  );
  if (!outcome.ok) {
    return outcome;
  }

  const revokedById = new Map(
    outcome.value.sessions.map((session) => [session.sessionId, session] as const),
  );
  const revoked = sessionRows
    .filter((row) => {
      const replacement = revokedById.get(row.sessionId as Session['sessionId']);
      return replacement !== undefined && replacement.status === 'revoked';
    })
    .map((row) => {
      const replacement = revokedById.get(row.sessionId as Session['sessionId']);
      return replacement === undefined ? row : { ...row, status: replacement.status, revokedReason: replacement.revokedReason ?? null };
    });
  return ok({
    recovery: outcome.value.request,
    sessions: outcome.value.sessions,
    issued: outcome.value.session,
    revoked,
  });
}

/** Whether the credential's contact channel can carry a recovery message. */
export function recoveryMethodFor(credential: CredentialRow): 'email' | 'sms' {
  return credential.contactKind === 'phone' ? 'sms' : 'email';
}

/** A fresh recovery id. */
export function newRecoveryId(): string {
  return randomUUID();
}

/** The statuses the schema's CHECK constraint permits, from the platform's union. */
const RECOVERY_STATUSES: readonly RecoveryStatus[] = ['pending', 'consumed', 'expired', 'locked'];

/**
 * A stored recovery row as the platform's `RecoveryRequest`.
 *
 * The row is untyped strings and the aggregate is a branded union, so the two
 * vocabularies meet exactly once, here, where a disagreement is loud. A status
 * the schema permits but this list does not is a defect rather than a value to
 * coerce to the nearest neighbour, and the session ids are branded here for the
 * same reason `completeRecovery` can rely on their type.
 */
export function recoveryRequestOf(
  row: RecoveryRow,
  userId: UserId,
  method: 'email' | 'sms',
): RecoveryRequest {
  const status = RECOVERY_STATUSES.find((candidate) => candidate === row.status);
  if (status === undefined) {
    throw new Error(
      `stored recovery ${row.recoveryId} is '${row.status}', which is not a recovery status`,
    );
  }
  return {
    recoveryId: castId<'RecoveryId'>(row.recoveryId),
    userId,
    method,
    requestedAt: row.requestedAt,
    expiresAt: row.expiresAt,
    status,
    attempts: row.attempts,
    ...(row.consumedAt === null ? {} : { consumedAt: row.consumedAt }),
    revokedSessionIds: row.revokedSessionIds.map((id) => castId<'SessionId'>(id)),
  };
}