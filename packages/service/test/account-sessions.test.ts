import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStores, createTransaction } from '@been-there/database';
import pg from 'pg';
import {
  serviceRoutes,
  startService,
  type ContactMessage,
  type ServiceDependencies,
} from '@been-there/service';
import { requireDatabase, type JsonResponse } from './support/harness.js';
import { createSessionActorResolver } from '../src/accounts/session-resolver.js';

/**
 * Sign-in, refresh, logout and recovery, over real HTTP against the real
 * database.
 *
 * The properties here are mostly about what is *revoked* and about who is
 * *told*, because that is where recovery either works or becomes a weapon. Every
 * assertion reads the database rather than the response body: a response that
 * says "signed out" while a session row is still `active` is the exact failure
 * §7.1 step 4 exists to prevent.
 */

const PASSWORD = 'correct horse battery staple';

/**
 * This suite builds its own service instance rather than using `startHarness`,
 * and the reason is the property under test. `startHarness` resolves a bearer
 * token by looking the digest up in `account_sessions` and returning an actor
 * without ever asking whether the session is still live — so a *revoked* token
 * authenticates, and every assertion here about revocation would be asserting
 * about a token the test harness accepts. These are the same five assertions that
 * decide whether recovery actually protects an account, so they run against the
 * production resolver, `createSessionActorResolver`, wired the way the composition
 * root wires it.
 */
let pool: pg.Pool;
let url: string;
const messages: ContactMessage[] = [];

const harness = {
  get url() {
    return url;
  },
  get pool() {
    return pool;
  },
  get messages() {
    return messages;
  },
  get transaction() {
    return harnessTransaction;
  },
  get stores() {
    return harnessStores;
  },
};
let harnessTransaction: ReturnType<typeof createTransaction>;
let harnessStores: ReturnType<typeof createStores>;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: requireDatabase() });
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
    now: () => new Date(),
  };
  url = (await startService(dependencies, { routes: serviceRoutes(dependencies) })).url;
});

afterAll(async () => {
  await pool.end();
});

/** One request, the same shape `startHarness`'s `call` has. */
function call(
  _harness: unknown,
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
    return { status: response.status, body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
  });
}

function uniqueContact(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@beenthere.dev`;
}

async function signUp(prefix: string): Promise<{ contact: string; userId: string; token: string }> {
  const contact = uniqueContact(prefix);
  const response = await call(harness, 'POST', '/v1/accounts', 'x', {
    contact,
    password: PASSWORD,
    dateOfBirth: '1994-03-02',
    termsVersion: '2026-09-01',
  });
  if (response.status !== 201) {
    throw new Error(`sign-up returned ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return {
    contact,
    userId: String(response.body['userId']),
    token: (response.body['session'] as Record<string, unknown>)['token'] as string,
  };
}

function signIn(contact: string, password = PASSWORD) {
  return call(harness, 'POST', '/v1/account-sessions', 'x', { contact, password });
}

async function sessionsFor(userId: string) {
  return harness.transaction.run((tx) => harness.stores.accounts.listSessionsFor(userId as never, tx));
}

async function noticeCount(userId: string): Promise<number> {
  return harness.transaction.run((tx) => harness.stores.accounts.listNoticesFor(userId as never, tx))
    .then((notices) => notices.length);
}

describe('sign-in', () => {
  it('exchanges a credential for a session that authenticates a real route', async () => {
    const account = await signUp('signin');

    const signedIn = await signIn(account.contact);
    expect(signedIn.status).toBe(201);
    const token = String(signedIn.body['token']);
    expect(signedIn.body['userId']).toBe(account.userId);

    const served = await call(harness, 'GET', `/v1/accounts/${account.userId}`, token);
    expect(served.status).toBe(200);
  });

  it('gives a wrong password and an unknown account the identical refusal', async () => {
    const account = await signUp('signin-fail');
    const wrong = await signIn(account.contact, 'not the right password');
    const unknown = await signIn(uniqueContact('nobody'), PASSWORD);

    // §9 gives "account unknown" the same row as "wrong password". A different
    // status, a different message, or a different `reason` between them is an
    // account-existence oracle.
    expect(wrong.status).toBe(unknown.status);
    expect(wrong.body).toEqual(unknown.body);
    expect((wrong.body['error'] as Record<string, unknown>)['details']).toMatchObject({
      title: "That email and password don't match.",
    });
  });
});

describe('refresh', () => {
  it('rotates: the old token dies and the new one authenticates', async () => {
    const account = await signUp('refresh');
    const signedIn = await signIn(account.contact);
    const original = String(signedIn.body['token']);

    const refreshed = await call(harness, 'POST', '/v1/account-sessions/refresh', 'x', {
      token: original,
    });
    expect(refreshed.status).toBe(200);
    const rotated = String(refreshed.body['token']);
    expect(rotated).not.toBe(original);

    // Rotation is single-use: the presented token is superseded in the same
    // transaction that writes the new one.
    expect((await call(harness, 'GET', `/v1/accounts/${account.userId}`, original)).status).toBe(403);
    expect((await call(harness, 'GET', `/v1/accounts/${account.userId}`, rotated)).status).toBe(200);
  });
});

describe('logout', () => {
  it('revokes only the presented device', async () => {
    const account = await signUp('logout-one');
    const phone = await signIn(account.contact);
    const laptop = await signIn(account.contact);
    const phoneToken = String(phone.body['token']);
    const laptopToken = String(laptop.body['token']);

    const response = await call(harness, 'DELETE', '/v1/account-sessions', 'x', {
      token: phoneToken,
    });
    expect(response.status).toBe(200);
    expect(response.body['scope']).toBe('this_device');

    expect((await call(harness, 'GET', `/v1/accounts/${account.userId}`, phoneToken)).status).toBe(403);
    expect((await call(harness, 'GET', `/v1/accounts/${account.userId}`, laptopToken)).status).toBe(200);

    const rows = await sessionsFor(account.userId);
    expect(rows.filter((row) => row.status === 'active')).toHaveLength(2);
  });

  it('revokes every device and tells the owner, from any session', async () => {
    const account = await signUp('logout-all');
    const first = String((await signIn(account.contact)).body['token']);
    const second = String((await signIn(account.contact)).body['token']);
    const before = harness.messages.length;

    const response = await call(harness, 'DELETE', '/v1/account-sessions/all', first);
    expect(response.status).toBe(200);
    expect(response.body['scope']).toBe('all_devices');

    const rows = await sessionsFor(account.userId);
    expect(rows.filter((row) => row.status === 'active')).toHaveLength(0);
    // Both tokens are dead, including the one that was *not* presented: §6.1
    // says every device, and an attacker holding the other cookie must lose it.
    expect((await call(harness, 'GET', `/v1/accounts/${account.userId}`, second)).status).toBe(403);
    expect(harness.messages.length).toBe(before + 1);
    const notice = harness.messages[harness.messages.length - 1];
    expect(notice?.subject).toBe('We signed you out everywhere');
    expect(notice?.body).toContain('secure your account now');
  });
});

describe('recovery', () => {
  it('answers identically whether or not the account exists', async () => {
    const account = await signUp('recovery-neutral');
    const known = await call(harness, 'POST', '/v1/account-recovery', 'x', {
      contact: account.contact,
    });
    const unknown = await call(harness, 'POST', '/v1/account-recovery', 'x', {
      contact: uniqueContact('ghost'),
    });
    expect(known.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    expect((known.body as Record<string, unknown>)['message']).toBe(
      "If that account exists, we've sent a link. It expires in 30 minutes.",
    );
  });

  it('revokes every session, replaces the password, and tells the owner once', async () => {
    const account = await signUp('recovery-complete');
    const stolen = String((await signIn(account.contact)).body['token']);
    await signIn(account.contact);

    const requested = await call(harness, 'POST', '/v1/account-recovery', 'x', {
      contact: account.contact,
    });
    expect(requested.status).toBe(202);
    // The code reaches the relay and never the response body.
    const message = harness.messages[harness.messages.length - 1];
    const code = message?.secret ?? '';
    expect(code).not.toBe('');

    const completed = await call(harness, 'POST', '/v1/account-recovery/complete', 'x', {
      contact: account.contact,
      code,
      password: 'a whole different password',
    });
    expect(completed.status).toBe(200);
    expect(Number(completed.body['sessionsRevoked'])).toBeGreaterThanOrEqual(2);

    // The revocation is the security value of the flow, so it is asserted on the
    // rows rather than on the count in the body.
    const rows = await sessionsFor(account.userId);
    expect(rows.filter((row) => row.status === 'active')).toHaveLength(1);
    expect(
      rows.filter((row) => row.revokedReason === 'recovery_completed'),
    ).toHaveLength(rows.length - 1);
    // The attacker's cookie is among them.
    expect((await call(harness, 'GET', `/v1/accounts/${account.userId}`, stolen)).status).toBe(403);
    // And the new password works while the old one does not.
    expect((await signIn(account.contact, 'a whole different password')).status).toBe(201);
    expect((await signIn(account.contact, PASSWORD)).status).toBe(403);

    // Told once, keyed on the fact rather than the attempt.
    const notices = await harness.transaction.run((tx) =>
      harness.stores.accounts.listNoticesFor(account.userId as never, tx),
    );
    const completedNotices = notices.filter((n) => n.kind === 'account.recovery_completed');
    expect(completedNotices).toHaveLength(1);
  });

  it('refuses a reused recovery code', async () => {
    const account = await signUp('recovery-replay');
    await call(harness, 'POST', '/v1/account-recovery', 'x', { contact: account.contact });
    const code = harness.messages[harness.messages.length - 1]?.secret ?? '';

    const first = await call(harness, 'POST', '/v1/account-recovery/complete', 'x', {
      contact: account.contact,
      code,
      password: 'a whole different password',
    });
    expect(first.status).toBe(200);

    const replay = await call(harness, 'POST', '/v1/account-recovery/complete', 'x', {
      contact: account.contact,
      code,
      password: 'yet another password',
    });
    // The same refusal as a wrong code and as an expired one, because a client
    // that can tell them apart learns the state of somebody's reset link.
    expect(replay.status).toBe(400);
    expect((replay.body['error'] as Record<string, unknown>)['details']).toMatchObject({
      reason: 'recovery_code_rejected',
    });
  });

  it('tells the owner once when recovery is used against them', async () => {
    const account = await signUp('recovery-harassment');
    // Three requests inside the 24-hour window: the first two proceed, the third
    // crosses §7.2's threshold and pauses recovery.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await call(harness, 'POST', '/v1/account-recovery', 'x', {
        contact: account.contact,
      });
      // The requester learns nothing at any point in the burst.
      expect(response.status).toBe(202);
      expect((response.body as Record<string, unknown>)['message']).toBe(
        "If that account exists, we've sent a link. It expires in 30 minutes.",
      );
    }

    let notices = await harness.transaction.run((tx) =>
      harness.stores.accounts.listNoticesFor(account.userId as never, tx),
    );
    expect(notices.filter((n) => n.kind === 'account.recovery_paused')).toHaveLength(1);

    // A fourth, fifth and fortieth attempt add nothing: the notice is keyed on the
    // pause window, so the unique index refuses each of them. This is the whole of
    // §7.2's "never on a per-attempt basis".
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await call(harness, 'POST', '/v1/account-recovery', 'x', { contact: account.contact });
    }
    notices = await harness.transaction.run((tx) =>
      harness.stores.accounts.listNoticesFor(account.userId as never, tx),
    );
    expect(notices.filter((n) => n.kind === 'account.recovery_paused')).toHaveLength(1);

    // And recovery really is paused: the third request opened no recovery, so the
    // account has none to complete.
    const open = await harness.transaction.run((tx) =>
      harness.stores.accounts.findOpenRecoveryFor(account.userId as never, tx),
    );
    expect(open?.status).not.toBe('pending');
  });
});