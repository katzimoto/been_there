/**
 * The guard that keeps the demo honest about its own rate limits.
 *
 * ## Why this exists
 *
 * `SIGNUP_PER_IP_PER_HOUR` is 5 (`packages/service/src/accounts/rate-limit.ts`).
 * The walk creates four accounts. That is four of five with nothing spare, and
 * the margin is invisible: nothing in the walk asserts anything about it, so a
 * fifth sign-up added anywhere would fail the demo for a reason that has nothing
 * to do with what the walk demonstrates — and the failure would read as a bug in
 * step 1 rather than as an exhausted bucket.
 *
 * `scripts/demo/server.mjs` installs the trusted-hop seam that gives each
 * account its own address. That seam is load-bearing and nothing else would say
 * so, which makes it exactly the kind of line that gets deleted one day by
 * someone tidying a file.
 *
 * ## Four assertions, each closing a specific way to weaken the demo
 *
 * 1. **The constant is still 5.** Read from the built module, not copied into
 *    this file — a copy would be a second number that drifts. A printed line
 *    would protect nothing, so this throws.
 * 2. **The refusal is the real limit and not a bypass.** Five sign-ups from one
 *    presented address are admitted and the sixth is refused, and the refusal
 *    body must name `bucket: signup_per_ip` with `limit: 5`. A special case that
 *    exempted the demo would either not refuse at all, or refuse without saying
 *    which bucket and limit it applied — and the first is caught by the status,
 *    the second by the body.
 * 3. **An absent header falls back to the socket address.** Six requests with no
 *    header share one bucket and the sixth is refused. If absence invented an
 *    address, each would land in its own bucket and all six would be admitted.
 * 4. **A malformed header falls back to the same socket address, not a new one.**
 *    Sent after 3 has exhausted it, `x-forwarded-for: not-an-ip` must also be
 *    refused. A parser that returned the raw string would put it in a fresh
 *    bucket and it would be admitted — so this catches a parser change that
 *    silently widens the key space, which assertions 1 and 2 would both miss.
 *
 * The cost is fourteen sign-ups in buckets of their own, none of which the walk
 * spends.
 *
 * ## Why it is a preflight and not a numbered step
 *
 * The eleven numbered steps are the product's claims and belong to the brief.
 * This is a property of the demo's own plumbing, so it runs before them, prints
 * as a header observation, and fails the run before step 1 rather than appearing
 * as a twelfth product claim.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './demo-database.mjs';

/** What the limit is supposed to be. Asserted, never assumed. */
const EXPECTED_LIMIT = 5;

/** Two addresses of their own, so the walk's buckets are never spent. */
const BUDGET_ADDRESS = '198.51.100.7';
const SPARE_ADDRESS = '198.51.100.8';

/** Deliberately not an address, so the parser must refuse it. */
const MALFORMED = 'not-an-ip';

const RATE_LIMIT_MODULE = join(REPO_ROOT, 'packages/service/dist/accounts/rate-limit.js');

/**
 * The limit, read from the built module rather than restated here.
 *
 * The package does not re-export it, so this resolves the built module by path —
 * the same thing `packages/service/test/health-restart.test.ts` does when it
 * needs a built package in a fresh process. Throws rather than reporting: a
 * guard that prints the number protects nothing.
 */
async function readLimitConstant() {
  if (!existsSync(RATE_LIMIT_MODULE)) {
    throw new Error(
      `packages/service is not built: ${RATE_LIMIT_MODULE} is missing. Run \`npm run build\`.`,
    );
  }
  const module = await import(RATE_LIMIT_MODULE);
  return module['SIGNUP_PER_IP_PER_HOUR'];
}

function signUpBody(contact) {
  return {
    contact,
    password: 'correct-horse-battery-staple-42',
    dateOfBirth: '1990-06-15',
    termsVersion: '2026-09-01',
  };
}

/** One sign-up, as a client of `contact`. */
function signUp(client, contact) {
  return client.call('POST', '/v1/accounts', undefined, signUpBody(contact));
}

/**
 * Runs `count` sign-ups from whatever address is currently presented and
 * reports the statuses.
 */
async function attemptRange(client, label, count) {
  const statuses = [];
  for (let attempt = 1; attempt <= count; attempt += 1) {
    const response = await signUp(
      client,
      `preflight-${label.replace(/[^a-z0-9]+/gi, '-')}-${attempt}@example.test`,
    );
    statuses.push({ status: response.status, body: response.body });
  }
  return statuses;
}

/** `{ admitted, refused, firstRefusal }` for a run of sign-ups. */
function summarise(attempts) {
  return {
    admitted: attempts.filter((entry) => entry.status === 201).length,
    refused: attempts.filter((entry) => entry.status === 429).length,
    firstRefusal: attempts.find((entry) => entry.status === 429),
  };
}

/**
 * Asserts the run behaved exactly as a bucket of five should, and that the
 * refusal named the real bucket and limit rather than a bypass.
 */
function requireBucketOfFive(attempts, what) {
  const { admitted, refused, firstRefusal } = summarise(attempts);
  if (admitted !== EXPECTED_LIMIT || refused !== 1) {
    throw new Error(
      `${what}: admitted ${admitted} and refused ${refused} of ${EXPECTED_LIMIT + 1} sign-ups, ` +
        `expected ${EXPECTED_LIMIT} and 1. The rate limit is part of the product; if it was ` +
        'raised, or exempted for the demo, then that is the bug — not this check.',
    );
  }
  const details = firstRefusal.body['error']?.['details'];
  const bucket = details?.['bucket'];
  const limit = details?.['limit'];
  if (bucket !== 'signup_per_ip' || limit !== EXPECTED_LIMIT) {
    throw new Error(
      `${what}: the refusal named bucket ${JSON.stringify(bucket)} and limit ${JSON.stringify(limit)}, ` +
        'expected signup_per_ip and 5. A refusal that does not name the bucket and the limit it ' +
        'applied is indistinguishable from a bypass.',
    );
  }
}

/**
 * Exercises the limit, the trusted hop that makes it per-address, and the parser
 * that decides which address a request belongs to.
 *
 * @param {{ fromAddress: (address: string | null) => void, call: (m: string, p: string, t?: string, b?: unknown) => Promise<{status: number, body: Record<string, unknown>}> }} client
 * @param {(text: string) => void} say
 */
export async function checkRateLimitBudget(client, say) {
  const constant = await readLimitConstant();
  if (constant !== EXPECTED_LIMIT) {
    throw new Error(
      `SIGNUP_PER_IP_PER_HOUR is ${constant}, expected ${EXPECTED_LIMIT}. The walk creates four ` +
        'accounts, so this number is load-bearing: raise it and the demo stops demonstrating the ' +
        'limit, lower it and the walk cannot run.',
    );
  }
  say(`SIGNUP_PER_IP_PER_HOUR is ${constant}, asserted against the built module`);

  // 2. The presented address gets its own bucket, and the refusal is the real one.
  client.fromAddress(BUDGET_ADDRESS);
  const budget = await attemptRange(client, BUDGET_ADDRESS, EXPECTED_LIMIT + 1);
  requireBucketOfFive(budget, `one address presented as ${BUDGET_ADDRESS}`);
  say(
    `${EXPECTED_LIMIT} sign-ups from ${BUDGET_ADDRESS} admitted, the last refused 429 ` +
      `bucket signup_per_ip limit ${EXPECTED_LIMIT}`,
  );

  // 3. An absent header falls back to the socket address rather than a fresh key.
  client.fromAddress(null);
  const noHeader = await attemptRange(client, 'no-header', EXPECTED_LIMIT + 1);
  requireBucketOfFive(noHeader, 'no X-Forwarded-For header');
  say(`with no header, ${EXPECTED_LIMIT} admitted and one refused — the socket address is used`);

  // 4. A malformed header must land on that same exhausted socket bucket. A
  // parser returning the raw string would put it in a new bucket and it would be
  // admitted, which is the silent widening this catches.
  client.fromAddress(MALFORMED);
  const malformed = await signUp(client, `preflight-malformed@example.test`);
  if (malformed.status !== 429) {
    throw new Error(
      `a sign-up with X-Forwarded-For: ${MALFORMED} was ${malformed.status}, expected 429. The ` +
        'socket bucket is already exhausted by the previous case, so anything other than a refusal ' +
        'means a malformed header is being given its own bucket rather than falling back.',
    );
  }
  say(`a malformed header falls back to the same socket bucket, refused 429`);

  // And a well-formed second address is still independent of both.
  client.fromAddress(SPARE_ADDRESS);
  const spare = await signUp(client, `preflight-spare-${SPARE_ADDRESS.replace(/\./g, '-')}@example.test`);
  if (spare.status !== 201) {
    throw new Error(
      `a sign-up from a second address ${SPARE_ADDRESS} was refused with ${spare.status}. Every ` +
        'request is landing in one bucket, so the trusted-hop seam in scripts/demo/server.mjs is ' +
        'either missing or not being read — and the walk is four sign-ups from exhausting a ' +
        'shared bucket of five.',
    );
  }
  say(`a sign-up from ${SPARE_ADDRESS} was admitted, so addresses are counted separately`);
  client.fromAddress(null);
}