import { describe, expect, it } from 'vitest';
import {
  type CaseId,
  type MessageId,
  type Result,
  assertMachineIsTotal,
  castId,
} from '@been-there/core';
import {
  type Conversation,
  type ConversationState,
  type MessageState,
  applyConversationEvent,
  applyMessageEvent,
  MAX_MESSAGE_BODY_LENGTH,
  conversationMachine,
  createMessage,
  isMessagingOpen,
  isTemporarilyClosed,
  messageMachine,
  peerOf,
  startConversation,
} from '../src/index.js';
import { ALICE, BOB, CONVERSATION_ID, MATCH_ID, OPENED_AT, STRANGER, at, match, message } from './fixtures.js';

function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

function rejected<T, E>(result: Result<T, E>): boolean {
  return !result.ok;
}

describe('conversation machine', () => {
  it('binds a new conversation to the match that created it', () => {
    const conversation = startConversation(match(), OPENED_AT);
    expect(conversation.conversationId).toBe(CONVERSATION_ID);
    expect(conversation.matchId).toBe(MATCH_ID);
    expect(conversation.state).toBe<ConversationState>('active');
    expect(peerOf(conversation, ALICE)).toBe(BOB);
    expect(peerOf(conversation, STRANGER)).toBeNull();
  });

  it('leaves every non-terminal state a way out and every terminal state none', () => {
    assertMachineIsTotal(conversationMachine, ['ended', 'ended_by_unmatch']);
    for (const state of conversationMachine.states) {
      if (state === 'ended' || state === 'ended_by_unmatch') {
        expect(conversationMachine.legalEvents(state)).toEqual([]);
        continue;
      }
      expect(conversationMachine.legalEvents(state).length).toBeGreaterThan(0);
    }
  });

  it('refuses to freeze a conversation without a recorded case', () => {
    const conversation = startConversation(match(), OPENED_AT);
    expect(rejected(applyConversationEvent(conversation, 'freeze_for_restriction', { at: at(1) }))).toBe(
      true,
    );
    const frozen = succeeded(
      applyConversationEvent(conversation, 'freeze_for_restriction', {
        at: at(1),
        caseId: castId<'CaseId'>('case-1'),
      }),
    );
    expect(frozen.state).toBe<ConversationState>('frozen_by_restriction');
    expect(frozen.stateChangedAt).toEqual(at(1));
    expect(isTemporarilyClosed(frozen.state)).toBe(true);
    expect(isMessagingOpen(frozen.state)).toBe(false);
  });

  it('never resurrects a conversation whose match is gone when a block is lifted', () => {
    const blocked = succeeded(
      applyConversationEvent(startConversation(match(), OPENED_AT), 'block_applied', { at: at(1) }),
    );
    expect(
      rejected(applyConversationEvent(blocked, 'block_lifted', { at: at(2), matchState: 'unmatched' })),
    ).toBe(true);
    expect(
      succeeded(
        applyConversationEvent(blocked, 'block_lifted', { at: at(2), matchState: 'active' }),
      ).state,
    ).toBe<ConversationState>('active');
  });

  it('keeps a lifted block un-sendable by state alone only until the capability says otherwise', () => {
    const blocked = succeeded(
      applyConversationEvent(startConversation(match(), OPENED_AT), 'block_applied', { at: at(1) }),
    );
    // The conversation state returns to active, but sending is still gated by
    // the moderation-owned capability projection — see the permission suite.
    expect(
      succeeded(
        applyConversationEvent(blocked, 'block_lifted', { at: at(2), matchState: 'active' }),
      ).state,
    ).toBe<ConversationState>('active');
  });

  it('does not let a lifted restriction reopen a blocked conversation', () => {
    expect(conversationMachine.legalEvents('blocked')).not.toContain('unfreeze_on_restriction_lift');
    expect(conversationMachine.legalEvents('blocked')).toContain('block_lifted');
  });

  it('ends on unmatch from every open state, and never again', () => {
    for (const state of ['active', 'blocked', 'frozen_by_restriction'] as const) {
      const ended = succeeded(
        applyConversationEvent(
          { ...startConversation(match(), OPENED_AT), state },
          'unmatch',
          { at: at(5) },
        ),
      );
      expect(ended.state).toBe<ConversationState>('ended_by_unmatch');
      expect(conversationMachine.legalEvents(ended.state)).toEqual([]);
    }
  });

  it('reopens a frozen conversation only through the case that closed it', () => {
    const frozen: Conversation = {
      ...startConversation(match(), OPENED_AT),
      state: 'frozen_by_restriction',
    };
    expect(
      rejected(applyConversationEvent(frozen, 'unfreeze_on_restriction_lift', { at: at(3) })),
    ).toBe(true);
    expect(
      succeeded(
        applyConversationEvent(frozen, 'unfreeze_on_restriction_lift', { at: at(3), caseId: castId<'CaseId'>('case-1') }),
      ).state,
    ).toBe<ConversationState>('active');
  });

  it('offers a way out of every non-terminal state', () => {
    expect(conversationMachine.legalEvents('active')).toContain('end');
    expect(conversationMachine.legalEvents('blocked')).toContain('block_lifted');
    expect(conversationMachine.legalEvents('frozen_by_restriction')).toContain(
      'unfreeze_on_restriction_lift',
    );
  });
});

describe('message machine', () => {
  it('walks the acknowledgement path in order and refuses to go back', () => {
    const sent = succeeded(
      createMessage({
        messageId: castId<'MessageId'>('m-1'),
        conversationId: CONVERSATION_ID,
        senderId: ALICE,
        body: 'hi',
        createdAt: OPENED_AT,
      }),
    );
    expect(sent.state).toBe<MessageState>('sent');
    const delivered = succeeded(applyMessageEvent(sent, 'deliver', { at: at(1) }));
    expect(delivered.state).toBe<MessageState>('delivered');
    const read = succeeded(applyMessageEvent(delivered, 'mark_read', { at: at(2) }));
    expect(read.state).toBe<MessageState>('read');
    expect(rejected(applyMessageEvent(read, 'deliver', { at: at(3) }))).toBe(true);
    expect(rejected(applyMessageEvent(read, 'mark_read', { at: at(4) }))).toBe(true);
  });

  it('recovers a failed message by retry and keeps deletion terminal', () => {
    const failed = succeeded(applyMessageEvent(message(), 'fail', { at: at(9) }));
    expect(failed.state).toBe<MessageState>('failed');
    expect(succeeded(applyMessageEvent(failed, 'retry', { at: at(10) })).state).toBe<MessageState>('sent');
    const deleted = succeeded(applyMessageEvent(failed, 'delete', { at: at(11), deletedBy: 'sender' }));
    expect(deleted.state).toBe<MessageState>('deleted');
    expect(messageMachine.legalEvents('deleted')).toEqual([]);
  });

  it('lets a user delete their own message but never a moderator without a case', () => {
    const sent = message();
    expect(
      succeeded(applyMessageEvent(sent, 'delete', { at: at(1), deletedBy: 'sender' })).state,
    ).toBe<MessageState>('deleted');
    expect(rejected(applyMessageEvent(sent, 'delete', { at: at(1), deletedBy: 'moderation' }))).toBe(
      true,
    );
    expect(
      succeeded(
        applyMessageEvent(sent, 'delete', { at: at(1), deletedBy: 'moderation', caseId: castId<'CaseId'>('case-1') }),
      ).state,
    ).toBe<MessageState>('deleted');
  });

  it('rejects an empty, blank, or oversized body', () => {
    const base = { messageId: castId<'MessageId'>('m-1'), conversationId: CONVERSATION_ID, senderId: ALICE, createdAt: OPENED_AT };
    expect(rejected(createMessage({ ...base, body: '' }))).toBe(true);
    expect(rejected(createMessage({ ...base, body: '   \n ' }))).toBe(true);
    expect(rejected(createMessage({ ...base, body: 'x'.repeat(MAX_MESSAGE_BODY_LENGTH + 1) }))).toBe(
      true,
    );
    const longest = succeeded(
      createMessage({ ...base, body: 'x'.repeat(MAX_MESSAGE_BODY_LENGTH) }),
    );
    expect(longest.body.length).toBe(MAX_MESSAGE_BODY_LENGTH);
    expect(longest.stateChangedAt).toEqual(OPENED_AT);
  });
});
