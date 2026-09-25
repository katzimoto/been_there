import {
  type ActorId,
  type CaseId,
  type ConversationId,
  type DomainError,
  type MatchId,
  type Result,
  type StateMachine,
  type UserId,
  defineStateMachine,
  domainError,
  ok,
} from '@been-there/core';
import type { MatchProjection, MatchState } from './read-models.js';

/**
 * Conversation lifecycle (issue #5).
 *
 * Five states, and the distinction that matters is *why* messaging stopped:
 *
 *   active                 — both parties may send.
 *   blocked                — a user safety action. Temporary, liftable, and it
 *                            dominates every other condition: a lifted
 *                            restriction or an active match cannot reopen it.
 *   frozen_by_restriction  — an enforcement action removed a capability. The
 *                            conversation is unavailable, but it is a safety
 *                            *pause*, not a deletion, and only a recorded case
 *                            can put it here.
 *   ended_by_unmatch       — one party moved on. No sending, ever again, for
 *                            this conversation. A new match creates a new one.
 *   ended                  — closed for any other reason, including a case.
 *
 * Two properties are deliberate. Every state retains the message record and
 * stays referenceable by a report — the machine has no delete-transition at
 * all, so commitment #4 of the overview cannot be violated from here. And the
 * conversation state is never the authority on a *capability*: whether someone
 * may send is decided by the moderation-owned capability projection in
 * `canSend`, so a stale or optimistic state can never widen access.
 */

export type ConversationState =
  | 'active'
  | 'blocked'
  | 'frozen_by_restriction'
  | 'ended_by_unmatch'
  | 'ended';

export type ConversationEvent =
  | 'block_applied'
  | 'block_lifted'
  | 'freeze_for_restriction'
  | 'unfreeze_on_restriction_lift'
  | 'unmatch'
  | 'end';

export interface ConversationContext {
  /** Current dating state, so an unblock can never resurrect a dead match. */
  readonly matchState?: MatchState;
  /** Mandatory for every enforcement-driven move: automation may not pause a chat. */
  readonly caseId?: CaseId;
  readonly moderatorId?: ActorId;
}

export const conversationMachine: StateMachine<
  ConversationState,
  ConversationEvent,
  ConversationContext
> = defineStateMachine<ConversationState, ConversationEvent, ConversationContext>({
  domain: 'communication',
  initial: 'active',
  transitions: [
    {
      event: 'block_applied',
      from: ['active', 'frozen_by_restriction'],
      to: 'blocked',
      note: 'A block is a user safety action: unilateral, immediate, no case required.',
    },
    {
      event: 'block_lifted',
      from: ['blocked'],
      to: 'active',
      guard: (ctx) => ctx?.matchState === 'active',
      note: 'Lifting a block restores messaging only while the match is alive. If a restriction is still live, the capability check in canSend keeps the conversation un-sendable — the state never becomes the authority on that.',
    },
    {
      event: 'freeze_for_restriction',
      from: ['active'],
      to: 'frozen_by_restriction',
      guard: (ctx) => ctx?.caseId !== undefined,
      note: 'Only a recorded enforcement case may pause a conversation. Risk state alone may not.',
    },
    {
      event: 'unfreeze_on_restriction_lift',
      from: ['frozen_by_restriction'],
      to: 'active',
      guard: (ctx) => ctx?.caseId !== undefined,
      note: 'Reopening a frozen conversation is itself an enforcement move and needs the case that closed it.',
    },
    {
      event: 'unmatch',
      from: ['active', 'blocked', 'frozen_by_restriction'],
      to: 'ended_by_unmatch',
      note: 'Unmatch ends messaging and nothing else. The record, and the right to report it, survive.',
    },
    {
      event: 'end',
      from: ['active', 'blocked', 'frozen_by_restriction'],
      to: 'ended',
    },
  ],
});

export interface Conversation {
  readonly conversationId: ConversationId;
  readonly matchId: MatchId;
  readonly participants: readonly [UserId, UserId];
  readonly state: ConversationState;
  readonly openedAt: Date;
  readonly stateChangedAt: Date;
  readonly lastMessageAt: Date | null;
}

export function startConversation(match: MatchProjection, at: Date): Conversation {
  return {
    conversationId: match.conversationId,
    matchId: match.matchId,
    participants: match.participants,
    state: 'active',
    openedAt: at,
    stateChangedAt: at,
    lastMessageAt: null,
  };
}

export interface ConversationCommandContext extends ConversationContext {
  readonly at: Date;
}

export function applyConversationEvent(
  conversation: Conversation,
  event: ConversationEvent,
  context: ConversationCommandContext,
): Result<Conversation, DomainError> {
  const next = conversationMachine.next(conversation.state, event, context);
  if (!next.ok) {
    return next;
  }
  return ok({ ...conversation, state: next.value, stateChangedAt: context.at });
}

/** The single question the transport asks before accepting a message. */
export function isMessagingOpen(state: ConversationState): boolean {
  return state === 'active';
}

/**
 * `blocked` and `frozen_by_restriction` are pauses, not endings: a named user
 * action or a recorded case can reverse them. `ended` and `ended_by_unmatch`
 * are terminal for this conversation.
 */
export function isTemporarilyClosed(state: ConversationState): boolean {
  return state === 'blocked' || state === 'frozen_by_restriction';
}

export function peerOf(conversation: Conversation, userId: UserId): UserId | null {
  if (conversation.participants[0] === userId) {
    return conversation.participants[1];
  }
  if (conversation.participants[1] === userId) {
    return conversation.participants[0];
  }
  return null;
}
