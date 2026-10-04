import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createStores, createTransaction } from '@been-there/database';
import pg from 'pg';
import {
  serviceRoutes,
  startService,
  type ContactMessage,
  type ServiceDependencies,
} from '@been-there/service';
import { hashPassword } from '@been-there/platform';
import { castId } from '@been-there/core';
import type { StaffIdentityRow, Stores, Transaction } from '@been-there/contracts';
import { requireDatabaseReady, type JsonResponse } from './support/harness.js';
import { createSessionActorResolver } from '../src/accounts/session-resolver.js';
import { sessionTokenDigest } from '../src/accounts/session-token.js';
import { harnessVerificationProvider } from './support/provider.js';
import { reclaimPrepared } from './support/reclaim.js';

/**
 * The two subject-kind hazards in the account-session routes.
 *
 * `account_sessions.user_id` is nullable so a staff session can live in the same
 * table as a member's. That single change makes two previously-impossible code
 * paths reachable, and this file is the proof that both are closed:
 *
 *  - **Hazard 1 — `DELETE /v1/account-sessions` (this device).** It looks a
 *    session up by token and echoes `row.userId` into the 200 body while writing
 *    member-shaped bookkeeping. With `user_id` nullable, a *staff* token
 *    presented here echoed `userId: null` and did member sign-out bookkeeping for
 *    a moderator. The route now refuses a non-member row with
 *    `subject_kind_mismatch`, before any write.
 *
 *  - **Hazard 2 — `DELETE /v1/account-sessions/all`.** It derives the owner from
 *    `request.actor.userId`, which is `null` for a staff actor. The old answer was
 *    `MISSING_FIELD('session')`, which reads like "send the field again" and
 *    invites the tempting next step: deriving an owner from the other column and
 *    revoking across the wrong subject. It is now an explicit
 *    `permission_denied` / `subject_kind_mismatch`.
 *
 * The positive control matters as much as the refusals: the hazard-1 guard must
 * not break a *member's* sign-out, so that is asserted against a real signed-in
 * member and the real user id, not against the static token table.
 *
 * This suite builds its own service instance rather than using `startHarness`,
 * for the same reason `account-sessions.test.ts` does: the property under test is
 * about which rows a revocation touches, and a resolver that hands back an actor
 * for a revoked token would make every assertion about revocation vacuous. The
 * production resolver, `createSessionActorResolver`, is wired the way the
 * composition root wires it.
 */

const PASSWORD = 'correct horse battery staple';

let pool: pg.Pool;
let url: string;
// Assigned as soon as the pool exists, so a setup failure cannot displace the
// failure that caused it with a `TypeError` from the teardown.
let closePool: (() => Promise<void>) | undefined;
const messages: ContactMessage[] = [];

/**
 * The peer address presented to the service, read per request. This suite builds
 * its own service, so it installs the trusted hop itself — without it every
 * request arrives over one loopback socket and they all share one
 * `signup_per_ip` bucket.
 */
let presentedAddress: string | null = null;

/** Per-run octets, so two runs never share a bucket. */
const ROTATION_A = Math.floor(Math.random() * 254) + 1;
const ROTATION_B = Math.floor(Math.random() * 254) + 1;
let signUpSubject = 0;
let harnessStores: Stores;
let harnessTransaction: Transaction;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: await requireDatabaseReady() });
  closePool = () => pool.end();
  await pool.query('SELECT 1');
  harnessStores = createStores(pool);
  harnessTransaction = createTransaction(pool);
  const dependencies: ServiceDependencies = {
    stores: harnessStores,
    transaction: harnessTransaction,
    actors: createSessionActorResolver({
      stores: harnessStores,
      transaction: harnessTransaction,
      now: () => new Date(),
    }),
    contacts: {
      deliver: async (message: ContactMessage) => {
        messages.push(message);
      },
    },
    // This suite is about which rows a revocation touches, not about verification,
    // but a service cannot be composed without the port: the default score sits
    // above the 0.9 floor, so the sign-ins below reach `verified` as they would in
    // any other suite.
    verification: harnessVerificationProvider(),
    now: () => new Date(),
  };
  url = (
    await startService(dependencies, {
      routes: serviceRoutes(dependencies),
      peerAddressFrom: (message) => presentedAddress ?? message.socket.remoteAddress ?? null,
    })
  ).url;
});

afterAll(async () => {
  await closePool?.();
  // Nothing else holds the per-suite database this suite prepared: it built its
  // own `ServiceDependencies` rather than going through `startHarness`.
  reclaimPrepared();
});

/** One request, the same shape `startHarness`'s `call` has. */
function call(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<JsonResponse> {
  return fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => {
    const text = await response.text();
    return {
      status: response.status,
      body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  });
}

function uniqueContact(prefix: string): string {
  return `${prefix}-${randomUUID()}@beenthere.dev`;
}

interface Account {
  readonly contact: string;
  readonly userId: string;
  readonly token: string;
}

async function signUp(prefix: string): Promise<Account> {
  const contact = uniqueContact(prefix);
  // A distinct presented address per account: §10's `signup_per_ip` limit refuses
  // the sixth sign-up from one address, which is not a thing a person does.
  signUpSubject += 1;
  presentedAddress = `203.${ROTATION_A}.${ROTATION_B}.${signUpSubject}`;
  const response = await call('POST', '/v1/accounts', 'x', {
    contact,
    password: PASSWORD,
    dateOfBirth: '1994-03-02',
    termsVersion: '2026-09-01',
  });
  if (response.status !== 201) {
    throw new Error(`sign-up returned ${response.status}: ${JSON.stringify(response.body)}`);
  }
  const session = response.body['session'] as Record<string, unknown>;
  return { contact, userId: String(response.body['userId']), token: String(session['token']) };
}

function signIn(contact: string): Promise<JsonResponse> {
  return call('POST', '/v1/account-sessions', 'x', { contact, password: PASSWORD });
}

interface StaffIdentity {
  readonly staffId: string;
  readonly token: string;
  readonly sessionId: string;
}

/**
 * A real staff identity, signed in through `POST /v1/staff-sessions`.
 *
 * The row is provisioned directly and the *credential* is spent over HTTP, so the
 * token under test is one the production sign-in route minted: an ordinary row in
 * the ordinary session table whose `user_id` is `NULL`. A static caller table
 * would have been wrong here — the hazard is precisely that this route can be
 * handed a token whose row has no member subject.
 */
async function staffSignIn(role = 'senior_moderator'): Promise<StaffIdentity> {
  const contact = uniqueContact('mod');
  const now = new Date();
  const row: StaffIdentityRow = {
    staffId: randomUUID(),
    contactKind: 'email',
    contactIdentifier: contact,
    passwordHash: await hashPassword(PASSWORD),
    displayName: 'R. Moderator',
    role,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await harnessTransaction.run((tx) => harnessStores.staff.insertStaff(row, tx));

  const response = await call('POST', '/v1/staff-sessions', 'x', {
    contact,
    password: PASSWORD,
  });
  if (response.status !== 201) {
    throw new Error(`staff sign-in returned ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return {
    staffId: String(response.body['staffId']),
    token: String(response.body['token']),
    sessionId: String(response.body['sessionId']),
  };
}

/** The session row a token names, read straight from the table. */
function sessionForToken(token: string) {
  return harnessTransaction.run((tx) =>
    harnessStores.accounts.findSessionByToken(sessionTokenDigest(token), tx),
  );
}

function sessionsFor(userId: string) {
  return harnessTransaction.run((tx) =>
    harnessStores.accounts.listSessionsFor(castId<'UserId'>(userId), tx),
  );
}

/**
 * `error.details` of a refusal — where the machine-readable reason lives.
 *
 * Asserted on `details.reason` and never on `details.message`: the wording is
 * prose that may be rephrased, the reason is the contract.
 */
function detailsOf(response: JsonResponse): Record<string, unknown> {
  const error = response.body['error'] as Record<string, unknown> | undefined;
  return (error?.['details'] ?? {}) as Record<string, unknown>;
}

/**
 * Proof that a token still authenticates, without asserting a route a moderator
 * has no business calling.
 *
 * `GET /v1/accounts/:userId` gates on `actor.role === 'user'`, so a staff actor
 * passes the gate and gets the account — the only reason a 403 here could mean is
 * a dead session, which makes this a clean liveness probe for either subject.
 */
function readsAccount(token: string, userId: string): Promise<JsonResponse> {
  return call('GET', `/v1/accounts/${userId}`, token);
}

describe('DELETE /v1/account-sessions — hazard 1, a staff session is not a member session', () => {
  it('refuses a staff token instead of echoing a null userId as a member sign-out', async () => {
    const staff = await staffSignIn();
    const bystander = await signUp('subject-bystander');

    const response = await call('DELETE', '/v1/account-sessions', 'x', { token: staff.token });

    // Not 200. Before the subject check this returned
    // `{ userId: null, revoked: 1, scope: 'this_device' }` and wrote a member
    // sign-out funnel event for a moderator.
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: { code: 'permission_denied', domain: 'service.accounts' },
    });
    expect(detailsOf(response)).toMatchObject({
      reason: 'subject_kind_mismatch',
      subjectKind: 'staff',
    });

    // The refusal came *before* any write: the moderator's session is untouched
    // and still authenticates.
    expect((await sessionForToken(staff.token))?.status).toBe('active');
    expect((await readsAccount(staff.token, bystander.userId)).status).toBe(200);
  });

  it("still signs a member out, echoing that member's real userId", async () => {
    const account = await signUp('subject-member');
    const token = String((await signIn(account.contact)).body['token']);

    const response = await call('DELETE', '/v1/account-sessions', 'x', { token });

    // The positive control. A guard that refused everything would satisfy the
    // hazard test above; this is what proves it is a *subject* check.
    expect(response.status).toBe(200);
    expect(response.body['userId']).toBe(account.userId);
    expect(response.body['revoked']).toBe(1);
    expect(response.body['scope']).toBe('this_device');

    const row = await sessionForToken(token);
    expect(row?.status).toBe('revoked');
    expect(row?.userId).toBe(account.userId);
    expect(row?.subjectKind).toBe('member');
    expect((await readsAccount(token, account.userId)).status).toBe(403);
  });
});

describe('DELETE /v1/account-sessions/all — hazard 2, a staff actor has no member to sign out', () => {
  it('refuses a staff session with subject_kind_mismatch rather than a missing-field error', async () => {
    const staff = await staffSignIn();
    const bystander = await signUp('subject-all-refused');

    const response = await call('DELETE', '/v1/account-sessions/all', staff.token);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({
      error: { code: 'permission_denied', domain: 'service.accounts' },
    });
    expect(detailsOf(response)).toMatchObject({ reason: 'subject_kind_mismatch' });

    // Refused, not acted on: the moderator is still signed in.
    expect((await sessionForToken(staff.token))?.status).toBe('active');
    expect((await readsAccount(staff.token, bystander.userId)).status).toBe(200);
  });

  it("signs a member out of every device and leaves the moderator's session active", async () => {
    const account = await signUp('subject-all');
    const phone = String((await signIn(account.contact)).body['token']);
    const laptop = String((await signIn(account.contact)).body['token']);
    const staff = await staffSignIn();

    const response = await call('DELETE', '/v1/account-sessions/all', phone);
    expect(response.status).toBe(200);
    expect(response.body['scope']).toBe('all_devices');

    // The member's own sessions are gone, including the one not presented.
    const memberRows = await sessionsFor(account.userId);
    expect(memberRows.filter((row) => row.status === 'active')).toHaveLength(0);
    expect((await sessionForToken(laptop))?.status).toBe('revoked');

    // The moderator's session is untouched. This is the real proof: a member
    // pressing "sign out everywhere" cannot take a moderator's access with them.
    const staffRow = await sessionForToken(staff.token);
    expect(staffRow?.status).toBe('active');
    expect(staffRow?.staffId).toBe(staff.staffId);
    expect(staffRow?.userId).toBeNull();

    // And the moderator's token still authenticates a request afterwards.
    expect((await readsAccount(staff.token, account.userId)).status).toBe(200);
  });
});

describe('listSessionsFor — a member id cannot resolve a staff session', () => {
  it('never returns a staff session row, because user_id = $1 cannot match NULL', async () => {
    const account = await signUp('subject-list');
    await signIn(account.contact);
    const staff = await staffSignIn();

    const rows = await sessionsFor(account.userId);
    expect(rows.map((row) => row.sessionId)).not.toContain(staff.sessionId);
    expect(rows.every((row) => row.subjectKind === 'member')).toBe(true);

    // The staff surface finds it, so the absence above is the discriminator
    // working rather than the row having vanished.
    const staffRows = await harnessTransaction.run((tx) =>
      harnessStores.staff.listSessionsForStaff(staff.staffId, tx),
    );
    expect(staffRows.map((row) => row.sessionId)).toContain(staff.sessionId);
  });
});