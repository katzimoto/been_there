import { type ConversationId, type MatchId, type UserId, castId } from '@been-there/core';
import {
  type BlockEdge,
  type CapabilityProjection,
  type CommunicationDependencies,
  type Conversation,
  type ConversationState,
  type MatchProjection,
  type Message,
  type PeerStanding,
  activeBlockView,
  startConversation,
} from '../src/index.js';

export const ALICE: UserId = castId<'UserId'>('u-alice');
export const BOB: UserId = castId<'UserId'>('u-bob');
export const STRANGER: UserId = castId<'UserId'>('u-stranger');
export const MATCH_ID: MatchId = castId<'MatchId'>('m-1');
export const CONVERSATION_ID: ConversationId = castId<'ConversationId'>('c-1');

export const OPENED_AT = new Date('2026-01-01T09:00:00.000Z');

export function match(overrides: Partial<MatchProjection> = {}): MatchProjection {
  return {
    matchId: MATCH_ID,
    conversationId: CONVERSATION_ID,
    participants: [ALICE, BOB],
    state: 'active',
    matchedAt: OPENED_AT,
    ...overrides,
  };
}

export function conversationIn(
  state: ConversationState,
  overrides: Partial<Conversation> = {},
): Conversation {
  return {
    ...startConversation(match(), OPENED_AT),
    state,
    stateChangedAt: OPENED_AT,
    ...overrides,
  };
}

export interface DependencyOverrides {
  readonly match?: Partial<MatchProjection>;
  readonly edges?: readonly BlockEdge[];
  readonly capabilities?: readonly string[];
  readonly sender?: UserId;
  /** Defaults to the other participant of `match.participants`. */
  readonly peer?: UserId;
  /** Defaults to true: a counterpart who may send. */
  readonly peerCanSendMessages?: boolean;
  /**
   * The wire value of the counterparty's standing. Pass `undefined` to model a
   * projection that never loaded — omit the key for a live one, which defaults
   * to a counterpart who may send.
   */
  readonly peerStanding?: PeerStanding | undefined;
}

export function dependencies(
  overrides: DependencyOverrides = {},
): CommunicationDependencies {
  const projection = match(overrides.match);
  const sender = overrides.sender ?? ALICE;
  const counterparty = overrides.peer ?? projection.participants.find((id) => id !== sender) ?? BOB;
  // Unchecked on purpose, and the only cast in this file: a standing that
  // never loaded cannot be spelled in `CommunicationDependencies`, which is
  // exactly why the gate has to survive one. This is what it looks like on
  // the wire.
  const peerStanding =
    'peerStanding' in overrides
      ? (overrides.peerStanding as PeerStanding)
      : peerStandingOf(counterparty, overrides.peerCanSendMessages ?? true);
  return {
    match: projection,
    blocking: activeBlockView(overrides.edges ?? []),
    senderStanding: standing(sender, overrides.capabilities),
    peerStanding,
  };
}


export function standing(
  userId: UserId,
  capabilities: readonly string[] = ['send_message', 'report', 'block'],
): CapabilityProjection {
  return { userId, capabilities };
}

export function peerStandingOf(userId: UserId, canSendMessages = true): PeerStanding {
  return { userId, canSendMessages };
}

export function blockBetween(blocker: UserId, blocked: UserId, lifted = false): BlockEdge {
  return { blockerId: blocker, blockedId: blocked, appliedAt: OPENED_AT, liftedAt: lifted ? OPENED_AT : null };
}

let sequence = 0;

export function message(overrides: Partial<Message> = {}): Message {
  sequence += 1;
  return {
    messageId: castId<'MessageId'>(`msg-${sequence}`),
    conversationId: CONVERSATION_ID,
    senderId: ALICE,
    body: `message ${sequence}`,
    createdAt: at(sequence),
    state: 'sent',
    stateChangedAt: at(sequence),
    ...overrides,
  };
}

export function at(secondsAfterOpen: number): Date {
  return new Date(OPENED_AT.getTime() + secondsAfterOpen * 1000);
}
