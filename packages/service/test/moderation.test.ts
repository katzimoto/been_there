import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserId } from '@been-there/core';
import { castId } from '@been-there/core';
import { type Caller, type Harness, call, member, moderator, startHarness } from './support/harness.js';
import { COMPLETE_PROFILE, PASSING_RESULT, createAccount, newPeer, verify } from './support/fixtures.js';

const ALICE = 'alice';
const STRANGER = 'stranger';
const BOB = 'bob';
const ERIN = 'erin-token';
const MOD = 'moderator-token';
const BOT = 'automation-token';

/** The reporting, queue and decision half of the flow. */
describe('reports, the moderator queue, and decisions', () => {
  let harness: Harness;
  let callers: Caller[];
  let bob: UserId;
  /** A verified user Bob has matched and then unmatched with. */
  let reportedUserId: string;

  beforeAll(async () => {
    const bobCaller = member('bob');
    callers = [bobCaller, moderator(MOD), moderator(BOT, true)];
    harness = await startHarness(callers);
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
      moderatorId: 'senior_moderator',
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
      moderatorId: 'senior_moderator',
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
      moderatorId: 'risk-detector',
      rationale: 'a sufficiently long rationale for the decision',
    });
    expect(automated.status).toBe(403);
    const refusal = automated.body['error'] as Record<string, unknown>;
    expect(refusal['code']).toBe('permission_denied');
  });

  it('records a decision under the named moderator and applies the standing it produced', async () => {
    const caseId = await anOpenCaseFor(harness, reportedUserId);
    const decided = await call(harness, 'POST', `/v1/moderation/cases/${caseId}/decisions`, MOD, {
      moderatorId: 'senior_moderator',
      action: 'restrict',
      removedCapabilities: ['like'],
      rationale: 'the messages in this case meet the bar for a first restriction',
    });
    expect(decided.status).toBe(201);
    expect(decided.body['moderatorId']).toBe('senior_moderator');
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
