import { type Result, type UserId, castId, capabilitiesFor } from '@been-there/core';
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
  type DependencyOverrides,
  ALICE,
  BOB,
  CONVERSATION_ID,
  STRANGER,
  at,
  blockBetween,
  conversationIn,
  dependencies,
  match,
  peerStandingOf,
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

function errorOf(
  result: Result<unknown, { code: string; message: string; details?: Record<string, unknown> }>,
): { code: string; message: string; details?: Record<string, unknown> } | null {
  return result.ok ? null : result.error;
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
      'standing_unidentifiable',
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
      send(BOB, 'hi', at(30), { senderStanding: standing(BOB), peerStanding: peerStandingOf(ALICE) }, 'msg-2'),
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

  /**
   * The same send, expressed in the fixture's vocabulary for the projections —
   * which is the only way to model a standing that is loaded, absent, or
   * describing somebody other than the party it is consulted for. The sender's
   * own projection follows the sender unless a test deliberately mis-wires it.
   */
  function sendAgainst(overrides: DependencyOverrides, senderId: UserId = ALICE, id = 'msg-projection') {
    return sendMessage(
      { conversation, senderId, messageId: castId<'MessageId'>(id), body: 'hi', at: at(10) },
      { ...deps(), ...dependencies({ ...overrides, sender: overrides.sender ?? senderId }) },
    );
  }

  it('refuses a send into a conversation whose counterpart may not send', () => {
    // ALICE is in good standing. The point of §8.4 is that BOB's restriction
    // closes the composer for ALICE too, in the same words it would use if
    // ALICE were the restricted one.
    const counterpartRestricted = sendAgainst({ peerCanSendMessages: false }, ALICE, 'msg-peer');
    const senderRestricted = sendAgainst({ capabilities: ['report'] }, ALICE, 'msg-self');
    expect(ruleOf(counterpartRestricted)).toBe('missing_send_message_capability');
    // The whole error, not merely the rule name: a restriction readable from
    // the difference between the two branches is a restriction that can be
    // probed.
    expect(errorOf(counterpartRestricted)).toEqual(errorOf(senderRestricted));
  });

  it('refuses both directions when one party of the conversation is restricted', () => {
    // The ordinary case, not an edge case: one limited, one active. Neither may
    // message, and the refusal does not depend on which of them is talking.
    const activeToRestricted = sendAgainst({ peerCanSendMessages: false }, ALICE, 'msg-a');
    const restrictedToActive = sendAgainst({ capabilities: ['report'] }, BOB, 'msg-b');
    expect(rejected(activeToRestricted)).toBe(true);
    expect(rejected(restrictedToActive)).toBe(true);
    expect(errorOf(activeToRestricted)).toEqual(errorOf(restrictedToActive));
  });

  it('lets a block outrank a counterpart restriction, and mentions nothing else', () => {
    const verdict = sendAgainst(
      { edges: [blockBetween(BOB, ALICE)], peerCanSendMessages: false },
      ALICE,
      'msg-blocked',
    );
    expect(ruleOf(verdict)).toBe('blocked');
    // Exactly one key: no capability, no user id. A block that also reported
    // the counterpart's standing would tell a blocked party what state the
    // person who blocked them is in.
    expect(errorOf(verdict)?.details).toEqual({ rule: 'blocked' });
  });

  it('refuses a counterpart whose real capability set has no send_message, in any restricted state', () => {
    for (const state of ['limited', 'suspended', 'banned'] as const) {
      const verdict = sendAgainst(
        { peerCanSendMessages: capabilitiesFor(state).includes('send_message') },
        ALICE,
        `msg-${state}`,
      );
      expect(ruleOf(verdict)).toBe('missing_send_message_capability');
    }
  });

  it('fails closed when the counterpart standing never loaded', () => {
    const verdict = sendAgainst({ peerStanding: undefined }, ALICE, 'msg-missing');
    expect(ruleOf(verdict)).toBe('standing_unidentifiable');
    // `external_dependency_failed`, not a refusal: a projection that could not
    // be read is an operator's problem, and laundering it into an ordinary
    // refusal is how a broken read looks like a working feature.
    expect(errorOf(verdict)?.code).toBe('external_dependency_failed');
    expect(errorOf(verdict)?.details?.['party']).toBe('counterpart');
  });

  it('fails closed on a standing that describes somebody else, and names the party', () => {
    const wrongPeer = sendAgainst({ peerStanding: peerStandingOf(STRANGER) }, ALICE, 'msg-wrong-peer');
    const wrongSender = sendAgainst({ sender: ALICE, capabilities: ['report'] }, BOB, 'msg-wrong-sender');
    expect(rejected(wrongPeer)).toBe(true);
    expect(errorOf(wrongPeer)?.details?.['party']).toBe('counterpart');
    // BOB is the sender here and the projection on the wire names ALICE, so the
    // gate must blame the sender's side rather than assume the counterpart's
    // standing is the suspect one.
    expect(errorOf(wrongSender)?.details?.['party']).toBe('sender');
  });

  it('refuses when the counterpart field holds the sender\'s own standing', () => {
    // The caller's mistake that would defeat the rule outright: a peer
    // standing naming the sender satisfies the type, and the gate would then
    // read one party twice and call the result symmetric. Comparing the id
    // against the *other* participant turns that into a refusal rather than a
    // silent bypass.
    const verdict = sendAgainst({ peerStanding: peerStandingOf(ALICE) }, ALICE, 'msg-same-standing');
    expect(ruleOf(verdict)).toBe('standing_unidentifiable');
    expect(errorOf(verdict)?.details?.['party']).toBe('counterpart');
  });
});
