import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Caller, type Harness, type JsonResponse, startHarness } from './support/harness.js';
import {
  RECOVERY_LIMIT,
  recover,
  recoveryAddressFor,
  registerAccounts,
  requestRecovery,
  uniqueContact,
} from './support/rate-limit.js';

/**
 * §10's `recovery_per_source`, over real HTTP against the real database.
 *
 * One of the two limits whose unit is the caller's address, and the only one
 * whose refusal is deliberately invisible — see `answers a refused request
 * identically to an admitted one`. The shared fixtures live in
 * `support/rate-limit.ts` so the address scheme cannot drift between this suite
 * and the sign-up one.
 */

let harness: Harness;
const callers: Caller[] = [];
// Assigned the moment `startHarness` returns. `harness` is unassigned when it
// throws — which is where a migration failure surfaces — and an `afterAll` that
// reads it then raises a `TypeError` in place of the failure that caused it.
let closeHarness: (() => Promise<void>) | undefined;

beforeAll(async () => {
  harness = await startHarness(callers);
  closeHarness = harness.close;
});

afterAll(async () => {
  await closeHarness?.();
});

interface RecoveryAttempt {
  readonly response: JsonResponse;
  /** Messages the service tried to deliver because of this request. */
  readonly issued: number;
}

/**
 * One recovery request per contact, from whatever address is presented now.
 *
 * The message count is the only observable this endpoint leaves: §7.1.2 returns
 * one neutral answer whatever it decided, so "was a reset link sent" is how a
 * test learns whether a request was admitted or refused. Returning both halves
 * per request lets a test assert that the refusals happened *and* that the
 * responses were identical, which together are the property — asserting the
 * responses alone would pass against an endpoint that refused nothing.
 */
async function recoverEach(contacts: readonly string[]): Promise<readonly RecoveryAttempt[]> {
  const attempts: RecoveryAttempt[] = [];
  for (const contact of contacts) {
    const before = harness.messages.length;
    const response = await requestRecovery(harness, contact);
    attempts.push({ response, issued: harness.messages.length - before });
  }
  return attempts;
}

describe('recovery_per_source', () => {
  it('refuses the sixth recovery request from one address in a day', async () => {
    // Each request names a different account, so the budget that moves here is
    // the source address's and not §7.1's 3-per-account: pointed at one account
    // the third request would be refused by §7.2 and the sixth would never be
    // reached. A message being sent is the observable — the response is the same
    // neutral body either way, which is the refusal-shape test's subject.
    const address = recoveryAddressFor(1);
    const contacts = await registerAccounts(harness, RECOVERY_LIMIT + 1, 'recovery-source');
    harness.fromAddress(address);

    const attempts = await recoverEach(contacts);

    expect(attempts.slice(0, RECOVERY_LIMIT).map((attempt) => attempt.issued)).toEqual(
      Array<number>(RECOVERY_LIMIT).fill(1),
    );
    expect(attempts[RECOVERY_LIMIT]?.issued).toBe(0);
  });

  it('answers a refused request identically to an admitted one', async () => {
    // The refusal must not be visible in the response. If the sixth returned
    // `rate_limited` while the first five returned the neutral body, a caller
    // could watch for the change to learn how close a given address was to its
    // budget — and on this endpoint, that is a signal about the requester.
    const address = recoveryAddressFor(2);
    const contacts = await registerAccounts(harness, RECOVERY_LIMIT + 1, 'recovery-neutral');
    harness.fromAddress(address);

    const attempts = await recoverEach(contacts);

    // The refusal happened, so the comparison below is not vacuous.
    expect(attempts[RECOVERY_LIMIT]?.issued).toBe(0);
    const admitted = attempts[0]?.response;
    const refused = attempts[RECOVERY_LIMIT]?.response;
    expect(admitted?.status).toBe(202);
    expect(refused?.status).toBe(admitted?.status);
    expect(refused?.body).toEqual(admitted?.body);
  });

  it('spends the source budget on contacts that do not exist', async () => {
    // A contact nobody holds is still a request, and it is charged like one. If it
    // were free, `recovery_per_source` would not bound the endpoint at all — a
    // caller could send unlimited requests for identifiers it had guessed, and the
    // neutral response of §7.1.2 would be the only thing in the way of reading
    // the whole user table off it. That is what the per-source limit is for.
    //
    // Four unknowns leave exactly one slot, and it goes to a real account; the
    // request after that is refused. Were unknowns free, both would be admitted.
    const address = recoveryAddressFor(3);
    const contacts = await registerAccounts(harness, 2, 'recovery-after-spray');
    harness.fromAddress(address);
    for (let attempt = 1; attempt < RECOVERY_LIMIT; attempt += 1) {
      await requestRecovery(harness, uniqueContact(`absent-${attempt}`));
    }

    const attempts = await recoverEach(contacts);

    expect(attempts.map((attempt) => attempt.issued)).toEqual([1, 0]);
  });

  it('counts one source against another separately', async () => {
    // Each source gets its own accounts, so what separates them can only be the
    // source key. The busy source's spend is asserted rather than assumed: a
    // source that had not actually been exhausted would make the second half of
    // this test pass for the wrong reason.
    const busy = recoveryAddressFor(4);
    const other = recoveryAddressFor(5);
    const contacts = await registerAccounts(harness, RECOVERY_LIMIT + 2, 'recovery-two-sources');

    harness.fromAddress(busy);
    const exhausted = await recoverEach(contacts.slice(0, RECOVERY_LIMIT + 1));
    expect(exhausted.map((attempt) => attempt.issued)).toEqual([
      ...Array<number>(RECOVERY_LIMIT).fill(1),
      0,
    ]);

    harness.fromAddress(other);
    const fresh = await recoverEach(contacts.slice(RECOVERY_LIMIT + 1));

    expect(fresh.map((attempt) => attempt.issued)).toEqual([1]);
  });

  it('admits one of several simultaneous requests that arrive together', async () => {
    // The concurrency claim for this limit, and the harder of the two to observe
    // because the response cannot report it. Four of the source's five are spent
    // and eight requests are fired at once, so they race for the one remaining
    // admission. Without the subject lock each transaction counts the window,
    // each reads four, each concludes it is the fifth, and each is admitted — a
    // limit that holds in a sequential suite and fails the moment it is real.
    //
    // Verified by deleting `lockRateLimitSubject` and running this: it fails, with
    // 3 and 8 messages issued across runs where the limit permits 1. Restored, it
    // passes.
    //
    // Eight rather than two because the assertion is about the *total* admitted,
    // which widens the window a lost lock has to slip through — and because the
    // response cannot say which requests were admitted (§7.1.2 returns the same
    // neutral body for all of them), so the count of issued messages is the only
    // observable. Each account is distinct, so §7.1's per-account budget is not
    // what refuses the losers; otherwise this would pass with the lock removed
    // for the wrong reason.
    const racers = 8;
    const address = recoveryAddressFor(6);
    const contacts = await registerAccounts(harness, racers, 'recovery-race');
    harness.fromAddress(address);
    for (const contact of contacts.slice(0, RECOVERY_LIMIT - 1)) {
      await requestRecovery(harness, contact);
    }

    const before = harness.messages.length;
    const concurrent = await Promise.all(
      contacts.slice(RECOVERY_LIMIT - 1).map((contact) => recover(harness, contact)),
    );

    expect(concurrent.every((response) => response.status === 202)).toBe(true);
    expect(harness.messages.length - before).toBe(1);
  });
});
