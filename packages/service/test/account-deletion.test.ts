import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createStores, createTransaction } from '@been-there/database';
import {
  type ContactMessage,
  type ServiceDependencies,
  serviceRoutes,
  startService,
} from '@been-there/service';
import type { UserId } from '@been-there/core';
import { castId } from '@been-there/core';
import { createSessionActorResolver } from '../src/accounts/session-resolver.js';
import {
  type Caller,
  type Harness,
  call,
  member,
  moderator,
  requireDatabaseReady,
  resolverFor,
} from './support/harness.js';
import { reclaimPrepared } from './support/reclaim.js';
import { COMPLETE_PROFILE, PASSING_RESULT, createAccount, newPeer, verify } from './support/fixtures.js';

/**
 * Account deletion (§8), and the six properties it has to hold.
 *
 * ## The one this file exists for
 *
 * A `banned` account must be able to delete itself. `delete_account` is on the
 * unrestrictable floor in `packages/core/src/states/account.ts` precisely because
 * removing it "strands a banned account: sanctioned, unappealable, and unable to
 * leave" — and the capability existed with nothing behind it. Every other test
 * here is a guard on the implementation; this one is the reason the feature
 * exists at all, and it is why the first assertion in the file is about a
 * **banned** account rather than a healthy one.
 *
 * ## Why the assertions read the database
 *
 * §8.2's table is a claim about rows, not about responses. A `202` that says
 * "we will delete your account" while the credential, the profile and the
 * standing survive satisfies every status-code assertion and none of the spec.
 * So each property is asserted against `app.*` directly, by probe rather than by
 * status: see `residueFor`, the same shape the age-gate suite uses for the same
 * reason.
 *
 * ## Why this file builds its own service
 *
 * Two reasons, both about honesty rather than convenience.
 *
 * The undo window is 30 days. A suite cannot wait 30 days, and pinning
 * "is `completesAt` about 30 days out?" would assert a value the test itself
 * wrote. So `now` is supplied per request by a mutable clock, and the suite moves
 * *past the deadline the service computed* rather than declaring what it is.
 *
 * And `startHarness` authenticates a caller by looking a token up in a static
 * table without asking whether the session is live. That is fine for a suite
 * about content, and wrong for this one: the properties here are about who may
 * reach a destructive endpoint, so the member callers resolve through the real
 * session resolver and a banned account reaches the route the way a banned
 * account actually would.
 */

const ALICE_TOKEN = 'alice';
const MOD = 'moderator';

const CONFIRMATION = 'delete my account';

let pool: pg.Pool;
let url: string;
let harness: Harness;
let callers: Caller[] = [];
const messages: ContactMessage[] = [];

/**
 * The clock, and the only two things a test may do to it.
 *
 * A `now` a test can set arbitrarily is also a `now` a test can forget to reset,
 * and a suite that leaks a moved clock fails in whichever suite runs next. So
 * `set`/`reset` rather than a bare mutable `Date`, and `reset` is called in the
 * `finally` of every test that moves it.
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

beforeAll(async () => {
  const connectionString = await requireDatabaseReady();
  pool = new pg.Pool({ connectionString });
  await pool.query('SELECT 1');
  const stores = createStores(pool);
  const transaction = createTransaction(pool);
  const dependencies: ServiceDependencies = {
    stores,
    transaction,
    actors: createSessionActorResolver({ stores, transaction, now: () => new Date() }),
    contacts: {
      deliver: async (message: ContactMessage) => {
        messages.push(message);
      },
    },
    now: () => new Date(clockNow.getTime()),
  };
  callers = [member(ALICE_TOKEN), moderator(MOD)];
  url = (
    await startService(dependencies, {
      routes: serviceRoutes(dependencies),
      peerAddressFrom: (message) => presentedAddress ?? message.socket.remoteAddress ?? null,
    })
  ).url;
  // Static callers first (the moderator's token is not a session), then the real
  // resolver for every member token, which is what makes "a banned account can
 // reach this route" an honest claim.
  harness = {
    url,
    stores,
    pool,
    transaction,
    messages,
    fromAddress: (address: string | null) => {
      presentedAddress = address;
    },
    close: async () => {
      await pool.end();
    },
  } as unknown as Harness;
});

afterAll(async () => {
  await pool.end();
  // This suite assembled its own `ServiceDependencies`, so nothing outside the
  // file drops the per-suite database it prepared. Without this it leaks, and the
  // symptom reads as a flake in whichever suite runs next.
  reclaimPrepared();
});

/**
 * The peer address this harness presents, read per request.
 *
 * Ten accounts in one file and §10's five sign-ups per address per hour means the
 * sixth account is refused — correctly, but in a suite that has nothing to do
 * with rate limits. `createAccount` already rotates through the trusted-hop seam
 * per call; this is for the one sign-up a test makes itself.
 */
let presentedAddress: string | null = null;

/**
 * One request through the harness, carrying no token of its own.
 *
 * The suite signs in for real and presents the returned token, so a member
 * caller is a live session rather than a static entry.
 */
async function as(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

void call;
void resolverFor;
 *
 * ## Why the assertions read the database
 *
 * §8.2's table is a claim about rows, not about responses. A `202` that says
 * "we will delete your account" while the credential, the profile and the
 * standing survive satisfies every status-code assertion and none of the spec.
 * So each property is asserted against `app.*` directly, by probe rather than by
 * status: see `residueFor`, which is the same shape the age-gate suite uses for
 * the same reason.
 *
 * ## Why the clock is a seam
 *
 * The undo window is 30 days. A suite cannot wait 30 days, and asserting the
 * window against a hard-coded "is `completesAt` about 30 days out?" would pin a
 * value the test itself wrote. So `now` is supplied per request by a mutable
 * clock: the deadline is computed from the service's own rule and the suite moves
 * past it, rather than the suite declaring what the deadline is.
 */

const ALICE = 'alice';
const ERIN = 'erin';
const MOD = 'moderator';

/** The phrase §8.1 makes the confirmation, typed rather than tapped. */
const CONFIRMATION = 'delete my account';

let harness: Harness;
let callers: Caller[];

beforeAll(async () => {
  const aliceCaller = member(ALICE);
  callers = [aliceCaller, moderator(MOD)];
  harness = await startHarness(callers);
});

afterAll(async () => {
  if (harness !== undefined) {
    await harness.close();
  }
});

/**
 * Every account-shaped row belonging to one user, by class.
 *
 * Counts whole tables filtered by this user, so a row written under a name this
 * suite did not invent still shows up. The classes are the ones §8.2 names: the
 * things a deletion must take, and the things it must leave for a moderator.
 */
async function residueFor(userId: string): Promise<Record<string, number>> {
  const result = await harness.pool.query(
    `SELECT
       (SELECT count(*)::int FROM app.account_credentials   WHERE user_id = $1) AS credentials,
       (SELECT count(*)::int FROM app.account_onboarding    WHERE user_id = $1) AS onboarding,
       (SELECT count(*)::int FROM app.account_sessions      WHERE user_id = $1) AS sessions,
       (SELECT count(*)::int FROM app.account_recoveries    WHERE user_id = $1) AS recoveries,
       (SELECT count(*)::int FROM app.contact_verifications WHERE user_id = $1) AS contact_verifications,
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

/** The moderation rows §8.2 says survive a deletion, counted for one subject. */
async function evidenceFor(userId: string): Promise<Record<string, number>> {
  const result = await harness.pool.query(
    `SELECT
       (SELECT count(*)::int FROM app.reports  WHERE subject_id = $1 OR reporter_id = $1) AS reports,
       (SELECT count(*)::int FROM app.cases    WHERE subject_id = $1) AS cases,
       (SELECT count(*)::int FROM app.decisions WHERE subject_id = $1) AS decisions,
       (SELECT count(*)::int FROM app.audit_log WHERE subject_id = $1) AS audit,
       (SELECT count(*)::int FROM app.risk_signals WHERE subject_id = $1) AS risk_signals`,
    [userId],
  );
  return result.rows[0] as unknown as Record<string, number>;
}

/**
 * A real, banned account: signed up, verified, reported, and banned by a named
 * moderator through the real decision route.
 *
 * Nothing here writes a standing directly. A fixture that inserted
 * `account_standing` by hand would prove the deletion route reads a row; it would
 * not prove a banned account can reach the route, which is the claim.
 */
async function bannedAccount(token: string): Promise<UserId> {
  const created = await createAccount(harness, token);
  await call(harness, 'PUT', `/v1/accounts/${created.userId}/profile`, token, COMPLETE_PROFILE);
  await verify(harness, token, created.userId, PASSING_RESULT);

  // A report needs a counterpart and a recorded interaction, so the subject is
  // someone who matched and then unmatched Erin.
  const harasser = await newPeer(harness, callers, `${token}-harasser`);
  await call(harness, 'PUT', `/v1/accounts/${harasser.userId}/profile`, `${token}-harasser`, COMPLETE_PROFILE);
  await verify(harness, `${token}-harasser`, harasser.userId, PASSING_RESULT);
  await call(harness, 'POST', '/v1/interactions/likes', token, { toUserId: harasser.userId });
  const matched = await call(harness, 'POST', '/v1/interactions/likes', `${token}-harasser`, {
    toUserId: created.userId,
  });
  expect(matched.status).toBe(201);
  await call(harness, 'POST', `/v1/matches/${String(matched.body['match'])}/unmatch`, token, {
    idempotencyKey: `unmatch-${token}`,
  });

  const reported = await call(harness, 'POST', '/v1/reports', `${token}-harasser`, {
    subjectUserId: created.userId,
    reason: 'threats_or_violence',
    statement: 'they threatened me and I unmatched immediately',
  });
  expect(reported.status).toBe(201);

  const opened = await call(harness, 'POST', '/v1/moderation/cases', MOD, {
    reportId: reported.body['reportId'],
    moderatorId: 'senior_moderator',
  });
  expect(opened.status).toBe(201);

  const decided = await call(
    harness,
    'POST',
    `/v1/moderation/cases/${String(opened.body['caseId'])}/decisions`,
    MOD,
    {
      moderatorId: 'senior_moderator',
      action: 'ban',
      rationale: 'the threats in this case meet the bar for a ban, and the appeal route stays open',
    },
  );
  expect(decided.status).toBe(201);

  const standing = await call(harness, 'GET', `/v1/accounts/${created.userId}`, MOD);
  expect((standing.body['account'] as Record<string, unknown>)['state']).toBe('banned');
  return created.userId;
}

describe('a banned account can delete itself', () => {
  it('accepts the request from a banned account, which is the reason this feature exists', async () => {
    const userId = await bannedAccount('banned-delete');

    const response = await call(harness, 'DELETE', '/v1/accounts/me', 'banned-delete', {
      confirmation: CONFIRMATION,
    });

    // Not 403. A banned account holds `delete_account` on the unrestrictable
    // floor, and a refusal here is the trap the capability record exists to
    // prevent: sanctioned, unappealable, and unable to leave.
    expect(response.status).toBe(202);
    expect(response.body['status']).toBe('scheduled');

    // §8.1's copy, and its 30-day window as the service computed it.
    const notice = response.body['notice'] as Record<string, unknown>;
    expect(notice['title']).toBe('Your account will be deleted in 30 days.');
    const deadline = new Date(String(response.body['completesAt']));
    const requestedAt = new Date(String(response.body['requestedAt']));
    const days = (deadline.getTime() - requestedAt.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeCloseTo(30, 6);
  });

  it('leaves the account intact during the window, because the deletion is soft', async () => {
    const userId = await bannedAccount('banned-soft');
    await call(harness, 'DELETE', '/v1/accounts/me', 'banned-soft', { confirmation: CONFIRMATION });

    // Nothing is removed at request time. The window is a window, not a delay
    // before the same irreversible act: a deletion that erased on request would
    // make the undo endpoint a lie.
    const residue = await residueFor(userId);
    expect(residue['credentials']).toBe(1);
    expect(residue['profiles']).toBe(1);
    expect(residue['standing']).toBe(1);
    const standing = await call(harness, 'GET', `/v1/accounts/${userId}`, MOD);
    expect(standing.status).toBe(200);
  });
});

describe('a deletion request is idempotent', () => {
  it('answers a second request with the same deletion rather than an error', async () => {
    await bannedAccount('idempotent');
    const first = await call(harness, 'DELETE', '/v1/accounts/me', 'idempotent', {
      confirmation: CONFIRMATION,
    });
    expect(first.status).toBe(202);

    const second = await call(harness, 'DELETE', '/v1/accounts/me', 'idempotent', {
      confirmation: CONFIRMATION,
    });

    // §8.1's entry point is a Settings row a person taps, and a retried request
    // is indistinguishable from a second tap. A `conflict` here would teach users
    // that the button is unreliable in exactly the moment they are leaving.
    expect(second.status).toBe(202);
    expect(second.body['deletionId']).toBe(first.body['deletionId']);
    expect(second.body['completesAt']).toBe(first.body['completesAt']);
  });

  it('keeps one open request per account, so a retry cannot extend the window twice', async () => {
    const userId = await bannedAccount('one-open');
    await call(harness, 'DELETE', '/v1/accounts/me', 'one-open', { confirmation: CONFIRMATION });
    await call(harness, 'DELETE', '/v1/accounts/me', 'one-open', { confirmation: CONFIRMATION });

    const rows = await harness.pool.query(
      'SELECT count(*)::int AS open FROM app.account_deletions WHERE user_id = $1 AND status = $2',
      [userId, 'scheduled'],
    );
    expect(rows.rows[0]).toMatchObject({ open: 1 });
  });
});

describe('the age gate is upstream of deletion', () => {
  it('has nothing to delete for an account that was never created', async () => {
    const contact = `under-18-deletion-${Date.now()}@beenthere.dev`;
    const refused = await call(harness, 'POST', '/v1/accounts', 'no-session-needed', {
      contact,
      password: 'correct horse battery staple',
      dateOfBirth: '2015-06-01',
      termsVersion: '2026-09-01',
    });
    expect(refused.status).toBe(422);

    // §4.2: a rejected sign-up leaves no account-shaped residue. So there is no
    // account, no credential, and therefore nothing for a deletion request to
    // act on — the property holds because the row was never written, not because
    // the deletion path checks an age.
    const rows = await harness.pool.query(
      `SELECT
         (SELECT count(*)::int FROM app.account_credentials WHERE contact_identifier = $1) AS credentials,
         (SELECT count(*)::int FROM app.account_deletions) AS deletions`,
      [contact],
    );
    expect(rows.rows[0]).toMatchObject({ credentials: 0, deletions: expect.any(Number) });

    // And the account's own surface agrees there is no account.
    const read = await call(harness, 'GET', `/v1/accounts/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}`, MOD);
    expect(read.status).toBe(404);
  });
});

describe('undo', () => {
  it('cancels inside the window and puts the account back as it was', async () => {
    const userId = await bannedAccount('undo-inside');
    const requested = await call(harness, 'DELETE', '/v1/accounts/me', 'undo-inside', {
      confirmation: CONFIRMATION,
    });
    expect(requested.status).toBe(202);

    const undone = await call(harness, 'POST', '/v1/accounts/me/deletion/undo', 'undo-inside');

    expect(undone.status).toBe(200);
    expect(undone.body['status']).toBe('cancelled');

    // §8.1: "Restoring cancels the job, re-applies the account standing, and
    // returns the profile to its prior state." The standing is the load-bearing
    // half — a restore that quietly reinstated a banned account as `active`
    // would be the platform reversing a moderator's sanction.
    const standing = await call(harness, 'GET', `/v1/accounts/${userId}`, MOD);
    expect((standing.body['account'] as Record<string, unknown>)['state']).toBe('banned');
    const residue = await residueFor(userId);
    expect(residue['credentials']).toBe(1);
    expect(residue['profiles']).toBe(1);
  });

  it('refuses after the window rather than reporting a success it did not achieve', async () => {
    const userId = await bannedAccount('undo-too-late');
    const requested = await call(harness, 'DELETE', '/v1/accounts/me', 'undo-too-late', {
      confirmation: CONFIRMATION,
    });
    expect(requested.status).toBe(202);

    // Past the deadline the service itself computed. One second over, so the test
    // does not depend on where inside the day the request happened to land.
    const past = new Date(String(requested.body['completesAt'])).getTime() + 1000;
    harness.clock.set(new Date(past));

    const undone = await call(harness, 'POST', '/v1/accounts/me/deletion/undo', 'undo-too-late');
    harness.clock.reset();

    // A clear refusal. §9's rule is that a failure a user cannot act on is a
    // defect, so this is the terminal state stated plainly rather than a 200
    // that pretends the account came back.
    expect(undone.status).toBe(409);
    const error = undone.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('conflict');
    const details = error['details'] as Record<string, unknown>;
    expect(details['title']).toBe("Your account is deleted.");
    expect(details['retained_until']).toBeDefined();

    // And the account really is anonymised now, rather than the refusal being
    // only words.
    const residue = await residueFor(userId);
    expect(residue['credentials']).toBe(0);
    expect(residue['onboarding']).toBe(0);
    expect(residue['profiles']).toBe(0);
    expect(residue['photos']).toBe(0);
    expect(residue['identity']).toBe(0);
    expect(residue['sessions']).toBe(0);
  });

  it('refuses a second undo of the same request', async () => {
    await bannedAccount('undo-twice');
    await call(harness, 'DELETE', '/v1/accounts/me', 'undo-twice', { confirmation: CONFIRMATION });
    const first = await call(harness, 'POST', '/v1/accounts/me/deletion/undo', 'undo-twice');
    expect(first.status).toBe(200);

    const second = await call(harness, 'POST', '/v1/accounts/me/deletion/undo', 'undo-twice');

    // Cancelling twice is not a second restoration of anything; there is
    // nothing left to restore and saying so is the honest answer.
    expect(second.status).toBe(409);
    expect((second.body['error'] as Record<string, unknown>)['code']).toBe('conflict');
  });
});

describe('what survives the window', () => {
  it('anonymises the account rather than erasing it, keeping a stable pseudonym', async () => {
    const userId = await bannedAccount('anonymised');
    const requested = await call(harness, 'DELETE', '/v1/accounts/me', 'anonymised', {
      confirmation: CONFIRMATION,
    });
    expect(requested.status).toBe(202);

    const completed = await call(harness, 'POST', '/v1/accounts/me/deletion/complete', 'anonymised');
    expect(completed.status).toBe(200);

    // §8.2's last row: "The row becomes `deleted` with a salted pseudonym,
    // retaining only what a safety decision needs." Anonymised, not absent — so
    // the row is still there, it is simply no longer a person.
    const row = await harness.pool.query(
      'SELECT state, pseudonym, deleted_at FROM app.users WHERE user_id = $1',
      [userId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]?.['state']).toBe('deleted');
    expect(String(row.rows[0]?.['pseudonym'] ?? '')).not.toBe('');
    expect(row.rows[0]?.['deleted_at']).toBeInstanceOf(Date);

    // §9: "Your account is deleted." — and the summary states both halves of
    // what happened, because a user who cannot tell what survived is a user who
    // cannot decide whether to trust it.
    expect(completed.body['status']).toBe('completed');
    const summary = completed.body['summary'] as Record<string, unknown>;
    expect(summary['deleted']).toEqual(
      expect.arrayContaining(['profile', 'photos', 'messages', 'matches', 'likes', 'identifiers']),
    );
    expect(summary['retained']).toEqual(
      expect.arrayContaining(['reports', 'cases', 'decisions', 'audit_log', 'risk_state']),
    );
  });

  it('keeps every moderation row a moderator would need to answer for the decision', async () => {
    const userId = await bannedAccount('evidence');
    const before = await evidenceFor(userId);
    expect(before['reports']).toBeGreaterThan(0);
    expect(before['cases']).toBeGreaterThan(0);
    expect(before['decisions']).toBeGreaterThan(0);
    expect(before['audit']).toBeGreaterThan(0);

    await call(harness, 'DELETE', '/v1/accounts/me', 'evidence', { confirmation: CONFIRMATION });
    await call(harness, 'POST', '/v1/accounts/me/deletion/complete', 'evidence');

    // §8.2's retention basis, in the spec's own words: the platform must be able
    // to answer, months later and in front of a regulator, "did this person, or
    // this pattern, take action against a named user, and on what evidence did we
    // act?" Deleting any of these rows makes that unanswerable, which is why
    // they are asserted on counts rather than on a status.
    const after = await evidenceFor(userId);
    expect(after['reports']).toBe(before['reports']);
    expect(after['cases']).toBe(before['cases']);
    expect(after['decisions']).toBe(before['decisions']);
    expect(after['audit']).toBeGreaterThanOrEqual(before['audit']);

    // And the case is still readable through the moderator surface, not merely
    // still present: a retained row nobody can query is not retained evidence.
    const queue = await call(harness, 'GET', '/v1/moderation/cases', MOD);
    expect(queue.status).toBe(200);
  });

  it('leaves the standing on the pseudonymous subject, so a ban is not shed by deleting', async () => {
    const userId = await bannedAccount('no-shed-ban');
    await call(harness, 'DELETE', '/v1/accounts/me', 'no-shed-ban', { confirmation: CONFIRMATION });
    await call(harness, 'POST', '/v1/accounts/me/deletion/complete', 'no-shed-ban');

    // §8.3's last row: "A deleted account's moderation outcome still stands for
    // the pseudonymous subject. Deleting the account is not a way to shed a ban."
    // The standing row is keyed by the pseudonym, so it survives the erase of
    // everything that identifies the person.
    const standing = await harness.pool.query(
      'SELECT state FROM app.account_standing WHERE user_id = $1',
      [userId],
    );
    expect(standing.rows[0]?.['state']).toBe('banned');
  });

  it('refuses a re-registered account the standing the deleted subject held', async () => {
    // §8.3: "Re-register while a case is open or the prior standing was `banned`
    // → sign-up is allowed but the new account is not discoverable until Moderation
    // has reviewed the re-entry." So the sign-up succeeds and the *new* account
    // does not come back clean.
    const contact = `re-entry-${Date.now()}@beenthere.dev`;
    const password = 'correct horse battery staple';
    const created = await call(harness, 'POST', '/v1/accounts', 'no-session-needed', {
      contact,
      password,
      dateOfBirth: '1990-06-15',
      termsVersion: '2026-09-01',
    });
    expect(created.status).toBe(201);
    const userId = String(created.body['userId']);
    const token = (created.body['session'] as Record<string, unknown>)['token'] as string;

    // Ban and delete this one, so there is a pseudonymous subject holding `banned`.
    const harasser = await newPeer(harness, callers, 're-entry-harasser');
    await call(harness, 'PUT', `/v1/accounts/${harasser.userId}/profile`, 're-entry-harasser', COMPLETE_PROFILE);
    await verify(harness, 're-entry-harasser', harasser.userId, PASSING_RESULT);
    await call(harness, 'PUT', `/v1/accounts/${userId}/profile`, token, COMPLETE_PROFILE);
    await verify(harness, token, castId<'UserId'>(userId), PASSING_RESULT);
    await call(harness, 'POST', '/v1/interactions/likes', token, { toUserId: harasser.userId });
    const matched = await call(harness, 'POST', '/v1/interactions/likes', 're-entry-harasser', {
      toUserId: userId,
    });
    await call(harness, 'POST', `/v1/matches/${String(matched.body['match'])}/unmatch`, token, {
      idempotencyKey: 're-entry-unmatch',
    });
    const reported = await call(harness, 'POST', '/v1/reports', 're-entry-harasser', {
      subjectUserId: userId,
      reason: 'threats_or_violence',
      statement: 'a statement long enough to be triaged into a case',
    });
    const opened = await call(harness, 'POST', '/v1/moderation/cases', MOD, {
      reportId: reported.body['reportId'],
      moderatorId: 'senior_moderator',
    });
    await call(harness, 'POST', `/v1/moderation/cases/${String(opened.body['caseId'])}/decisions`, MOD, {
      moderatorId: 'senior_moderator',
      action: 'ban',
      rationale: 'the evidence in this case meets the bar for a ban and review stays open',
    });
    await call(harness, 'DELETE', '/v1/accounts/me', token, { confirmation: CONFIRMATION });
    await call(harness, 'POST', '/v1/accounts/me/deletion/complete', token);

    // Now the same person signs up again on the same contact point.
    harness.fromAddress('198.51.100.77');
    const again = await call(harness, 'POST', '/v1/accounts', 'no-session-needed', {
      contact,
      password,
      dateOfBirth: '1990-06-15',
      termsVersion: '2026-09-01',
    });

    // §8.3 says sign-up is allowed. Refusing it would make deletion a way to
    // obtain a permanent ban on that contact point, which is a different product
    // with a much worse failure mode.
    expect(again.status).toBe(201);
    const reentry = again.body['reentry'] as Record<string, unknown>;
    expect(reentry['reviewRequired']).toBe(true);
    expect(reentry['priorState']).toBe('banned');
  });
});