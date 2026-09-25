#!/usr/bin/env node
/**
 * The development dataset.
 *
 * Eight people, a block, a match with a conversation, a report, two cases and an
 * audit log — built by *running* the domain, never by writing state down.
 *
 * The rule this file exists to enforce: nobody is `verified` because this file
 * says so. Every identity state is the answer the domain's own machine gave to
 * a real event — a provider result at or above the confidence floor. The same
 * goes for `limited` and `banned`, which the account machine only accepts with a
 * case and a named moderator attached, and for risk, which is replayed through
 * the risk machine rather than assigned.
 *
 * Every person therefore carries the trail that produced their state. A trail
 * that does not replay to the same state is a bug in this file, and
 * `verifyDataset` (run by `make seed-verify`) says so rather than printing a
 * confident summary over it.
 *
 * The dataset is built in process. There is no database behind it yet — this
 * repository has no schema, so `make seed` refuses instead of pretending to have
 * loaded anything. See docs/development/local-environment.md.
 *
 * The scenario, for a reader who would rather skip the code:
 *
 *   Riley matched Frankie, blocked him when he would not stop messaging, and
 *   reported him. A moderator triaged the report, opened a case, took it and
 *   started the review; a lead banned Frankie against that case. Trust & Safety
 *   separately opened a case for Ellis, whose risk has escalated, and a
 *   moderator restricted Ellis. Avery and Blair matched and are talking. Casey
 *   is mid-verification. Devon's provider result was borderline and is waiting
 *   on a human. Sasha's verification has expired.
 */
import { isDiscoverableIdentity } from '@been-there/core';
import { activeBlockBetween, contactPermission } from '@been-there/dating';
import {
  assignCase,
  createContext,
  createIdSource,
  openCase,
  readEvidence,
  startCaseReview,
  submitReport,
  triageReport,
} from '@been-there/moderation';
import { InMemoryAuditLog } from '@been-there/platform';
import {
  LEAD,
  MODERATOR,
  PRIVACY_OFFICER,
  SEED_EPOCH,
  accountMachine,
  activeUser,
  asActor,
  asConversation,
  asCorrelation,
  asReport,
  asSubject,
  asUser,
  asVerification,
  assertPackagesBuilt,
  blockAndEnd,
  classify,
  conversationWithMessages,
  createAuditRecorder,
  createClock,
  identityMachine,
  matchFromLedger,
  mutualLikes,
  must,
  providerResult,
  riskTrail,
  standingFor,
  startVerification,
  step,
  trailEntry,
  verificationThroughProvider,
} from './dataset-steps.mjs';

const verifiedPeople = [
  ['u-avery', 'Avery', 0.97],
  ['u-blair', 'Blair', 0.93],
  ['u-frankie', 'Frankie', 0.91],
  ['u-riley', 'Riley', 0.96],
  ['u-ellis', 'Ellis', 0.95],
  ['u-sasha', 'Sasha', 0.94],
];

/**
 * Builds the dataset. Everything below is a real domain call: the identity
 * provider flow, the account machine, the risk machine, the like/match/block
 * rules, the send path, and the report → triage → case → review queue walk.
 */
export function loadDevelopmentDataset() {
  assertPackagesBuilt();
  const now = createClock();
  const moderation = createContext({ now, ids: createIdSource('mod') });
  const auditLog = new InMemoryAuditLog();
  const audit = createAuditRecorder(auditLog, now);

  // --- Identity: the provider decides who is verified. ----------------------

  const verified = verifiedPeople.map(([userId, displayName, confidence]) => {
    const outcome = verificationThroughProvider({ userId, providerResult: providerResult(confidence) }, now());
    audit(
      'identity.verification_changed',
      'system',
      asSubject(userId),
      [
        classify('from', 'public', 'unverified'),
        classify('to', 'public', outcome.state),
        classify('providerConfidence', 'sensitive', confidence),
        classify('via', 'internal', 'provider_result_received'),
      ],
      { correlation: `corr-${userId}` },
    );
    return activeUser(userId, displayName, {
      identityState: outcome.state,
      verificationId: asVerification(`ver-${userId}`),
      identityTrail: outcome.trail,
    });
  });

  // Submitted to the provider, not yet answered: still `pending`, and so not
  // discoverable. No event would make this user verified but for a result that
  // has not come back.
  const casey = startVerification('u-casey', now());

  // A borderline provider result: routed to a human, never auto-resolved.
  const devon = verificationThroughProvider(
    {
      userId: 'u-devon',
      providerResult: providerResult(0.62, {
        check: 'liveness',
        outcome: 'inconclusive',
        score: 0.55,
        reason: 'provider disagreement on liveness',
      }),
    },
    now(),
  );
  audit(
    'identity.verification_changed',
    'system',
    asSubject('u-devon'),
    [
      classify('from', 'public', 'unverified'),
      classify('to', 'public', devon.state),
      classify('providerConfidence', 'sensitive', 0.62),
      classify('via', 'internal', 'flag_for_review'),
    ],
    { correlation: 'corr-u-devon' },
  );

  const users = [
    ...verified,
    activeUser('u-casey', 'Casey', {
      identityState: casey.start.identity.state,
      verificationId: casey.start.attempt.verificationId,
      identityTrail: [trailEntry(identityMachine.initial, casey.start.identity.viaEvent, casey.start.identity.state)],
      attemptState: casey.attempt.state,
    }),
    activeUser('u-devon', 'Devon', {
      identityState: devon.state,
      verificationId: asVerification('ver-u-devon'),
      identityTrail: devon.trail,
      decision: devon.decision.decision,
    }),
  ];

  // Verification decays: still a known person, out of the discoverable pool.
  const sasha = users.find((person) => person.userId === 'u-sasha');
  const sashaTrail = [...sasha.identityTrail];
  sasha.identityState = step(identityMachine, sasha.identityState, 'expire', undefined, sashaTrail);
  sasha.identityTrail = sashaTrail;

  const standings = new Map(users.map((person) => [person.userId, standingFor(person)]));

  // --- Risk: evidence, replayed through the risk machine. -------------------

  const riskAssessments = [
    riskTrail('u-frankie', [
      ['signal_observed', { score: 0.62, corroboratingDetectors: 1 }],
      ['signal_observed', { score: 0.81, corroboratingDetectors: 2 }],
      ['signal_observed', { score: 0.95, corroboratingDetectors: 3 }],
    ]),
    riskTrail('u-ellis', [
      ['signal_observed', { score: 0.55, corroboratingDetectors: 1 }],
      ['signal_observed', { score: 0.78, corroboratingDetectors: 2 }],
    ]),
    riskTrail('u-devon', [['signal_observed', { score: 0.52, corroboratingDetectors: 1 }]]),
  ];

  // --- Dating: two matches, one of which a block will end. ------------------

  const abLedger = mutualLikes(standings, 'u-avery', 'u-blair', now);
  const abMatch = matchFromLedger(abLedger, 'u-blair', 'u-avery', asConversation('conv-avery-blair'));
  const rfLedger = mutualLikes(standings, 'u-riley', 'u-frankie', now);
  const rfMatch = matchFromLedger(rfLedger, 'u-frankie', 'u-riley', asConversation('conv-riley-frankie'));

  const abProjection = {
    matchId: abMatch.matchId,
    conversationId: asConversation('conv-avery-blair'),
    participants: abMatch.participants,
    state: 'active',
    matchedAt: abMatch.createdAt,
  };
  const { conversation, messages } = conversationWithMessages(
    abProjection,
    [
      ['msg-1', 'u-avery', 'The photograph on your profile is lovely.'],
      ['msg-2', 'u-blair', 'Thank you. That one took about forty attempts.'],
    ],
    now,
  );

  // --- The block, and what it ends. ----------------------------------------

  const { block, match: endedMatch } = blockAndEnd(
    'u-riley',
    'u-frankie',
    'block-riley-frankie',
    rfMatch,
    rfLedger,
    now,
  );
  const contact = {
    'riley/frankie': contactPermission(
      activeBlockBetween(asUser('u-riley'), asUser('u-frankie'), [block]),
      endedMatch.ended === null,
    ),
    'avery/blair': contactPermission(
      activeBlockBetween(asUser('u-avery'), asUser('u-blair'), [block]),
      abMatch.ended === null,
    ),
  };

  // --- The report, the queue walk, and the case. ---------------------------

  const reportCorrelation = asCorrelation('corr-report-riley');
  const submission = must(
    submitReport(moderation, {
      reportId: asReport('report-1'),
      subjectId: asUser('u-frankie'),
      reporterId: asUser('u-riley'),
      reason: 'harassment',
      statement: 'He kept messaging after I blocked him, from a new account with the same photos.',
      relationship: {
        status: 'blocked',
        capturedAt: now(),
        conversationId: asConversation('conv-riley-frankie'),
        messageRange: { from: 'msg-rf-1', to: 'msg-rf-4' },
      },
      evidence: [
        {
          kind: 'message_snapshot',
          sourceDomain: 'communication',
          artefactReference: 'blob://messages/riley-frankie/1-4',
          digest: 'sha256:riley-frankie-1-4',
          redactedSummary: 'Four messages sent after the block, quoting the reporter back at themselves.',
        },
        {
          kind: 'identity_artefact',
          sourceDomain: 'identity',
          artefactReference: 'blob://identity/frankie/selfie.webm',
          digest: 'sha256:frankie-selfie',
          redactedSummary: 'Liveness capture attached by the verification provider.',
        },
      ],
      correlationId: reportCorrelation,
    }),
    'submit the report against frankie',
  );

  const triaged = must(
    triageReport(moderation, {
      report: submission.report,
      moderatorId: MODERATOR.actorId,
      correlationId: reportCorrelation,
    }),
    'triage report-1',
  );
  const opened = must(
    openCase(moderation, {
      source: 'user_report',
      report: triaged,
      openedBy: MODERATOR.actorId,
      correlationId: reportCorrelation,
    }),
    'open a case for report-1',
  );
  const assigned = must(
    assignCase(moderation, {
      moderationCase: opened.moderationCase,
      actor: MODERATOR,
      correlationId: reportCorrelation,
    }),
    'assign the frankie case',
  );
  const inReview = must(
    startCaseReview(moderation, {
      moderationCase: assigned,
      actor: MODERATOR,
      correlationId: reportCorrelation,
    }),
    'start the frankie case review',
  );
  const caseId = inReview.caseId;

  // Trust & Safety opens its own case for the restricted account. A case is the
  // authority an enforcement action needs, so the restriction names this one.
  const ellisRisk = riskAssessments.find((entry) => entry.subjectId === 'u-ellis');
  const ellisCase = must(
    openCase(moderation, {
      source: 'trust_safety_review',
      subjectId: asUser('u-ellis'),
      riskAssessmentId: ellisRisk.assessmentId,
      riskState: ellisRisk.state,
      detectors: ellisRisk.contributingDetectors,
      digest: 'sha256:ellis-risk-snapshot',
      openedBy: asActor('system'),
      correlationId: asCorrelation('corr-ellis-review'),
    }),
    'open the trust and safety case for ellis',
  ).moderationCase;

  const onCase = (action, actorId, extra = []) =>
    audit(action, actorId, asSubject('u-frankie'), [classify('caseId', 'internal', caseId), ...extra], {
      caseId,
      correlation: 'corr-report-riley',
    });

  onCase('report.submitted', asUser('u-riley'), [
    classify('reportId', 'internal', 'report-1'),
    classify('reporterId', 'sensitive', 'u-riley'),
  ]);
  onCase('report.triaged', MODERATOR.actorId);
  onCase('case.opened', MODERATOR.actorId);
  onCase('case.assigned', MODERATOR.actorId, [classify('moderatorId', 'internal', MODERATOR.actorId)]);
  onCase('case.review_started', MODERATOR.actorId);
  audit(
    'authz.permission_denied',
    asActor('support-lane'),
    asSubject('u-frankie'),
    [
      classify('role', 'internal', 'support'),
      classify('action', 'internal', 'audit.read'),
      classify('reason', 'internal', 'role "support" may not audit.read'),
    ],
    { correlation: 'corr-support-probe' },
  );
  audit(
    'auth.session_issued',
    'system',
    asSubject('u-avery'),
    [classify('method', 'internal', 'passkey'), classify('device', 'internal', 'local-seed')],
    { correlation: 'corr-session-avery' },
  );

  // --- Enforcement, through the account machine. ----------------------------

  const ellisContext = {
    caseId: ellisCase.caseId,
    moderatorId: MODERATOR.actorId,
    removedCapabilities: ['send_message', 'like'],
  };
  const ellisTrail = [];
  const ellisState = step(accountMachine, 'active', 'restrict', ellisContext, ellisTrail);

  const frankieContext = { caseId, moderatorId: LEAD.actorId };
  const frankieTrail = [];
  const frankieState = step(accountMachine, 'active', 'ban', frankieContext, frankieTrail);

  onCase('account.enforcement_applied', LEAD.actorId, [
    classify('accountState', 'sensitive', frankieState),
    classify('missingCapabilities', 'sensitive', 'browse_discovery, like, send_message, edit_profile'),
    classify('reversibleVia', 'internal', 'account_state:lift_ban'),
  ]);

  for (const person of users) {
    if (person.userId === 'u-ellis') {
      person.accountState = ellisState;
      person.accountContext = ellisContext;
      person.accountTrail = ellisTrail;
    }
    if (person.userId === 'u-frankie') {
      person.accountState = frankieState;
      person.accountContext = frankieContext;
      person.accountTrail = frankieTrail;
    }
    person.capabilities = capabilitiesFor(person.accountState, person.accountContext);
    person.discoverable = isDiscoverableIdentity({
      state: person.identityState,
      latestVerificationId: person.verificationId,
      generation: 1,
    });
  }

  // --- Evidence, and who may read it. --------------------------------------

  const evidence = submission.evidence;
  for (const artefact of evidence) {
    onCase('evidence.read', MODERATOR.actorId, [
      classify('evidenceId', 'internal', artefact.evidenceId),
      classify('kind', 'internal', artefact.kind),
    ]);
  }
  const identityArtefact = evidence.find((entry) => entry.kind === 'identity_artefact');
  const denied = readEvidence(moderation, MODERATOR, identityArtefact, caseId);
  if (denied.visibility !== 'denied') {
    throw new Error(
      `a plain moderator must be denied raw identity evidence, but readEvidence returned ${denied.visibility}`,
    );
  }
  onCase('evidence.read_denied', MODERATOR.actorId, [
    classify('evidenceId', 'internal', identityArtefact.evidenceId),
    classify('clearance', 'internal', 'reviewer'),
  ]);

  return {
    epoch: SEED_EPOCH,
    users,
    riskAssessments,
    matches: [abMatch, endedMatch],
    conversations: [{ ...conversation, messages }],
    blocks: [block],
    contact,
    report: submission.report,
    cases: [inReview, ellisCase],
    evidence,
    moderationAuditEntries: moderation.audit.entries,
    platformAuditLog: auditLog,
    caseId,
    reviewers: { moderator: MODERATOR, lead: LEAD, privacyOfficer: PRIVACY_OFFICER },
  };
}
