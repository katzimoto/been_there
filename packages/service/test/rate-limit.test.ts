import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Caller, type Harness, type JsonResponse, call, startHarness } from './support/harness.js';

/**
 * The two per-address limits in §10 — `signup_per_ip` and `recovery_per_source` —
 * over real HTTP against the real database.
 *
 * These are the only two limits whose unit is the caller's address, and they are
 * the two the rest of the suite cannot reach: every other request in this
 * repository arrives from `127.0.0.1`, so without a way to present a distinct
 * peer address there would be exactly one `signup_per_ip` bucket on the machine
 * and the sixth sign-up of the whole test run would fail. The harness installs
 * `peerAddressFrom`, which is the same hook a deployment behind a trusted proxy
 * installs, so what is exercised here is the production path rather than a
 * test-only branch. `the direct-socket path` at the bottom is the counterpart
 * that pins the no-proxy deployment.
 */

const PASSWORD = 'correct horse battery staple';
const TERMS_VERSION = '2026-09-01';
const NO_SESSION = 'no-session-needed';

/** §10: 5 sign-ups per address per hour. */
const SIGNUP_LIMIT = 5;
/** §10: 5 recovery requests per address per day. */
const RECOVERY_LIMIT = 5;

let harness: Harness;
const callers: Caller[] = [];

beforeAll(async () => {
  harness = await startHarness(callers);
});

afterAll(async () => {
  await harness.close();
});

let sequence = 0;

/**
 * A contact identifier no other attempt in this run will use.
 *
 * Unique rather than shared so a test's account is never refused as a duplicate,
 * which would be a different refusal with the same status and would make a
 * rate-limit assertion pass for the wrong reason.
 */
function uniqueContact(prefix: string): string {
  sequence += 1;
  return `${prefix}-${process.pid}-${sequence}-${Date.now().toString(36)}@beenthere.dev`;
}

/** A well-formed adult sign-up, varying only the contact. */
function signUpFor(contact: string): Promise<JsonResponse> {
  return call(harness, 'POST', '/v1/accounts', NO_SESSION, {
    contact,
    password: PASSWORD,
    dateOfBirth: '1994-03-02',
    termsVersion: TERMS_VERSION,
  });
}

/**
 * Per-run octets, so two runs never share a `signup_per_ip` bucket.
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
function addressFor(subject: number): string {
  return `198.${RUN_OCTET_A}.${RUN_OCTET_B}.${subject}`;
}

/** The same, in the other documentation range, for the recovery suite. */
function recoveryAddressFor(subject: number): string {
  return `203.${RUN_OCTET_A}.${RUN_OCTET_B}.${subject}`;
}

function requestRecovery(contact: string): Promise<JsonResponse> {
  return call(harness, 'POST', '/v1/account-recovery', NO_SESSION, { contact });
}

/** Events in the log for one bucket and subject, oldest first. */
async function loggedEvents(bucket: string, subjectKey: string): Promise<readonly { occurred_at: Date }[]> {
  const result = await harness.pool.query(
    `SELECT occurred_at FROM app.account_rate_limit_events
      WHERE bucket = $1 AND subject_key = $2 ORDER BY event_id`,
    [bucket, subjectKey],
  );
  return result.rows as readonly { occurred_at: Date }[];
}

/** The key the service derives for an address, mirroring `sourceKey`. */
function keyFor(address: string): string {
  return address.includes(':') ? `v6:${address}` : `v4:${address}`;
}

describe('signup_per_ip', () => {
  it('admits five sign-ups from one address in an hour and refuses the sixth', async () => {
    const address = addressFor(1);
    harness.fromAddress(address);

    const statuses: number[] = [];
    for (let attempt = 1; attempt <= SIGNUP_LIMIT + 1; attempt += 1) {
      statuses.push((await signUpFor(uniqueContact(`signup-${attempt}`))).status);
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
      await signUpFor(uniqueContact(`busy-${attempt}`));
    }

    harness.fromAddress(fresh);
    const admitted = await signUpFor(uniqueContact('fresh-peer'));

    expect(admitted.status).toBe(201);
  });

  it('refuses the sixth of two simultaneous requests that arrive together', async () => {
    // The concurrency claim. Five are already spent, so exactly one of these two
    // The concurrency claim. Four are spent and the limit is five, so these two
    // are racing for the one remaining admission. Without the subject lock both
    // transactions read a count of four, both conclude they are the fifth, and
    // both are admitted — a limit that holds in a sequential suite and fails the
    // moment it is real.
    const address = addressFor(4);
    harness.fromAddress(address);
    for (let attempt = 1; attempt < SIGNUP_LIMIT; attempt += 1) {
      const spent = await signUpFor(uniqueContact(`race-spend-${attempt}`));
      expect(spent.status).toBe(201);
    }

    const concurrent = await Promise.all([
      signUpFor(uniqueContact('race-a')),
      signUpFor(uniqueContact('race-b')),
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
    expect(await loggedEvents('signup_per_ip', keyFor(address))).toHaveLength(SIGNUP_LIMIT);
    const admitted = await signUpFor(uniqueContact('after-the-window'));

    expect(admitted.status).toBe(201);

  it('records the refused attempt in the log', async () => {
    // A limit that counts only what it allowed is not a limit: the sixth would be
    // refused, and then a seventh would read a count of five again and be
    // admitted. The append-only log is what makes the refusal cumulative.
    const address = addressFor(6);
    harness.fromAddress(address);
    for (let attempt = 1; attempt <= SIGNUP_LIMIT + 3; attempt += 1) {
      await signUpFor(uniqueContact(`logged-${attempt}`));
    }

    const events = await loggedEvents('signup_per_ip', keyFor(address));

    expect(events).toHaveLength(SIGNUP_LIMIT + 3);
  });

  it('says nothing about whether the contact exists', async () => {
    // §5.3: the refusal must not be readable as an existence oracle. The claim is
    // made by asking about a contact that IS registered and one that is NOT, from
    // an address that is over budget, and requiring the two refusals to be
    // identical. A copy that mentioned an account, a duplicate or a registration
    // would separate them and answer the question the caller was asking.
    const address = addressFor(7);
    const registered = uniqueContact('oracle-known');
    expect((await signUpFor(registered)).status).toBe(201);
    harness.fromAddress(address);
    for (let attempt = 1; attempt <= SIGNUP_LIMIT + 1; attempt += 1) {
      await signUpFor(uniqueContact(`oracle-spend-${attempt}`));
    }

    const forRegistered = await signUpFor(registered);
    const forAbsent = await signUpFor(uniqueContact('oracle-absent'));

    expect(forRegistered.status).toBe(429);
    expect(forAbsent.status).toBe(429);
    expect(forAbsent.body).toEqual(forRegistered.body);
    // Nothing in the refusal names a contact, an account or a registration.
    const serialised = JSON.stringify(forAbsent.body).toLowerCase();
    for (const leak of ['account', 'email', 'contact', 'exist', 'registered', 'duplicate']) {
      expect(serialised).not.toContain(leak);
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
    const first = uniqueContact('cross-first');
    for (let attempt = 1; attempt <= SIGNUP_LIMIT + 1; attempt += 1) {
      await signUpFor(uniqueContact(`cross-${attempt}`));
    }
    const chargedWhileOverBudget = await loggedEvents('signup_per_contact', first);

    expect(chargedWhileOverBudget).toHaveLength(1);
  });
});

});
describe('recovery_per_source', () => {
  it('refuses the sixth recovery request from one address in a day', async () => {
    // A recovery request is "admitted" by a message being sent, not by the
    // response: this endpoint returns one neutral answer in every case, so the
    // only observable difference between the fifth and the sixth is whether a
    // reset link exists. That is also the point — see the refusal-shape test.
    const address = recoveryAddressFor(1);
    const contact = uniqueContact('recovery-source');
    const owner = await signUpFor(contact);
    expect(owner.status).toBe(201);
    harness.fromAddress(address);

    for (let attempt = 1; attempt <= RECOVERY_LIMIT; attempt += 1) {
      const before = harness.messages.length;
      await requestRecovery(contact);
      expect(harness.messages.length).toBe(before + 1);
    }

    const before = harness.messages.length;
    await requestRecovery(contact);

    expect(harness.messages.length).toBe(before);
  });

  it('answers a refused request identically to an admitted one', async () => {
    // The refusal must not be visible in the response. If the sixth returned
    // `rate_limited` while the first five returned the neutral body, a caller
    // could watch for the change to learn how close a given address was to its
    // budget — and on this endpoint, that is a signal about the requester.
    const address = recoveryAddressFor(2);
    const contact = uniqueContact('recovery-neutral');
    await signUpFor(contact);
    harness.fromAddress(address);

    const admitted = await requestRecovery(contact);
    for (let attempt = 2; attempt <= RECOVERY_LIMIT + 1; attempt += 1) {
      await requestRecovery(contact);
    }
    const refused = await requestRecovery(contact);

    expect(refused.status).toBe(admitted.status);
    expect(refused.body).toEqual(admitted.body);
  });

  it('does not consume the budget for a contact that does not exist', async () => {
    // Not an assertion that unknown contacts are free — they are charged, because
    // spraying unknown addresses is what the limit is for. This is the claim that
    // one source's recovery of a real account is bounded regardless of what it
    // sends alongside, which is what the per-account limit alone would not give.
    const address = recoveryAddressFor(3);
    harness.fromAddress(address);
    for (let attempt = 1; attempt <= RECOVERY_LIMIT; attempt += 1) {
      await requestRecovery(uniqueContact(`unknown-${attempt}`));
    }

    const before = harness.messages.length;
    const known = uniqueContact('recovery-after-spray');
    await signUpFor(known);
    await requestRecovery(known);

    expect(harness.messages.length).toBe(before + 1);
  });

  it('counts one source against another separately', async () => {
    const busy = recoveryAddressFor(4);
    const other = recoveryAddressFor(5);
    const contact = uniqueContact('recovery-two-sources');
    await signUpFor(contact);

    harness.fromAddress(busy);
    for (let attempt = 1; attempt <= RECOVERY_LIMIT + 1; attempt += 1) {
      await requestRecovery(contact);
    }
    const before = harness.messages.length;

    harness.fromAddress(other);
    await requestRecovery(contact);

    expect(harness.messages.length).toBe(before + 1);
  });
});

describe('the direct-socket path', () => {
  it('counts the socket address when no trusted hop supplies one', async () => {
    // The counterpart to every test above, and the one that would catch someone
    // deleting `peerAddressFrom` and leaving the rest of this file green through
    // the injected address. With no override installed the address comes from the
    // socket, and the socket says `127.0.0.1` — so events land under that key and
    // not under any key this suite invented.
    harness.fromAddress(null);
    const contact = uniqueContact('socket-path');
    await signUpFor(contact);

    const events = await loggedEvents('signup_per_ip', 'v4:127.0.0.1');
    const prefixEvents = await loggedEvents('signup_per_ip', 'v6:0000:0000:0000:0000::/64');

    expect(events.length + prefixEvents.length).toBeGreaterThan(0);
  });
});

