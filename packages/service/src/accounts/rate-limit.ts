import { type DomainError, type Result, domainError, ok } from '@been-there/core';
import type { RateLimitBucket, Stores, Transaction } from '@been-there/contracts';

/**
 * The rate limits, as counts over a window.
 *
 * §10 is a table of numbers, and this module is the only place those numbers are
 * written down. They live here rather than beside each route because a limit that
 * is restated at two call sites is a limit whose two copies will disagree, and the
 * disagreement is invisible until someone is refused one request too many.
 *
 * The counters are rows in `account_rate_limit_events`, not counter rows in a
 * table of their own. The migration argues the case: a counter needs an upsert
 * that races, and under concurrency a raced counter is not a rate limit, it is a
 * suggestion. An append-only log needs an index and a count, and the count of a
 * window is the same answer either way.
 *
 * ## What a limit is not
 *
 * A rate limit is a Platform access control. It never sets an account state, never
 * appears in the product as a restriction, and never reaches a moderator queue on
 * its own. Nothing in this module writes an account state or reads one, which is
 * what makes that structural rather than a matter of discipline at the call sites.
 */

/** §10: sign-up per IP, 5 / hour. */
export const SIGNUP_PER_IP_PER_HOUR = 5;

/** §10: sign-up per contact identifier, 3 / day. */
export const SIGNUP_PER_CONTACT_PER_DAY = 3;

/** §6: failed logins per account, 5 / 15 min, then a progressive delay. */
export const LOGIN_ATTEMPTS_PER_WINDOW = 5;

/** §6: the window those failures are counted in. */
export const LOGIN_WINDOW_MINUTES = 15;

/** §10: the longest the progressive post-threshold delay ever reaches. */
export const LOGIN_MAX_DELAY_MINUTES = 15;

/** The window each limit counts over, in one place so the two cannot drift. */
export const WINDOW_MS = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  login: LOGIN_WINDOW_MINUTES * 60 * 1000,
} as const;

/** §9's row for a sign-up refused by a rate limit, verbatim. */
export const RATE_LIMITED_COPY = {
  title: 'Too many attempts from this network.',
  body: 'Try again later, or use a different network.',
} as const;

/**
 * Whether a bucket is over its limit, and the refusal if it is.
 *
 * The count is read before the event is recorded rather than after, so a request
 * that is refused for being over the limit does not itself push the window
 * further: otherwise a client retrying in a tight loop would extend its own lockout
 * indefinitely, and "try again later" would never become true.
 */
export async function withinLimit(
  stores: Stores,
  bucket: RateLimitBucket,
  subjectKey: string,
  limit: number,
  windowMs: number,
  now: Date,
  tx: Transaction,
): Promise<Result<true, DomainError>> {
  const since = new Date(now.getTime() - windowMs);
  const seen = await stores.accounts.countRateLimitEvents(bucket, subjectKey, since, tx);
  if (seen < limit) {
    return ok(true);
  }
  return rateLimited(bucket, limit, windowMs, now);
}

/**
 * The rate-limit refusal, carrying when it lifts.
 *
 * `retryAt` is in the details rather than left for a client to derive: the client
 * does not know the window this bucket uses, and §9 says a refusal the user cannot
 * act on is a defect — "try again later" with no "later" is not actionable.
 */
export function rateLimited(
  bucket: RateLimitBucket,
  limit: number,
  windowMs: number,
  now: Date,
): Result<true, DomainError> {
  const retryAt = new Date(now.getTime() + windowMs);
  return domainError('rate_limited', 'service.accounts', RATE_LIMITED_COPY.body, {
    reason: 'rate_limited',
    title: RATE_LIMITED_COPY.title,
    bucket,
    limit,
    retryAt: retryAt.toISOString(),
  });
}

/** Records one attempt. Called on every attempt, refused or not. */
export async function recordAttempt(
  stores: Stores,
  bucket: RateLimitBucket,
  subjectKey: string,
  now: Date,
  tx: Transaction,
): Promise<void> {
  await stores.accounts.recordRateLimitEvent(bucket, subjectKey, now, tx);
}

/**
 * The delay a login failure earns, once the threshold is crossed.
 *
 * §6 says progressive delay after 5 failures in 15 minutes, capped at 15. The
 * shape is one minute doubling from there: enough that a script is pointless,
 * short enough that a person who fat-fingered their password twice is not locked
 * out of their own account for an afternoon. A flat 15 minutes would satisfy the
 * letter of the rule and be a support ticket.
 */
export function loginDelayMinutes(failuresBeyondThreshold: number): number {
  const minutes = 2 ** Math.max(0, failuresBeyondThreshold);
  return Math.min(minutes, LOGIN_MAX_DELAY_MINUTES);
}