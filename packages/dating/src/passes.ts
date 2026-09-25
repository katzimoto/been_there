import type { UserId } from '@been-there/core';
import type { PassId } from './ids.js';

/**
 * Passes — the "do not show me this person again" decision (issue #4, #12).
 *
 * A pass is a soft hide, not a veto, and three things follow from that:
 *
 *  1. **It expires.** Suppression is a window, not a tombstone. A pass made on
 *     a bad day cannot remove a person from a pool permanently, so a decision
 *     that cannot be reviewed by the person who made it does not get to be
 *     permanent. Thirty days is the window both feature specs name.
 *  2. **The same user can override it.** A like is an affirmative act, so it
 *     supersedes the liker's own pass over that person and nothing else — one
 *     person's like cannot speak for the other party's pass.
 *  3. **It never reaches a match.** `resolveMatch` refuses while a pass is in
 *     effect in either direction, so an in-effect pass is exactly a suppressed
 *     candidate, and the two rules are the same rule read at two moments.
 *
 * The record is retained whatever becomes of it. A superseded or expired pass
 * is a historical fact about a pair and is reportable evidence, exactly like a
 * withdrawn like.
 */

export const PASS_SUPPRESSION_DAYS = 30;

const DAY_MS = 86_400_000;

export type PassState = 'live' | 'superseded';

export interface PassRecord {
  readonly passId: PassId;
  readonly from: UserId;
  readonly to: UserId;
  readonly createdAt: Date;
  /** `superseded` once the same user liked the person they had passed. */
  readonly state: PassState;
}

/** The instant suppression ends: `createdAt` plus the window. */
export function passSuppressesUntil(pass: PassRecord): Date {
  return new Date(pass.createdAt.getTime() + PASS_SUPPRESSION_DAYS * DAY_MS);
}

/**
 * A pass suppresses while it is `live` and the clock has not reached the end of
 * its window. The boundary is one-sided and deliberate: the end instant is
 * already outside the window, so day 30 and day 31 cannot both be "still
 * suppressed" and the acceptance scenario needs no epsilon to be true.
 */
export function isPassInEffect(pass: PassRecord, at: Date): boolean {
  return pass.state === 'live' && at.getTime() < passSuppressesUntil(pass).getTime();
}

export function passesInEffect(passes: readonly PassRecord[], at: Date): readonly PassRecord[] {
  return passes.filter((pass) => isPassInEffect(pass, at));
}

export function supersedePasses(
  passes: readonly PassRecord[],
  liker: UserId,
  target: UserId,
): readonly PassRecord[] {
  return passes.map((pass) =>
    pass.state === 'live' && pass.from === liker && pass.to === target
      ? { ...pass, state: 'superseded' }
      : pass,
  );
}
