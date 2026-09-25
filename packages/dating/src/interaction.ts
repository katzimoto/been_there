import {
  type ConversationId,
  type DomainError,
  type IdentityState,
  type MatchId,
  type Result,
  type UserId,
  castId,
  defineStateMachine,
  domainError,
  ok,
} from '@been-there/core';
import { type BlockRecord, activeBlockBetween } from './blocks.js';
import { type IdempotencyKey, type LikeId, type PassId } from './ids.js';
import { type NewPass, type PassRecord, type PassState, isPassInEffect } from './passes.js';
import type { ProfileState } from './profile.js';
import {
  type LikeLedger,
  type LikeRecord,
  type LikeState,
  currentLikeBetween,
  isMutualLike,
  setLikeState,
} from './likes.js';

/**
 * Likes, passes, matches and unmatching (issue #4, #12).
 *
 * Four properties are load-bearing and are modelled as data rather than as
 * application discipline:
 *
 *  1. **Idempotence.** A like is a fact about the ordered pair (from, to), not
 *     about a request. Recording the same like twice is a no-op, and a second
 *     like id for the same pair is a conflict rather than a second record, so
 *     a retried request can never inflate a like count or a match. An unmatch
 *     carries an idempotency key and replays its own outcome for the same
 *     reason.
 *
 *  2. **One match per pair, whatever the arrival order.** A match is *derived*
 *     from the set of like records, and its identity is derived from the
 *     unordered pair of user ids. Two concurrent reciprocal likes therefore
 *     compute the same `MatchId` and the same two like ids: the second writer
 *     to commit recognises a match that already exists instead of creating a
 *     rival one. Serialising the writers is an implementation detail of the
 *     storage layer; the rule does not depend on it.
 *
 *  3. **Nothing that happened is un-happened.** A retracted like, a superseded
 *     pass and an ended match are *states* on retained records. Nothing in this
 *     module deletes a row, because a deleted row is a relationship that can no
 *     longer be reported, and commitment 4 makes the right to report a property
 *     of what happened rather than of what survives.
 *
 *  4. **Preconditions are re-read at action time.** `recordLike` takes the two
 *     standings and the block edges as arguments, so "you cannot like after
 *     your verification lapsed" is a guard somebody can delete rather than a
 *     comment somebody can forget. A card served five minutes ago is not a
 *     licence to act on.
 */

export type InteractionState = 'none' | 'liked' | 'passed' | 'matched' | 'unmatched';

export type InteractionEvent = 'like' | 'pass' | 'match' | 'unmatch' | 'withdraw_like';

export interface InteractionContext {
  readonly self: boolean;
  readonly blocked: boolean;
  /** A pass in effect, in either direction, at the moment of the transition. */
  readonly passActive: boolean;
  readonly like: LikeRecord | null;
  readonly counterpartLike: LikeRecord | null;
}

export const interactionMachine = defineStateMachine<
  InteractionState,
  InteractionEvent,
  InteractionContext
>({
  domain: 'dating.interaction',
  initial: 'none',
  transitions: [
    { event: 'like', from: ['none', 'passed', 'unmatched'], to: 'liked', guard: (ctx) => !ctx.self && !ctx.blocked, note: 'A pass is a soft hide, not a veto: liking after a pass is allowed, and `recordLike` supersedes the pass it overrides so the pair can still match. Identity, capability and profile preconditions live in `recordLike`, not in this guard.' },
    { event: 'like', from: ['matched'], to: 'matched', guard: (ctx) => !ctx.self, note: 'Liking someone you are already matched with is a no-op, not an error: a double tap is the expected case, so the state is unchanged rather than refused.' },
    { event: 'pass', from: ['none', 'passed'], to: 'passed', guard: (ctx) => !ctx.self, note: 'A pass hides the candidate from the passer. It is not a block, and it is reversible by liking.' },
    { event: 'pass', from: ['liked'], to: 'passed', guard: (ctx) => !ctx.self, note: 'A pass after a like overtakes it: the like moves to `superseded` and suppression is re-applied. Expressed so the machine can reach every decision the product allows, not because the UI offers a like-then-pass button.' },
    { event: 'match', from: ['liked'], to: 'matched', guard: (ctx) => !ctx.passActive && isMutualLike(ctx.like, ctx.counterpartLike), note: 'A match needs two distinct reciprocal likes, no pass in effect, and no block.' },
    { event: 'unmatch', from: ['matched'], to: 'unmatched', note: 'Either party may unmatch. Unmatching never deletes the like records, the match record or the conversation evidence.' },
    { event: 'withdraw_like', from: ['liked'], to: 'none', guard: (ctx) => !ctx.blocked, note: 'A one-sided like can be retracted before it becomes a match.' },
  ],
});

/**
 * The standing one party sees of a match. The non-`active` values are the
 * difference between "this match cannot be used right now" (`dormant_*`,
 * `restricted_*` — it comes back by itself when the cause clears) and "this
 * match is over" (`closed_*` — it does not).
 */
export type MatchStanding =
  | 'active'
  /** The counterpart is no longer `verified`; messaging resumes when they are. */
  | 'dormant_target_unverified'
  /** The counterpart cannot be messaged; the missing capability is named. */
  | 'restricted_by_target'
  /** The counterpart cannot appear in the product at all. Never explained. */
  | 'closed_by_target'
  /** This party, or an enforcement action, ended it. */
  | 'closed_by_actor';

/** Why a match stopped. The cause is the same for both parties; the standing is not. */
export type MatchEndCause = 'unmatched' | 'ended_by_block';

export interface MatchEnd {
  readonly cause: MatchEndCause;
  /** Who did it: the party that acted, or `system` for an enforcement action. */
  readonly actorId: UserId | 'system';
  readonly at: Date;
  /**
   * Present for an actor-initiated end. It is what makes a retried unmatch
   * command replay its own outcome instead of failing as an invalid
   * transition — the same transport-retry problem a retried like has, and the
   * reason a double tap cannot produce two unmatches.
   */
  readonly idempotencyKey: IdempotencyKey | null;
}

export interface MatchRecord {
  readonly matchId: MatchId;
  /** Canonical order, so the pair has exactly one representation. */
  readonly participants: readonly [UserId, UserId];
  readonly likeIds: readonly [LikeId, LikeId];
  /**
   * One standing per participant, in `participants` order. The two entries are
   * equal only while both are `active`: when one party's view is degraded the
   * other party's is not, and a single status cannot say so. Neither entry is
   * ever removed, so a match cannot vanish from one party's list because of
   * the other party's standing.
   */
  readonly standings: readonly [MatchStanding, MatchStanding];
  readonly createdAt: Date;
  /** Cause of the end. `null` while the match is live; retained forever after. */
  readonly ended: MatchEnd | null;
  /** Assigned by Communication; dating only carries and retains the id. */
  readonly conversationId: ConversationId | null;
}

/** The standing one party sees, or `null` when they are not in this match. */
export function matchStandingFor(match: MatchRecord, viewer: UserId): MatchStanding | null {
  if (match.participants[0] === viewer) {
    return match.standings[0];
  }
  return match.participants[1] === viewer ? match.standings[1] : null;
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


export interface MatchAttempt {
  readonly actor: UserId;
  readonly counterpart: UserId;
  /** The like that triggered this attempt. */
  readonly like: LikeRecord;
  /** Ledger state after the like was recorded. */
  readonly ledger: LikeLedger;
  readonly blocks: readonly BlockRecord[];
  readonly passes: readonly PassRecord[];
  /** The clock the pass window is read against. */
  readonly at: Date;
  readonly conversationId?: ConversationId | null;
}

export type MatchResolution =
  | { readonly outcome: 'awaiting_counterpart'; readonly ledger: LikeLedger }
  | { readonly outcome: 'match_created'; readonly match: MatchRecord; readonly ledger: LikeLedger }
  | { readonly outcome: 'match_refused'; readonly reason: 'blocked' | 'passed' };

/**
 * The whole match-creation rule, as one pure function over two like records.
 * Order of evaluation is block, then pass, then reciprocity — the same order
 * the eligibility gate uses, so a candidate who cannot be seen also cannot
 * match.
 *
 * The pass test is `isPassInEffect` on the attempt's own clock: the same
 * definition discovery uses, so "a like can never lead to a pair discovery
 * would have refused" is a property of the code rather than of two agreeing
 * documents. A pass that has expired suppresses nobody, and a pass the liker has
 * since overridden with a like is not in effect. That is what makes "a like
 * after a pass still matches" true and "a match across the counterpart's live
 * pass" false — one rule, two directions, and the asymmetry is deliberate: one
 * person's like cannot speak for the other party's pass.
 */
export function resolveMatch(attempt: MatchAttempt): Result<MatchResolution, DomainError> {
  const { actor, counterpart, ledger, blocks, passes, at } = attempt;
  if (actor === counterpart) {
    return domainError('validation_failed', 'dating.interaction', 'a user cannot match themselves');
  }
  const triggeringLike = ledger.likes.find((entry) => entry.likeId === attempt.like.likeId);
  if (
    triggeringLike === undefined ||
    triggeringLike.from !== actor ||
    triggeringLike.to !== counterpart ||
    (triggeringLike.state !== 'live' && triggeringLike.state !== 'matched')
  ) {
    return domainError(
      'validation_failed',
      'dating.interaction',
      'the triggering like is not the actor’s live like of the counterpart',
    );
  }
  if (activeBlockBetween(actor, counterpart, blocks) !== null) {
    return ok({ outcome: 'match_refused', reason: 'blocked' });
  }
  const passedEitherWay = passes.some(
    (pass) =>
      isPassInEffect(pass, at) &&
      ((pass.from === actor && pass.to === counterpart) || (pass.from === counterpart && pass.to === actor)),
  );
  if (passedEitherWay) {
    return ok({ outcome: 'match_refused', reason: 'passed' });
  }
  const counterpartLike = currentLikeBetween(ledger, counterpart, actor);
  if (counterpartLike === null || counterpartLike.likeId === triggeringLike.likeId) {
    return ok({ outcome: 'awaiting_counterpart', ledger });
  }
  const [first, second] = canonicalPair(actor, counterpart);
  const orderedLikes: readonly [LikeId, LikeId] =
    triggeringLike.from === first
      ? [triggeringLike.likeId, counterpartLike.likeId]
      : [counterpartLike.likeId, triggeringLike.likeId];
  return ok({
    outcome: 'match_created',
    ledger: setLikeState(ledger, orderedLikes, 'matched'),
    match: {
      matchId: deriveMatchId(actor, counterpart),
      participants: [first, second],
      likeIds: orderedLikes,
      standings: ['active', 'active'],
      createdAt: triggeringLike.createdAt,
      ended: null,
      conversationId: attempt.conversationId ?? null,
    },
  });
}

export interface BlockOutcome {
  readonly match: MatchRecord;
  /** The pair's likes are withdrawn, not deleted: a block ends the interaction. */
  readonly ledger: LikeLedger;
}

/**
 * A block ends an open match, withdraws the pair's likes, and closes the match
 * under two different standings: the blocker closed it, and the blocked party
 * sees a counterpart who can no longer be reached — never who blocked them, and
 * never that a block happened. Precedence lives here, not in a UI check.
 */
export function applyBlockToMatch(
  block: BlockRecord,
  match: MatchRecord,
  ledger: LikeLedger,
  at: Date,
): Result<BlockOutcome, DomainError> {
  if (!match.participants.includes(block.blocker) || !match.participants.includes(block.blocked)) {
    return domainError('validation_failed', 'dating.interaction', 'block does not involve this match', {
      matchId: match.matchId,
    });
  }
  if (match.ended !== null) {
    return domainError('invalid_transition', 'dating.interaction', 'match is already ended', {
      cause: match.ended.cause,
    });
  }
  const blockerIsFirst = match.participants[0] === block.blocker;
  const standings: readonly [MatchStanding, MatchStanding] = blockerIsFirst
    ? ['closed_by_actor', 'closed_by_target']
    : ['closed_by_target', 'closed_by_actor'];
  return ok({
    match: {
      ...match,
      standings,
      ended: { cause: 'ended_by_block', actorId: 'system', at, idempotencyKey: null },
    },
    ledger: setLikeState(ledger, match.likeIds, 'withdrawn'),
  });
}

export interface ConversationDisposition {
  readonly conversationId: ConversationId;
  readonly state: 'open' | 'closed';
  /** Always true: an ended match keeps its conversation as evidence. */
  readonly retainedForEvidence: true;
}

export interface UnmatchCommand {
  readonly match: MatchRecord;
  readonly actor: UserId;
  readonly at: Date;
  /** Caller-supplied, so a transport retry is a no-op rather than an error. */
  readonly key: IdempotencyKey;
}

export interface UnmatchOutcome {
  readonly match: MatchRecord;
  /** The pair's likes are withdrawn, not deleted, for the same reason. */
  readonly ledger: LikeLedger;
  readonly conversation: ConversationDisposition | null;
}

/**
 * Either party may end a match. The match record is retained with both parties
 * standing at `closed_by_actor`, the likes between them are withdrawn rather
 * than deleted, and the conversation is closed but kept, so a report filed after
 * the unmatch still has its evidence attached and the pair is free to be decided
 * on again. A retry carrying the same idempotency key replays the same outcome;
 * a different key on an ended match is an error.
 */
export function unmatch(
  ledger: LikeLedger,
  command: UnmatchCommand,
): Result<UnmatchOutcome, DomainError> {
  const { match, actor, at, key } = command;
  const conversation: ConversationDisposition | null =
    match.conversationId === null
      ? null
      : { conversationId: match.conversationId, state: 'closed', retainedForEvidence: true };
  if (!match.participants.includes(actor)) {
    return domainError('permission_denied', 'dating.interaction', 'only a participant can unmatch', {
      matchId: match.matchId,
    });
  }
  if (match.ended !== null) {
    if (match.ended.cause === 'unmatched' && match.ended.idempotencyKey === key) {
      return ok({ match, ledger, conversation });
    }
    return domainError('invalid_transition', 'dating.interaction', 'match is already ended', {
      cause: match.ended.cause,
    });
  }
  return ok({
    match: {
      ...match,
      standings: ['closed_by_actor', 'closed_by_actor'],
      ended: { cause: 'unmatched', actorId: actor, at, idempotencyKey: key },
    },
    ledger: setLikeState(ledger, match.likeIds, 'withdrawn'),
    conversation,
  });
}

export interface ReportableRelation {
  readonly viewer: UserId;
  readonly subject: UserId;
  readonly likes: readonly LikeRecord[];
  readonly passes: readonly PassRecord[];
  /** Retained whatever the match's per-party standings are. */
  readonly match: MatchRecord | null;
  readonly blocks: readonly BlockRecord[];
}

export interface LikeEvidence {
  readonly likeId: LikeId;
  /** Why the like is not standing: this is the part that says what happened. */
  readonly state: LikeState;
}

export interface PassEvidence {
  readonly passId: PassId;
  readonly state: PassState;
}

export interface ReportEvidence {
  readonly likes: readonly LikeEvidence[];
  readonly passes: readonly PassEvidence[];
  readonly matchId: MatchId | null;
  readonly conversationId: ConversationId | null;
}

/**
 * The right to report is a property of the recorded relationship, not of its
 * current state. A relationship that existed cannot be un-existed by unmatching
 * it, by retracting a like, or by letting a pass expire, so every one of those
 * still yields a reportable subject — with each record's state attached, because
 * "they liked me and then withdrew it" and "we matched and then unmatched" are
 * different stories and the state is what tells them apart. The only thing that
 * makes a subject unreportable is that there was never any interaction at all.
 */
export function evidenceForReport(relation: ReportableRelation): Result<ReportEvidence, DomainError> {
  if (relation.viewer === relation.subject) {
    return domainError('validation_failed', 'dating.interaction', 'a user cannot report themselves');
  }
  const likes = relation.likes.map((like) => ({ likeId: like.likeId, state: like.state }));
  const passes = relation.passes.map((pass) => ({ passId: pass.passId, state: pass.state }));
  if (likes.length === 0 && passes.length === 0 && relation.match === null && relation.blocks.length === 0) {
    return domainError('not_found', 'dating.interaction', 'no recorded interaction with this user');
  }
  return ok({
    likes,
    passes,
    matchId: relation.match?.matchId ?? null,
    conversationId: relation.match?.conversationId ?? null,
  });
}
