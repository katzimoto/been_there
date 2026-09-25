import { castId } from '@been-there/core';

/**
 * Ids this domain owns. The shared kernel brands the ids it models
 * (`MatchId`, `ProfileId`, …) and deliberately has no like, pass or block
 * concept, so it cannot brand them. The same discipline is applied here: one
 * construction point, ids that are not interchangeable, and a single cast in
 * one place instead of at every call site.
 */

declare const brand: unique symbol;
type Brand<B extends string> = string & { readonly [brand]: B };

export type LikeId = Brand<'LikeId'>;
export type PassId = Brand<'PassId'>;
export type BlockId = Brand<'BlockId'>;

/** The only way a dating-owned id comes into existence. */
export function castDatingId<T extends string>(value: string): Brand<T> {
  return castId<T>(value) as unknown as Brand<T>;
}
