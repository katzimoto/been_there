import {
  type CaseId,
  type ConversationId,
  type DomainError,
  type MessageId,
  type Result,
  type StateMachine,
  type UserId,
  defineStateMachine,
  domainError,
  ok,
} from '@been-there/core';

/**
 * Message value object and its acknowledgement lifecycle (issue #5).
 *
 * The acknowledgement states describe what the *transport* knows, never what
 * the message is. `read` means an acknowledgement was recorded; it is not a
 * judgement, a reaction, or a signal about the person. No event in this file
 * inspects `body` — the machine cannot, because it is never given one.
 */

export type MessageState = 'sent' | 'delivered' | 'read' | 'failed' | 'deleted';

export type MessageEvent = 'deliver' | 'mark_read' | 'fail' | 'retry' | 'delete';

export type MessageDeletionActor = 'sender' | 'recipient' | 'moderation';

export interface MessageContext {
  readonly deletedBy?: MessageDeletionActor;
  /** Mandatory when the deletion is moderation-driven. */
  readonly caseId?: CaseId;
}

export const messageMachine: StateMachine<MessageState, MessageEvent, MessageContext> =
  defineStateMachine<MessageState, MessageEvent, MessageContext>({
    domain: 'communication.message',
    initial: 'sent',
    transitions: [
      { event: 'deliver', from: ['sent'], to: 'delivered' },
      { event: 'mark_read', from: ['delivered'], to: 'read' },
      {
        event: 'fail',
        from: ['sent'],
        to: 'failed',
        note: 'A transport failure is not a moderation outcome and carries no case.',
      },
      { event: 'retry', from: ['failed'], to: 'sent' },
      {
        event: 'delete',
        from: ['sent', 'delivered', 'read', 'failed'],
        to: 'deleted',
        guard: (ctx) => ctx?.deletedBy !== 'moderation' || ctx?.caseId !== undefined,
        note: 'A user may delete their own message; only a recorded case may delete on moderation authority.',
      },
    ],
  });

export const MAX_MESSAGE_BODY_LENGTH = 4000;

export interface Message {
  readonly messageId: MessageId;
  readonly conversationId: ConversationId;
  readonly senderId: UserId;
  readonly body: string;
  readonly createdAt: Date;
  readonly state: MessageState;
  readonly stateChangedAt: Date;
}

export interface NewMessage {
  readonly messageId: MessageId;
  readonly conversationId: ConversationId;
  readonly senderId: UserId;
  readonly body: string;
  readonly createdAt: Date;
}

export function createMessage(input: NewMessage): Result<Message, DomainError> {
  if (input.body.trim().length === 0) {
    return domainError('validation_failed', 'communication', 'a message body may not be empty', {
      field: 'body',
    });
  }
  if (input.body.length > MAX_MESSAGE_BODY_LENGTH) {
    return domainError('validation_failed', 'communication', 'a message body may be too long', {
      field: 'body',
      maxLength: MAX_MESSAGE_BODY_LENGTH,
      length: input.body.length,
    });
  }
  return ok({ ...input, state: 'sent', stateChangedAt: input.createdAt });
}

export interface MessageCommandContext extends MessageContext {
  readonly at: Date;
}

export function applyMessageEvent(
  message: Message,
  event: MessageEvent,
  context: MessageCommandContext,
): Result<Message, DomainError> {
  const next = messageMachine.next(message.state, event, context);
  if (!next.ok) {
    return next;
  }
  return ok({ ...message, state: next.value, stateChangedAt: context.at });
}
