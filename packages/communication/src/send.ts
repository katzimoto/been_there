import {
  type DomainError,
  type MessageId,
  type Result,
  type UserId,
  domainError,
} from '@been-there/core';
import { type Conversation, peerOf } from './conversation.js';
import { NEW_CONVERSATION_RATE_RULE, PER_CONVERSATION_RATE_RULE, evaluateRateRule } from './friction.js';
import { type Message, createMessage } from './message.js';
import { canSend } from './permissions.js';
import type { MessageSentSignal } from './signals.js';
import type { CommunicationDependencies } from './read-models.js';

/**
 * The send path (issue #5).
 *
 * The order below is the whole safety argument, and it is deliberate:
 *
 *   1. participant — structural precondition; also what makes `peer` non-null
 *                    for the signal payload.
 *   2. `canSend`   — authorisation. A rate limit is a cost the sender pays; it
 *                    is not an oracle that reveals why a conversation is
 *                    unavailable, and a blocked user must not be able to infer
 *                    that the block is what stopped them.
 *   3. body check  — an empty or oversized body is rejected before it can
 *                    consume rate budget.
 *   4. friction    — last, and only ever as friction. Nothing below this line
 *                    can move the conversation, close it, or touch an account
 *                    standing; a rate-limited sender stays `active` and simply
 *                    waits out the window.
 *
 * On success the caller receives the message *and the signal payload it must
 * publish*. Building the envelope is the application service's job; the payload
 * is assembled here, once, from the metadata that is allowed to leave.
 */

export interface SendCommand {
  readonly conversation: Conversation;
  readonly senderId: UserId;
  readonly messageId: MessageId;
  readonly body: string;
  readonly at: Date;
}

export interface SendDependencies extends CommunicationDependencies {
  /** Send instants in this conversation, for the burst rule. */
  readonly recentSendTimestamps: readonly Date[];
  /** Conversation-open instants for this user, for the new-conversation rule. */
  readonly recentConversationStarts: readonly Date[];
  readonly previousMessageAt: Date | null;
  readonly messagesInConversation: number;
  readonly messagesLastHour: number;
}

export interface SentMessage {
  readonly message: Message;
  readonly signal: MessageSentSignal;
}

export function sendMessage(
  command: SendCommand,
  dependencies: SendDependencies,
): Result<SentMessage, DomainError> {
  const peer = peerOf(command.conversation, command.senderId);
  if (peer === null) {
    return domainError('permission_denied', 'communication', 'the sender is not a participant', {
      rule: 'not_a_participant',
    });
  }
  const authorized = canSend(command.conversation, command.senderId, dependencies);
  if (!authorized.ok) {
    return authorized;
  }
  const created = createMessage({
    messageId: command.messageId,
    conversationId: command.conversation.conversationId,
    senderId: command.senderId,
    body: command.body,
    createdAt: command.at,
  });
  if (!created.ok) {
    return created;
  }
  const conversationFriction = evaluateRateRule(
    PER_CONVERSATION_RATE_RULE,
    dependencies.recentSendTimestamps,
    command.at,
  );
  if (!conversationFriction.ok) {
    return conversationFriction;
  }
  const startFriction = evaluateRateRule(
    NEW_CONVERSATION_RATE_RULE,
    dependencies.recentConversationStarts,
    command.at,
  );
  if (!startFriction.ok) {
    return startFriction;
  }

  return {
    ok: true,
    value: {
      message: created.value,
      signal: {
        conversationId: command.conversation.conversationId,
        matchId: command.conversation.matchId,
        senderId: command.senderId,
        peerId: peer,
        messageId: command.messageId,
        messageState: created.value.state,
        sentAt: command.at,
        secondsSincePreviousMessage:
          dependencies.previousMessageAt === null
            ? null
            : (command.at.getTime() - dependencies.previousMessageAt.getTime()) / 1000,
        messagesInConversation: dependencies.messagesInConversation,
        messagesLastHour: dependencies.messagesLastHour,
        bodyLength: command.body.length,
        secondsSinceConversationOpened:
          (command.at.getTime() - command.conversation.openedAt.getTime()) / 1000,
      },
    },
  };
}
