import {
  type DomainError,
  type DomainErrorCode,
  type Err,
  type Result,
  type UserId,
  domainError,
  ok,
} from '@been-there/core';
import { type Conversation, isMessagingOpen, peerOf } from './conversation.js';
import type { BlockingReadModel, CommunicationDependencies } from './read-models.js';

/**
 * The central gate (issue #5).
 *
 * `SEND_CHECKS` is an ordered table, not a chain of `if`s scattered through
 * handlers, so the precedence of a safety fact over a product fact is data and
 * therefore reviewable. The order is the policy:
 *
 *   1. `blocked`                       — a block dominates everything below it.
 *   2. `not_a_participant`             — structural access, before product rules.
 *   3. `match_not_for_conversation`    — the match projection must be this one.
 *   4. `match_not_active`              — the relationship still exists.
 *   5. `conversation_not_open`         — frozen, blocked, un-matched, or ended.
 *   6. `missing_send_message_capability` — the enforcement capability set.
 *
 * A block is checked first on purpose. If it were fourth, a restricted user
 * who blocked someone would be told the conversation is unavailable "because of
 * your restriction", which both leaks the enforcement reason into a product
 * surface and makes the strongest fact the weakest one.
 */

export const SEND_MESSAGE_CAPABILITY = 'send_message';

export type SendDenialRule =
  | 'blocked'
  | 'not_a_participant'
  | 'match_not_for_conversation'
  | 'match_not_active'
  | 'conversation_not_open'
  | 'missing_send_message_capability';

interface SendCheckInput {
  readonly conversation: Conversation;
  readonly senderId: UserId;
  readonly dependencies: CommunicationDependencies;
}

export interface SendCheck {
  readonly rule: SendDenialRule;
  readonly evaluate: (input: SendCheckInput) => Result<void, DomainError>;
}

function denial(
  rule: SendDenialRule,
  code: DomainErrorCode,
  message: string,
  details: Record<string, string> = {},
): Err<DomainError> {
  return domainError(code, 'communication', message, { rule, ...details });
}

export const SEND_CHECKS: readonly SendCheck[] = [
  {
    rule: 'blocked',
    evaluate: ({ conversation, dependencies }) =>
      dependencies.blocking.isBlockedEitherWay(
        conversation.participants[0],
        conversation.participants[1],
      )
        ? denial('blocked', 'permission_denied', 'a block is in force between these participants')
        : ok(undefined),
  },
  {
    rule: 'not_a_participant',
    evaluate: ({ conversation, senderId }) =>
      peerOf(conversation, senderId) === null
        ? denial('not_a_participant', 'permission_denied', 'the sender is not a participant', {
            senderId,
          })
        : ok(undefined),
  },
  {
    rule: 'match_not_for_conversation',
    evaluate: ({ conversation, dependencies }) =>
      dependencies.match.conversationId !== conversation.conversationId
        ? denial(
            'match_not_for_conversation',
            'conflict',
            'the match projection describes a different conversation',
          )
        : ok(undefined),
  },
  {
    rule: 'match_not_active',
    evaluate: ({ dependencies }) =>
      dependencies.match.state !== 'active'
        ? denial('match_not_active', 'not_eligible', 'the match is no longer active', {
            matchState: dependencies.match.state,
          })
        : ok(undefined),
  },
  {
    rule: 'conversation_not_open',
    evaluate: ({ conversation }) =>
      isMessagingOpen(conversation.state)
        ? ok(undefined)
        : denial('conversation_not_open', 'not_eligible', 'the conversation is not open for messaging', {
            conversationState: conversation.state,
          }),
  },
  {
    rule: 'missing_send_message_capability',
    evaluate: ({ dependencies }) =>
      dependencies.senderStanding.capabilities.includes(SEND_MESSAGE_CAPABILITY)
        ? ok(undefined)
        : denial(
            'missing_send_message_capability',
            'permission_denied',
            'the account may not send messages',
            { capability: SEND_MESSAGE_CAPABILITY },
          ),
  },
];

/**
 * Pure authorisation. It reads projections and a conversation snapshot; it
 * mutates nothing, publishes nothing, and never decides that a message is
 * unacceptable — that judgement does not exist anywhere in this package.
 */
export function canSend(
  conversation: Conversation,
  senderId: UserId,
  dependencies: CommunicationDependencies,
): Result<void, DomainError> {
  for (const check of SEND_CHECKS) {
    const verdict = check.evaluate({ conversation, senderId, dependencies });
    if (!verdict.ok) {
      return verdict;
    }
  }
  return ok(undefined);
}

/**
 * Reading is asymmetric, and that asymmetry is the whole point of a block. The
 * blocker keeps their history — they may need it to report later. The blocked
 * party loses read access immediately and unconditionally, including while the
 * conversation is still formally `active` on this side of the projection.
 * Ended and frozen conversations keep both parties' read access, because the
 * history is evidence.
 */
export function canView(
  conversation: Conversation,
  viewerId: UserId,
  blocking: BlockingReadModel,
): Result<void, DomainError> {
  const peer = peerOf(conversation, viewerId);
  if (peer === null) {
    return denial('not_a_participant', 'permission_denied', 'the viewer is not a participant', {
      viewerId,
    });
  }
  if (blocking.isBlockedBy(peer, viewerId)) {
    return denial('blocked', 'permission_denied', 'this participant has blocked the viewer');
  }
  return ok(undefined);
}
