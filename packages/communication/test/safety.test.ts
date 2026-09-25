import { type ActorId, type CaseId, type DomainEvent, type Result, InMemoryEventBus, castId } from '@been-there/core';
import { describe, expect, it } from 'vitest';
import {
  COMMUNICATION_SIGNALS,
  DEFAULT_RETENTION_POLICY,
  MODERATION_CLEARANCE,
  SAFETY_CLEARANCE,
  type ConversationEvidence,
  type MessageSentSignal,
  captureEvidence,
  conversationMachine,
  conversationStateChangedEvent,
  evidenceCapturedEvent,
  frictionAppliedEvent,
  messageSentEvent,
  retentionOutcome,
  sendMessage,
  type SendDependencies,
} from '../src/index.js';
import { ALICE, BOB, CONVERSATION_ID, STRANGER, at, conversationIn, dependencies, message } from './fixtures.js';

const CASE_ID = castId<'CaseId'>('case-7');
const CAPTURED_AT = new Date('2026-04-01T10:00:00.000Z');

const ENVELOPE = {
  eventId: castId<'EventId'>('e-1'),
  correlationId: castId<'CorrelationId'>('c-1'),
  actorId: castId<'ActorId'>('a-1'),
  occurredAt: CAPTURED_AT,
};

/**
 * The kernel's `publish` is typed to the envelope's default payload, so a
 * typed signal needs this single widening step. A generic `publish<P>` on the
 * event bus would remove the cast; until then it happens here and nowhere else.
 */
function publishable<P>(event: DomainEvent<P>): DomainEvent {
  return { ...event, payload: event.payload as unknown as Readonly<Record<string, unknown>> };
}

function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

function rejected<T, E>(result: Result<T, E>): boolean {
  return !result.ok;
}

function sendDeps(overrides: Partial<SendDependencies> = {}): SendDependencies {
  return {
    ...dependencies(),
    recentSendTimestamps: [],
    recentConversationStarts: [],
    previousMessageAt: null,
    messagesInConversation: 3,
    messagesLastHour: 1,
    ...overrides,
  };
}

const BODY = 'meet me at the coffee place on fifth';

function sentSignal(): MessageSentSignal {
  return succeeded(
    sendMessage(
      {
        conversation: conversationIn('active'),
        senderId: ALICE,
        messageId: castId<'MessageId'>('msg-signal'),
        body: BODY,
        at: CAPTURED_AT,
      },
      sendDeps(),
    ),
  ).signal;
}

describe('the signal catalogue', () => {
  it('publishes nothing at a clearance that reaches message history', () => {
    for (const entry of COMMUNICATION_SIGNALS) {
      expect(['internal', 'restricted']).toContain(entry.sensitivity);
    }
  });

  it('keeps the case-scoped evidence pointer at restricted clearance', () => {
    const evidence = COMMUNICATION_SIGNALS.find(
      (entry) => entry.type === 'communication.evidence_captured',
    );
    expect(evidence?.sensitivity).toBe('restricted');
    const behavioural = COMMUNICATION_SIGNALS.filter(
      (entry) => entry.type !== 'communication.evidence_captured',
    );
    for (const entry of behavioural) {
      expect(entry.sensitivity).toBe('internal');
    }
  });

  it('delivers behavioural signals to safety but not to the product surface', async () => {
    const bus = new InMemoryEventBus();
    const seenByProduct: string[] = [];
    const seenBySafety: string[] = [];
    const seenByModeration: string[] = [];
    bus.subscribe({ upTo: 'public' }, (event) => {
      seenByProduct.push(event.type);
    });
    bus.subscribe(SAFETY_CLEARANCE, (event) => {
      seenBySafety.push(event.type);
    });
    bus.subscribe(MODERATION_CLEARANCE, (event) => {
      seenByModeration.push(event.type);
    });

    await bus.publish(publishable(messageSentEvent(sentSignal(), ENVELOPE)));
    await bus.publish(publishable(conversationStateChangedEvent(
      {
        conversationId: CONVERSATION_ID,
        matchId: castId<'MatchId'>('m-1'),
        from: 'active',
        to: 'blocked',
        changedAt: CAPTURED_AT,
        caseId: null,
      },
      ENVELOPE,
    )));
    await bus.publish(publishable(frictionAppliedEvent(
      {
        ruleId: 'per_conversation_burst',
        subjectId: ALICE,
        conversationId: CONVERSATION_ID,
        used: 20,
        limit: 20,
        windowMs: 60_000,
        at: CAPTURED_AT,
      },
      ENVELOPE,
    )));
    await bus.publish(publishable(evidenceCapturedEvent(
      {
        caseId: CASE_ID,
        conversationId: CONVERSATION_ID,
        subjectId: ALICE,
        requestedByUserId: BOB,
        capturedAt: CAPTURED_AT,
        scopedMessageCount: 2,
        redactedMessageCount: 1,
        redactionReasons: ['email_address'],
      },
      ENVELOPE,
    )));

    expect(seenByProduct).toEqual([]);
    expect(seenBySafety).toEqual([
      'communication.message_sent',
      'communication.conversation_state_changed',
      'communication.friction_applied',
    ]);
    expect(seenByModeration).toHaveLength(4);
  });
});

describe('content never crosses into a signal', () => {
  const payload = sentSignal();

  it('publishes exactly the metadata fields and nothing else', () => {
    expect(Object.keys(payload).sort()).toEqual(
      [
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
      ].sort(),
    );
  });

  it('leaks no free text in the serialised event', () => {
    const event = messageSentEvent(payload, ENVELOPE);
    const serialised = JSON.stringify(event);
    expect(serialised).not.toContain('coffee');
    expect(serialised).not.toContain('fifth');
    expect(serialised).toContain(`"bodyLength":${BODY.length}`);
  });

  it('records the instant it happened, not the time the envelope was built', () => {
    const event = messageSentEvent(payload, { ...ENVELOPE, occurredAt: new Date('2020-01-01T00:00:00Z') });
    expect(event.occurredAt).toEqual(new Date('2020-01-01T00:00:00Z'));
    expect(event.sensitivity).toBe('internal');
  });
});

describe('evidence capture', () => {
  const conversation = conversationIn('active');
  const transcript = [
    message({ createdAt: at(30), senderId: ALICE, body: 'first one' }),
    message({ createdAt: at(10), senderId: BOB, body: 'reach me at bob@example.com' }),
    message({ createdAt: at(20), senderId: ALICE, body: 'and https://example.test/photos' }),
  ];

  it('orders the transcript chronologically whatever order the projection returns', () => {
    const evidence = succeeded(
      captureEvidence(conversation, transcript, {
        caseId: CASE_ID,
        subjectId: ALICE,
        requestedByUserId: BOB,
        capturedAt: CAPTURED_AT,
      }),
    );
    expect(evidence.messages.map((entry) => entry.sentAt.getTime())).toEqual([
      at(10).getTime(),
      at(20).getTime(),
      at(30).getTime(),
    ]);
  });

  it('redacts contact details and records that it did', () => {
    const evidence = succeeded(
      captureEvidence(conversation, transcript, {
        caseId: CASE_ID,
        subjectId: ALICE,
        requestedByUserId: BOB,
        capturedAt: CAPTURED_AT,
      }),
    );
    const bodies = evidence.messages.map((entry) => entry.redactedBody);
    expect(bodies.join(' ')).not.toContain('bob@example.com');
    expect(bodies.join(' ')).not.toContain('https://example.test/photos');
    expect(evidence.redactedMessageCount).toBe(2);
    const redacted = evidence.messages.filter((entry) => entry.redactions.length > 0);
    expect(redacted.flatMap((entry) => entry.redactions).sort()).toEqual([
      'email_address',
      'external_link',
    ]);
    expect(redacted[0]?.redactedBody).toContain('[redacted:');
  });

  it('keeps the unredacted length so a moderator can see that something was removed', () => {
    const evidence = succeeded(
      captureEvidence(conversation, transcript, {
        caseId: CASE_ID,
        subjectId: ALICE,
        requestedByUserId: BOB,
        capturedAt: CAPTURED_AT,
      }),
    );
    const withEmail = evidence.messages.find((entry) => entry.redactions.includes('email_address'));
    expect(withEmail?.bodyLength).toBe('reach me at bob@example.com'.length);
  });

  it('scopes the view to the requested message ids and drops unknown ones', () => {
    const evidence = succeeded(
      captureEvidence(conversation, transcript, {
        caseId: CASE_ID,
        subjectId: ALICE,
        requestedByUserId: BOB,
        capturedAt: CAPTURED_AT,
        messageIds: [transcript[2]?.messageId as never, castId<'MessageId'>('msg-missing')],
      }),
    );
    expect(evidence.messages).toHaveLength(1);
    expect(evidence.scope.messageIds).toHaveLength(2);
  });

  it('scopes the view to a start instant when no ids are given', () => {
    const evidence = succeeded(
      captureEvidence(conversation, transcript, {
        caseId: CASE_ID,
        subjectId: ALICE,
        requestedByUserId: BOB,
        capturedAt: CAPTURED_AT,
        since: at(20),
      }),
    );
    expect(evidence.messages.map((entry) => entry.sentAt.getTime())).toEqual([
      at(20).getTime(),
      at(30).getTime(),
    ]);
  });

  it('ignores messages belonging to another conversation', () => {
    const evidence = succeeded(
      captureEvidence(conversation, [...transcript, message({ conversationId: castId<'ConversationId'>('c-other') })], {
        caseId: CASE_ID,
        subjectId: ALICE,
        requestedByUserId: BOB,
        capturedAt: CAPTURED_AT,
      }),
    );
    expect(evidence.messages).toHaveLength(3);
  });

  it('refuses a subject who is not in the conversation', () => {
    const verdict = captureEvidence(conversation, transcript, {
      caseId: CASE_ID,
      subjectId: STRANGER,
      requestedByUserId: BOB,
      capturedAt: CAPTURED_AT,
    });
    expect(rejected(verdict)).toBe(true);
    if (!verdict.ok) {
      expect(verdict.error.code).toBe('not_found');
    }
  });

  it('stays available in every conversation state, including after an unmatch', () => {
    for (const state of conversationMachine.states) {
      const evidence: ConversationEvidence = succeeded(
        captureEvidence(conversationIn(state), transcript, {
          caseId: CASE_ID,
          subjectId: ALICE,
          requestedByUserId: BOB,
          capturedAt: CAPTURED_AT,
        }),
      );
      expect(evidence.conversationState).toBe(state);
      expect(evidence.messages).toHaveLength(3);
      expect(evidence.caseId).toBe(CASE_ID);
    }
  });

  it('marks which messages the subject is attributed to, without deciding anything', () => {
    const evidence = succeeded(
      captureEvidence(conversation, transcript, {
        caseId: CASE_ID,
        subjectId: ALICE,
        requestedByUserId: BOB,
        capturedAt: CAPTURED_AT,
      }),
    );
    expect(evidence.messages.map((entry) => entry.attributedToSubject)).toEqual([false, true, true]);
  });
});

describe('retention', () => {
  const policy = DEFAULT_RETENTION_POLICY;

  it('keeps history for the full window and evidence beyond it', () => {
    expect(retentionOutcome(0, policy)).toBe('live_history');
    expect(retentionOutcome(policy.conversationHistoryDays, policy)).toBe('live_history');
    expect(retentionOutcome(policy.conversationHistoryDays + 0.01, policy)).toBe('reportable_only');
    expect(retentionOutcome(policy.reportEvidenceDays, policy)).toBe('reportable_only');
    expect(retentionOutcome(policy.reportEvidenceDays + 0.01, policy)).toBe('purged');
  });

  it('never regains history as a conversation ages', () => {
    const outcomes = [0, 10, 100, 200, 300, 400, 500].map((age) => retentionOutcome(age, policy));
    expect(outcomes).toEqual([
      'live_history',
      'live_history',
      'live_history',
      'reportable_only',
      'reportable_only',
      'purged',
      'purged',
    ]);
  });
});
