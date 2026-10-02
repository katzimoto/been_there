import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CaseId, type CorrelationId, type UserId, castId } from '@been-there/core';
import { type EvidenceKind, captureEvidence } from '@been-there/moderation';
import { requestModerationContext } from '@been-there/service';
import { type Caller, type Harness, call, member, staff, startHarness } from './support/harness.js';
import { COMPLETE_PROFILE, PASSING_RESULT, createAccount, newPeer, verify } from './support/fixtures.js';

/**
 * The moderator workspace, over real HTTP against the real database.
 *
 * There is no client in this repository, so none of this is a console test. It is
 * the server half a console would sit on, and the half worth having: the
 * properties a console cannot be trusted to enforce, because a console can be
 * closed and a token cannot. Each is stated as a request a caller can make and a
 * result it must not be able to produce.
 */

const BOB = 'bob';
const SENIOR = 'senior-mod-token';
const PLAIN = 'plain-mod-token';
const SUPPORT = 'support-token';
const PRIVACY = 'identity-privacy-token';
const BOT = 'automated-mod-token';

const ARTEFACT = 'blob://identity/erin/selfie.webm';
const IDENTITY_SUMMARY = 'Liveness capture attached by the verification provider.';

/**
 * The queue's own ranking, written out rather than imported: the assertion is
 * about the order the service serves, so it states the order it expects rather
 * than agreeing with whatever the service happens to do.
 */
const PRIORITY_RANK: Readonly<Record<string, number>> = { urgent: 3, high: 2, normal: 1, low: 0 };

describe('the moderator workspace', () => {
  let harness: Harness;
  let callers: Caller[];

  let bob: UserId;

  beforeAll(async () => {
    const bobCaller = member(BOB);
    callers = [
      bobCaller,
      staff(SENIOR, 'senior_moderator'),
      staff(PLAIN, 'moderator'),
      staff(SUPPORT, 'support'),
      staff(PRIVACY, 'identity_privacy_officer'),
      staff(BOT, 'senior_moderator', true),
    ];
    harness = await startHarness(callers);
    bob = (await createAccount(harness, BOB)).userId;
    bobCaller.userId = bob;
    const profile = await call(harness, 'PUT', `/v1/accounts/${bob}/profile`, BOB, COMPLETE_PROFILE);
    expect(profile.status).toBe(200);
    await verify(harness, BOB, bob, PASSING_RESULT);
  });

  afterAll(async () => {
    if (harness !== undefined) {
      await harness.close();
    }
  });

  it('serves the queue highest priority first, oldest first, and only unresolved', async () => {
    // Five subjects so the four triage priorities are five real cases rather
    // than four guesses, and two of them at the same priority so the tiebreak is
    // under test. The database is shared across runs, so the assertions are on
    // the order the page is *in* rather than on which cases it happens to hold.
    const wanted = ['threats_or_violence', 'impersonation', 'harassment', 'harassment', 'spam'];
    const opened: string[] = [];
    for (const [index, reason] of wanted.entries()) {
      const peer = await matchedPeer(harness, callers, bob, `peer-${index}`);
      const reported = await call(harness, 'POST', '/v1/reports', BOB, {
        subjectUserId: peer,
        reason,
        statement: 'the behaviour in this conversation needs a human',
      });
      expect(reported.status).toBe(201);
      const caseOpened = await call(harness, 'POST', '/v1/moderation/cases', SENIOR, {
        reportId: reported.body['reportId'],
        moderatorId: 'mod-senior',
      });
      expect(caseOpened.status).toBe(201);
      opened.push(String(caseOpened.body['caseId']));
    }

    // A plain moderator reads the queue: the queue is `sensitive` work, and
    // reserving it to a senior would leave the role unable to do the job it
    // exists for. Support and members do not, and the two refusals are the
    // boundary this assertion is really about.
    expect((await servedQueue(harness, PLAIN)).length).toBeGreaterThan(0);
    expect((await call(harness, 'GET', '/v1/moderation/cases', SUPPORT)).status).toBe(403);
    expect((await call(harness, 'GET', '/v1/moderation/cases', BOB)).status).toBe(403);

    const page = await servedQueue(harness, SENIOR);
    // The whole ordering claim, on the page as served: priority never rises, and
    // within one priority the open instants never go backwards.
    for (const [index, entry] of page.entries()) {
      expect(entry['resolutionDecisionId']).toBeNull();
      expect(PRIORITY_RANK[String(entry['priority'])]).toBeGreaterThanOrEqual(0);
      const previous = page[index - 1];
      if (previous === undefined) {
        continue;
      }
      const before = PRIORITY_RANK[String(previous['priority'])] ?? -1;
      const after = PRIORITY_RANK[String(entry['priority'])] ?? -1;
      expect(after).toBeLessThanOrEqual(before);
      if (after === before) {
        expect(String(entry['openedAt']) >= String(previous['openedAt'])).toBe(true);
      }
    }

    // The unresolved filter, on a case this test owns. The shared database has
    // older urgent cases ahead of anything opened here, so the page is full long
    // before a new case reaches it; what is asserted is the predicate itself —
    // deciding the case is what sets the column the queue filters on.
    const urgent = await openCaseFor(harness, callers, bob, 'queue-resolved', 'threats_or_violence');
    const decided = await call(harness, 'POST', `/v1/moderation/cases/${urgent}/decisions`, SENIOR, {
      moderatorId: 'mod-senior',
      action: 'warn',
      rationale: 'a warning is enough for a first look at this one',
    });
    expect(decided.status).toBe(201);
    const resolved = await call(harness, 'GET', `/v1/moderation/cases/${urgent}`, SENIOR);
    expect(resolved.body['resolutionDecisionId']).toBe(decided.body['decisionId']);
    expect((await servedQueue(harness, SENIOR)).map((entry) => entry['caseId'])).not.toContain(urgent);
    expect(opened).toHaveLength(5);
  });

  it('refuses the case view to a member and to support, and serves the moderator roles', async () => {
    const caseId = await openCaseFor(harness, callers, bob, 'case-view', 'harassment');

    expect((await call(harness, 'GET', `/v1/moderation/cases/${caseId}`, BOB)).status).toBe(403);

    // Support reads session metadata and the internal audit trail. It reads
    // neither cases nor evidence.
    const supportView = await call(harness, 'GET', `/v1/moderation/cases/${caseId}`, SUPPORT);
    expect(supportView.status).toBe(403);
    expect((supportView.body['error'] as Record<string, unknown>)['code']).toBe('permission_denied');

    expect((await call(harness, 'GET', `/v1/moderation/cases/${caseId}`, PLAIN)).status).toBe(200);
    expect((await call(harness, 'GET', `/v1/moderation/cases/${caseId}`, SENIOR)).status).toBe(200);
  });

  it('keeps the reporter out of the case view, so it is not a side door around the evidence gate', async () => {
    const statement = 'a-reporter-word-that-only-belongs-in-evidence';
    const caseId = await openCaseFor(harness, callers, bob, 'case-view-no-statement', 'harassment', statement);

    const view = await call(harness, 'GET', `/v1/moderation/cases/${caseId}`, SENIOR);
    expect(view.status).toBe(200);
    // The reporter's own words and the reporter's id are `restricted`: they
    // belong to the evidence read, which audits itself. A case record carrying
    // them would hand them out with no row saying who looked.
    expect(JSON.stringify(view.body)).not.toContain(statement);
    expect(view.body['reporterId']).toBeUndefined();
    expect(view.body['statement']).toBeUndefined();
    // What it must carry: the case, and the ids an appeal is answered from.
    expect(view.body['caseId']).toBe(caseId);
    expect((view.body['reportIds'] as unknown[]).length).toBeGreaterThan(0);
    expect((view.body['evidenceIds'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('serves a plain moderator the case evidence, and refuses support the same read', async () => {
    const caseId = await openCaseFor(harness, callers, bob, 'evidence-reviewer', 'harassment');

    const plain = await call(harness, 'GET', `/v1/moderation/cases/${caseId}/evidence`, PLAIN);
    expect(plain.status).toBe(200);
    const entries = plain.body['evidence'] as Readonly<Record<string, unknown>>[];
    expect(entries.length).toBeGreaterThan(0);
    // `report_statement` is `reviewer`-clearance, so a plain moderator reads it in
    // full. That is what makes the redaction and denial tests below meaningful
    // rather than vacuous.
    for (const entry of entries) {
      expect(entry['visibility']).toBe('full');
      expect(entry['artefactReference']).toBeDefined();
    }

    expect((await call(harness, 'GET', `/v1/moderation/cases/${caseId}/evidence`, SUPPORT)).status).toBe(403);
    expect((await call(harness, 'GET', `/v1/moderation/cases/${caseId}/evidence`, BOB)).status).toBe(403);
  });

  it('redacts identity evidence from a moderator and from a lead, and serves only the identity officer', async () => {
    const caseId = await openCaseFor(harness, callers, bob, 'identity-evidence', 'impersonation');
    const evidenceId = await attachEvidence(harness, caseId, {
      kind: 'identity_artefact',
      artefactReference: ARTEFACT,
      redactedSummary: IDENTITY_SUMMARY,
    });

    // A plain moderator. The artefact is never on the wire, and neither is the
    // digest: the redaction is not "the summary plus a reference".
    const plain = await evidenceServedTo(harness, PLAIN, caseId, evidenceId);
    expect(plain['visibility']).toBe('redacted');
    expect(plain['artefactReference']).toBeUndefined();
    expect(plain['digest']).toBeUndefined();
    expect(plain['redactedSummary']).toBe(IDENTITY_SUMMARY);

    // A lead, the highest clearance inside the moderation hierarchy. The gate
    // checks identity evidence before the ladder, so seniority does not reach
    // it — that appointment belongs to the identity domain alone.
    const lead = await evidenceServedTo(harness, SENIOR, caseId, evidenceId);
    expect(lead['visibility']).toBe('redacted');
    expect(lead['artefactReference']).toBeUndefined();
    expect(lead['digest']).toBeUndefined();

    const officer = await evidenceServedTo(harness, PRIVACY, caseId, evidenceId);
    expect(officer['visibility']).toBe('full');
    expect(officer['artefactReference']).toBe(ARTEFACT);
  });

  it('audits every evidence read, and a denied one is a row that gets written', async () => {
    const caseId = await openCaseFor(harness, callers, bob, 'escalated-evidence', 'harassment');
    // `device_signal` needs an escalated reviewer, so a plain reviewer is refused
    // it and the refusal is the interesting audit row.
    const evidenceId = await attachEvidence(harness, caseId, {
      kind: 'device_signal',
      artefactReference: 'blob://trust-safety/device-fingerprint',
      redactedSummary: 'Device and session signals attached by Trust & Safety.',
    });

    const refused = await evidenceServedTo(harness, PLAIN, caseId, evidenceId);
    expect(refused['visibility']).toBe('denied');
    // A refusal must not leak what it refused.
    expect(refused['artefactReference']).toBeUndefined();
    expect(refused['digest']).toBeUndefined();
    expect(refused['redactedSummary']).toBeUndefined();

    const afterRefusal = await auditFor(harness, evidenceId);
    const deniedRow = afterRefusal.find((entry) => entry['action'] === 'evidence.read_denied');
    expect(deniedRow).toBeDefined();
    expect(deniedRow?.['outcome']).toBe('denied');
    // The row names the clearance used and the one required, which is what makes
    // a pattern of over-reaching readable after the fact.
    expect(deniedRow?.['detail']).toMatchObject({
      visibility: 'denied',
      clearance: 'reviewer',
      required: 'escalated_reviewer',
    });

    // A lead clears the same bar, and that read is audited too — as a second row
    // on the same evidence, not an edit of the first.
    const allowed = await evidenceServedTo(harness, SENIOR, caseId, evidenceId);
    expect(allowed['visibility']).toBe('full');
    const afterAllowance = await auditFor(harness, evidenceId);
    expect(afterAllowance.filter((entry) => entry['action'] === 'evidence.read_denied')).toHaveLength(1);
    expect(afterAllowance.filter((entry) => entry['outcome'] === 'allowed')).toHaveLength(1);
  });

  it('refuses a reversal with no named human, and refuses an automated actor', async () => {
    const caseId = await openCaseFor(harness, callers, bob, 'reversal-human', 'threats_or_violence');
    const banned = await call(harness, 'POST', `/v1/moderation/cases/${caseId}/decisions`, SENIOR, {
      moderatorId: 'mod-senior',
      action: 'ban',
      rationale: 'this behaviour meets the bar for a ban on this account',
    });
    expect(banned.status).toBe(201);
    const decisionId = String(banned.body['decisionId']);
    const path = `/v1/moderation/cases/${caseId}/decisions/${decisionId}/reversal`;

    // A reversal is a decision, so it passes the same two doors: a named
    // moderator, and a caller that is not a machine.
    const anonymous = await call(harness, 'POST', path, SENIOR, {
      rationale: 'reversing without saying who is taking the reversal',
    });
    expect(anonymous.status).toBe(400);
    expect((anonymous.body['error'] as Record<string, unknown>)['code']).toBe('validation_failed');

    const automated = await call(harness, 'POST', path, BOT, {
      moderatorId: 'risk-detector',
      rationale: 'a machine reversing a sanction on its own initiative',
    });
    expect(automated.status).toBe(403);
    expect((automated.body['error'] as Record<string, unknown>)['code']).toBe('permission_denied');
  });

  it('refuses a plain moderator the lift of a ban and lets a senior moderator take it', async () => {
    const caseId = await openCaseFor(harness, callers, bob, 'lift-ban', 'threats_or_violence');
    const subject = await subjectOf(harness, caseId);
    const banned = await call(harness, 'POST', `/v1/moderation/cases/${caseId}/decisions`, SENIOR, {
      moderatorId: 'mod-senior',
      action: 'ban',
      rationale: 'this behaviour meets the bar for a ban on this account',
    });
    expect(banned.status).toBe(201);
    const decisionId = String(banned.body['decisionId']);
    expect(await standingOf(harness, subject, SENIOR)).toBe('banned');

    // The refusal has to be about the lift and nothing incidental: a plain
    // moderator may decide cases and read their evidence, and is stopped here by
    // the one permission it does not hold.
    const refused = await call(
      harness,
      'POST',
      `/v1/moderation/cases/${caseId}/decisions/${decisionId}/reversal`,
      PLAIN,
      { moderatorId: 'mod-plain', rationale: 'lifting a ban is above this moderator and the platform says so' },
    );
    expect(refused.status).toBe(403);
    expect((refused.body['error'] as Record<string, unknown>)['details']).toMatchObject({
      action: 'account.enforce.lift_ban',
      role: 'moderator',
    });
    // Nothing moved: a refused lift is a refusal, not a partial write.
    expect(await standingOf(harness, subject, SENIOR)).toBe('banned');

    const lifted = await call(
      harness,
      'POST',
      `/v1/moderation/cases/${caseId}/decisions/${decisionId}/reversal`,
      SENIOR,
      { moderatorId: 'mod-senior', rationale: 'on review this account is a good-faith reporter, lifting the ban' },
    );
    expect(lifted.status).toBe(201);
    expect(lifted.body['reverses']).toBe(decisionId);
    expect(lifted.body['accountState']).toBe('active');
    expect(await standingOf(harness, subject, SENIOR)).toBe('active');
  });

  it('appends a reversal and leaves the original decision byte-identical', async () => {
    const caseId = await openCaseFor(harness, callers, bob, 'append-only', 'threats_or_violence');
    const subject = await subjectOf(harness, caseId);
    const restricted = await call(harness, 'POST', `/v1/moderation/cases/${caseId}/decisions`, SENIOR, {
      moderatorId: 'mod-senior',
      action: 'restrict',
      removedCapabilities: ['like'],
      rationale: 'a first restriction is proportionate to what this case holds',
    });
    expect(restricted.status).toBe(201);
    const decisionId = String(restricted.body['decisionId']);
    const before = await decisionRow(harness, decisionId);
    expect(before).not.toBeNull();

    const reversed = await call(
      harness,
      'POST',
      `/v1/moderation/cases/${caseId}/decisions/${decisionId}/reversal`,
      PLAIN,
      { moderatorId: 'mod-plain', rationale: 'lifting a restriction is not reserved to a senior moderator' },
    );
    expect(reversed.status).toBe(201);
    const reversalId = String(reversed.body['decisionId']);
    expect(reversalId).not.toBe(decisionId);

    // Every column of the original row, unchanged. An append is the only shape in
    // which the appeal record is worth anything.
    expect(await decisionRow(harness, decisionId)).toEqual(before);
    // Both decisions are on the case, and the second names the first.
    const second = await decisionRow(harness, reversalId);
    expect(second?.['reverses']).toBe(decisionId);
    expect(second?.['action']).toBe('clear');

    // The case itself did not move: the review happened and produced that
    // decision, and the case's own resolution pointer still names it.
    const view = await call(harness, 'GET', `/v1/moderation/cases/${caseId}`, SENIOR);
    expect(view.body['state']).toBe('resolved');
    expect(view.body['resolutionDecisionId']).toBe(decisionId);
    const decisions = view.body['decisions'] as Readonly<Record<string, unknown>>[];
    expect(decisions.map((entry) => entry['decisionId'])).toEqual([decisionId, reversalId]);
    // A sanction that has already been answered is not appealable, and neither is
    // the clearance that answered it: a user may appeal a sanction, not a
    // clearance. Both are the domain's judgement, not a count kept here.
    expect(decisions[0]?.['appealable']).toBe(false);
    expect(decisions[1]?.['appealable']).toBe(false);
    // The lift put the account back, and the standing says which state it is in.
    expect(await standingOf(harness, subject, SENIOR)).toBe('active');
  });
});

/** The queue as the endpoint serves it, page order intact. */
async function servedQueue(harness: Harness, token: string): Promise<Readonly<Record<string, unknown>>[]> {
  const queue = await call(harness, 'GET', '/v1/moderation/cases', token);
  expect(queue.status).toBe(200);
  return queue.body['cases'] as Readonly<Record<string, unknown>>[];
}

/** A person Bob has matched and then unmatched, which is what makes them reportable. */
async function matchedPeer(
  harness: Harness,
  callers: Caller[],
  bob: UserId,
  token: string,
): Promise<string> {
  const peer = (await newPeer(harness, callers, token)).userId;
  const profile = await call(harness, 'PUT', `/v1/accounts/${peer}/profile`, token, COMPLETE_PROFILE);
  expect(profile.status).toBe(200);
  await verify(harness, token, peer, PASSING_RESULT);
  await call(harness, 'POST', '/v1/interactions/likes', BOB, { toUserId: peer });
  const matched = await call(harness, 'POST', '/v1/interactions/likes', token, { toUserId: bob });
  expect(matched.status).toBe(201);
  const unmatched = await call(harness, 'POST', `/v1/matches/${String(matched.body['match'])}/unmatch`, BOB, {
    idempotencyKey: `unmatch-${token}`,
  });
  expect(unmatched.status).toBe(200);
  return peer;
}

async function openCaseFor(
  harness: Harness,
  callers: Caller[],
  bob: UserId,
  label: string,
  reason: string,
  statement = 'a statement only a reviewer should be able to read',
): Promise<string> {
  const peer = await matchedPeer(harness, callers, bob, `subject-${label}`);
  const reported = await call(harness, 'POST', '/v1/reports', BOB, {
    subjectUserId: peer,
    reason,
    statement,
  });
  expect(reported.status).toBe(201);
  const opened = await call(harness, 'POST', '/v1/moderation/cases', SENIOR, {
    reportId: reported.body['reportId'],
    moderatorId: 'mod-senior',
  });
  expect(opened.status).toBe(201);
  return String(opened.body['caseId']);
}

/** The queue, narrowed to the cases this test opened and in the order served. */
async function queuedCaseIds(harness: Harness, token: string, caseIds: readonly string[]): Promise<unknown[]> {
  const queue = await call(harness, 'GET', '/v1/moderation/cases', token);
  expect(queue.status).toBe(200);
  return (queue.body['cases'] as Readonly<Record<string, unknown>>[])
    .map((entry) => entry['caseId'])
    .filter((id) => caseIds.includes(String(id)));
}

/** The account a case is about, so a test can read the standing it produced. */
async function subjectOf(harness: Harness, caseId: string): Promise<string> {
  const found = await harness.transaction.run((tx) =>
    harness.stores.moderation.findCase(castId<'CaseId'>(caseId), tx),
  );
  if (found === null) {
    throw new Error(`case ${caseId} was not found`);
  }
  return found.subjectId;
}

async function standingOf(harness: Harness, userId: string, token: string): Promise<string | null> {
  const read = await call(harness, 'GET', `/v1/accounts/${userId}`, token);
  const account = read.body['account'] as Record<string, unknown> | undefined;
  return account === undefined ? null : String(account['state']);
}

/**
 * One evidence record on a case, minted by the domain's own constructor and
 * placed where the identity-anomaly intake path would have placed it.
 *
 * `openCase({source: 'identity_anomaly'})` captures exactly this record and
 * nothing in the current schema persists it — `reports.captured_evidence` is the
 * one place frozen evidence lives — so the fixture writes the record the domain
 * produced rather than inventing one. Minting it through `captureEvidence` is
 * what makes it genuine: the `access` level it claims is the one
 * `EVIDENCE_POLICY` declares for that kind, and a hand-written row could claim
 * any of them.
 */
async function attachEvidence(
  harness: Harness,
  caseId: string,
  spec: { readonly kind: EvidenceKind; readonly artefactReference: string; readonly redactedSummary: string },
): Promise<string> {
  const typed = castId<'CaseId'>(caseId);
  const found = await harness.transaction.run((tx) => harness.stores.moderation.findCase(typed, tx));
  const reportId = found?.reportIds[0];
  if (found === null || found === undefined || reportId === undefined) {
    throw new Error(`case ${caseId} has no report to carry the evidence`);
  }
  const { context } = requestModerationContext(new Date());
  const captured = captureEvidence(context, {
    kind: spec.kind,
    subjectId: found.subjectId,
    sourceDomain: spec.kind.startsWith('identity') ? 'identity' : 'trust-safety',
    artefactReference: spec.artefactReference,
    digest: `sha256:${randomUUID().replaceAll('-', '')}`,
    redactedSummary: spec.redactedSummary,
    capture: { at: 'case_intake', caseId: typed },
    caseId: typed,
    actorId: 'system',
    correlationId: castId<'CorrelationId'>(randomUUID()),
  });
  if (!captured.ok) {
    throw new Error(`the fixture could not mint ${spec.kind}: ${captured.error.message}`);
  }
  const record = captured.value;
  await harness.pool.query(
    'UPDATE app.reports SET captured_evidence = captured_evidence || $2::jsonb WHERE report_id = $1',
    [reportId, JSON.stringify([record])],
  );
  await harness.pool.query('UPDATE app.cases SET evidence_ids = evidence_ids || $2::uuid WHERE case_id = $1', [
    caseId,
    record.evidenceId,
  ]);
  return record.evidenceId;
}

/** The one evidence entry a caller was served, found by the id the fixture placed. */
async function evidenceServedTo(
  harness: Harness,
  token: string,
  caseId: string,
  evidenceId: string,
): Promise<Readonly<Record<string, unknown>>> {
  const read = await call(harness, 'GET', `/v1/moderation/cases/${caseId}/evidence`, token);
  expect(read.status).toBe(200);
  const entries = read.body['evidence'] as Readonly<Record<string, unknown>>[];
  const found = entries.find((entry) => entry['evidenceId'] === evidenceId);
  if (found === undefined) {
    throw new Error(`evidence ${evidenceId} was not served (got ${JSON.stringify(entries)})`);
  }
  return found;
}

async function auditFor(
  harness: Harness,
  evidenceId: string,
): Promise<readonly Readonly<Record<string, unknown>>[]> {
  return harness.transaction.run((tx) => harness.stores.moderation.findAuditForEntity('evidence', evidenceId, tx));
}

/** A decision row as the database holds it, column for column. */
async function decisionRow(harness: Harness, decisionId: string): Promise<Readonly<Record<string, unknown>> | null> {
  const found = await harness.pool.query('SELECT * FROM app.decisions WHERE decision_id = $1', [decisionId]);
  return (found.rows[0] as Readonly<Record<string, unknown>> | undefined) ?? null;
}
