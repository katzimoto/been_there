import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Caller, type Harness, startHarness } from './support/harness.js';
import {
  LOOPBACK_KEY,
  SIGNUP_LIMIT,
  UNKNOWN_SOURCE_KEY,
  addressFor,
  ipv6For,
  keyFor,
  loggedEvents,
  refusalIn,
  signUpFor,
  uniqueContact,
  withoutRetryAt,
} from './support/rate-limit.js';

/**
 * §10's `signup_per_ip`, over real HTTP against the real database.
 *
 * One of the two limits whose unit is the caller's address. Every request in
 * this repository arrives from `127.0.0.1`, so without a way to present a
 * distinct peer address there would be exactly one `signup_per_ip` bucket on
 * the machine and the sixth sign-up of the whole test run would fail. The
 * harness installs `peerAddressFrom`, the hook a deployment behind a trusted
 * proxy installs, so what is exercised is a production path. The suite at the
 * bottom is the counterpart that pins the deployment with nothing in front of
 * the service. Shared fixtures live in `support/rate-limit.ts`.
 */

let harness: Harness;
const callers: Caller[] = [];

beforeAll(async () => {
  harness = await startHarness(callers);
});

afterAll(async () => {
  await harness.close();
});

/**
 * A subject above the suite's own numbered ones, for the single sign-up a test
 * needs from an address it is not about to exhaust.
 */
let registrationSubject = 90;

describe('signup_per_ip', () => {
  it('admits five sign-ups from one address in an hour and refuses the sixth', async () => {
    const address = addressFor(1);
    harness.fromAddress(address);

    const statuses: number[] = [];
    for (let attempt = 1; attempt <= SIGNUP_LIMIT + 1; attempt += 1) {
      statuses.push((await signUpFor(harness, uniqueContact(`signup-${attempt}`))).status);
    }

    expect(statuses.slice(0, SIGNUP_LIMIT)).toEqual(Array<number>(SIGNUP_LIMIT).fill(201));
    expect(statuses[SIGNUP_LIMIT]).toBe(429);
  });

  it('gives two addresses independent budgets', async () => {
    // The point of a per-address key: exhausting one address's budget must not
    // refuse a different address, or the limit is a global throttle wearing a
    // per-address label.
    const busy = addressFor(2);
    const fresh = addressFor(3);
    harness.fromAddress(busy);
    for (let attempt = 1; attempt <= SIGNUP_LIMIT + 1; attempt += 1) {
      await signUpFor(harness, uniqueContact(`busy-${attempt}`));
    }

    harness.fromAddress(fresh);
    const admitted = await signUpFor(harness, uniqueContact('fresh-peer'));

    expect(admitted.status).toBe(201);
  });

  it('refuses one of two simultaneous sign-ups that arrive together', async () => {
    // The concurrency claim for this limit. Four are spent and the limit is five,
    // so these two are racing for the one remaining admission. Without the subject
    // lock both transactions read a count of four, both conclude they are the
    // fifth, and both are admitted — a limit that holds in a sequential suite and
    // fails the moment it is real.
    //
    // Verified by deleting `lockRateLimitSubject` and running this: it fails with
    // two 201s where one is permitted. Restored, it passes — six consecutive runs,
    // no flake.
    const address = addressFor(4);
    harness.fromAddress(address);
    for (let attempt = 1; attempt < SIGNUP_LIMIT; attempt += 1) {
      expect((await signUpFor(harness, uniqueContact(`race-spend-${attempt}`))).status).toBe(201);
    }

    const concurrent = await Promise.all([
      signUpFor(harness, uniqueContact('race-a')),
      signUpFor(harness, uniqueContact('race-b')),
    ]);

    expect(concurrent.filter((response) => response.status === 201)).toHaveLength(1);
    expect(concurrent.filter((response) => response.status === 429)).toHaveLength(1);
  });

  it('does not count an attempt from outside the hour', async () => {
    // Per-window, not cumulative: a limit that only ever grows would refuse a
    // caller who made five attempts this morning and none since. The events are
    // backdated rather than waited out — the window arithmetic is what is under
    // test, and an hour of real time would only make the suite slow.
    const address = addressFor(5);
    harness.fromAddress(address);
    const stale = new Date(Date.now() - 61 * 60 * 1000);
    for (let attempt = 0; attempt < SIGNUP_LIMIT; attempt += 1) {
      await harness.transaction.run(async (tx) => {
        await harness.stores.accounts.recordRateLimitEvent(
          'signup_per_ip',
          keyFor(address),
          stale,
          tx,
        );
      });
    }

    // Five events exist for this address, all outside the window.
    expect(await loggedEvents(harness,'signup_per_ip', keyFor(address))).toHaveLength(SIGNUP_LIMIT);
    const admitted = await signUpFor(harness, uniqueContact('after-the-window'));

    expect(admitted.status).toBe(201);
  });

  it('records the refused attempt in the log', async () => {
    // A limit that counts only what it allowed is not a limit: the sixth would be
    // refused, and then a seventh would read a count of five again and be
    // admitted. The append-only log is what makes the refusal cumulative.
    const address = addressFor(6);
    harness.fromAddress(address);
    for (let attempt = 1; attempt <= SIGNUP_LIMIT + 3; attempt += 1) {
      await signUpFor(harness, uniqueContact(`logged-${attempt}`));
    }

    const events = await loggedEvents(harness,'signup_per_ip', keyFor(address));

    expect(events).toHaveLength(SIGNUP_LIMIT + 3);
  });

  it('says nothing about whether the contact exists', async () => {
    // §5.3: the refusal must not be readable as an existence oracle. The claim is
    // made by asking about a contact that IS registered and one that is NOT, from
    // an address that is over budget, and requiring the two refusals to be
    // identical. A copy that mentioned an account, a duplicate or a registration
    // would separate them and answer the question the caller was asking.
    //
    // `retryAt` is compared out, and that is a claim rather than a concession: it
    // is `now + window`, so it is a restatement of the caller's own clock and
    // cannot encode anything about the contact. Byte equality is not available
    // here for any two requests, so demanding it would be demanding that the
    // service freeze time.
    const address = addressFor(7);
    const registered = uniqueContact('oracle-known');
    // From an address of its own: signing the owner up from `address` would spend
    // one of the five this test is about to exhaust.
    harness.fromAddress(addressFor(registrationSubject));
    const owner = await signUpFor(harness, registered);
    expect(owner.status).toBe(201);
    harness.fromAddress(address);
    for (let attempt = 1; attempt <= SIGNUP_LIMIT + 1; attempt += 1) {
      await signUpFor(harness, uniqueContact(`oracle-spend-${attempt}`));
    }

    const forRegistered = await signUpFor(harness, registered);
    const forAbsent = await signUpFor(harness, uniqueContact('oracle-absent'));

    expect(forRegistered.status).toBe(429);
    expect(forAbsent.status).toBe(429);
    expect(withoutRetryAt(refusalIn(forAbsent))).toEqual(withoutRetryAt(refusalIn(forRegistered)));
    // Nothing a caller reads names a contact, an account or a registration. The
    // scan is over the copy rather than the whole body: `domain` is
    // `service.accounts` on every refusal this route can return, so it says which
    // module answered and nothing about who asked.
    const copy = JSON.stringify({
      message: refusalIn(forAbsent).error?.message,
      title: refusalIn(forAbsent).error?.details?.['title'],
    }).toLowerCase();
    for (const leak of ['account', 'email', 'contact', 'exist', 'registered', 'duplicate']) {
      expect(copy).not.toContain(leak);
    }
  });

  it('charges the contact budget for an attempt the address budget refused', async () => {
    // §10's two sign-up limits are independent and neither refunds the other. A
    // caller that spends its address budget must not thereby get a fresh look at
    // the contact budget, or "which of the two do I evade?" becomes a question
    // with an answer — and the answer would be "spend the per-IP one first".
    //
    // The claim is about the *log*, which is where the two budgets meet: an
    // attempt refused by the address limit is still charged to the contact
    // bucket. Without that charge a caller could spend its whole address budget
    // probing contacts and arrive at the contact budget with nothing spent.
    const address = addressFor(8);
    harness.fromAddress(address);
    for (let attempt = 1; attempt <= SIGNUP_LIMIT; attempt += 1) {
      await signUpFor(harness, uniqueContact(`cross-spend-${attempt}`));
    }

    // The probed contact, attempted *while over budget* — which is the whole
    // point. Asking about the log for a contact no attempt ever carried would
    // read zero for the same reason whether or not the charge exists.
    const probed = uniqueContact('cross-probed');
    const refused = await signUpFor(harness, probed);
    const chargedWhileOverBudget = await loggedEvents(harness,'signup_per_contact', probed);

    expect(refused.status).toBe(429);
    expect(chargedWhileOverBudget).toHaveLength(1);
  });

  it('counts every address in one IPv6 prefix as one source', async () => {
    // §10 says per IP, and an IPv6 subscriber is routinely delegated a /64 —
    // 2^64 addresses — which is also what a phone with `ip privacy` enabled
    // rotates through every few minutes while keeping the prefix. Keyed on the
    // whole address, the limit would not limit that subscriber at all. So the key
    // is the /64, and this is the test that says so: a second address inside the
    // prefix is refused, and a different prefix is not.
    const subscriber = ipv6For(1, 1);
    harness.fromAddress(subscriber);
    for (let attempt = 1; attempt <= SIGNUP_LIMIT + 1; attempt += 1) {
      await signUpFor(harness, uniqueContact(`v6-spend-${attempt}`));
    }

    harness.fromAddress(ipv6For(1, 2));
    const sameSubscriber = await signUpFor(harness, uniqueContact('v6-same-prefix'));

    harness.fromAddress(ipv6For(2, 1));
    const otherSubscriber = await signUpFor(harness, uniqueContact('v6-other-prefix'));

    expect(sameSubscriber.status).toBe(429);
    expect(otherSubscriber.status).toBe(201);
  });
});
describe('the direct-socket path', () => {
  // A second service, started the way a deployment with nothing in front of it
  // starts. No suite above can reach this path: they all install `peerAddressFrom`
  // and present an address through it, so deleting the `?? message.socket
  // .remoteAddress` fallback from the server would leave every one of them green.
  let direct: Harness;

  beforeAll(async () => {
    direct = await startHarness(callers, { trustedHop: false });
  });

  afterAll(async () => {
    await direct.close();
  });

  it('takes the peer address from the socket when no trusted hop supplies one', async () => {
    // Two claims, and the first is the load-bearing one. If the socket address
    // could not be read, `sourceKey` answers `unknown-source` and every caller in
    // the world shares one bucket — so a sign-up moving that key would mean the
    // production path is broken even though the request succeeded. It is asserted
    // as *unchanged* rather than as an absolute zero because it is the only claim
    // here that survives the rest of the suite running in parallel against the
    // same database.
    const before = await loggedEvents(direct, 'signup_per_ip', UNKNOWN_SOURCE_KEY);

    await signUpFor(direct, uniqueContact('socket-path'));

    const afterUnreadable = await loggedEvents(direct, 'signup_per_ip', UNKNOWN_SOURCE_KEY);
    const afterLoopback = await loggedEvents(direct, 'signup_per_ip', LOOPBACK_KEY);

    expect(afterUnreadable).toHaveLength(before.length);
    // "At least one" rather than "exactly one": other suites sign up over this
    // same loopback address concurrently, so the count can move under the
    // assertion for reasons that have nothing to do with this request.
    expect(afterLoopback.length).toBeGreaterThan(0);
  });
});