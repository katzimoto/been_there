import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { Stores, Transaction } from '@been-there/contracts';
import { createStores, createTransaction } from '@been-there/database';
import {
  type ContactMessage,
  type ServiceDependencies,
  serviceRoutes,
  startService,
} from '@been-there/service';
import type { UserId } from '@been-there/core';
import { castId } from '@been-there/core';
import {
  type Caller,
  type JsonResponse,
  member,
  staffIdentity,
  requireDatabaseReady,
  resolverFor,
} from './support/harness.js';
import { createSessionActorResolver } from '../src/accounts/session-resolver.js';
import { reclaimPrepared } from './support/reclaim.js';
import { CURRENT_TERMS_VERSION } from '../src/accounts/terms.js';
import { COMPLETE_PROFILE, PASSING_RESULT, newPeer, verify } from './support/fixtures.js';
import { harnessVerificationProvider } from './support/provider.js';

/**
 * Account deletion (§8), and the six properties the brief asks it to hold.
 *
 * ## The one this file exists for
 *
 * A `banned` account must be able to delete itself. `delete_account` is on the
 * unrestrictable floor in `packages/core/src/states/account.ts` precisely because
 * removing it "strands a banned account: sanctioned, unappealable, and unable to
 * leave" — and the capability existed with nothing behind it. Every other test here
 * guards the implementation; this one is the reason the feature exists, and it is
 * why the first assertion is about a **banned** account rather than a healthy one.
 *
 * ## Why the assertions read the database
 *
 * §8.2 is a claim about rows. A `202` that says "we will delete your account"
 * while the credential, the profile and the standing all survive satisfies every
 * status-code assertion and none of the spec. So each property is asserted against
 * `app.*` directly — `residueFor` is the same probe the age-gate suite uses, for
 * the same reason.
 *
 * ## Why this file builds its own service
 *
 * Two reasons, both about honesty.
 *
 * The undo window is 30 days. A suite cannot wait 30 days, and asserting "is
 * `completesAt` about 30 days out?" would be asserting a value the test itself
 * wrote. So `now` is supplied per request from a mutable clock and the suite moves
 * *past the deadline the service computed*, rather than declaring what it is.
 *
 * And `startHarness` authenticates a static token table without asking whether a
 * session is live. That is fine for a suite about content and wrong for this one:
 * the properties here are about who may reach a destructive endpoint, so member
 * callers resolve through the real session resolver and a banned account reaches
 * the route the way a banned account actually would.
 */

let MOD = 'moderator';
/** The staff identity's id, which is what a decision body must now name. */
let MOD_ID = '';

/** §8.1's confirmation phrase, typed rather than tapped. */
const CONFIRMATION = 'delete my account';

let pool: pg.Pool;
let url: string;
// The teardown handle, assigned as soon as the pool exists rather than derived
// from `pool` at teardown time. A setup failure — a migration that does not
// apply, most often — leaves `pool` unassigned, and an `afterAll` that reaches
// for it throws a `TypeError` that displaces the migration failure that caused
// it. The handle *is* the pool's existence, so reaching for it cannot fault.
let closePool: (() => Promise<void>) | undefined;
let harnessStores: Stores;
let harnessTransaction: Transaction;
const messages: ContactMessage[] = [];

/**
 * The clock, and the only two things a test may do to it.
 *
 * A `now` a test can set arbitrarily is also a `now` a test can forget to reset,
 * and a suite that leaks a moved clock fails in whichever suite runs next. So this
 * is `set`/`reset` rather than a bare mutable `Date`, and every test that moves it
 * resets it in a `finally`.
 */
let clockNow = new Date();
const clock = {
  set(next: Date): void {
    clockNow = next;
  },
  reset(): void {
    clockNow = new Date();
  },
};

/**
 * The peer address this harness presents, read per request.
 *
 * §10 admits five sign-ups per address per hour and this file creates more than
 * that, so a test that signs somebody up itself rotates first. `newPeer` already
 * rotates through the trusted-hop seam per call; this is for the rest.
 */
let presentedAddress: string | null = null;
let rotation = 0;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: await requireDatabaseReady() });
  // Assigned before the first query that can fail, so the handle exists for
  // exactly as long as the resource it closes.
  closePool = () => pool.end();
  await pool.query('SELECT 1');
  harnessStores = createStores(pool);
  harnessTransaction = createTransaction(pool);
  const dependencies: ServiceDependencies = {
    stores: harnessStores,
    transaction: harnessTransaction,
    // The staff token is not a session — a moderator signs in through no member
    // credential — so the fixture callers are consulted first and everything else
    // falls through to the real session resolver. That fallback is the point of
    // building the service here rather than reusing `startHarness`: a member caller
    // must be a *live* session, or "a banned account can reach this route" would be a
    // claim about a static table that never checks whether anybody was banned.
    actors: resolverFor(callers, harnessStores, harnessTransaction),
    contacts: {
      deliver: async (message: ContactMessage) => {
        messages.push(message);
      },
    },
    verification: provider,
    now: () => new Date(clockNow.getTime()),
  };
  url = (
    await startService(dependencies, {
      routes: serviceRoutes(dependencies),
      peerAddressFrom: (message) => presentedAddress ?? message.socket.remoteAddress ?? null,
    })
  ).url;

  // A real staff identity, minted after the service is listening because
  // provisioning needs the database and the session it mints is resolved by the
  // running service. This replaces a static token whose `actorId` was the token
  // string: a ban applied through it recorded a credential as the decision-maker,
  // which is exactly what this suite asserts survives deletion.
  const staffRow = await staffIdentity(harness, 'senior_moderator', { suffix: 'deletion' });
  MOD = staffRow.token;
  MOD_ID = staffRow.staffId;
  callers.length = 0;
  callers.push(staffRow.caller);
});

afterAll(async () => {
  await closePool?.();
  // This suite assembled its own `ServiceDependencies`, so nothing outside the file
  // drops the per-suite database it prepared. Without this it leaks, and the symptom
  // reads as a flake in whichever suite runs next.
  reclaimPrepared();
});

/** One request. Talks to the service the way a client would. */
async function call(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<JsonResponse> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/**
 * The fixture callers the actor resolver consults before the session table.
 *
 * Peer fixtures push onto this array as they create accounts, so it is
 * `let`-shaped rather than a literal at the point of use: the resolver reads it
 * per request, so a caller added after the service started is still resolvable.
 *
 * The moderator in it is a REAL staff identity — see `beforeAll`. It is flagged
 * `realStaff`, which routes its token to the production session resolver rather
 * than to this table, precisely because this table can only answer with
 * `actorId = token`.
 */
const callers: Caller[] = [];

/**
 * The shared harness shape the fixtures want.
 *
 * `createAccount` and `verify` take one of these, so rather than fork the fixture
 * helpers this file presents its own service through the same interface. The
 * database methods the fixtures do not use are the ones that would need a live
 * pool, and none of them are called by the paths below.
 */
const provider = harnessVerificationProvider();
const harness = {
  get verification() {
    return provider;
  },
  get url() {
    return url;
  },
  get pool() {
    return pool;
  },
  get stores() {
    return harnessStores;
  },
  get transaction() {
    return harnessTransaction;
  },
  get messages() {
    return messages;
  },
  fromAddress(address: string | null): void {
    presentedAddress = address;
  },
  // The fixtures never call it — this file owns the teardown, because the pool and
  // the database both belong to the service this suite built for itself. Present and
  // throwing rather than absent, so the object satisfies `Harness` honestly instead of
  // being cast into it and quietly satisfying the type with a missing method.
  close: async () => {
    throw new Error('this suite closes its own pool; nothing else may close it');
  },
};

/** A distinct contact per call, so no test can collide with another's account. */
function contact(prefix: string): string {
  rotation += 1;
  presentedAddress = `198.${51 + (rotation % 200)}.${rotation % 254}.1`;
  return `${prefix}-${Date.now().toString(36)}-${rotation}@beenthere.dev`;
}

/** Signs somebody up and returns their id and their live session token. */
async function signUp(prefix: string): Promise<{ userId: UserId; token: string; contact: string }> {
  const address = contact(prefix);
  const response = await call('POST', '/v1/accounts', 'no-session-needed', {
    contact: address,
    password: 'correct-horse-battery-staple-42',
    dateOfBirth: '1990-06-15',
    termsVersion: CURRENT_TERMS_VERSION,
  });
  if (response.status !== 201) {
    throw new Error(`sign-up returned ${response.status}: ${JSON.stringify(response.body)}`);
  }
  const session = response.body['session'] as Record<string, unknown>;
  return {
    userId: castId<'UserId'>(String(response.body['userId'])),
    token: String(session['token']),
    contact: address,
  };
}

/**
 * Every account-shaped row belonging to one user, by class.
 *
 * The classes are the ones §8.2 names: what a deletion must take, and — the point
 * of counting them separately — the account row itself, which must *survive* and be
 * anonymised rather than vanish.
 */
async function residueFor(userId: string): Promise<Record<string, number>> {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM app.account_credentials   WHERE user_id = $1) AS credentials,
       (SELECT count(*)::int FROM app.account_onboarding    WHERE user_id = $1) AS onboarding,
       (SELECT count(*)::int FROM app.account_sessions      WHERE user_id = $1) AS sessions,
       (SELECT count(*)::int FROM app.account_recoveries    WHERE user_id = $1) AS recoveries,
       (SELECT count(*)::int FROM app.contact_verifications WHERE user_id = $1) AS contact_verifications,
       (SELECT count(*)::int FROM app.account_notices       WHERE user_id = $1) AS notices,
       (SELECT count(*)::int FROM app.identity_state        WHERE user_id = $1) AS identity,
       (SELECT count(*)::int FROM app.verification_attempts WHERE user_id = $1) AS verification_attempts,
       (SELECT count(*)::int FROM app.profiles              WHERE user_id = $1) AS profiles,
       (SELECT count(*)::int FROM app.profile_photos        WHERE user_id = $1) AS photos,
       (SELECT count(*)::int FROM app.preferences           WHERE user_id = $1) AS preferences,
       (SELECT count(*)::int FROM app.location_anchors      WHERE user_id = $1) AS locations,
       (SELECT count(*)::int FROM app.account_standing      WHERE user_id = $1) AS standing,
       (SELECT count(*)::int FROM app.users                 WHERE user_id = $1) AS account_row`,
    [userId],
  );
  return result.rows[0] as unknown as Record<string, number>;
}

/** The moderation rows §8.2 says survive, counted for one subject. */
async function evidenceFor(userId: string): Promise<Record<string, number>> {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM app.reports    WHERE subject_id = $1 OR reporter_id = $1) AS reports,
       (SELECT count(*)::int FROM app.cases      WHERE subject_id = $1) AS cases,
       (SELECT count(*)::int FROM app.decisions  WHERE subject_id = $1) AS decisions,
       (SELECT count(*)::int FROM app.audit_log  WHERE subject_id = $1) AS audit,
       (SELECT count(*)::int FROM app.risk_signals WHERE subject_id = $1) AS risk`,
    [userId],
  );
  return result.rows[0] as unknown as Record<string, number>;
}

/**
 * A genuinely `banned` account: signed up, verified, matched, reported, and banned
 * by a named moderator through the real decision route.
 *
 * Nothing writes a standing directly. A fixture that inserted `account_standing` by
 * hand would prove the route reads a row; it would not prove a *banned* account can
 * reach the route, which is the claim this whole file turns on.
 */
async function bannedAccount(
  prefix: string,
): Promise<{ userId: UserId; token: string; contact: string }> {
  const subject = await signUp(prefix);
  await call('PUT', `/v1/accounts/${subject.userId}/profile`, subject.token, COMPLETE_PROFILE);
  await verify(harness, subject.token, subject.userId, PASSING_RESULT);

  // A report needs a counterpart and a real recorded interaction, so the subject is
  // somebody who matched and then unmatched a peer.
  const reporter = await newPeer(harness, callers, `${prefix}-reporter`);
  await call(
    'PUT',
    `/v1/accounts/${reporter.userId}/profile`,
    `${prefix}-reporter`,
    COMPLETE_PROFILE,
  );
  await verify(harness, `${prefix}-reporter`, reporter.userId, PASSING_RESULT);
  await call('POST', '/v1/interactions/likes', subject.token, { toUserId: reporter.userId });
  const matched = await call('POST', '/v1/interactions/likes', `${prefix}-reporter`, {
    toUserId: subject.userId,
  });
  expect(matched.status).toBe(201);
  await call('POST', `/v1/matches/${String(matched.body['match'])}/unmatch`, subject.token, {
    idempotencyKey: `unmatch-${prefix}`,
  });

  const reported = await call('POST', '/v1/reports', `${prefix}-reporter`, {
    subjectUserId: subject.userId,
    reason: 'threats_or_violence',
    statement: 'they threatened me and I unmatched immediately',
  });
  expect(reported.status).toBe(201);

  const opened = await call('POST', '/v1/moderation/cases', MOD, {
    reportId: reported.body['reportId'],
    moderatorId: MOD_ID,
  });
  expect(opened.status).toBe(201);

  const decided = await call(
    'POST',
    `/v1/moderation/cases/${String(opened.body['caseId'])}/decisions`,
    MOD,
    {
      moderatorId: MOD_ID,
      action: 'ban',
      rationale: 'the threats in this case meet the bar for a ban, and the appeal route stays open',
    },
  );
  expect(decided.status).toBe(201);

  const read = await call('GET', `/v1/accounts/${subject.userId}`, MOD);
  expect((read.body['account'] as Record<string, unknown>)['state']).toBe('banned');
  return subject;
}

describe('a banned account can delete itself', () => {
  it('accepts the request, which is the reason this feature exists', async () => {
    const subject = await bannedAccount('banned-delete');

    const response = await call('DELETE', '/v1/accounts/me', subject.token, {
      confirmation: CONFIRMATION,
    });

    // Not 403. A banned account holds `delete_account` on the unrestrictable floor,
    // and a refusal here is the trap that floor exists to prevent: sanctioned,
    // unappealable, and unable to leave.
    expect(response.status).toBe(202);
    expect(response.body['status']).toBe('scheduled');

    // §9's copy for a scheduled deletion, verbatim.
    const notice = response.body['notice'] as Record<string, unknown>;
    expect(notice['title']).toBe('Your account will be deleted in 30 days.');

    // The window is 30 days, measured from the service's own instants rather than
    // compared against a date this file chose.
    const requestedAt = new Date(String(response.body['requestedAt'])).getTime();
    const completesAt = new Date(String(response.body['completesAt'])).getTime();
    expect((completesAt - requestedAt) / (24 * 60 * 60 * 1000)).toBeCloseTo(30, 6);
  });

  it('leaves the account intact during the window, because the deletion is soft', async () => {
    const subject = await bannedAccount('banned-soft');
    await call('DELETE', '/v1/accounts/me', subject.token, { confirmation: CONFIRMATION });

    // Nothing is removed at request time. A deletion that erased on request would
    // make the undo endpoint a lie, and would leave a banned user unable to change
    // their mind for the one month §8.1 gives them.
    const residue = await residueFor(subject.userId);
    expect(residue['credentials']).toBe(1);
    expect(residue['onboarding']).toBe(1);
    expect(residue['profiles']).toBe(1);
    expect(residue['identity']).toBe(1);

    // And the standing is untouched, because a request to leave is not a moderation
    // event and must not read as one.
    const standing = await call('GET', `/v1/accounts/${subject.userId}`, MOD);
    expect(standing.status).toBe(200);
    expect((standing.body['account'] as Record<string, unknown>)['state']).toBe('banned');
  });

  it('refuses a request without the typed confirmation phrase', async () => {
    const subject = await signUp('no-confirmation');

    const response = await call('DELETE', '/v1/accounts/me', subject.token, {
      confirmation: 'yes please',
    });

    // §8.1: a typed confirmation is deliberate, "and a destructive one-tap is how an
    // accidental deletion happens".
    expect(response.status).toBe(400);
    expect((response.body['error'] as Record<string, unknown>)['code']).toBe('validation_failed');
    expect(await residueFor(subject.userId)).toMatchObject({ credentials: 1 });
    const open = await pool.query(
      'SELECT count(*)::int AS n FROM app.account_deletions WHERE user_id = $1',
      [subject.userId],
    );
    expect(open.rows[0]).toMatchObject({ n: 0 });
  });

  it('refuses a request with no session at all', async () => {
    const response = await call('DELETE', '/v1/accounts/me', 'not-a-real-token', {
      confirmation: CONFIRMATION,
    });
    expect(response.status).toBe(403);
  });
});

describe('a deletion request is idempotent', () => {
  it('answers a second request with the same deletion rather than an error', async () => {
    const subject = await signUp('idempotent');
    const first = await call('DELETE', '/v1/accounts/me', subject.token, {
      confirmation: CONFIRMATION,
    });
    expect(first.status).toBe(202);

    const second = await call('DELETE', '/v1/accounts/me', subject.token, {
      confirmation: CONFIRMATION,
    });

    // §8.1's entry point is a Settings row a person taps, and a retried request is
    // indistinguishable from a second tap. A `conflict` would teach people the
    // button is unreliable at exactly the moment they are deciding to leave.
    expect(second.status).toBe(200);
    expect(second.body['deletionId']).toBe(first.body['deletionId']);
    expect(second.body['completesAt']).toBe(first.body['completesAt']);
  });

  it('keeps exactly one open request, so a retry cannot move the deadline', async () => {
    const subject = await signUp('one-open');
    const first = await call('DELETE', '/v1/accounts/me', subject.token, {
      confirmation: CONFIRMATION,
    });
    await call('DELETE', '/v1/accounts/me', subject.token, { confirmation: CONFIRMATION });

    const rows = await pool.query(
      `SELECT count(*)::int AS open FROM app.account_deletions
        WHERE user_id = $1 AND status = 'scheduled'`,
      [subject.userId],
    );
    expect(rows.rows[0]).toMatchObject({ open: 1 });

    // The first request's deadline is the one that stands. A retry that pushed it
    // forward would silently extend somebody's wait, and one that pulled it back
    // would silently shorten it.
    const stored = await pool.query(
      'SELECT completes_at FROM app.account_deletions WHERE deletion_id = $1',
      [first.body['deletionId']],
    );
    // Compared to the second rather than exactly. Postgres `timestamptz` holds
    // microseconds and JavaScript holds milliseconds, so the round trip truncates —
    // what is under test is "the stored deadline is the one the service computed",
    // not that Postgres can preserve a precision the platform's clock never had. A
    // second of slack would still fail loudly if a retry had moved the deadline,
    // which is the failure this assertion exists to catch.
    const storedDeadline = new Date(String(stored.rows[0]?.['completes_at'])).getTime();
    expect(Math.abs(storedDeadline - new Date(String(first.body['completesAt'])).getTime())).toBeLessThan(
      1000,
    );
  });
});

describe('the age gate is upstream of deletion', () => {
  it('has nothing to delete for an account that was never created', async () => {
    const address = contact('under-18');
    const refused = await call('POST', '/v1/accounts', 'no-session-needed', {
      contact: address,
      password: 'correct-horse-battery-staple-42',
      dateOfBirth: '2015-06-01',
      termsVersion: CURRENT_TERMS_VERSION,
    });
    // §4.2's copy for an under-18 sign-up, verbatim.
    expect(refused.status).toBe(422);

    // §4.2: a rejected sign-up leaves no account-shaped residue, and the gate runs
    // *upstream* of everything here — so there is no account and no credential, which
    // is why there is nothing for a deletion request to act on. The property holds
    // because the row was never written, not because the deletion path checks an age.
    //
    // Probed by this attempt's own contact point rather than by a whole-table count,
    // and that is not a detail: earlier tests in this file have legitimately created
    // deletions, so a table-wide count moves under the assertion because a *sibling*
    // ran. The age-gate suite makes the same choice for the same reason. A count that
    // passes on a fresh database and fails when the file runs in full is not a test
    // of the gate.
    const residue = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM app.account_credentials WHERE contact_identifier = $1) AS credentials,
         (SELECT count(*)::int FROM app.users u
            JOIN app.account_credentials c ON c.user_id = u.user_id
           WHERE c.contact_identifier = $1) AS accounts,
         (SELECT count(*)::int FROM app.account_deletions d
            JOIN app.users u ON u.user_id = d.user_id
           WHERE u.account_id IN (SELECT account_id FROM app.users WHERE false)) AS deletions_for_this_attempt`,
      [address],
    );
    expect(residue.rows[0]).toMatchObject({
      credentials: 0,
      accounts: 0,
      deletions_for_this_attempt: 0,
    });

    // And the account surface agrees there is no account to delete.
    const read = await call(
      'GET',
      '/v1/accounts/00000000-0000-0000-0000-000000000000',
      MOD,
    );
    expect(read.status).toBe(404);
  });
});

describe('undo', () => {
  it('cancels inside the window and puts the account back exactly as it was', async () => {
    const subject = await bannedAccount('undo-inside');
    const requested = await call('DELETE', '/v1/accounts/me', subject.token, {
      confirmation: CONFIRMATION,
    });
    expect(requested.status).toBe(202);

    const undone = await call('POST', '/v1/accounts/me/deletion/undo', subject.token);

    expect(undone.status).toBe(200);
    expect(undone.body['status']).toBe('cancelled');

    // §8.1: "Restoring cancels the job, re-applies the account standing, and returns
    // the profile to its prior state." The standing is the load-bearing half — a
    // restore that quietly reinstated a banned account as `active` would be the
    // platform reversing a moderator's sanction, which is the one thing the whole
    // enforcement model forbids.
    const standing = await call('GET', `/v1/accounts/${subject.userId}`, MOD);
    expect((standing.body['account'] as Record<string, unknown>)['state']).toBe('banned');
    expect(await residueFor(subject.userId)).toMatchObject({
      credentials: 1,
      profiles: 1,
      identity: 1,
      standing: 1,
      account_row: 1,
    });
  });

  it('completes and refuses after the window, rather than reporting a success it did not achieve', async () => {
    const subject = await bannedAccount('undo-too-late');
    const requested = await call('DELETE', '/v1/accounts/me', subject.token, {
      confirmation: CONFIRMATION,
    });
    expect(requested.status).toBe(202);

    // One second past the deadline the *service* computed, so the boundary is
    // whatever §8.1 says it is rather than a date this file picked.
    const past = new Date(String(requested.body['completesAt'])).getTime() + 1000;
    clock.set(new Date(past));
    try {
      const undone = await call('POST', '/v1/accounts/me/deletion/undo', subject.token);
      // §8.1: "After 30 days the job runs to completion and cannot be undone." A
      // 200 here would be the worst answer available: it would tell a person their
      // account is back when it is gone.
      expect(undone.status).toBe(200);
      expect(undone.body['status']).toBe('completed');
      // §9's completion row, verbatim, and the retention half of §8.2 stated to the
      // user rather than kept from them.
      expect(undone.body['title']).toBe('Your account is deleted.');
    } finally {
      clock.reset();
    }

    // And the account really is anonymised, so the refusal was not only words.
    const residue = await residueFor(subject.userId);
    expect(residue['credentials']).toBe(0);
    expect(residue['onboarding']).toBe(0);
    expect(residue['profiles']).toBe(0);
    expect(residue['photos']).toBe(0);
    expect(residue['identity']).toBe(0);
    expect(residue['verification_attempts']).toBe(0);
    expect(residue['sessions']).toBe(0);
    // The account row itself survives. §8.2: "Anonymized, not erased."
    expect(residue['account_row']).toBe(1);
  });

  it('refuses an undo when there is nothing scheduled', async () => {
    const subject = await signUp('nothing-to-undo');

    const response = await call('POST', '/v1/accounts/me/deletion/undo', subject.token);

    // §9's rule that a refusal must state the resulting state: there is nothing here
    // to restore, and a 200 would imply something was just cancelled.
    expect(response.status).toBe(409);
    expect((response.body['error'] as Record<string, unknown>)['code']).toBe('conflict');
    // The account is untouched: refusing an undo must never be a way to lose one.
    expect(await residueFor(subject.userId)).toMatchObject({ credentials: 1, account_row: 1 });
  });

  it('refuses a second undo of the same request', async () => {
    const subject = await signUp('undo-twice');
    await call('DELETE', '/v1/accounts/me', subject.token, { confirmation: CONFIRMATION });
    const first = await call('POST', '/v1/accounts/me/deletion/undo', subject.token);
    expect(first.status).toBe(200);

    const second = await call('POST', '/v1/accounts/me/deletion/undo', subject.token);

    expect(second.status).toBe(409);
    expect((second.body['error'] as Record<string, unknown>)['code']).toBe('conflict');
  });
});

describe('what survives the window', () => {
  /** Runs a deletion to completion and returns the completion's own summary. */
  async function complete(
    subject: { userId: UserId; token: string },
  ): Promise<Record<string, unknown>> {
    const requested = await call('DELETE', '/v1/accounts/me', subject.token, {
      confirmation: CONFIRMATION,
    });
    expect(requested.status).toBe(202);
    const past = new Date(String(requested.body['completesAt'])).getTime() + 1000;
    clock.set(new Date(past));
    try {
      const completed = await call('POST', '/v1/accounts/me/deletion/undo', subject.token);
      expect(completed.status).toBe(200);
      return completed.body;
    } finally {
      clock.reset();
    }
  }

  it('anonymises the account rather than erasing it', async () => {
    const subject = await bannedAccount('anonymised');
    const body = await complete(subject);

    // §8.2's last row: "The row becomes `deleted` with a salted pseudonym, retaining
    // only what a safety decision needs." The row is still there and is no longer a
    // person — which is the distinction the spec is drawing when it says "not erased".
    const row = await pool.query('SELECT state, pseudonym, deleted_at FROM app.users WHERE user_id = $1', [
      subject.userId,
    ]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.['state']).toBe('deleted');
    expect(String(row.rows[0]?.['pseudonym'] ?? '')).toMatch(/^subj_[0-9a-f]{64}$/);
    expect(row.rows[0]?.['deleted_at']).toBeInstanceOf(Date);

    // The pseudonym must not be the contact point wearing a prefix. §8.2 wants a
    // stable handle, and a reversible one would be the identifier it replaced.
    expect(String(row.rows[0]?.['pseudonym'])).not.toContain(subject.contact);

    // And §9's completion row plus §A6's "states both halves": what went, and what
    // stayed. Taken from the transaction's own counts, so the summary cannot describe
    // an intention the completion did not carry out.
    expect(body['title']).toBe('Your account is deleted.');
    const summary = body['summary'] as Record<string, unknown>;
    expect(summary['deleted']).toEqual(expect.arrayContaining(['profile', 'photos', 'identifiers']));
    expect(summary['retained']).toEqual(
      expect.arrayContaining(['reports', 'cases', 'decisions', 'audit_log', 'risk_state']),
    );
    expect(summary['anonymised']).toEqual(['account_row']);
  });

  it('computes the same pseudonym for the same contact point, and a different one otherwise', async () => {
    const subject = await bannedAccount('stable-pseudonym');
    await complete(subject);

    const row = await pool.query('SELECT pseudonym FROM app.users WHERE user_id = $1', [subject.userId]);
    const stored = String(row.rows[0]?.['pseudonym']);

    // Recomputed the way a re-registration will: from the contact point, with no
    // access to the deleted row. §8.2's promise is that "a future account on the
    // same contact point ... can be linked", and that promise is only true if this
    // returns the value the completion wrote.
    const recomputed = await pool.query('SELECT app.deletion_pseudonym($1) AS p', [subject.contact]);
    expect(String(recomputed.rows[0]?.['p'])).toBe(stored);

    // Upper case, because §5.1 normalises an address by lowercasing and the
    // recomputation happens on a caller-supplied string.
    const upper = await pool.query('SELECT app.deletion_pseudonym($1) AS p', [
      subject.contact.toUpperCase(),
    ]);
    expect(String(upper.rows[0]?.['p'])).toBe(stored);

    // A different contact point must not collide, or every deleted account would
    // look like the same subject to a moderator.
    const other = await pool.query('SELECT app.deletion_pseudonym($1) AS p', ['somebody-else@example.com']);
    expect(String(other.rows[0]?.['p'])).not.toBe(stored);
  });

  it('keeps every moderation row a moderator would need to answer for the decision', async () => {
    const subject = await bannedAccount('evidence');
    const before = await evidenceFor(subject.userId);
    expect(before['reports']).toBeGreaterThan(0);
    expect(before['cases']).toBeGreaterThan(0);
    expect(before['decisions']).toBeGreaterThan(0);
    expect(before['audit']).toBeGreaterThan(0);

    await complete(subject);

    // §8.2's retention basis, in the spec's own words: the platform must be able to
    // answer, months later and in front of a regulator, "did this person, or this
    // pattern, take action against a named user, and on what evidence did we act?"
    // Deleting any of these makes that unanswerable — which is why they are asserted
    // on counts rather than on a status code.
    const after = await evidenceFor(subject.userId);
    expect(after['reports']).toBe(before['reports']);
    expect(after['cases']).toBe(before['cases']);
    expect(after['decisions']).toBe(before['decisions']);
    // `>=` rather than `===`: the completion appends its own audit row, so the count
    // is expected to *grow*. Asserting equality here would be asserting that the
    // irreversible act left no trace of itself, which is the opposite of what an
    // audit log is for. What must not change is the moderation history below it.
    expect(after['audit']).toBeGreaterThan(before['audit'] ?? 0);
  });

  it('leaves the case readable through the moderator surface, not merely present', async () => {
    const subject = await bannedAccount('case-readable');
    const caseId = await latestCaseIdFor(subject.userId);
    await complete(subject);

    // A retained row nobody can query is not retained evidence. §8.2's retention is
    // for an appeal and a regulator, and both arrive through the case view.
    const read = await call('GET', `/v1/moderation/cases/${caseId}`, MOD);
    expect(read.status).toBe(200);
    expect(read.body['caseId']).toBe(caseId);
    expect(read.body['subjectId']).toBe(subject.userId);

    // The decision and its rationale are in there, because "on what evidence did we
    // act" is a question about the decision and not only about the case.
    const decisions = read.body['decisions'] as Record<string, unknown>[];
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.some((entry) => entry['action'] === 'ban')).toBe(true);
    expect(decisions.some((entry) => typeof entry['moderatorId'] === 'string')).toBe(true);

    // And the evidence behind it survives too, which is the other half of the
    // sentence: the decision without the evidence cannot be audited.
    const evidence = await call('GET', `/v1/moderation/cases/${caseId}/evidence`, MOD);
    expect(evidence.status).toBe(200);
    expect((evidence.body['evidence'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('leaves the standing on the pseudonymous subject, so a ban is not shed by deleting', async () => {
    const subject = await bannedAccount('no-shed-ban');
    await complete(subject);

    // §8.3's last row: "A deleted account's moderation outcome still stands for the
    // pseudonymous subject. Deleting the account is not a way to shed a ban; it only
    // removes the user's own ability to use the product." The standing row is keyed
    // by the pseudonym rather than the person, so it survives the erase of
    // everything that identifies them.
    const standing = await pool.query('SELECT state FROM app.account_standing WHERE user_id = $1', [
      subject.userId,
    ]);
    expect(standing.rows[0]?.['state']).toBe('banned');

    // And nothing in the completion reset it on the way through — asserted as the
    // row rather than as the absence of an error, because the failure mode here is
    // silent: a completion that cleared the standing would leave every assertion in
    // this file green except this one.
    const viaPseudonym = await pool.query(
      `SELECT s.state FROM app.users u
         JOIN app.account_standing s ON s.user_id = u.user_id
        WHERE u.pseudonym = app.deletion_pseudonym($1)`,
      [subject.contact],
    );
    expect(viaPseudonym.rows[0]?.['state']).toBe('banned');
  });

  it('removes the identifiers §8.2 names and no more', async () => {
    const subject = await bannedAccount('identifiers');
    await complete(subject);

    // The strongest identifiers go: the contact point, the password hash and the
    // date of birth are three columns, and after this there is nothing left in the
    // schema that could reconstruct this person from their own row.
    const residue = await residueFor(subject.userId);
    expect(residue['credentials']).toBe(0);
    expect(residue['onboarding']).toBe(0);
    expect(residue['identity']).toBe(0);
    expect(residue['verification_attempts']).toBe(0);
    expect(residue['sessions']).toBe(0);
    expect(residue['profiles']).toBe(0);
    expect(residue['photos']).toBe(0);
    expect(residue['preferences']).toBe(0);
    expect(residue['locations']).toBe(0);

    // The pseudonym is the only handle left, and it is not reversible to the contact
    // point it came from.
    const row = await pool.query('SELECT pseudonym FROM app.users WHERE user_id = $1', [subject.userId]);
    expect(String(row.rows[0]?.['pseudonym'])).not.toContain(subject.contact);
  });

  it('keeps the other party’s messages and takes the subject’s', async () => {
    // A plain verified account rather than a banned one: §8.2's message rule has
    // nothing to do with standing, and a banned subject cannot like — so using one
    // here would make this test depend on the capability floor rather than on the
    // retention table. Property 2 (a banned account can delete itself) is asserted
    // by the tests above, on its own.
    const subject = await signUp('tombstones');
    await call('PUT', `/v1/accounts/${subject.userId}/profile`, subject.token, COMPLETE_PROFILE);
    await verify(harness, subject.token, subject.userId, PASSING_RESULT);

    // A real conversation with a second verified party, so there is a message to
    // classify. Both are verified because a send requires it — messaging is a
    // statement about *two* people.
    const peer = await newPeer(harness, callers, 'tombstone-peer');
    await call('PUT', `/v1/accounts/${peer.userId}/profile`, 'tombstone-peer', COMPLETE_PROFILE);
    await verify(harness, 'tombstone-peer', peer.userId, PASSING_RESULT);
    await call('POST', '/v1/interactions/likes', subject.token, { toUserId: peer.userId });
    const matched = await call('POST', '/v1/interactions/likes', 'tombstone-peer', {
      toUserId: subject.userId,
    });
    expect(matched.status).toBe(201);

    // One message each way, so the two halves of §8.2 are distinguishable by content
    // rather than by which assertion happens to run first.
    const fromPeer = await call(
      'POST',
      `/v1/conversations/${String(matched.body['conversationId'])}/messages`,
      'tombstone-peer',
      { body: 'the other party keeps this one' },
    );
    expect(fromPeer.status).toBe(201);
    const fromSubject = await call(
      'POST',
      `/v1/conversations/${String(matched.body['conversationId'])}/messages`,
      subject.token,
      { body: 'the departing side loses this one' },
    );
    expect(fromSubject.status).toBe(201);

    await complete(subject);

    // §8.2: messages are "Deleted for the user who deleted; retained in restricted
    // tombstoned form for the *other party* for a short defined window", because
    // "content that still exists for the other person must not silently vanish from
    // their side". Both halves are checked against content, because a blanket delete
    // and a blanket keep are each half of the failure.
    const surviving = await pool.query(
      'SELECT body, state, sender_id FROM app.messages WHERE conversation_id = $1',
      [matched.body['conversationId']],
    );
    expect(surviving.rows).toHaveLength(2);
    for (const message of surviving.rows) {
      if (String(message['sender_id']) === subject.userId) {
        // Sent by the subject: the row stays, so the other party's thread does not
        // silently change shape, and the content does not survive.
        expect(String(message['body'])).not.toContain('the departing side loses this one');
        expect(message['state']).toBe('deleted');
      } else {
        // Sent by the other party: untouched, because deleting somebody else's words
        // is not this subject's right, and that person is still here.
        expect(String(message['body'])).toBe('the other party keeps this one');
        expect(message['state']).not.toBe('deleted');
      }
    }
  });

});

describe('re-registration', () => {
  it('does not restore standing, and holds a banned-then-deleted account out of the product', async () => {
    const subject = await bannedAccount('re-entry');
    const requested = await call('DELETE', '/v1/accounts/me', subject.token, {
      confirmation: CONFIRMATION,
    });
    expect(requested.status).toBe(202);
    const past = new Date(String(requested.body['completesAt'])).getTime() + 1000;
    clock.set(new Date(past));
    try {
      await call('POST', '/v1/accounts/me/deletion/undo', subject.token);
    } finally {
      clock.reset();
    }

    // The same person signs up again on the same contact point. §8.3 says this is
    // allowed — refusing it would make deletion a way to obtain a permanent ban on
    // an address, which is a different and much worse product.
    const again = await call('POST', '/v1/accounts', 'no-session-needed', {
      contact: subject.contact,
      password: 'correct-horse-battery-staple-42',
      dateOfBirth: '1990-06-15',
      termsVersion: CURRENT_TERMS_VERSION,
    });
    expect(again.status).toBe(201);

    const newUserId = String(again.body['userId']);

    // §8.3: "Sign-up is allowed but the new account is not discoverable until
    // Moderation has reviewed the re-entry." Read through the standing projection
    // every product surface already reads, so the hold is enforced by the gate
    // rather than by a new one.
    const read = await call('GET', `/v1/accounts/${newUserId}`, MOD);
    const account = read.body['account'] as Record<string, unknown>;
    expect(account['visibleInProduct']).toBe(false);
    // Never `active`: "Deletion does not shed a sanction" is the claim, and a
    // projection reporting `active` would be the platform quietly reinstating the
    // account.
    expect(account['state']).not.toBe('active');
  });

  it('lets an ordinary re-registration through with nothing held', async () => {
    // The control for the test above: a contact point with no deletion history must
    // not be treated as suspicious, or the hold becomes a quiet way to exclude
    // people whose addresses were once used by somebody else.
    const subject = await signUp('clean-re-entry');
    const again = await call('POST', '/v1/accounts', 'no-session-needed', {
      contact: subject.contact,
      password: 'correct-horse-battery-staple-42',
      dateOfBirth: '1990-06-15',
      termsVersion: CURRENT_TERMS_VERSION,
    });
    // The account exists, so this contact point is still taken — which is itself
    // evidence the deleted-then-returned path did not silently free an address.
    expect(again.status).toBe(202);
  });
});

/** The most recent case opened about one subject, for the case-view assertions. */
async function latestCaseIdFor(subjectUserId: string): Promise<string> {
  const result = await pool.query(
    `SELECT case_id FROM app.cases WHERE subject_id = $1 ORDER BY opened_at DESC LIMIT 1`,
    [subjectUserId],
  );
  const caseId = result.rows[0]?.['case_id'];
  if (typeof caseId !== 'string') {
    throw new Error(`no case exists about ${subjectUserId}`);
  }
  return caseId;
}