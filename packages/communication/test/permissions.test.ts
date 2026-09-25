import { type Result, castId } from '@been-there/core';
import { describe, expect, it } from 'vitest';
import {
  type SendDependencies,
  type SendDenialRule,
  NEW_CONVERSATION_RATE_RULE,
  PER_CONVERSATION_RATE_RULE,
  SEND_CHECKS,
  activeBlockView,
  canSend,
  canView,
  evaluateRateRule,
  sendMessage,
} from '../src/index.js';
import {
  ALICE,
  BOB,
  CONVERSATION_ID,
  STRANGER,
  at,
  blockBetween,
  conversationIn,
  dependencies,
  match,
  standing,
} from './fixtures.js';

function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

function rejected<T, E>(result: Result<T, E>): boolean {
  return !result.ok;
}

function ruleOf(result: Result<unknown, { details?: Record<string, unknown> }>): unknown {
  return result.ok ? null : result.error.details?.['rule'];
}

const OTHER_CONVERSATION = castId<'ConversationId'>('c-other');

describe('the send permission gate', () => {
  it('evaluates its rules in the documented order', () => {
    expect(SEND_CHECKS.map((check) => check.rule)).toEqual<SendDenialRule[]>([
      'blocked',
      'not_a_participant',
      'match_not_for_conversation',
      'match_not_active',
      'conversation_not_open',
      'missing_send_message_capability',
    ]);
  });

  it('allows a matched, unblocked, capable sender on an open conversation', () => {
    expect(canSend(conversationIn('active'), ALICE, dependencies()).ok).toBe(true);
  });

  it('denies a block even though the match is active and the sender is capable', () => {
    const verdict = canSend(
      conversationIn('active'),
      ALICE,
      dependencies({ edges: [blockBetween(BOB, ALICE)] }),
    );
    expect(ruleOf(verdict)).toBe('blocked');
  });

  it('stops denying once the block is lifted', () => {
    const verdict = canSend(
      conversationIn('active'),
      ALICE,
      dependencies({ edges: [blockBetween(BOB, ALICE, true)] }),
    );
    expect(verdict.ok).toBe(true);
  });

  it('denies a non-participant', () => {
    const verdict = canSend(
      conversationIn('active'),
      STRANGER,
      dependencies({ sender: STRANGER }),
    );
    expect(ruleOf(verdict)).toBe('not_a_participant');
  });

  it('denies a match projection belonging to another conversation', () => {
    const verdict = canSend(
      conversationIn('active'),
      ALICE,
      dependencies({ match: { conversationId: OTHER_CONVERSATION } }),
    );
    expect(ruleOf(verdict)).toBe('match_not_for_conversation');
  });

  it('denies an unmatched match', () => {
    const verdict = canSend(
      conversationIn('active'),
      ALICE,
      dependencies({ match: { state: 'unmatched' } }),
    );
    expect(ruleOf(verdict)).toBe('match_not_active');
  });

  it('denies every non-open conversation state', () => {
    for (const state of ['blocked', 'frozen_by_restriction', 'ended_by_unmatch', 'ended'] as const) {
      expect(ruleOf(canSend(conversationIn(state), ALICE, dependencies()))).toBe('conversation_not_open');
    }
  });

  it('denies a sender without the send_message capability', () => {
    const verdict = canSend(
      conversationIn('active'),
      ALICE,
      dependencies({ capabilities: ['report', 'block'] }),
    );
    expect(ruleOf(verdict)).toBe('missing_send_message_capability');
  });

  it('keeps the conversation state from overriding a live restriction', () => {
    // A block was lifted, so the state says `active`; the moderation-owned
    // capability projection is what actually stops the send.
    const verdict = canSend(
      conversationIn('active'),
      ALICE,
      dependencies({ capabilities: ['report'], edges: [blockBetween(BOB, ALICE, true)] }),
    );
    expect(ruleOf(verdict)).toBe('missing_send_message_capability');
  });

  it('lets a block dominate every other failing condition at once', () => {
    const verdict = canSend(
      conversationIn('ended_by_unmatch'),
      ALICE,
      dependencies({
        capabilities: [],
        match: { state: 'unmatched', conversationId: OTHER_CONVERSATION },
        edges: [blockBetween(BOB, ALICE)],
      }),
    );
    expect(ruleOf(verdict)).toBe('blocked');
  });
});

describe('read access after a block', () => {
  const blocked = activeBlockView([blockBetween(BOB, ALICE)]);

  it('hides the conversation from the blocked party and keeps it for the blocker', () => {
    expect(canView(conversationIn('active'), ALICE, blocked).ok).toBe(false);
    expect(canView(conversationIn('active'), BOB, blocked).ok).toBe(true);
  });

  it('keeps history readable by both parties once no block is in force', () => {
    const none = activeBlockView([]);
    expect(canView(conversationIn('ended_by_unmatch'), ALICE, none).ok).toBe(true);
    expect(canView(conversationIn('frozen_by_restriction'), BOB, none).ok).toBe(true);
  });

  it('refuses a viewer who was never in the conversation', () => {
    expect(ruleOf(canView(conversationIn('active'), STRANGER, blocked))).toBe('not_a_participant');
  });
});

describe('rate friction', () => {
  const now = new Date('2026-03-01T12:00:00.000Z');

  it('counts only attempts inside the window and rejects at the limit', () => {
    const inside = Array.from({ length: PER_CONVERSATION_RATE_RULE.limit }, (_, i) =>
      new Date(now.getTime() - i * 1000),
    );
    expect(rejected(evaluateRateRule(PER_CONVERSATION_RATE_RULE, inside, now))).toBe(true);
    expect(evaluateRateRule(PER_CONVERSATION_RATE_RULE, inside.slice(1), now).ok).toBe(true);
  });

  it('drops an attempt that sits exactly on the window edge', () => {
    const onEdge = [new Date(now.getTime() - PER_CONVERSATION_RATE_RULE.windowMs)];
    const verdict = succeeded(evaluateRateRule(PER_CONVERSATION_RATE_RULE, onEdge, now));
    expect(verdict.used).toBe(0);
    expect(verdict.remaining).toBe(PER_CONVERSATION_RATE_RULE.limit);
  });

  it('ignores an attempt stamped in the future', () => {
    const ahead = [new Date(now.getTime() + 60_000)];
    expect(succeeded(evaluateRateRule(PER_CONVERSATION_RATE_RULE, ahead, now)).used).toBe(0);
  });

  it('answers a rate limit with a retry hint and never with a case', () => {
    const attempts = Array.from({ length: 5 }, (_, i) => new Date(now.getTime() - (16 + i) * 1000));
    const verdict = evaluateRateRule(
      { id: 'per_conversation_burst', limit: 5, windowMs: 60_000 },
      attempts,
      now,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.error.code).toBe('rate_limited');
      expect(verdict.error.retryable).toBe(true);
      expect(verdict.error.details?.['retryAfterMs']).toBe(40_000);
      expect(verdict.error.details?.['caseId']).toBeUndefined();
    }
  });

  it('applies the new-conversation rule on a different window than the burst rule', () => {
    const starts = Array.from({ length: NEW_CONVERSATION_RATE_RULE.limit }, (_, i) =>
      new Date(now.getTime() - i * 60_000),
    );
    expect(evaluateRateRule(PER_CONVERSATION_RATE_RULE, starts, now).ok).toBe(true);
    expect(rejected(evaluateRateRule(NEW_CONVERSATION_RATE_RULE, starts, now))).toBe(true);
  });
});

describe('the send path', () => {
  const conversation = conversationIn('active');

  function deps(overrides: Partial<SendDependencies> = {}): SendDependencies {
    return {
      ...dependencies(),
      recentSendTimestamps: [],
      recentConversationStarts: [],
      previousMessageAt: null,
      messagesInConversation: 0,
      messagesLastHour: 0,
      ...overrides,
    };
  }

  function send(senderId: typeof ALICE, body: string, sendAt: Date, override: Partial<SendDependencies> = {}, id = 'msg-1') {
    return sendMessage(
      { conversation, senderId, messageId: castId<'MessageId'>(id), body, at: sendAt },
      deps(override),
    );
  }

  it('produces the message and the signal the safety layer consumes', () => {
    const sent = succeeded(
      send(ALICE, 'hello there', at(120), {
        previousMessageAt: at(60),
        messagesInConversation: 4,
        messagesLastHour: 2,
      }),
    );
    expect(sent.message.body).toBe('hello there');
    expect(sent.signal.peerId).toBe(BOB);
    expect(sent.signal.secondsSincePreviousMessage).toBe(60);
    expect(sent.signal.secondsSinceConversationOpened).toBe(120);
    expect(sent.signal.bodyLength).toBe('hello there'.length);
    expect(sent.signal.messagesInConversation).toBe(4);
    expect(sent.signal.messagesLastHour).toBe(2);
  });

  it('sends the other direction just as well', () => {
    const sent = succeeded(
      send(BOB, 'hi', at(30), { senderStanding: standing(BOB) }, 'msg-2'),
    );
    expect(sent.message.conversationId).toBe(CONVERSATION_ID);
    expect(sent.signal.senderId).toBe(BOB);
    expect(sent.signal.peerId).toBe(ALICE);
    expect(sent.signal.secondsSincePreviousMessage).toBeNull();
  });

  it('authorises before it validates, so a denial never reveals a body problem', () => {
    const verdict = sendMessage(
      {
        conversation: conversationIn('ended'),
        senderId: ALICE,
        messageId: castId<'MessageId'>('msg-3'),
        body: '   ',
        at: at(10),
      },
      deps(),
    );
    expect(rejected(verdict)).toBe(true);
    if (!verdict.ok) {
      expect(verdict.error.code).toBe('not_eligible');
    }
  });

  it('validates the body before spending rate budget', () => {
    const verdict = send(ALICE, '', at(10), {
      recentSendTimestamps: Array.from({ length: 50 }, () => at(1)),
    });
    expect(rejected(verdict)).toBe(true);
    if (!verdict.ok) {
      expect(verdict.error.code).toBe('validation_failed');
    }
  });

  it('never closes a conversation, however hard a sender is rate limited', () => {
    const burst = Array.from({ length: 200 }, () => at(1));
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const verdict = send(ALICE, 'are you there', at(2), { recentSendTimestamps: burst }, `burst-${attempt}`);
      expect(rejected(verdict)).toBe(true);
    }
    expect(conversation.state).toBe('active');
    expect(conversation.stateChangedAt).toEqual(conversation.openedAt);
  });

  it('lets the same sender through once the window has cleared', () => {
    const later = new Date(at(1).getTime() + PER_CONVERSATION_RATE_RULE.windowMs);
    expect(send(ALICE, 'still there?', later, { recentSendTimestamps: [at(1)] }, 'msg-late').ok).toBe(
      true,
    );
  });

  it('refuses a stranger before anything else', () => {
    const verdict = send(STRANGER, 'hello', at(10), { senderStanding: standing(STRANGER) }, 'msg-4');
    expect(ruleOf(verdict)).toBe('not_a_participant');
  });

  it('ignores a match projection that has drifted to another conversation', () => {
    const verdict = send(ALICE, 'hi', at(10), {
      match: { ...match(), conversationId: OTHER_CONVERSATION },
    });
    expect(ruleOf(verdict)).toBe('match_not_for_conversation');
  });

  it('denies a blocked sender even with a live match and a full capability set', () => {
    const verdict = send(ALICE, 'hi', at(10), {
      blocking: activeBlockView([blockBetween(BOB, ALICE)]),
    });
    expect(ruleOf(verdict)).toBe('blocked');
  });
});
