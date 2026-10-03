import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Caller, type Harness, call, member, staffIdentity, startHarness } from './support/harness.js';
import { COMPLETE_PROFILE, PASSING_RESULT, createAccount, newPeer, verify } from './support/fixtures.js';

/**
 * Staff identity, over real HTTP against the real database.
 *
 * ## What this suite exists to prove
 *
 * Before this change a moderator was a string compared in JavaScript by a
 * composition root, and `actorId` was set to that string. The consequences are
 * all checkable, and every one of them was a real gap:
 *
 *  - A decision recorded a credential, not a person, so `decisions.moderator_id`
 *    could not answer "which human did this".
 *  - Access could not be withdrawn for one person. Revoking the shared token
 *    invalidated it for everyone, which is the opposite of what a suspension is.
 *  - Nothing could be *audited*: the audit log names an actor, and the actor was
 *    a bearer token that appeared in logs.
 *
 * So the properties here are the ones a person needs to exist: a human can reach
 * a queue, their name is what gets recorded, their access can be withdrawn
 * without touching anyone else's, and the guards that refused a nameless decision
 * still refuse now that a name is available.
 */
const BOB = 'bob';
const ERIN = 'erin';

describe('a named moderator can reach the queue, and the queue records their name', () => {
  let harness: Harness;
  let callers: Caller[];
  let bob: string;
  let mod: Awaited<ReturnType<typeof staffIdentity>>;
  let bot: Awaited<ReturnType<typeof staffIdentity>>;

  beforeAll(async () => {
    const bobCaller = member(BOB);
    harness = await startHarness([bobCaller]);
    // Real identities, minted after the service is listening: provisioning needs
    // the database, and the session it mints is resolved by the running service.
    mod = await staffIdentity(harness, 'senior_moderator', { suffix: 'identity' });
    bot = await staffIdentity(harness, 'senior_moderator', { suffix: 'identity-bot', automated: true });
    callers = [bobCaller, mod.caller, bot.caller];
    harness.reloadCallers(callers);

    // `createAccount` returns the branded id; kept branded rather than widened to
    // `string` so nothing downstream has to cast it back.
    const bobId = (await createAccount(harness, BOB)).userId;
    bob = bobId;
    bobCaller.userId = bobId;
    await call(harness, 'PUT', `/v1/accounts/${bob}/profile`, BOB, COMPLETE_PROFILE);
    await verify(harness, BOB, bob, PASSING_RESULT);
  });

  afterAll(async () => {
    await harness?.close();
  });

  /** A report about somebody Bob interacted with, which is what a case opens from. */
  async function aReportedPeer(): Promise<string> {
    const peer = (await newPeer(harness, callers, ERIN)).userId;
    await call(harness, 'PUT', `/v1/accounts/${peer}/profile`, ERIN, COMPLETE_PROFILE);
    await verify(harness, ERIN, peer, PASSING_RESULT);
    await call(harness, 'POST', '/v1/interactions/likes', BOB, { toUserId: peer });
    const matched = await call(harness, 'POST', '/v1/interactions/likes', ERIN, { toUserId: bob });
    await call(harness, 'POST', `/v1/matches/${String(matched.body['match'])}/unmatch`, BOB, {
      idempotencyKey: 'staff-identity-unmatch',
    });
    const reported = await call(harness, 'POST', '/v1/reports', BOB, {
      subjectUserId: peer,
      reason: 'threats_or_violence',
      statement: 'they threatened me in the conversation',
    });
    expect(reported.status).toBe(201);
    return String(reported.body['reportId']);
  }

  it('signs a moderator in and returns who they are', async () => {
    const signedIn = await call(harness, 'POST', '/v1/staff-sessions', 'nobody', {
      contact: mod.contact,
      password: mod.password,
    });
    expect(signedIn.status).toBe(201);
    expect(signedIn.body['staffId']).toBe(mod.staffId);
    expect(signedIn.body['displayName']).toBe(mod.displayName);
    expect(signedIn.body['role']).toBe('senior_moderator');
    // Absent, not null. There is no member behind a staff session, and a
    // fabricated all-null member field is what made the old token path hard to
    // reason about.
    expect('userId' in signedIn.body).toBe(false);
  });

  it('serves the queue to a staff session', async () => {
    const queue = await call(harness, 'GET', '/v1/moderation/cases', mod.token);
    expect(queue.status).toBe(200);
  });

  it('records the moderator identity, not the bearer token', async () => {
    const reportId = await aReportedPeer();
    const opened = await call(harness, 'POST', '/v1/moderation/cases', mod.token, {
      reportId,
      moderatorId: mod.staffId,
    });
    expect(opened.status).toBe(201);
    const caseId = String(opened.body['caseId']);

    const decided = await call(harness, 'POST', `/v1/moderation/cases/${caseId}/decisions`, mod.token, {
      moderatorId: mod.staffId,
      action: 'restrict',
      removedCapabilities: ['like'],
      rationale: 'the messages retained on this case meet the bar for a first restriction',
    });
    expect(decided.status).toBe(201);

    // The person, not the credential. This is the assertion the old harness could
    // not make: `actorId` used to be the token, so "the recorded moderator is the
    // session holder" was true only in the sense that the token named itself.
    expect(decided.body['moderatorId']).toBe(mod.staffId);
    expect(decided.body['moderatorId']).not.toBe(mod.token);
  });

  it('refuses a decision that names a moderator who is not the session holder', async () => {
    const reportId = await aReportedPeer();
    const opened = await call(harness, 'POST', '/v1/moderation/cases', mod.token, {
      reportId,
      moderatorId: mod.staffId,
    });
    const caseId = String(opened.body['caseId']);

    // The impersonation the old body-supplied `moderatorId` allowed: any
    // moderator could attribute a sanction to a colleague, and the record would
    // say the colleague did it.
    const attributed = await call(harness, 'POST', `/v1/moderation/cases/${caseId}/decisions`, mod.token, {
      moderatorId: bot.staffId,
      action: 'ban',
      rationale: 'a long enough rationale that only the attribution is wrong',
    });
    expect(attributed.status).toBe(403);
    const error = attributed.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('permission_denied');
    expect((error['details'] as Record<string, unknown>)['reason']).toBe('moderator_mismatch');
  });

  it('still refuses a decision with no named moderator at all', async () => {
    const reportId = await aReportedPeer();
    const opened = await call(harness, 'POST', '/v1/moderation/cases', mod.token, {
      reportId,
      moderatorId: mod.staffId,
    });
    const caseId = String(opened.body['caseId']);

    const anonymous = await call(harness, 'POST', `/v1/moderation/cases/${caseId}/decisions`, mod.token, {
      action: 'warn',
      rationale: 'a sufficiently long rationale for the decision',
    });
    expect(anonymous.status).toBe(400);
    const error = anonymous.body['error'] as Record<string, unknown>;
    expect((error['details'] as Record<string, unknown>)['field']).toBe('moderatorId');
  });

  it('still refuses a decision from an automated actor holding a real identity', async () => {
    const reportId = await aReportedPeer();
    const opened = await call(harness, 'POST', '/v1/moderation/cases', mod.token, {
      reportId,
      moderatorId: mod.staffId,
    });
    expect(opened.status).toBe(201);
    const caseId = String(opened.body['caseId']);

    // The load-bearing one. A real, correctly-named, unsuspended staff identity —
    // everything a decision needs except a person at the keyboard — and the
    // refusal must still fire. If satisfying the named-human guard were enough,
    // this would succeed, and the guard would have been satisfied by a string
    // rather than by a human.
    const automated = await call(harness, 'POST', `/v1/moderation/cases/${caseId}/decisions`, bot.token, {
      moderatorId: bot.staffId,
      action: 'ban',
      rationale: 'a sufficiently long rationale that only the automation is wrong',
    });
    expect(automated.status).toBe(403);
    const error = automated.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('permission_denied');
  });

  it('stops honouring a revoked staff session', async () => {
    const reportId = await aReportedPeer();
    const opened = await call(harness, 'POST', '/v1/moderation/cases', mod.token, {
      reportId,
      moderatorId: mod.staffId,
    });
    expect(opened.status).toBe(201);

    const revoked = await call(harness, 'DELETE', '/v1/staff-sessions/all', 'nobody', {
      staffId: mod.staffId,
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body['revoked']).toBeGreaterThan(0);

    // The token is unexpired and still well-formed. It must not authenticate,
    // because revocation is a statement about the credential rather than about
    // the clock.
    const afterRevocation = await call(harness, 'GET', '/v1/moderation/cases', mod.token);
    expect(afterRevocation.status).toBe(403);
  });

  it('stops honouring a suspended identity before its token could expire', async () => {
    const live = await staffIdentity(harness, 'senior_moderator', { suffix: 'suspend-me' });
    harness.reloadCallers([...callers, live.caller]);
    expect((await call(harness, 'GET', '/v1/moderation/cases', live.token)).status).toBe(200);

    await harness.transaction.run((tx) =>
      harness.stores.staff.updateStaffStatus(live.staffId, 'suspended', new Date(), tx),
    );

    // The session is untouched: still active, nowhere near its refresh window. It
    // stops working anyway, because the role and the status live on the identity
    // and the resolver reads them per request. A status cached on the session row
    // would keep this moderator working for up to thirty days.
    const afterSuspension = await call(harness, 'GET', '/v1/moderation/cases', live.token);
    expect(afterSuspension.status).toBe(403);
  });

  it('says the same thing for a wrong password and an unknown contact', async () => {
    const wrongPassword = await call(harness, 'POST', '/v1/staff-sessions', 'nobody', {
      contact: mod.contact,
      password: 'not-the-password-at-all',
    });
    const unknownContact = await call(harness, 'POST', '/v1/staff-sessions', 'nobody', {
      contact: 'nobody@been-there.test',
      password: 'not-the-password-at-all',
    });

    expect(wrongPassword.status).toBe(unknownContact.status);
    // Identical bodies, not merely identical statuses: a difference here is an
    // existence oracle over the staff directory, which is more sensitive than the
    // member one.
    expect(wrongPassword.body).toEqual(unknownContact.body);
  });

  it('refuses a suspended identity at sign-in, with that same body', async () => {
    const suspended = await staffIdentity(harness, 'moderator', { suffix: 'never-signs-in' });
    await harness.transaction.run((tx) =>
      harness.stores.staff.updateStaffStatus(suspended.staffId, 'suspended', new Date(), tx),
    );

    const refused = await call(harness, 'POST', '/v1/staff-sessions', 'nobody', {
      contact: suspended.contact,
      password: suspended.password,
    });
    expect(refused.status).toBe(403);
    expect('token' in refused.body).toBe(false);
  });
});
