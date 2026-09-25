import { randomUUID } from 'node:crypto';
import {
  type ConversationId,
  type DomainError,
  type MatchId,
  type MessageId,
  type Result,
  type UserId,
  castId,
  domainError,
  ok,
} from '@been-there/core';
import {
  type BlockEdge,
  type CapabilityProjection,
  type Conversation,
  type ConversationState,
  type MatchProjection,
  type PeerStanding,
  activeBlockView,
  sendMessage,
} from '@been-there/communication';
import { MESSAGE_CAPABILITY, matchStandingFor } from '@been-there/dating';
import { MISSING_FIELD, NOT_FOUND } from '../http/failure.js';
import { readString } from '../http/body.js';
import { okResponse, route, type Route, type RouteRequest } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { blocksBetween, matchRecordOf } from '../wiring/dating.js';
import { subjectStandingFor } from '../wiring/standing.js';

/**
 * Sending a message.
 *
 * ## Two gates, in the domain's order, and no local equivalents
 *
 * `sendMessage` already calls `canSend`, and `canSend` already runs the ordered
 * `SEND_CHECKS` table. This route calls `sendMessage` and passes the result
 * through. It does not re-check "is this conversation active?", "is there a
 * block?", or "can this person send?" — a local copy of any of those is a second
 * answer to a question the domain answers once, and the two would drift.
 *
 * ## The refusal is byte-identical for both parties, and that is load-bearing
 *
 * `canSend` evaluates the sender's and the counterpart's standing under one rule,
 * one code, one message. That is what makes a restriction un-probeable: a sender
 * who is restricted and a sender whose counterpart is restricted cannot tell the
 * difference. So the *projections* handed in are deliberately thin —
 * `PeerStanding` is one boolean, not a capability list — and the service does not
 * "improve" them by passing the full standing. Doing so would let a caller tell
 * a banned counterpart from a limited one, which is the leak the one-bit shape
 * exists to prevent.
 *
 * ## A standing the service cannot read refuses the send
 *
 * `standing_unidentifiable` fails closed, and this route lets it: if a party's
 * standing projection is missing, the send is refused and the reason is the
 * wiring fault rather than a product refusal, which is exactly what that rule
 * exists for. Degrading to "allowed" would look like the feature working.
 */

const MAX_MESSAGE_PAGE = 200;

export function conversationRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    route('POST', '/v1/conversations/:conversationId/messages', async (request) => {
      const actorId = request.actor.userId;
      if (actorId === null) {
        return MISSING_FIELD('userId');
      }
      const conversationId = request.params['conversationId'];
      if (conversationId === undefined) {
        return MISSING_FIELD('conversationId');
      }
      const body = readString(request.body, 'body');
      if (!body.ok) {
        return body;
      }
      const row = await dependencies.stores.conversations.find(
        castId<'ConversationId'>(conversationId),
        actorId,
        request.tx,
      );
      if (row === null) {
        return NOT_FOUND('conversation');
      }
      const conversation = conversationOf(row);
      const counterpartId =
        conversation.participants[0] === actorId
          ? conversation.participants[1]
          : conversation.participants[0];
      const [senderStanding, peerStanding, matchRow, blocks, history] = await Promise.all([
        subjectStandingFor(dependencies.stores, actorId, request.now, request.tx),
        subjectStandingFor(dependencies.stores, counterpartId, request.now, request.tx),
        matchForConversation(dependencies, request, conversation, actorId),
        blocksBetween(dependencies.stores, conversation.participants[0], conversation.participants[1], request.tx),
        dependencies.stores.conversations.findMessages(
          conversation.conversationId,
          { limit: MAX_MESSAGE_PAGE, offset: 0 },
          actorId,
          request.tx,
        ),
      ]);
      if (matchRow === null) {
        return domainError(
          'conflict',
          'communication',
          'the conversation has no match behind it, so nothing authorises a send',
          { conversationId },
        );
      }
      if (senderStanding === null || peerStanding === null) {
        // Deliberately not resolved into a capability answer here. `canSend`'s
        // `standing_unidentifiable` rule is what refuses an absent standing, and it
        // refuses it as the wiring fault it is. Filling a default in here would
        // make the feature look like it works while a projection is missing.
        return domainError(
          'external_dependency_failed',
          'communication',
          'an account standing could not be evaluated',
          { party: senderStanding === null ? 'sender' : 'counterpart' },
        );
      }
      const match = matchRow;
      const edges: BlockEdge[] = blocks.map((block) => ({
        blockerId: block.blocker,
        blockedId: block.blocked,
        appliedAt: block.createdAt,
        liftedAt: block.active ? null : block.createdAt,
      }));
      const senderCapabilities: CapabilityProjection = {
        userId: actorId,
        capabilities: senderStanding.standing.account.capabilities,
      };
      const peer: PeerStanding = {
        userId: counterpartId,
        // One bit, never a capability list: see the module comment.
        canSendMessages: peerStanding.standing.account.capabilities.includes(MESSAGE_CAPABILITY),
      };
      const sent = sendMessage(
        {
          conversation,
          senderId: actorId,
          messageId: castId<'MessageId'>(randomUUID()),
          body: body.value,
          at: request.now,
        },
        {
          match: matchProjectionOf(match, conversation),
          blocking: activeBlockView(edges),
          senderStanding: senderCapabilities,
          peerStanding: peer,
          recentSendTimestamps: history.items.map((message) => message.createdAt),
          recentConversationStarts: [conversation.openedAt],
          previousMessageAt: conversation.lastMessageAt,
          messagesInConversation: history.total,
          messagesLastHour: history.items.filter(
            (message) => request.now.getTime() - message.createdAt.getTime() < 3_600_000,
          ).length,
        },
      );
      if (!sent.ok) {
        return sent;
      }
      const appended = await dependencies.stores.conversations.appendMessage(
        {
          messageId: sent.value.message.messageId,
          conversationId: conversation.conversationId,
          senderId: sent.value.message.senderId,
          body: sent.value.message.body,
          createdAt: sent.value.message.createdAt,
          state: sent.value.message.state,
        },
        request.tx,
      );
      return okResponse(201, {
        messageId: sent.value.message.messageId,
        conversationId: conversation.conversationId,
        createdAt: sent.value.message.createdAt.toISOString(),
        state: sent.value.message.state,
        created: appended.created,
      });
    }),

    route('GET', '/v1/conversations/:conversationId/messages', async (request) => {
      const actorId = request.actor.userId;
      if (actorId === null) {
        return MISSING_FIELD('userId');
      }
      const conversationId = request.params['conversationId'];
      if (conversationId === undefined) {
        return MISSING_FIELD('conversationId');
      }
      const page = await dependencies.stores.conversations.findMessages(
        castId<'ConversationId'>(conversationId),
        { limit: MAX_MESSAGE_PAGE, offset: 0 },
        actorId,
        request.tx,
      );
      return okResponse(200, {
        total: page.total,
        messages: page.items.map((message) => ({
          messageId: message.messageId,
          senderId: message.senderId,
          body: message.body,
          state: message.state,
          createdAt: message.createdAt.toISOString(),
        })),
      });
    }),
  ];
}

function conversationOf(row: {
  readonly conversationId: ConversationId;
  readonly matchId: MatchId;
  readonly participants: readonly [UserId, UserId];
  readonly state: string;
  readonly openedAt: Date;
  readonly stateChangedAt: Date | null;
  readonly lastMessageAt: Date | null;
}): Conversation {
  const state = CONVERSATION_STATES.find((candidate) => candidate === row.state);
  if (state === undefined) {
    // The `conversations.state` CHECK constraint makes an unknown state
    // unreachable, so this is a store/schema disagreement rather than user input.
    // Failing closed is the right direction: a send against a conversation whose
    // state the service cannot read must not be authorised.
    throw new Error(
      `stored conversation ${row.conversationId} has state '${row.state}', which the conversation machine does not declare`,
    );
  }
  return {
    conversationId: row.conversationId,
    matchId: row.matchId,
    participants: row.participants,
    state,
    openedAt: row.openedAt,
    stateChangedAt: row.stateChangedAt ?? row.openedAt,
    lastMessageAt: row.lastMessageAt,
  };
}

const CONVERSATION_STATES: readonly ConversationState[] = [
  'active',
  'blocked',
  'frozen_by_restriction',
  'ended_by_unmatch',
  'ended',
];

/**
 * The match behind a conversation, read through the participant-scoped port.
 *
 * `findByMatch` takes a reader because a match id is `match:{a}|{b}` and is
 * therefore *more* guessable than a conversation uuid — anyone who knows two user
 * ids can construct one. A non-participant gets `null`, identical to a match that
 * does not exist, so a probe cannot tell the two apart.
 */
async function matchForConversation(
  dependencies: ServiceDependencies,
  request: RouteRequest,
  conversation: Conversation,
  reader: UserId,
): Promise<{ readonly matchId: string; readonly state: 'active' | 'unmatched'; readonly matchedAt: Date } | null> {
  const row = await dependencies.stores.interaction.findMatch(conversation.matchId, request.tx);
  if (row === null) {
    return null;
  }
  const match = matchRecordOf(row, conversation.conversationId);
  return {
    matchId: match.matchId,
    // `relationshipView` would re-derive standings from live projections, but the
    // send gate wants the *record's* own state: a `closed_by_target` match is
    // over, and the domain's `match_not_active` rule is what says so.
    state: match.ended === null && matchStandingFor(match, reader) === 'active' ? 'active' : 'unmatched',
    matchedAt: match.createdAt,
  };
}

function matchProjectionOf(
  match: { readonly matchId: string; readonly state: 'active' | 'unmatched'; readonly matchedAt: Date },
  conversation: Conversation,
): MatchProjection {
  return {
    matchId: conversation.matchId,
    conversationId: conversation.conversationId,
    participants: conversation.participants,
    state: match.state,
    matchedAt: match.matchedAt,
  };
}

