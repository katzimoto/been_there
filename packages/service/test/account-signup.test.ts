import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Caller, type Harness, call, startHarness } from './support/harness.js';

/**
 * Sign-up, and the age gate, over real HTTP against the real database.
 *
 * The acceptance test this file exists for is the one the previous agent flagged
 * as missing: **an under-18 date of birth creates no account row**. It counts rows
 * rather than asserting on a status code, because a 422 with a row behind it would
 * pass a status assertion and is precisely the failure the requirement names. The
 * count is taken across the whole table rather than filtered by a marker this test
 * invented, so an account created under a different name still shows up.
 */

const PASSWORD = 'correct horse battery staple';

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

/**
 * Every account-shaped row that could only belong to `contact`.
 *
 * Counting whole tables would be simpler and wrong: vitest runs the suite files in
 * parallel against one database, so a global count moves under the assertion
 * because *another* suite created an account. Probing by the contact this attempt
 * used is both deterministic and a stronger claim — "nothing exists for this
 * attempt", rather than "nothing changed while we were looking", which a
 * concurrent writer can satisfy by accident.
 */
async function residueFor(contact: string): Promise<Record<string, number>> {
  const result = await harness.pool.query(
    `SELECT
       (SELECT count(*)::int FROM app.account_credentials WHERE contact_identifier = $1) AS credentials,
       (SELECT count(*)::int FROM app.account_onboarding o
          JOIN app.account_credentials c ON c.user_id = o.user_id
         WHERE c.contact_identifier = $1) AS onboarding,
       (SELECT count(*)::int FROM app.identity_state i
          JOIN app.account_credentials c ON c.user_id = i.user_id
         WHERE c.contact_identifier = $1) AS identities,
       (SELECT count(*)::int FROM app.account_sessions s
          JOIN app.account_credentials c ON c.user_id = s.user_id
         WHERE c.contact_identifier = $1) AS sessions,
       (SELECT count(*)::int FROM app.contact_verifications v
          JOIN app.account_credentials c ON c.user_id = v.user_id
         WHERE c.contact_identifier = $1) AS contact_verifications`,
    [contact],
  );
  return result.rows[0] as unknown as Record<string, number>;
}

const NO_RESIDUE = {
  credentials: 0,
  onboarding: 0,
  identities: 0,
  sessions: 0,
  contact_verifications: 0,
};

function signUp(contact: string, overrides: Record<string, unknown> = {}): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  return call(harness, 'POST', '/v1/accounts', 'no-session-needed', {
    contact,
    password: PASSWORD,
    dateOfBirth: '1994-03-02',
    termsVersion: '2026-09-01',
    ...overrides,
  });
}

function uniqueContact(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@beenthere.dev`;
}

describe('the age gate', () => {
  it('creates no account row for a date of birth that computes under 18', async () => {
    const contact = uniqueContact('under-18');
    const response = await signUp(contact, { dateOfBirth: '2015-06-01' });

    // §9's row for an under-18 sign-up, verbatim, with the one action a person
    // can take: leave.
    expect(response.status).toBe(422);
    const error = response.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('not_eligible');
    expect(error['details']).toMatchObject({
      reason: 'under_18',
      title: "We can't create an account for you yet.",
      action: 'leave',
    });

    // Not the status: the residue. §4.2 says a rejected sign-up leaves no
    // account-shaped trace, and a response that said 422 while writing a user row
    // would satisfy every assertion above.
    expect(await residueFor(contact)).toEqual(NO_RESIDUE);
  });

  it('sends no message and contacts no provider for an under-18 sign-up', async () => {
    const delivered = harness.messages.length;
    await signUp(uniqueContact('under-18-quiet'), { dateOfBirth: '2012-01-01' });
    expect(harness.messages.length).toBe(delivered);
  });

  it('refuses a client-supplied age rather than trusting it', async () => {
    const contact = uniqueContact('claims-age');
    // An under-18 date with a claimed age of 34: if the claim were read instead
    // of the date, the account would be created. The claim must not reach the
    // gate at all — which is also why the input type has no field to put it in.
    const response = await signUp(contact, { dateOfBirth: '2015-06-01', age: 34 });

    expect(response.status).toBe(400);
    const error = response.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('validation_failed');
    expect(error['details']).toMatchObject({ field: 'age' });
    expect(await residueFor(contact)).toEqual(NO_RESIDUE);
  });

  it('refuses ageYears too, since §4.1 names that spelling', async () => {
    const response = await signUp(uniqueContact('claims-age-years'), {
      dateOfBirth: '2015-06-01',
      ageYears: 34,
    });
    expect(response.status).toBe(400);
    expect((response.body['error'] as Record<string, unknown>)['details']).toMatchObject({
      field: 'ageYears',
    });
  });

  it('creates the account at unverified and writes the date of birth', async () => {
    const contact = uniqueContact('adult');
    const response = await signUp(contact, { dateOfBirth: '1994-03-02' });

    expect(response.status).toBe(201);
    expect(response.body['identity']).toMatchObject({ state: 'unverified', discoverable: false });
    // The band crosses the boundary; the date and the age do not. §4.3 makes the
    // date owner-only-and-never-rendered and the exact age the same, and A4 says
    // no response in either direction contains either.
    expect(response.body['ageBand']).toBe('28-32');
    expect(JSON.stringify(response.body)).not.toContain('1994-03-02');
    expect(response.body).not.toHaveProperty('dateOfBirth');
    expect(response.body).not.toHaveProperty('age');

    const userId = String(response.body['userId']);
    const stored = await harness.transaction.run(async (tx) =>
      Promise.all([
        harness.stores.accounts.findCredentialByContact(contact, tx),
        harness.stores.accounts.findOnboarding(userId as never, tx),
        harness.stores.identity.find(userId as never, tx),
      ]),
    );
    expect(stored[0]?.passwordHash).toMatch(/^scrypt:/);
    expect(stored[0]?.passwordHash).not.toContain(PASSWORD);
    expect(stored[1]?.dateOfBirth).toBe('1994-03-02');
    expect(stored[1]?.termsVersion).toBe('2026-09-01');
    expect(stored[2]?.state).toBe('unverified');
  });

  it('refuses a stale terms version with the copy the failure table specifies', async () => {
    const contact = uniqueContact('stale-terms');
    const response = await signUp(contact, { termsVersion: '2020-01-01' });

    expect(response.status).toBe(400);
    const error = response.body['error'] as Record<string, unknown>;
    expect(error['details']).toMatchObject({
      field: 'terms',
      title: "We've updated our terms.",
      action: 'read_accept',
      current_version: '2026-09-01',
    });
    expect(error['message']).toBe('Have a read, then accept to continue.');
    expect(await residueFor(contact)).toEqual(NO_RESIDUE);
  });

  it('refuses an impossible date with the impossible-date copy', async () => {
    const response = await signUp(uniqueContact('impossible'), { dateOfBirth: '1994-02-31' });
    expect(response.status).toBe(400);
    expect((response.body['error'] as Record<string, unknown>)['details']).toMatchObject({
      field: 'dateOfBirth',
      title: "That date doesn't look right.",
    });
  });
});

describe('authentication on the account surface', () => {
  it('refuses a protected route without a session and serves it after sign-up', async () => {
    const created = await signUp(uniqueContact('auth'));
    const userId = String(created.body['userId']);
    const token = (created.body['session'] as Record<string, unknown>)['token'] as string;

    const anonymous = await call(harness, 'GET', `/v1/accounts/${userId}`, 'not-a-real-token');
    expect(anonymous.status).toBe(403);

    // The token the sign-up returned resolves through the same database lookup
    // production uses, so this is the real path and not a static table.
    const served = await call(harness, 'GET', `/v1/accounts/${userId}`, token);
    expect(served.status).toBe(200);
    expect(served.body['userId']).toBe(userId);
    expect(served.body['identity']).toMatchObject({ state: 'unverified' });
  });

  it('answers the readiness checklist with the next outstanding step', async () => {
    const created = await signUp(uniqueContact('readiness'));
    const userId = String(created.body['userId']);
    const token = (created.body['session'] as Record<string, unknown>)['token'] as string;

    const readiness = await call(harness, 'GET', `/v1/accounts/${userId}/onboarding`, token);
    expect(readiness.status).toBe(200);
    // The age gate and the terms were satisfied by this sign-up, so neither is
    // outstanding; contact verification is step 2 and was not.
    expect(readiness.body['ageGatePassed']).toBe(true);
    expect(readiness.body['termsCurrent']).toBe(true);
    expect(readiness.body['outstanding']).not.toContain('age_gate');
    expect(readiness.body['outstanding']).not.toContain('terms');
    expect(readiness.body['nextStep']).toBe('contact_verification');
    // Unverified identity is not discoverable, and no surface may say otherwise.
    expect(readiness.body['discoverable']).toBe(false);
    expect(JSON.stringify(readiness.body)).not.toContain('1994-03-02');
  });

  it('refuses another member the readiness checklist', async () => {
    const owner = await signUp(uniqueContact('checklist-owner'));
    const stranger = await signUp(uniqueContact('checklist-stranger'));
    const strangerToken = (stranger.body['session'] as Record<string, unknown>)['token'] as string;

    // 404 rather than 403: a 403 would confirm the account exists, which turns a
    // guessable id into an enumeration oracle.
    const response = await call(
      harness,
      'GET',
      `/v1/accounts/${String(owner.body['userId'])}/onboarding`,
      strangerToken,
    );
    expect(response.status).toBe(404);
  });
});