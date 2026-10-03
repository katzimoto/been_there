import { randomUUID } from 'node:crypto';
import {
  type DomainError,
  type MatchId,
  type Result,
  castId,
  domainError,
  ok,
} from '@been-there/core';
import { castDatingId, unmatch } from '@been-there/dating';
import { createServiceSafety } from '../wiring/safety.js';
import { subjectOf } from '../wiring/standing.js';
import { MISSING_FIELD, NOT_FOUND } from '../http/failure.js';
import { readString } from '../http/body.js';
import { okResponse, route, type Route } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { ledgersFor, matchRecordOf } from '../wiring/dating.js';

/**
 * Ending a match.
 *
 * ## The conversation is closed and kept
 *
 * `unmatch` returns a `ConversationDisposition` with `retainedForEvidence: true`,
 * and this route acts on it: the conversation's state moves to `ended_by_unmatch`
 * and nothing is deleted. That is commitment 4 in a return type — a relationship
 * that existed cannot be un-existed by ending it, so a report filed afterwards
 * still has its evidence attached. A route that deleted the conversation here
 * would satisfy "unmatch" and break "report what happened", and the second is the
 * promise.
 *
 * ## The idempotency key is the caller's
 *
 * A transport retry of an unmatch must replay its own outcome rather than
 * becoming a second attempt, so the key travels on the request. `matches` has no
 * column for it, which means a retry *after a restart* is decoded as a fresh
 * command and refused as an invalid transition — the safe direction, and a gap
 * reported in the handoff rather than papered over.
 */
export function matchRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    route('POST', '/v1/matches/:matchId/unmatch', async (request) => {
      const actorId = request.actor.userId;
      if (actorId === null) {
        return MISSING_FIELD('userId');
      }
      const matchId = castId<'MatchId'>(request.params['matchId'] ?? '');
      if (matchId.length === 0) {
        return MISSING_FIELD('matchId');
      }
      const key = readString(request.body, 'idempotencyKey');
      if (!key.ok) {
        return key;
      }
      const row = await dependencies.stores.interaction.findMatch(matchId, request.tx);
      if (row === null) {
        return NOT_FOUND('match');
      }
      const conversation = await dependencies.stores.conversations.findByMatch(
        matchId,
        actorId,
        request.tx,
      );
      const match = matchRecordOf(row, conversation?.conversationId ?? null);
      const ledgers = await ledgersFor(dependencies.stores, actorId, request.tx);
      const outcome = unmatch(ledgers.ledger, {
        match,
        actor: actorId,
        at: request.now,
        key: castDatingId<'IdempotencyKey'>(key.value),
      });
      if (!outcome.ok) {
        return outcome;
      }
      const ended = outcome.value.match.ended;
      if (ended !== null) {
        const applied = await dependencies.stores.interaction.updateMatch(
          matchId,
          {
            standings: outcome.value.match.standings,
            endedAt: ended.at,
            endedCause: ended.cause,
          },
          request.tx,
        );
        if (!applied) {
          return domainError('conflict', 'dating.interaction', 'the match moved while this was being ended', {
            matchId,
          });
        }
        for (const likeId of outcome.value.match.likeIds) {
          await dependencies.stores.interaction.updateLike(likeId, 'withdrawn', request.tx);
        }
        if (outcome.value.conversation !== null) {
          await dependencies.stores.conversations.updateState(
            outcome.value.conversation.conversationId,
            'ended_by_unmatch',
            request.now,
            request.tx,
          );
        }
      }
      // The unmatch is observed for both accounts: the one who ended the match
      // performed it, and the one who was unmatched is the account a detector
      // runs for. Publishing only the performer's side would leave
      // `interaction.unmatch_by_counterparty` permanently silent, which is the
      // reduction's documented answer to an unmatch it cannot place.
      const other =
        match.participants[0] === actorId ? match.participants[1] : match.participants[0];
      await createServiceSafety(dependencies).recorder.observe(
        {
          kind: 'unmatch.performed',
          actorId,
          subjectId: subjectOf(other),
          matchId,
          at: request.now,
        },
        request.tx,
      );
      // The conversation is closed and *kept*. The right to report outlives the
      // relationship — commitment 4 — so this route ends a conversation and
      // deletes nothing.
      return okResponse(200, {
        matchId: outcome.value.match.matchId,
        cause: ended?.cause ?? null,
        conversationRetained: outcome.value.conversation !== null,
      });
    }),

    route('GET', '/v1/matches', async (request) => {
      const actorId = request.actor.userId;
      if (actorId === null) {
        return MISSING_FIELD('userId');
      }
      const page = await dependencies.stores.interaction.findMatchesFor(
        actorId,
        { limit: 50, offset: 0 },
        request.tx,
      );
      return okResponse(200, { total: page.total, matches: page.items });
    }),
  ];
}
