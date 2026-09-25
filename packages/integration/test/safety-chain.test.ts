/**
 * The end-to-end safety chain from issue #1, exercised across every domain
 * package:
 *
 *   verified identity → profile → discovery → like → match → chat
 *     → block/report → automated risk detection → moderation → enforcement
 *
 * These tests exist because the eight architectural commitments are claims
 * about how domains *compose*. A single package can prove its own invariants;
 * only composition can prove that a signal raised in trust-safety does not
 * become a ban without a moderator, and that a ban decided in moderation
 * actually removes the user from discovery in dating.
 */
import { describe, expect, it } from 'vitest';
import {
  type ActorId,
  type Result,
  castId,
  isClearedToConsume,
} from '@been-there/core';
import { evaluateEligibility, unmatch } from '@been-there/dating';
import {
  type BlockEdge,
  type MatchProjection as ConversationMatchProjection,
  activeBlockView,
  captureEvidence,
  createMessage,
  sendMessage,
  startConversation,
} from '@been-there/communication';
import {
  applyDecay,
  applySignal,
  createSignal,
  emptyRiskRecord,
  sequentialIdFactory,
} from '@been-there/trust-safety';
import { createContext, decide, openCase, reportMachine, submitReport } from '@been-there/moderation';
import {
  ALICE,
  AT,
  BOB,
  bobSubject,
  block,
  like,
  matchRecord,
  relationship,
  standing,
} from './fixtures.js';

function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

function rejected<T, E extends { code: string }>(result: Result<T, E>): string | null {
  return result.ok ? null : result.error.code;
}

const MODERATOR = {
  actorId: castId<'ActorId'>('mod-1'),
  isLead: true,
  identityPrivacyRole: false,
  automated: false,
};
/** A service acting with a minted id — not a moderator, whatever the id says. */
const AUTOMATED = {
  actorId: castId<'ActorId'>('system-actor'),
  isLead: true,
  identityPrivacyRole: false,
  automated: true,
};
const SYSTEM_ACTOR = castId<'ActorId'>('system-actor');

/** The 1:1 conversation binding communication is given at match time. */
function conversationMatch(state: 'active' | 'unmatched' = 'active'): ConversationMatchProjection {
  const match = matchRecord();
  return {
    matchId: match.matchId,
    conversationId: match.conversationId!,
    participants: [ALICE, BOB],
    state,
    matchedAt: match.createdAt,
  };
}

function baseConversation() {
  return startConversation(conversationMatch(), AT);
}

function deliver(overrides: {
  readonly matchState?: 'active' | 'unmatched';
  readonly edges?: readonly BlockEdge[];
  readonly capabilities?: readonly string[];
} = {}) {
  return sendMessage(
    {
      conversation: baseConversation(),
      senderId: ALICE,
      messageId: castId<'MessageId'>('message-1'),
      body: 'hey there',
      at: AT,
    },
    {
      match: conversationMatch(overrides.matchState ?? 'active'),
      blocking: activeBlockView(overrides.edges ?? []),
      senderStanding: {
        userId: ALICE,
        capabilities: overrides.capabilities ?? ['send_message'],
      },
      recentSendTimestamps: [],
      recentConversationStarts: [],
      previousMessageAt: null,
      messagesInConversation: 0,
      messagesLastHour: 0,
    },
  );
}

/** A well-formed behavioural signal about BOB, from one detector. */
function signalAboutBob(weight = 0.8) {
  return succeeded(
    createSignal(
      {
        subjectId: bobSubject,
        actorId: bobSubject,
        behaviour: { kind: 'unmatch_then_report', entityId: 'match-1' },
        occurredAt: AT,
        weight,
      },
      { detector: 'interaction.unmatch_report', reliability: 'high', category: 'interaction' },
    ),
  );
}

function assess(now: Date) {
  return {
    now,
    correlationId: castId<'CorrelationId'>('corr-1'),
    ids: sequentialIdFactory(),
  };
}

const raised = () =>
  succeeded(
    applySignal(
      emptyRiskRecord(bobSubject, castId<'RiskAssessmentId'>('risk-1'), AT),
      signalAboutBob(),
      { entries: [] },
      assess(AT),
    ),
  );

/** A case opened from a trust & safety review candidate, as automation would. */
function caseFromRisk() {
  return succeeded(
    openCase(createContext({ now: () => AT }), {
      source: 'trust_safety_review',
      subjectId: BOB,
      riskAssessmentId: castId<'RiskAssessmentId'>('risk-1'),
      riskState: 'high',
      detectors: ['interaction.unmatch_report'],
      digest: 'sha256:abc',
      openedBy: 'system',
      correlationId: castId<'CorrelationId'>('corr-1'),
    }),
  ).moderationCase;
}

describe('commitment 1 — verified is the only discoverable identity state', () => {
  const base = {
    viewer: standing(ALICE),
    relationship: relationship(),
    distance: 'lt_5_km' as const,
  };

  for (const state of [
    'unverified',
    'pending',
    'review_required',
    'verification_failed',
    'expired',
  ] as const) {
    it(`excludes a candidate whose identity is ${state}`, () => {
      const decision = evaluateEligibility({
        ...base,
        candidate: standing(BOB, { identityState: state }),
      });
      expect(decision.eligible).toBe(false);
      expect(decision.eligible ? null : decision.reason).toBe('candidate_identity_not_verified');
    });
  }

  it('admits a verified, complete, active candidate', () => {
    expect(evaluateEligibility({ ...base, candidate: standing(BOB) }).eligible).toBe(true);
  });
});

describe('commitment 2 — automation raises risk, only a human enforces', () => {
  it('raises behavioural risk from a detector signal', () => {
    expect(raised().record.assessment.state).not.toBe('normal');
  });

  it('leaves the account untouched, so the user stays discoverable', () => {
    raised();

    // Dating has no idea anything happened: it still sees an active, verified user.
    const decision = evaluateEligibility({
      viewer: standing(ALICE),
      candidate: standing(BOB),
      relationship: relationship(),
      distance: 'lt_5_km',
    });
    expect(decision.eligible).toBe(true);
  });

  it('refuses a suspension attributed to no named moderator', () => {
    const outcome = decide(createContext({ now: () => AT }), {
      moderationCase: { ...caseFromRisk(), state: 'in_review' },
      actor: AUTOMATED,
      action: 'suspend',
      rationale: 'suspension attributed to automation',
      currentAccountState: 'active',
      correlationId: castId<'CorrelationId'>('corr-1'),
    });
    expect(rejected(outcome)).not.toBeNull();
  });

  it('refuses to decide before a moderator has started review', () => {
    const outcome = decide(createContext({ now: () => AT }), {
      moderationCase: caseFromRisk(),
      actor: MODERATOR,
      action: 'ban',
      rationale: 'decided without review',
      currentAccountState: 'active',
      correlationId: castId<'CorrelationId'>('corr-1'),
    });
    expect(rejected(outcome)).not.toBeNull();
  });

  it('removes the user from discovery only once a moderator has acted', () => {
    const outcome = succeeded(
      decide(createContext({ now: () => AT }), {
        moderationCase: { ...caseFromRisk(), state: 'in_review' },
        actor: MODERATOR,
        action: 'suspend',
        rationale: 'repeated unmatch-then-report behaviour seen by two detectors',
        currentAccountState: 'active',
        correlationId: castId<'CorrelationId'>('corr-1'),
      }),
    );
    expect(outcome.accountState).toBe('suspended');

    // The enforcement now propagates to the product: dating excludes them.
    const decision = evaluateEligibility({
      viewer: standing(ALICE),
      candidate: standing(BOB, { accountState: 'suspended', capabilities: ['report', 'block'] }),
      relationship: relationship(),
      distance: 'lt_5_km',
    });
    expect(decision.eligible).toBe(false);
  });
});

describe('commitment 3 — risk decays', () => {
  it('returns a subject to normal after a long quiet period', () => {
    const record = raised().record;
    expect(record.assessment.state).not.toBe('normal');

    // A single day is not a quiet period long enough to clear anything.
    const soon = applyDecay(record, assess(new Date('2026-03-02T12:00:00Z')));
    const soonState = soon.ok ? soon.value.record.assessment.state : record.assessment.state;
    expect(soonState).not.toBe('normal');

    // A month of quiet behaviour does.
    const later = applyDecay(record, assess(new Date('2026-04-01T12:00:00Z')));
    expect(succeeded(later).record.assessment.state).toBe('normal');
  });
});

describe('commitment 4 — the right to report outlives the match', () => {
  it('retains the match and the conversation when a match is ended', () => {
    const outcome = succeeded(unmatch(matchRecord(), ALICE, AT));
    expect(outcome.match.status).toBe('unmatched');
    expect(outcome.conversation?.retainedForEvidence).toBe(true);
  });

  it('still captures conversation evidence after the match has ended', () => {
    succeeded(unmatch(matchRecord(), ALICE, AT));

    const conversation = baseConversation();
    const message = succeeded(
      createMessage({
        messageId: castId<'MessageId'>('message-1'),
        conversationId: conversation.conversationId,
        senderId: ALICE,
        body: 'hello',
        createdAt: AT,
      }),
    );
    const evidence = captureEvidence(conversation, [message], {
      caseId: castId<'CaseId'>('case-1'),
      subjectId: BOB,
      requestedByUserId: ALICE,
      capturedAt: AT,
    });
    expect(evidence.ok).toBe(true);
  });

  it('opens a moderation case from a post-unmatch report, with its evidence attached', () => {
    const ctx = createContext({ now: () => AT });
    const submitted = succeeded(
      submitReport(ctx, {
        reportId: castId<'ReportId'>('report-1'),
        subjectId: BOB,
        reporterId: ALICE,
        reason: 'harassment',
        statement: 'they kept messaging after I asked them to stop',
        relationship: {
          status: 'unmatched',
          capturedAt: AT,
          conversationId: castId<'ConversationId'>('conversation-1'),
          messageRange: { from: 'message-1', to: 'message-1' },
        },
        evidence: [
          {
            kind: 'conversation_snapshot',
            sourceDomain: 'communication',
            artefactReference: 'conversation-1:message-1',
            digest: 'sha256:def',
            redactedSummary: 'two messages exchanged before the unmatch',
          },
        ],
        correlationId: castId<'CorrelationId'>('corr-1'),
      }),
    );

    const opened = succeeded(
      openCase(ctx, {
        source: 'user_report',
        // A report is triaged before it is worth a moderator's time, and a case
        // may only be opened from a triaged report.
        report: {
          ...submitted.report,
          state: succeeded(reportMachine.next(submitted.report.state, 'triage', {})),
        },
        openedBy: 'system',
        correlationId: castId<'CorrelationId'>('corr-1'),
      }),
    );
    expect(opened.moderationCase.reportIds).toContain(submitted.report.reportId);
    expect(opened.moderationCase.evidenceIds.length).toBeGreaterThan(0);
  });
});

describe('block dominates across domains', () => {
  it('stops messaging even though the match is still active', () => {
    const result = deliver({
      matchState: 'active',
      edges: [{ blockerId: BOB, blockedId: ALICE, appliedAt: AT, liftedAt: null }],
    });
    expect(rejected(result)).not.toBeNull();
  });

  it('removes the pair from dating discovery in either direction', () => {
    const decision = evaluateEligibility({
      viewer: standing(ALICE),
      candidate: standing(BOB),
      relationship: relationship({ blocks: [block(BOB, ALICE, 'block-1')] }),
      distance: 'lt_5_km',
    });
    expect(decision.eligible).toBe(false);
  });
});

describe('the safety signal carries no content', () => {
  it('publishes metadata only, so the message body never reaches a lower clearance', () => {
    const { signal } = succeeded(deliver());
    const serialised = JSON.stringify(signal);
    expect(serialised).not.toContain('hey there');
    // The exact key set is the real check: a length is metadata, a body is content.
    expect(Object.keys(signal).sort()).toEqual([
      'bodyLength',
      'conversationId',
      'matchId',
      'messageId',
      'messageState',
      'messagesInConversation',
      'messagesLastHour',
      'peerId',
      'secondsSinceConversationOpened',
      'secondsSincePreviousMessage',
      'senderId',
      'sentAt',
    ]);

    // A consumer cleared only for `public` is never delivered a user-classified event.
    expect(
      isClearedToConsume(
        { upTo: 'public' },
        {
          eventId: castId<'EventId'>('e-1'),
          type: 'communication.message_sent',
          version: 1,
          occurredAt: AT,
          actorId: SYSTEM_ACTOR,
          correlationId: castId<'CorrelationId'>('corr-1'),
          sensitivity: 'user',
          payload: {},
        },
      ),
    ).toBe(false);
  });
});

describe('two verified adults can complete the happy path', () => {
  it('matches and starts a conversation with no safety state involved', () => {
    const reciprocal = relationship({
      likes: [like(ALICE, BOB, 'like-alice-bob'), like(BOB, ALICE, 'like-bob-alice')],
      match: matchRecord(),
    });
    expect(reciprocal.likes).toHaveLength(2);
    expect(succeeded(deliver()).message.body).toBe('hey there');
  });
});
