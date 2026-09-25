import {
  type ConversationId,
  type DomainError,
  type MatchId,
  type Result,
  type UserId,
  castId,
  defineStateMachine,
  domainError,
  ok,
} from '@been-there/core';
import { type BlockRecord, activeBlockBetween } from './blocks.js';
import type { LikeId, PassId } from './ids.js';

/**
 * Likes, passes, matches and unmatching (issue #4, #12).
 *
 * Two properties are load-bearing and are modelled as data rather than as
 * application discipline:
 *
 *  1. **Idempotence.** A like is a fact about the ordered pair (from, to), not
 *     about a request. Recording the same like twice is a no-op, and a second
 *     like id for the same pair is a conflict rather than a second record, so
 *     a retried request can never inflate a like count or a match.
 *
 *  2. **One match per pair, whatever the arrival order.** A match is *derived*
 *     from the set of like records, and its identity is derived from the
 *     unordered pair of user ids. Two concurrent reciprocal likes therefore
 *     compute the same `MatchId` and the same two like ids: the second writer
 *     to commit recognises a match that already exists instead of creating a
 *     rival one. Serialising the writers is an implementation detail of the
 *     storage layer; the rule does not depend on it.
 */

export type InteractionState = 'none' | 'liked' | 'passed' | 'matched' | 'unmatched';

export type InteractionEvent = 'like' | 'pass' | 'match' | 'unmatch' | 'withdraw_like';

export interface InteractionContext {
  readonly self: boolean;
  readonly blocked: boolean;
  /** Either party has an active pass over the other. */
  readonly passActive: boolean;
  readonly like: LikeRecord | null;
  readonly counterpartLike: LikeRecord | null;
}

export interface LikeRecord {
  readonly likeId: LikeId;
  readonly from: UserId;
  readonly to: UserId;
  readonly createdAt: Date;
}

export interface PassRecord {
  readonly passId: PassId;
  readonly from: UserId;
  readonly to: UserId;
  readonly createdAt: Date;
}

export function isMutualLike(like: LikeRecord | null, counterpartLike: LikeRecord | null): boolean {
  return (
    like !== null &&
    counterpartLike !== null &&
    like.from !== like.to &&
    like.from === counterpartLike.to &&
    like.to === counterpartLike.from &&
    like.likeId !== counterpartLike.likeId
  );
}

export const interactionMachine = defineStateMachine<
  InteractionState,
  InteractionEvent,
  InteractionContext
>({
  domain: 'dating.interaction',
  initial: 'none',
  transitions: [
    { event: 'like', from: ['none', 'passed', 'unmatched'], to: 'liked', guard: (ctx) => !ctx.self && !ctx.blocked, note: 'A pass is a soft hide, not a veto: liking after a pass is allowed and clears it.' },
    { event: 'pass', from: ['none', 'passed'], to: 'passed', guard: (ctx) => !ctx.self, note: 'A pass hides the candidate from the passer. It is not a block and is reversible by liking.' },
    { event: 'match', from: ['liked'], to: 'matched', guard: (ctx) => !ctx.passActive && isMutualLike(ctx.like, ctx.counterpartLike), note: 'A match needs two distinct reciprocal likes, no active pass, and no block.' },
    { event: 'unmatch', from: ['matched'], to: 'unmatched', note: 'Either party may unmatch. Unmatching never deletes the like records, the match record or the conversation evidence.' },
    { event: 'withdraw_like', from: ['liked'], to: 'none', guard: (ctx) => !ctx.blocked, note: 'A one-sided like can be retracted before it becomes a match.' },
  ],
});

export type MatchStatus = 'active' | 'unmatched' | 'ended_by_block';

export interface MatchRecord {
  readonly matchId: MatchId;
  /** Canonical order, so the pair has exactly one representation. */
  readonly participants: readonly [UserId, UserId];
  readonly likeIds: readonly [LikeId, LikeId];
  readonly status: MatchStatus;
  readonly createdAt: Date;
  readonly endedAt: Date | null;
  /** Assigned by Communication; dating only carries and retains the id. */
  readonly conversationId: ConversationId | null;
}

/**
 * Canonical representation of an unordered pair. Match identity is derived
 * from this, so "the same two people" has exactly one representation no
 * matter which of them acted first.
 */
export function canonicalPair(a: UserId, b: UserId): readonly [UserId, UserId] {
  return a <= b ? [a, b] : [b, a];
}

export function deriveMatchId(a: UserId, b: UserId): MatchId {
  const [first, second] = canonicalPair(a, b);
  return castId<'MatchId'>(`match:${first}|${second}`);
}

export interface LikeLedger {
  readonly likes: readonly LikeRecord[];
}

export const EMPTY_LEDGER: LikeLedger = { likes: [] };

/**
 * Append-only with one exception: a duplicate pair is never appended twice. The
 * same id replayed is success (a retried request); a different id for a pair
 * that already has a like is a conflict (a client bug), and either way the
 * ledger still holds exactly one like for the pair.
 */
export function recordLike(ledger: LikeLedger, like: LikeRecord): Result<LikeLedger, DomainError> {
  if (like.from === like.to) {
    return domainError('validation_failed', 'dating.interaction', 'a user cannot like themselves');
  }
  const existing = ledger.likes.find((entry) => entry.from === like.from && entry.to === like.to);
  if (existing !== undefined) {
    if (existing.likeId === like.likeId) {
      return ok(ledger);
    }
    return domainError('conflict', 'dating.interaction', 'this pair already has a like', {
      from: like.from,
      to: like.to,
    });
  }
  return ok({ likes: [...ledger.likes, like] });
}

export function withdrawLike(ledger: LikeLedger, likeId: LikeId): LikeLedger {
  const remaining = ledger.likes.filter((entry) => entry.likeId !== likeId);
  return remaining.length === ledger.likes.length ? ledger : { likes: remaining };
}

export interface MatchAttempt {
  readonly actor: UserId;
  readonly counterpart: UserId;
  /** The like that triggered this attempt. */
  readonly like: LikeRecord;
  /** Ledger state after the like was recorded. */
  readonly ledger: LikeLedger;
  readonly blocks: readonly BlockRecord[];
  readonly passes: readonly PassRecord[];
  readonly conversationId?: ConversationId | null;
}

export type MatchResolution =
  | { readonly outcome: 'awaiting_counterpart' }
  | { readonly outcome: 'match_created'; readonly match: MatchRecord }
  | { readonly outcome: 'match_refused'; readonly reason: 'blocked' | 'passed' };

/**
 * The whole match-creation rule, as one pure function over two like records.
 * Order of evaluation is block, then pass, then reciprocity — the same order
 * the eligibility gate uses, so a candidate who cannot be seen also cannot
 * match.
 */
export function resolveMatch(attempt: MatchAttempt): Result<MatchResolution, DomainError> {
  const { actor, counterpart, like, ledger, blocks, passes } = attempt;
  if (actor === counterpart) {
    return domainError('validation_failed', 'dating.interaction', 'a user cannot match themselves');
  }
  const triggeringLike = ledger.likes.find((entry) => entry.likeId === like.likeId);
  if (triggeringLike === undefined || triggeringLike.from !== actor || triggeringLike.to !== counterpart) {
    return domainError('validation_failed', 'dating.interaction', 'the triggering like is not the actor’s like of the counterpart');
  }
  if (activeBlockBetween(actor, counterpart, blocks) !== null) {
    return ok({ outcome: 'match_refused', reason: 'blocked' });
  }
  const passedEitherWay = passes.some(
    (pass) =>
      (pass.from === actor && pass.to === counterpart) || (pass.from === counterpart && pass.to === actor),
  );
  if (passedEitherWay) {
    return ok({ outcome: 'match_refused', reason: 'passed' });
  }
  const counterpartLike = ledger.likes.find(
    (entry) => entry.from === counterpart && entry.to === actor && entry.likeId !== like.likeId,
  );
  if (counterpartLike === undefined) {
    return ok({ outcome: 'awaiting_counterpart' });
  }
  const [first, second] = canonicalPair(actor, counterpart);
  const orderedLikes: readonly [LikeId, LikeId] =
    like.from === first ? [like.likeId, counterpartLike.likeId] : [counterpartLike.likeId, like.likeId];
  return ok({
    outcome: 'match_created',
    match: {
      matchId: deriveMatchId(actor, counterpart),
      participants: [first, second],
      likeIds: orderedLikes,
      status: 'active',
      createdAt: attempt.like.createdAt,
      endedAt: null,
      conversationId: attempt.conversationId ?? null,
    },
  });
}

/** A block ends an open match. Precedence lives here, not in a UI check. */
export function applyBlockToMatch(
  block: BlockRecord,
  match: MatchRecord,
  at: Date,
): Result<MatchRecord, DomainError> {
  if (!match.participants.includes(block.blocker) || !match.participants.includes(block.blocked)) {
    return domainError('validation_failed', 'dating.interaction', 'block does not involve this match', {
      matchId: match.matchId,
    });
  }
  if (match.status !== 'active') {
    return domainError('invalid_transition', 'dating.interaction', 'match is already ended', {
      status: match.status,
    });
  }
  return ok({ ...match, status: 'ended_by_block', endedAt: at });
}

export interface ConversationDisposition {
  readonly conversationId: ConversationId;
  readonly state: 'open' | 'closed';
  /** Always true: an ended match keeps its conversation as evidence. */
  readonly retainedForEvidence: true;
}

export interface UnmatchOutcome {
  readonly match: MatchRecord;
  readonly conversation: ConversationDisposition | null;
}

/**
 * Either party may end a match. The match record is retained with status
 * `unmatched` rather than deleted, and the conversation is closed but kept, so
 * that a report filed after the unmatch still has its evidence attached.
 */
export function unmatch(match: MatchRecord, actor: UserId, at: Date): Result<UnmatchOutcome, DomainError> {
  if (!match.participants.includes(actor)) {
    return domainError('permission_denied', 'dating.interaction', 'only a participant can unmatch', {
      matchId: match.matchId,
    });
  }
  if (match.status !== 'active') {
    return domainError('invalid_transition', 'dating.interaction', 'match is already ended', {
      status: match.status,
    });
  }
  return ok({
    match: { ...match, status: 'unmatched', endedAt: at },
    conversation:
      match.conversationId === null
        ? null
        : { conversationId: match.conversationId, state: 'closed', retainedForEvidence: true },
  });
}

export interface ReportableRelation {
  readonly viewer: UserId;
  readonly subject: UserId;
  readonly likes: readonly LikeRecord[];
  readonly passes: readonly PassRecord[];
  /** Retained whether it is still active, unmatched, or ended by a block. */
  readonly match: MatchRecord | null;
  readonly blocks: readonly BlockRecord[];
}

export interface ReportEvidence {
  readonly likeIds: readonly LikeId[];
  readonly passIds: readonly PassId[];
  readonly matchId: MatchId | null;
  readonly conversationId: ConversationId | null;
}

/**
 * The right to report is a property of the recorded relationship, not of its
 * current state. A relationship that existed cannot be un-existed by unmatching
 * it, so an ended match, a released block and a retracted like all still
 * yield a reportable subject with its handles intact. The only thing that makes
 * a subject unreportable is that there was never any interaction at all.
 */
export function evidenceForReport(relation: ReportableRelation): Result<ReportEvidence, DomainError> {
  if (relation.viewer === relation.subject) {
    return domainError('validation_failed', 'dating.interaction', 'a user cannot report themselves');
  }
  const likeIds = relation.likes.map((like) => like.likeId);
  const passIds = relation.passes.map((pass) => pass.passId);
  if (likeIds.length === 0 && passIds.length === 0 && relation.match === null && relation.blocks.length === 0) {
    return domainError('not_found', 'dating.interaction', 'no recorded interaction with this user');
  }
  return ok({
    likeIds,
    passIds,
    matchId: relation.match?.matchId ?? null,
    conversationId: relation.match?.conversationId ?? null,
  });
}
