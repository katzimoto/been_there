import { randomUUID } from 'node:crypto';
import {
  type ConversationId,
  type DomainError,
  type MatchId,
  type Result,
  type UserId,
  castId,
  domainError,
  ok,
} from '@been-there/core';
import {
  type BlockRecord,
  type LikeLedger,
  type LikeRecord,
  applyBlockToMatch,
  castDatingId,
  createBlock,
  recordLike,
  recordPass,
  resolveMatch,
  unmatch,
} from '@been-there/dating';
import { startConversation } from '@been-there/communication';
import { MISSING_FIELD, NOT_FOUND } from '../http/failure.js';
import { readOptionalString, readString } from '../http/body.js';
import { StoreError } from '@been-there/contracts';
import { okResponse, route, type HttpResponse, type Route, type RouteRequest } from '../http/router.js';
import type { ServiceDependencies } from '../ports.js';
import { userIdOf } from './accounts.js';
import { blocksBetween, ledgersFor, matchRecordOf } from '../wiring/dating.js';
import { subjectStandingFor } from '../wiring/standing.js';

/**
 * Likes, passes, blocks and unmatching — the interaction ledger, through the
 * dating domain.
 *
 * ## One transaction, and it is not optional
 *
 * A like that becomes a match writes at least four things: the like, the
 * supersession of the pass it overrode, the match, and the conversation the match
 * opens. The dispatcher has already opened one transaction for the request and
 * every store call below is handed that same handle, so those rows commit
 * together or not at all. A service that opened its own transaction per store
 * call would look correct in the type and break in production, which is the
 * failure ADR 0001 exists to prevent.
 *
 * ## The pass supersession is reached, not reimplemented
 *
 * The verification pass found that a like after a pass has to supersede the pass
 * and that both `isPassInEffect` and `resolveMatch` must see the same fact.
 * `recordLike` returns the updated pass list and names the pass it overrode; this
 * route persists both — the returned ledger through `appendLike`, the
 * supersession through `supersedePass` — in the same transaction. It does not
 * decide that a supersession should happen. The domain decided, by returning a
 * pass list in which that pass is `superseded`.
 *
 * ## What this route refuses to know
 *
 * It never answers "may this user like?", "is this pair blocked?" or "does a
 * match exist?" — `recordLike`, `resolveMatch` and `applyBlockToMatch` answer all
 * three from arguments read fresh at action time. A card served five minutes ago
 * is not a licence to act, so nothing here trusts one.
 */

export function interactionRoutes(dependencies: ServiceDependencies): readonly Route[] {
  return [
    route('POST', '/v1/interactions/likes', async (request) => {
      const actorId = request.actor.userId;
      if (actorId === null) {
        return MISSING_FIELD('userId');
      }
      const toUserId = readString(request.body, 'toUserId');
      if (!toUserId.ok) {
        return toUserId;
      }
      const counterpart = userIdOf(toUserId.value);
      if (!counterpart.ok) {
        return counterpart;
      }
      // The like id is client-supplied when the client has one, because the port's
      // idempotence is on `(from, to, likeId)`: a server-minted id would make a
      // retried request a *second* like id for the same pair, which
      // `recordLike` correctly refuses as a conflict. Letting the caller carry the
      // key is what makes a transport retry collapse instead.
      const suppliedId = readOptionalString(request.body, 'likeId');
      if (!suppliedId.ok) {
        return suppliedId;
      }
      return recordLikeFor(dependencies, request, actorId, counterpart.value, suppliedId.value);
    }),

    route('POST', '/v1/interactions/passes', async (request) => {
      const actorId = request.actor.userId;
      if (actorId === null) {
        return MISSING_FIELD('userId');
      }
      const toUserId = readString(request.body, 'toUserId');
      if (!toUserId.ok) {
        return toUserId;
      }
      const counterpart = userIdOf(toUserId.value);
      if (!counterpart.ok) {
        return counterpart;
      }
      const ledgers = await ledgersFor(dependencies.stores, actorId, request.tx);
      const passId = castDatingId<'PassId'>(randomUUID());
      const passed = recordPass(ledgers.ledger, ledgers.passes, {
        passId,
        from: actorId,
        to: counterpart.value,
        createdAt: request.now,
      });
      if (!passed.ok) {
        return passed;
      }
      const created = await dependencies.stores.interaction.appendPass(
        { passId, from: actorId, to: counterpart.value, createdAt: request.now, state: 'live' },
        request.tx,
      );
      // A pass after a like overtakes it, and `recordPass` already moved that
      // like to `withdrawn` in the ledger it returned. The store's `updateLike` is
      // how that withdrawal reaches storage.
      for (const like of passed.value.ledger.likes) {
        if (like.from === actorId && like.to === counterpart.value && like.state === 'withdrawn') {
          await dependencies.stores.interaction.updateLike(like.likeId, 'withdrawn', request.tx);
        }
      }
      return okResponse(201, {
        passId,
        created: created.created,
        from: actorId,
        to: counterpart.value,
      });
    }),

    route('POST', '/v1/blocks', async (request) => {
      const actorId = request.actor.userId;
      if (actorId === null) {
        return MISSING_FIELD('userId');
      }
      const blockedRaw = readString(request.body, 'blockedUserId');
      if (!blockedRaw.ok) {
        return blockedRaw;
      }
      const blocked = userIdOf(blockedRaw.value);
      if (!blocked.ok) {
        return blocked;
      }
      const block = createBlock(
        actorId,
        blocked.value,
        castDatingId<'BlockId'>(randomUUID()),
        request.now,
      );
      if (!block.ok) {
        return block;
      }
      const created = await createBlockIdempotently(dependencies, request, block.value);
      if (created.kind === 'conflict') {
        // The pair already had an active block. The port calls `createBlock`
        // idempotent and returns `{ created: false }`; the store raises a
        // conflict instead, so the two are reconciled here by re-reading rather
        // than by guessing from the error. A second block on a pair is a fact the
        // service handles, not a fault the caller sees.
        const existing = await dependencies.stores.interaction.findBlocksBetween(
          actorId,
          blocked.value,
          request.tx,
        );
        const active = existing.find((entry) => entry['liftedAt'] === null || entry['liftedAt'] === undefined);
        return okResponse(200, {
          blockId: active === undefined ? null : String(active['blockId']),
          created: false,
        });
      }
      // A block ends an open match, and the ending is the domain's: the standing
      // each party sees, the cause, and the withdrawal of the pair's likes all
      // come out of `applyBlockToMatch`.
      const matchRow = await dependencies.stores.interaction.findMatchByPair(
        actorId,
        blocked.value,
        request.tx,
      );
      if (matchRow !== null) {
        const ended = await endMatchForBlock(dependencies, request, matchRow, block.value);
        if (!ended.ok) {
          return ended;
        }
      }
      return okResponse(201, { blockId: block.value.blockId, created: true });
    }),

  ];
}

/**
 * `createBlock` through the port's own idempotence contract, with the store's
 * conflict reconciled.
 *
 * The port says one active block per pair in either direction and that
 * `createBlock` reports `created: false` on a repeat. The store raises an
 * `InteractionConflictError` for the same fact. Rather than parse the error, the
 * caller re-reads: a conflict that is *not* followed by an active block was
 * something else and is allowed to propagate. That distinction is the whole
 * point — "a block already exists" and "the write failed" must never look alike.
 */
async function createBlockIdempotently(
  dependencies: ServiceDependencies,
  request: RouteRequest,
  block: BlockRecord,
): Promise<{ readonly kind: 'created' } | { readonly kind: 'conflict' }> {
  try {
    await dependencies.stores.interaction.createBlock(
      {
        blockId: block.blockId,
        blocker: block.blocker,
        blocked: block.blocked,
        createdAt: block.createdAt,
      },
      request.tx,
    );
    return { kind: 'created' };
  } catch (error) {
    // A *retryable* fault is an outage, never a conflict, and it propagates: the
    // caller must be told the answer is unknown rather than that a block exists.
    if (!(error instanceof StoreError) || error.retryable) {
      throw error;
    }
    // Everything else is confirmed by re-reading rather than by parsing prose. A
    // non-retryable fault that is *not* followed by an active block was something
    // else entirely, and is rethrown unchanged.
    const existing = await dependencies.stores.interaction.findBlocksBetween(
      block.blocker,
      block.blocked,
      request.tx,
    );
    const active = existing.find(
      (entry) => entry['liftedAt'] === null || entry['liftedAt'] === undefined,
    );
    if (active === undefined) {
      throw error;
    }
    return { kind: 'conflict' };
  }
}

/**
 * A like, and the match it may produce.
 *
 * Four stores writes share the request's transaction: the like, the pass
 * supersession `recordLike` decided on, the match, and the conversation. The
 * reciprocal-like race is settled by the `pair_key` unique index rather than by
 * anything here — `upsertMatch` returns the row that won, and a caller that lost
 * recognises a match that already exists instead of creating a rival one.
 */
async function recordLikeFor(
  dependencies: ServiceDependencies,
  request: RouteRequest,
  actorId: UserId,
  counterpartId: UserId,
  suppliedLikeId: string | null,
): Promise<Result<HttpResponse, DomainError>> {
  const [actor, target] = await Promise.all([
    subjectStandingFor(dependencies.stores, actorId, request.now, request.tx),
    subjectStandingFor(dependencies.stores, counterpartId, request.now, request.tx),
  ]);
  if (actor === null || target === null) {
    return NOT_FOUND('account');
  }
  const [ledgers, blocks] = await Promise.all([
    ledgersFor(dependencies.stores, actorId, request.tx),
    blocksBetween(dependencies.stores, actorId, counterpartId, request.tx),
  ]);
  const likeId = castDatingId<'LikeId'>(suppliedLikeId ?? randomUUID());
  const outcome = recordLike(
    ledgers.ledger,
    { likeId, from: actorId, to: counterpartId, createdAt: request.now },
    {
      actor: actor.standing,
      target: target.standing,
      blocks,
      passes: ledgers.passes,
      at: request.now,
    },
  );
  if (!outcome.ok) {
    return outcome;
  }
  const recorded = recordedLike(outcome.value.ledger, likeId, actorId, counterpartId, request.now);
  const appended = await dependencies.stores.interaction.appendLike(
    {
      likeId,
      from: actorId,
      to: counterpartId,
      createdAt: request.now,
      state: recorded.state,
      supersededPassId: recorded.supersededPassId,
    },
    request.tx,
  );
  if (recorded.supersededPassId !== null) {
    await dependencies.stores.interaction.supersedePass(actorId, counterpartId, request.now, request.tx);
  }

  const conversationId = castId<'ConversationId'>(randomUUID());
  const resolution = resolveMatch({
    actor: actorId,
    counterpart: counterpartId,
    like: recorded,
    ledger: outcome.value.ledger,
    blocks,
    passes: outcome.value.passes,
    at: request.now,
    conversationId,
  });
  if (!resolution.ok) {
    return resolution;
  }
  // The like is written and the resolution refused. That is a real answer —
  // `awaiting_counterpart`, or a block or an in-effect pass — and it is a 201,
  // because the like exists whether or not it became a match.
  if (resolution.value.outcome !== 'match_created') {
    return okResponse(201, {
      likeId,
      created: appended.created,
      match: null,
      resolution: resolution.value.outcome,
      reason: resolution.value.outcome === 'match_refused' ? resolution.value.reason : null,
    });
  }
  const match = resolution.value.match;
  const stored = await dependencies.stores.interaction.upsertMatch(
    {
      matchId: match.matchId,
      participants: match.participants,
      likeIds: match.likeIds,
      standings: match.standings,
      createdAt: match.createdAt,
    },
    request.tx,
  );
  for (const each of match.likeIds) {
    await dependencies.stores.interaction.updateLike(each, 'matched', request.tx);
  }
  // The conversation is opened by the communication domain's own constructor, so
  // the state it starts in — `active` — is declared there and nowhere else.
  const matchId = stored['matchId'] === undefined ? match.matchId : castId<'MatchId'>(String(stored['matchId']));
  const existing = await dependencies.stores.conversations.findByMatch(matchId, actorId, request.tx);
  if (existing !== null) {
    return okResponse(201, {
      likeId,
      created: appended.created,
      match: matchId,
      conversationId: existing.conversationId,
      resolution: 'match_created',
    });
  }
  const conversation = startConversation(
    {
      matchId,
      conversationId,
      participants: match.participants,
      state: 'active',
      matchedAt: match.createdAt,
    },
    request.now,
  );
  await dependencies.stores.conversations.create(
    {
      conversationId: conversation.conversationId,
      matchId: conversation.matchId,
      participants: conversation.participants,
      state: conversation.state,
      openedAt: conversation.openedAt,
      stateChangedAt: conversation.stateChangedAt,
      lastMessageAt: null,
    },
    request.tx,
  );
  return okResponse(201, {
    likeId,
    created: appended.created,
    match: matchId,
    conversationId: conversation.conversationId,
    resolution: 'match_created',
  });
}

/**
 * The like `recordLike` recorded.
 *
 * Returning `Ok` without the like it was asked to record would mean the domain
 * and the service disagree about what happened, and `resolveMatch` would then be
 * handed a fabricated like. So this throws rather than constructing one.
 */
function recordedLike(
  ledger: LikeLedger,
  likeId: string,
  from: UserId,
  to: UserId,
  at: Date,
): LikeRecord {
  const stored = ledger.likes.find((entry) => entry.likeId === likeId);
  if (stored === undefined) {
    throw new Error(`recordLike did not record ${likeId} for ${from} to ${to} at ${at.toISOString()}`);
  }
  return stored;
}

/**
 * A block ends an open match under two different standings — the blocker closed
 * it, the blocked party sees a counterpart who can no longer be reached, never
 * who blocked them — and withdraws the pair's likes rather than deleting them.
 * Every one of those outcomes is `applyBlockToMatch`'s; this function persists
 * them and decides nothing.
 */
async function endMatchForBlock(
  dependencies: ServiceDependencies,
  request: RouteRequest,
  matchRow: Readonly<Record<string, unknown>>,
  block: BlockRecord,
): Promise<Result<true, DomainError>> {
  const matchId = castId<'MatchId'>(String(matchRow['matchId']));
  const conversation = await dependencies.stores.conversations.findByMatch(
    matchId,
    block.blocker,
    request.tx,
  );
  const match = matchRecordOf(matchRow, conversation?.conversationId ?? null);
  const ledgers = await ledgersFor(dependencies.stores, block.blocker, request.tx);
  const outcome = applyBlockToMatch(block, match, ledgers.ledger, request.now);
  if (!outcome.ok) {
    return outcome;
  }
  const ended = outcome.value.match.ended;
  if (ended === null) {
    return ok(true);
  }
  await dependencies.stores.interaction.updateMatch(
    matchId,
    { standings: outcome.value.match.standings, endedAt: ended.at, endedCause: ended.cause },
    request.tx,
  );
  for (const likeId of outcome.value.match.likeIds) {
    await dependencies.stores.interaction.updateLike(likeId, 'withdrawn', request.tx);
  }
  if (conversation !== null) {
    await dependencies.stores.conversations.updateState(
      conversation.conversationId,
      'blocked',
      request.now,
      request.tx,
    );
  }
  return ok(true);
}
