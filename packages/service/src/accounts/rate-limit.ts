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

/**
 * §9's row for a sign-up refused by a rate limit, verbatim.
 *
 * This is also the answer to what a refusal is allowed to say. It names a network
 * and never a contact, so a caller who trips `signup_per_ip` learns the same thing
 * whether or not the address they typed is registered — which is the §5.3 rule,
 * and the only reason a per-address refusal is safe to return as anything other
 * than the generic failure. "Try again later, or use a different network" is also
 * actionable, which §9 requires of every refusal: a refusal the user cannot act
 * on is a defect.
 */
export const RATE_LIMITED_COPY = {
  title: 'Too many attempts from this network.',
  body: 'Try again later, or use a different network.',
} as const;

/**
 * How much of an IPv6 address a per-address limit counts over: the /64 routing
 * prefix.
 *
 * ## Why a prefix and not the whole address
 *
 * A single IPv6 subscriber is routinely delegated a /64 — 2^64 addresses — by
 * every ISP and mobile carrier in the world, because a /64 is the smallest block
 * RFC 6177 says should be handed to one site. Keying `signup_per_ip` on the full
 * address therefore does not limit a subscriber at all: a caller holding one
 * prefix can generate an unbounded number of addresses inside it and the limit
 * never trips. That is not only an attacker. It is a phone with `ip privacy`
 * enabled, which rotates the interface identifier every few minutes by default
 * while keeping the prefix. A limit that a default phone setting defeats is not a
 * limit.
 *
 * So the key is the /64. What that costs is granularity: a /64 is a household or
 * a mobile subscriber rather than a person, so five sign-ups an hour is shared
 * across everyone behind one allocation. That is the right way round here — a
 * household creating five accounts in an hour is not a legitimate pattern, and
 * §10's number is small enough that the false-positive cost is one person waiting
 * out an hour.
 *
 * ## Why IPv4 is not widened to a prefix
 *
 * An IPv4 subscriber gets one address, usually behind carrier NAT, so there is no
 * per-subscriber block to rotate within and nothing to gain. Truncating IPv4 to a
 * /24 would merge 256 addresses — an office block, a campus, a carrier range —
 * into one bucket, and five sign-ups an hour across a university is a
 * false-positive machine. The IPv4 key is the address.
 *
 * ## What a rotating attacker still gets
 *
 * Stated plainly because it is the question this design exists to answer: an
 * attacker holding N prefixes gets N x 5 sign-ups an hour, and this key does not
 * reduce that. Lowering it needs a signal that is not an address, which is a
 * detector's proposal rather than an access control. What this limit does buy is
 * that the cheap attack — one connection spraying five accounts — stops, and the
 * layers that actually resist enumeration are `signup_per_contact` (3/day, keyed
 * on the identifier, unrotatable without disposable mail) and the fact that a
 * duplicate answer is itself generic.
 */
export const IPV6_PREFIX_BITS = 64;

/** The bucket key used when there is no address to count over. */
const UNKNOWN_SOURCE_KEY = 'unknown-source';

/** Four dotted octets, each 0-255, and nothing else. */
function isIpv4(value: string): boolean {
  const parts = value.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Eight groups of one to four hex digits, with at most one `::`.
 *
 * Deliberately strict. A permissive parser here would accept strings no peer can
 * be addressed by, and since every distinct spelling of one address is a distinct
 * bucket, leniency here is a hole rather than a kindness.
 */
function isIpv6(value: string): boolean {
  const compressions = value.split('::').length - 1;
  if (compressions > 1) {
    return false;
  }
  const groups = value
    .split(':')
    .filter((group) => group !== '' && group !== undefined);
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return false;
  }
  return compressions === 1 ? groups.length <= 7 : groups.length === 8;
}

/** `::ffff:a.b.c.d`, the form a dual-stack listener reports IPv4 peers in. */
const IPV4_MAPPED = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/;

/**
 * An IPv6 address as exactly eight numeric groups, expanding `::`, or null.
 *
 * The single place compression is resolved, so `::1` and `0:0:0:0:0:0:0:1` read
 * as one address and therefore share one bucket. Returns null only where
 * `isIpv6` would already have rejected the input.
 */
function expandGroups(address: string): number[] | null {
  const compressed = address.includes('::');
  const [head, tail] = compressed ? address.split('::') : [address, ''];
  const left = (head ?? '').split(':').filter((group) => group !== '');
  const right = (tail ?? '').split(':').filter((group) => group !== '');
  if (left.length + right.length > 8) {
    return null;
  }
  const parsed = [...left, ...right].map((group) => Number.parseInt(group, 16));
  return [...parsed.slice(0, left.length), ...new Array<number>(8 - parsed.length).fill(0), ...parsed.slice(left.length)];
}

/**
 * The `subject_key` a per-address limit counts over.
 *
 * Returns a key, never null: a request whose peer address cannot be read is
 * counted under one shared `unknown-source` key rather than skipped. Skipping
 * would make an unreadable address an unlimited one, and the deployments that lose
 * the client address — a proxy that does not terminate, a unix socket — are
 * exactly the ones where an abuse control earns its keep. Sharing one bucket is a
 * denial of service against legitimate traffic, and that is the price; no control
 * at all on the configurations where callers cannot be told apart is worse.
 */
export function sourceKey(clientAddress: string | null | undefined): string {
  if (clientAddress === null || clientAddress === undefined) {
    return UNKNOWN_SOURCE_KEY;
  }
  // A zone index (`fe80::1%en0`) names a local interface and is not part of the
  // address, so it is stripped before anything else.
  const bare = clientAddress.trim().split('%')[0]?.toLowerCase() ?? '';
  if (isIpv4(bare)) {
    return `v4:${bare}`;
  }
  // Unwrapped rather than keyed as its own /64, or every IPv4 caller would get a
  // bucket separate from the one an IPv4-only listener hands them.
  const mapped = IPV4_MAPPED.exec(bare);
  if (mapped !== null) {
    const inner = mapped[1] ?? '';
    return isIpv4(inner) ? `v4:${inner}` : UNKNOWN_SOURCE_KEY;
  }
  const groups = isIpv6(bare) ? expandGroups(bare) : null;
  if (groups === null) {
    return UNKNOWN_SOURCE_KEY;
  }
  // The /64, zero-padded so two spellings of one prefix cannot be two keys.
  const prefix = groups
    .slice(0, IPV6_PREFIX_BITS / 16)
    .map((group) => group.toString(16).padStart(4, '0'))
    .join(':');
  return `v6:${prefix}::/${IPV6_PREFIX_BITS}`;
}

/**
 * Whether a bucket is over its limit, and the refusal if it is.
 *
 * Takes the subject lock first and holds it until the request's transaction ends.
 * Counting a window and appending to it are two statements, and a limit decided
 * between them is decided on a count another request can change before this one
 * acts on it: two concurrent sign-ups from one address can each read four and each
 * pass a limit of five. A sequential test never sees that; a parallel one does,
 * reliably. The lock is `pg_advisory_xact_lock` in the store, keyed on `(bucket,
 * subjectKey)` — the service issues no SQL, because a lock spelled out in a route
 * would be a second place that knows the store's dialect.
 */
export async function checkLimit(
  stores: Stores,
  bucket: RateLimitBucket,
  subjectKey: string,
  limit: number,
  windowMs: number,
  now: Date,
  tx: Transaction,
): Promise<Result<true, DomainError>> {
  await stores.accounts.lockRateLimitSubject(bucket, subjectKey, tx);
  const since = new Date(now.getTime() - windowMs);
  const seen = await stores.accounts.countRateLimitEvents(bucket, subjectKey, since, tx);
  return seen < limit ? ok(true) : rateLimited(bucket, limit, windowMs, now);
}

/**
 * Whether a bucket is over its limit, without taking the lock.
 *
 * For the caller that has already serialised its subject by other means — the
 * login path, where the credential row's own lock is taken before the password is
 * checked. It does not lock, because a caller that locks separately must not meet
 * a second, differently-keyed lock here; `checkLimit` is the one to reach for
 * when nothing else has serialised the subject.
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
  return seen < limit ? ok(true) : rateLimited(bucket, limit, windowMs, now);
}

/**
 * The rate-limit refusal, carrying when it lifts.
 *
 * `retryAt` is in the details rather than left for a client to derive: the client
 * does not know which window this bucket uses, and §9 says a refusal the user
 * cannot act on is a defect — "try again later" with no "later" is not actionable.
 */
export function rateLimited(
  bucket: RateLimitBucket,
  limit: number,
  windowMs: number,
  now: Date,
): Result<true, DomainError> {
  return domainError('rate_limited', 'service.accounts', RATE_LIMITED_COPY.body, {
    reason: 'rate_limited',
    title: RATE_LIMITED_COPY.title,
    bucket,
    limit,
    retryAt: new Date(now.getTime() + windowMs).toISOString(),
  });
}

/**
 * Records one attempt. Called on every attempt, refused or not.
 *
 * Including the refused ones, and that is the whole point of the append-only log.
 * A log that only counted the attempts it allowed would let a caller whose sixth
 * try was refused make a seventh, an eighth and a ninth, each of which would also
 * have been allowed had the first not been counted — so the limit would hold
 * against a caller who tries six times and evaporate against one who tries six
 * hundred. Refused attempts are also what makes the log worth auditing: a source
 * that trips the limit five times then stops is a different event from one that
 * trips it once.
 */
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
  return Math.min(2 ** Math.max(0, failuresBeyondThreshold), LOGIN_MAX_DELAY_MINUTES);
}
