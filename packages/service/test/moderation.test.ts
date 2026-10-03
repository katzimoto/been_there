import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { castId } from '@been-there/core';
import {
  type Caller,
  type Harness,
  call,
  member,
  startHarness,
  staffIdentity,
} from './support/harness.js';
import { COMPLETE_PROFILE, PASSING_RESULT, createAccount, newPeer, verify } from './support/fixtures.js';

const ALICE = 'alice';
const STRANGER = 'stranger';
const BOB = 'bob';
const ERIN = 'erin-token';
let MOD = 'moderator-token';
let BOT = 'automation-token';

/** The reporting, queue and decision half of the flow. */
describe('reports, the moderator queue, and decisions', () => {
  let harness: Harness;
  let callers: Caller[];
  let bob: UserId;
  /** The staff identity ids the database minted. */
  let modId: string;
  let botId: string;
  /** A verified user Bob has matched and then unmatched with. */
  let reportedUserId: string;

  beforeAll(async () => {
    const bobCaller = member('bob');
    // A placeholder so the harness starts with its shape; the real caller list is
    // rebuilt below once the identities exist. Starting the service first is not
    // an option: provisioning a staff identity needs the database, and the
    // resolver needs to be running to resolve the token it issues.
    harness = await startHarness([bobCaller]);
    // Real staff identities, not tokens in a table. `MOD` resolves to a row in
    // `staff_identities` and a session minted by production code, so `actorId`
    // is a person the database named. This is the property the suite exists to
    // check, and a static token could not check it at all.
    const mod = await staffIdentity(harness, 'senior_moderator', { suffix: 'mod' });
    const bot = await staffIdentity(harness, 'senior_moderator', {
      suffix: 'bot',
      automated: true,
    });
    callers = [bobCaller, mod.caller, bot.caller];
    await harness.reloadCallers(callers);
    modId = mod.staffId;
    botId = bot.staffId;
    MOD = mod.token;
    BOT = bot.token;
    bob = (await createAccount(harness, 'bob')).userId;
    bobCaller.userId = bob;
    const profile = await call(harness, 'PUT', `/v1/accounts/${bob}/profile`, 'bob', COMPLETE_PROFILE);
    expect(profile.status).toBe(200);

    // Bob must be verified as well as profiled: a like is a statement about *both*
    // people, and `recordLike`'s target-side checks refuse an unverified
    // counterpart with one indistinguishable `not_eligible`.
    await verify(harness, BOB, bob, PASSING_RESULT);
    const erin = (await newPeer(harness, callers, ERIN)).userId;
    await call(harness, 'PUT', `/v1/accounts/${erin}/profile`, ERIN, COMPLETE_PROFILE);
    await verify(harness, ERIN, erin, PASSING_RESULT);
    await call(harness, 'POST', '/v1/interactions/likes', BOB, { toUserId: erin });
    const matched = await call(harness, 'POST', '/v1/interactions/likes', ERIN, { toUserId: bob });
    expect(matched.status).toBe(201);
    expect(matched.body['resolution']).toBe('match_created');
    const unmatched = await call(harness, 'POST', `/v1/matches/${String(matched.body['match'])}/unmatch`, BOB, {
      idempotencyKey: 'unmatch-setup',
    });
    expect(unmatched.status).toBe(200);
    reportedUserId = erin;
  });

  afterAll(async () => {
    if (harness !== undefined) {
      await harness.close();
    }
  });

  it('reports after an unmatch, because the evidence is retained independently of the relationship', async () => {
    // The pair was matched and then unmatched in `beforeAll`, so the relationship
    // is over and only the records remain. `evidenceForReport` reads the retained
    // records, not the relationship's current state, which is the whole of it.
    const reported = await call(harness, 'POST', '/v1/reports', BOB, {
      subjectUserId: reportedUserId,
      reason: 'harassment',
      statement: 'they were abusive after we matched',
    });
    expect(reported.status).toBe(201);
    expect(reported.body['relationship']).toBe('unmatched');
    expect(reported.body['evidence']).toBeGreaterThan(0);
  });

  it('refuses a report about somebody with no recorded interaction at all', async () => {
    await newPeer(harness, callers, STRANGER);
    const response = await call(harness, 'POST', '/v1/reports', STRANGER, {
      subjectUserId: bob,
      reason: 'spam',
    });
    expect(response.status).toBe(404);
    const error = response.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('not_found');
  });

  it('opens a case from a triaged report and refuses the queue to a member', async () => {
    const reported = await call(harness, 'POST', '/v1/reports', BOB, {
      subjectUserId: reportedUserId,
      reason: 'threats_or_violence',
      statement: 'they threatened me in the conversation',
    });
    expect(reported.status).toBe(201);

    const memberQueue = await call(harness, 'GET', '/v1/moderation/cases', BOB);
    expect(memberQueue.status).toBe(403);

    const opened = await call(harness, 'POST', '/v1/moderation/cases', MOD, {
      reportId: reported.body['reportId'],
      // The session's own identity, not a role name. The route refuses a body
      // value that does not match the authenticated actor, so this is also the
      // assertion that the recorded moderator is a person rather than a literal.
      moderatorId: modId,
    });
    expect(opened.status).toBe(201);
    // A person-safety reason triages urgent whatever else says.
    expect(opened.body['priority']).toBe('urgent');
    expect(opened.body['queue']).toBe('safety');
    expect((opened.body['evidenceIds'] as unknown[]).length).toBeGreaterThan(0);

    const queue = await call(harness, 'GET', '/v1/moderation/cases', MOD);
    expect(queue.status).toBe(200);
    expect((queue.body['cases'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('refuses a decision with no moderator id, and refuses an automated actor', async () => {
    const reportId = await latestReportId(harness, reportedUserId, BOB);
    const opened = await call(harness, 'POST', '/v1/moderation/cases', MOD, {
      reportId,
      moderatorId: modId,
    });
    expect(opened.status).toBe(201);
    const caseId = String(opened.body['caseId']);

    const anonymous = await call(harness, 'POST', `/v1/moderation/cases/${caseId}/decisions`, MOD, {
      action: 'warn',
      rationale: 'a sufficiently long rationale for the decision',
    });
    expect(anonymous.status).toBe(400);
    const error = anonymous.body['error'] as Record<string, unknown>;
    expect((error['details'] as Record<string, unknown>)['field']).toBe('moderatorId');

    const automated = await call(harness, 'POST', `/v1/moderation/cases/${caseId}/decisions`, BOT, {
      action: 'ban',
      moderatorId: botId,
      rationale: 'a sufficiently long rationale for the decision',
    });
    expect(automated.status).toBe(403);
    const refusal = automated.body['error'] as Record<string, unknown>;
    expect(refusal['code']).toBe('permission_denied');
  });

  it('records a decision under the named moderator and applies the standing it produced', async () => {
    const caseId = await anOpenCaseFor(harness, reportedUserId);
    const decided = await call(harness, 'POST', `/v1/moderation/cases/${caseId}/decisions`, MOD, {
      moderatorId: modId,
      action: 'restrict',
      removedCapabilities: ['like'],
      rationale: 'the messages in this case meet the bar for a first restriction',
    });
    expect(decided.status).toBe(201);
    // The staff identity, not the role and not the bearer token. Before staff
    // sessions existed this assertion could only be made against a literal,
    // because the actor id *was* the token.
    expect(decided.body['moderatorId']).toBe(modId);
    expect(decided.body['action']).toBe('restrict');
    expect(decided.body['caseState']).toBe('resolved');
    // The decision and its audit rows are one unit of work, and there is at least
    // one of each.
    expect(Number(decided.body['auditEntries'])).toBeGreaterThan(0);

    const read = await call(harness, 'GET', `/v1/accounts/${reportedUserId}`, MOD);
    const account = read.body['account'] as Record<string, unknown>;
    expect(account['state']).toBe('limited');
    const capabilities = account['capabilities'] as string[];
    expect(capabilities).not.toContain('like');
    // The unrestrictable floor is applied where the grant is computed, so a
    // restriction can never take away the ability to report or block.
    expect(capabilities).toContain('report');
    expect(capabilities).toContain('block');
  });

  it('publishes what a restriction removed and which case decided it, to the account owner', async () => {
    // The decision above restricted Erin, so the standing row exists and carries
    // the case that produced it. Erin is the owner and reads her own account.
    const owner = await call(harness, 'GET', `/v1/accounts/${reportedUserId}`, ERIN);
    expect(owner.status).toBe(200);
    const account = owner.body['account'] as Record<string, unknown>;

    // Version 2 is what tells a client these three fields are here at all, and
    // the Swift decoder refuses anything else.
    expect(account['projectionVersion']).toBe(2);

    // The assertion is that the removed set is exactly the difference against the
    // published baseline — not that it matches a list this test also wrote, which
    // would pass against a client holding its own copy of the capability table.
    const baseline = account['baselineCapabilities'] as string[];
    const granted = account['capabilities'] as string[];
    const removed = account['removedCapabilities'] as string[];
    expect(baseline).toContain('like');
    expect(removed).toContain('like');
    expect([...baseline].filter((entry) => !granted.includes(entry)).sort()).toEqual([...removed].sort());

    // The case reference is what the member contests the decision on.
    expect(account['caseId']).toEqual(expect.any(String));
    // And nothing else about the decision travels with it. A reason, a moderator
    // or a report would each be somebody else's data; owner-visible stops at the
    // reference and no further.
    for (const forbidden of ['reason', 'rationale', 'moderatorId', 'reportId', 'evidence']) {
      expect(account[forbidden]).toBeUndefined();
    }
  });

  it('does not publish one account’s standing — or its case reference — to another member', async () => {
    // `caseId` is owner-visible. A projection any member could read about
    // *anybody* would publish the existence of a moderation case about an
    // identifiable person, which is the first fact the `restricted` clearance
    // exists to withhold.
    const foreign = await call(harness, 'GET', `/v1/accounts/${reportedUserId}`, BOB);
    expect(foreign.status).toBe(404);
    // And the refusal is indistinguishable from "no such account", because a
    // `403` would confirm the account is real and turn the id into an oracle.
    const missing = await call(harness, 'GET', `/v1/accounts/${randomUUID()}`, BOB);
    expect(missing.status).toBe(404);
  });
});

/** The most recent report id, from the moderation queue's own perspective. */
/**
 * A report id backed by a real recorded interaction, because
 * `evidenceForReport` refuses a pair with none — which is the rule that makes a
 * report survive an unmatch without making it possible about a stranger.
 */
async function latestReportId(harness: Harness, subjectUserId: string, token: string): Promise<string> {
  const reported = await call(harness, 'POST', '/v1/reports', token, {
    subjectUserId,
    reason: 'spam',
    statement: 'a statement long enough to be worth triaging',
  });
  expect(reported.status).toBe(201);
  return String(reported.body['reportId']);
}

/** The open case about one particular subject, or a failure that says so. */
async function anOpenCaseFor(harness: Harness, subjectUserId: string): Promise<string> {
  const queue = await call(harness, 'GET', '/v1/moderation/cases', MOD);
  const cases = queue.body['cases'] as Record<string, unknown>[];
  const found = cases.find((entry) => String(entry['subjectId']) === subjectUserId);
  if (found === undefined) {
    throw new Error(`no open case about ${subjectUserId}; the queue held ${cases.length}`);
  }
  return String(found['caseId']);
}
