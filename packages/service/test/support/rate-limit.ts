/**
 * Fixtures shared by the per-address rate-limit suites.
 *
 * `signup_per_ip` and `recovery_per_source` are the two limits in §10 whose unit
 * is the caller's address, and they are the two the rest of the repository cannot
 * reach: every other request here arrives from `127.0.0.1`, so without a way to
 * present a distinct peer address there would be exactly one `signup_per_ip`
 * bucket on the machine and the sixth sign-up of the whole test run would fail.
 * The harness installs `peerAddressFrom`, which is the hook a deployment behind
 * a trusted proxy installs, so what is exercised is a production path rather than
 * a test-only branch.
 *
 * These live here rather than in either suite because the address scheme is the
 * part that must agree: two suites minting buckets from different rules would
 * collide without either being wrong, and the collision would surface as one
 * limit's budget having been spent by the other's fixture.
 */
import { expect } from 'vitest';
import { type Harness, type JsonResponse, call } from './harness.js';

export const NO_SESSION = 'no-session-needed';

const PASSWORD = 'correct horse battery staple';
const TERMS_VERSION = '2026-09-01';

/** §10: 5 sign-up attempts per IP per hour. */
export const SIGNUP_LIMIT = 5;
/** §7.1: 5 recovery requests per source address per day. */
export const RECOVERY_LIMIT = 5;

/**
 * The key every request shares when its peer address cannot be read at all.
 *
 * Mirrors `UNKNOWN_SOURCE_KEY`, which the service module does not export.
 */
export const UNKNOWN_SOURCE_KEY = 'unknown-source';

/** The key a loopback socket address derives to. */
export const LOOPBACK_KEY = 'v4:127.0.0.1';

let sequence = 0;

/**
 * A contact identifier no other attempt in this run will use.
 *
 * Unique rather than shared so a test's account is never refused as a duplicate,
 * which would be a different refusal with the same status and would make a
 * rate-limit assertion pass for the wrong reason.
 */
export function uniqueContact(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.pid}-${sequence}-${Date.now().toString(36)}@beenthere.dev`;
}

/**
 * Per-run octets, so two runs never share a bucket.
 *
 * `account_rate_limit_events` is append-only and nothing prunes it, so a fixed
 * test address accumulates every attempt any previous run made against it.
 * Without this the first sign-up of a later run reads a count of five left by an
 * earlier one and is refused — a failure that says nothing about the code under
 * test, and one that gets *more* likely the faster the suite is run.
 */
const RUN_OCTET_A = Math.floor(Math.random() * 254) + 1;
const RUN_OCTET_B = Math.floor(Math.random() * 254) + 1;

/** A valid IPv4 address unique to this run, for a named subject. */
export function addressFor(subject: number): string {
  return `198.${RUN_OCTET_A}.${RUN_OCTET_B}.${subject}`;
}

/** The same, in the other documentation range, for the recovery suite. */
export function recoveryAddressFor(subject: number): string {
  return `203.${RUN_OCTET_A}.${RUN_OCTET_B}.${subject}`;
}

/**
 * Per-run hextet, so an IPv6 prefix is as run-specific as the IPv4 addresses are.
 */
const RUN_HEXTET = ((RUN_OCTET_A << 8) | RUN_OCTET_B).toString(16).padStart(4, '0');

/**
 * An IPv6 address in the documentation range, `subject` selecting the /64 and
 * `host` the interface identifier inside it.
 *
 * `2001:db8:<run>:0001::1` and `2001:db8:<run>:0001::2` are one subscriber's two
 * addresses; `subject` 2 is a different subscriber entirely. The split matters
 * because §10's key is the /64, not the address — see `IPV6_PREFIX_BITS` in
 * `accounts/rate-limit.ts` for why, and for what it costs.
 */
export function ipv6For(subject: number, host: number): string {
  return `2001:db8:${RUN_HEXTET}:${subject.toString(16).padStart(4, '0')}::${host.toString(16)}`;
}

/** A well-formed adult sign-up, varying only the contact. */
export function signUpFor(target: Harness, contact: string): Promise<JsonResponse> {
  return call(target, 'POST', '/v1/accounts', NO_SESSION, {
    contact,
    password: PASSWORD,
    dateOfBirth: '1994-03-02',
    termsVersion: TERMS_VERSION,
  });
}

/** A recovery request. The response is neutral whatever the service decided. */
export function requestRecovery(target: Harness, contact: string): Promise<JsonResponse> {
  return call(target, 'POST', '/v1/account-recovery', NO_SESSION, { contact });
}

/**
 * One recovery request against `target`, for handing to `map`.
 *
 * `Promise.all` takes promises rather than a lazy list, so a concurrency test
 * needs a one-argument form to fire a whole list at once.
 */
export function recover(target: Harness, contact: string): Promise<JsonResponse> {
  return requestRecovery(target, contact);
}

/** Events in the log for one bucket and subject, oldest first. */
export async function loggedEvents(
  target: Harness,
  bucket: string,
  subjectKey: string,
): Promise<readonly { occurred_at: Date }[]> {
  const result = await target.pool.query(
    `SELECT occurred_at FROM app.account_rate_limit_events
      WHERE bucket = $1 AND subject_key = $2 ORDER BY event_id`,
    [bucket, subjectKey],
  );
  return result.rows as readonly { occurred_at: Date }[];
}

/** The key the service derives for an IPv4 address, mirroring `sourceKey`. */
export function keyFor(address: string): string {
  return `v4:${address}`;
}

/**
 * Accounts that exist, one per request a limit suite aims at.
 *
 * §7.1 charges an *account* 3 recovery requests a day and a *source address* 5,
 * and a request against one account trips the account budget long before the
 * source budget. So a test that points several requests at one account measures
 * the wrong limit: the third is refused by §7.2 and the per-source limit is never
 * reached at all. Each account here is signed up from an address of its own, for
 * the mirror-image reason — a fifth sign-up from one address would spend
 * `signup_per_ip` and the budget under test would be measured against a bucket
 * something else had already filled.
 *
 * Moves the presented address, so a caller sets its own afterwards.
 */
export async function registerAccounts(
  harness: Harness,
  count: number,
  prefix: string,
): Promise<readonly string[]> {
  const contacts: string[] = [];
  for (let attempt = 1; attempt <= count; attempt += 1) {
    const contact = uniqueContact(`${prefix}-${attempt}`);
    harness.fromAddress(registrationAddress());
    const created = await signUpFor(harness, contact);
    expect(created.status).toBe(201);
    contacts.push(contact);
  }
  return contacts;
}

/**
 * The same for one address per run, from `100` up so a registration never
 * collides with a suite's own numbered subjects.
 */
let registrationSubject = 100;

function registrationAddress(): string {
  registrationSubject += 1;
  return addressFor(registrationSubject);
}

/**
 * A refusal as the service writes it.
 *
 * Typed rather than indexed blindly, because the shape *is* the claim these
 * tests make: a comparison that silently skipped a field it could not read would
 * pass against a refusal that had grown one.
 */
export interface RefusalBody {
  readonly error?: {
    readonly code?: string;
    readonly domain?: string;
    readonly message?: string;
    readonly retryable?: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
  };
  readonly message?: string;
}

/**
 * The refusal in a response, or a defect if the body is not one.
 *
 * A narrowing rather than a cast: a suite that asserted on a success body's
 * absence of fields would otherwise pass for the same reason a refusal with no
 * fields would.
 */
export function refusalIn(response: JsonResponse): RefusalBody {
  const error = response.body['error'];
  const details =
    typeof error === 'object' && error !== null && 'details' in error ? error.details : undefined;
  if (typeof details !== 'object' || details === null) {
    throw new Error(`expected a refusal body, received ${JSON.stringify(response.body)}`);
  }
  return response.body as RefusalBody;
}

/**
 * A refusal with `retryAt` removed, for comparing two refusals.
 *
 * `retryAt` is `now + window` — a restatement of the caller's own clock, carrying
 * nothing about the request that produced it. Two refusals cannot be byte-equal
 * without the service freezing time, so comparing them with this field present
 * would assert nothing and fail anyway; comparing them without it asserts that
 * every field that *could* carry an oracle is identical.
 */
export function withoutRetryAt(body: RefusalBody): unknown {
  const { details, ...rest } = body.error ?? {};
  if (details === undefined) {
    return body;
  }
  const { retryAt: _retryAt, ...comparable } = details;
  return { ...body, error: { ...rest, details: comparable } };
}
