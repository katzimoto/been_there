import {
  type DomainError,
  type IdentityState,
  type Result,
  type UserId,
  domainError,
  ok,
} from '@been-there/core';
import { type BlockRecord, activeBlockBetween } from './blocks.js';
import type { LikeId, PassId } from './ids.js';
import { type NewPass, type PassRecord, isPassInEffect } from './passes.js';
import type { ProfileState } from './profile.js';
import { DISCOVERABLE_IDENTITY_STATE, LIKE_CAPABILITY } from './read-models.js';

/**
 * The like ledger (issue #4, #12).
 *
 * Two properties are load-bearing here and are modelled as data rather than as
 * application discipline:
 *
 *  1. **Idempotence.** A like is a fact about the ordered pair (from, to), not
 *     about a request. Recording the same like twice is a no-op, and a second
 *     like id for the same pair is a conflict rather than a second record, so
 *     a retried request can never inflate a like count or a match.
 *
 *  2. **Nothing that happened is un-happened.** A retracted like is a *state* on
 *     a retained record. Nothing here deletes a row, because a deleted row is a
 *     relationship that can no longer be reported, and commitment 4 makes the
 *     right to report a property of what happened rather than of what survives.
 *
 *  3. **Preconditions are re-read at action time.** `recordLike` takes the two
 *     standings and the block edges as arguments, so "you cannot like after
 *     your verification lapsed" is a guard somebody can delete rather than a
 *     comment somebody can forget. A card served five minutes ago is not a
 *     licence to act on.
 */

/** What a like is now. Every value is a fact, and none of them is a deletion. */
export type LikeState =
  /** The liker's current decision; the only state that can become a match. */
  | 'live'
  /** Retracted before a match, overtaken by a later pass, or killed by a block or an unmatch. */
  | 'withdrawn'
  /** The pair became a match; the like is a historical fact of that match. */
  | 'matched';

/** What a caller supplies; the state and the pass link are derived by `recordLike`. */
export interface NewLike {
  readonly likeId: LikeId;
  readonly from: UserId;
  readonly to: UserId;
  readonly createdAt: Date;
}

export interface LikeRecord extends NewLike {
  readonly state: LikeState;
  /** The liker's own pass that this like overrode, if any. Never the counterpart's. */
  readonly supersededPassId: PassId | null;
}

/** A like that still counts: the liker's current decision, or the match's. */
export function isCurrentLike(like: LikeRecord): boolean {
  return like.state === 'live' || like.state === 'matched';
}

export function isMutualLike(like: LikeRecord | null, counterpartLike: LikeRecord | null): boolean {
  return (
    like !== null &&
    counterpartLike !== null &&
    isCurrentLike(like) &&
    isCurrentLike(counterpartLike) &&
    like.from !== like.to &&
    like.from === counterpartLike.to &&
    like.to === counterpartLike.from &&
    like.likeId !== counterpartLike.likeId
  );
}

export interface LikeLedger {
  readonly likes: readonly LikeRecord[];
}

export const EMPTY_LEDGER: LikeLedger = { likes: [] };

/**
 * The like that still stands for this ordered pair: a live one, or the one that
 * became the match. A withdrawn like is history and counts for nothing, which is
 * why the two never collide in a lookup.
 */
export function currentLikeBetween(ledger: LikeLedger, from: UserId, to: UserId): LikeRecord | null {
  return ledger.likes.find((entry) => isCurrentLike(entry) && entry.from === from && entry.to === to) ?? null;
}

/**
 * The minimum a like action reads about one party, taken fresh at action time.
 * A `SubjectStandingProjection` satisfies this structurally, so a caller passes
 * the projection it already holds rather than a copy shaped like one.
 */
export interface ActionStanding {
  readonly identity: { readonly state: IdentityState };
  readonly profile: { readonly state: ProfileState };
  readonly account: { readonly capabilities: readonly string[]; readonly visibleInProduct: boolean };
}

export interface LikeActionContext {
  readonly actor: ActionStanding;
  readonly target: ActionStanding;
  readonly blocks: readonly BlockRecord[];
  /** Current passes, so a like that overrides one can record which. */
  readonly passes: readonly PassRecord[];
  readonly at: Date;
}

/**
 * Records a like, after re-reading every precondition that could have changed
 * since the candidate's card was served.
 *
 * Actor-side failures are reported honestly, because the actor is being told
 * about their own state and hiding it would only strand them. Target-side
 * failures are one indistinguishable refusal, because a liker who can tell a
 * block from an absence has learned something they must not learn.
 */
export function recordLike(
  ledger: LikeLedger,
  like: NewLike,
  context: LikeActionContext,
): Result<LikeLedger, DomainError> {
  const { actor, target, blocks, passes, at } = context;
  if (like.from === like.to) {
    return domainError('validation_failed', 'dating.interaction', 'a user cannot like themselves');
  }
  if (
    actor.identity.state !== DISCOVERABLE_IDENTITY_STATE ||
    !actor.account.capabilities.includes(LIKE_CAPABILITY) ||
    actor.profile.state !== 'complete'
  ) {
    return domainError('permission_denied', 'dating.interaction', 'you cannot like right now', {
      identityState: actor.identity.state,
      profileState: actor.profile.state,
    });
  }
  if (
    target.identity.state !== DISCOVERABLE_IDENTITY_STATE ||
    target.profile.state !== 'complete' ||
    !target.account.visibleInProduct ||
    !target.account.capabilities.includes(LIKE_CAPABILITY) ||
    activeBlockBetween(like.from, like.to, blocks) !== null
  ) {
    return domainError('not_eligible', 'dating.interaction', 'this person is not available');
  }
  const existing = currentLikeBetween(ledger, like.from, like.to);
  if (existing !== null) {
    if (existing.likeId === like.likeId) {
      return ok(ledger);
    }
    if (existing.state === 'matched') {
      // The pair is already matched, so the like is on record and the liker is
      // told exactly that, rather than being handed a conflict for tapping twice.
      return ok(ledger);
    }
    return domainError('conflict', 'dating.interaction', 'this pair already has a like', {
      from: like.from,
      to: like.to,
    });
  }
  const superseded = passes.find(
    (pass) => isPassInEffect(pass, at) && pass.from === like.from && pass.to === like.to,
  );
  const record: LikeRecord = { ...like, state: 'live', supersededPassId: superseded?.passId ?? null };
  return ok({ likes: [...ledger.likes, record] });
}

/**
 * Retraction, not erasure. The row stays and its state becomes `withdrawn`, so
 * the pair remains reportable and the liker's own later like is a new decision
 * rather than an amendment of this one. Retracting an already-withdrawn like
 * returns the same ledger.
 */
export function withdrawLike(ledger: LikeLedger, likeId: LikeId): LikeLedger {
  if (!ledger.likes.some((entry) => entry.likeId === likeId && entry.state !== 'withdrawn')) {
    return ledger;
  }
  return {
    likes: ledger.likes.map((entry) =>
      entry.likeId === likeId ? { ...entry, state: 'withdrawn' } : entry,
    ),
  };
}

/**
 * Moves named likes to another state, keeping every row. Three callers, one rule.
 */
export function setLikeState(ledger: LikeLedger, likeIds: readonly LikeId[], state: LikeState): LikeLedger {
  return {
    likes: ledger.likes.map((entry) => (likeIds.includes(entry.likeId) ? { ...entry, state } : entry)),
  };
}

export interface PassOutcome {
  readonly ledger: LikeLedger;
  readonly passes: readonly PassRecord[];
}

/**
 * Records a pass, which withdraws the passer's own live like over the same
 * person: a pass is the later decision, so it is the one that stands. The like
 * is withdrawn rather than deleted, so a report about the pair can still see
 * that a like was given and then overtaken.
 *
 * Idempotent in the same shape `recordLike` is: the same pass id for the same
 * ordered pair is a replayed request and changes nothing, and a second id for a
 * pair that already has a live pass is a client bug.
 */
export function recordPass(
  ledger: LikeLedger,
  passes: readonly PassRecord[],
  pass: NewPass,
): Result<PassOutcome, DomainError> {
  if (pass.from === pass.to) {
    return domainError('validation_failed', 'dating.interaction', 'a user cannot pass on themselves');
  }
  const existing = passes.find((entry) => entry.state === 'live' && entry.from === pass.from && entry.to === pass.to);
  if (existing !== undefined) {
    if (existing.passId === pass.passId) {
      return ok({ ledger, passes });
    }
    return domainError('conflict', 'dating.interaction', 'this pair already has a live pass', {
      from: pass.from,
      to: pass.to,
    });
  }
  const record: PassRecord = { ...pass, state: 'live' };
  const overtaken = currentLikeBetween(ledger, pass.from, pass.to);
  return ok({
    ledger: overtaken === null ? ledger : setLikeState(ledger, [overtaken.likeId], 'withdrawn'),
    passes: [...passes, record],
  });
}
