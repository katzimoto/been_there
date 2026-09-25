import {
  type IdentityRecord,
  type IdentityState,
  type SubjectId,
  isDiscoverableIdentity,
} from '@been-there/core';

/**
 * The one thing other domains may read about identity (issue #3).
 *
 * This file is the whole cross-domain surface of the identity domain, and it is
 * intentionally small. Everything a dating card, a discovery filter, or a
 * messaging permission check needs is here; nothing that could help someone
 * build a fingerprint of a person's identity history is.
 *
 * What is deliberately absent, and why:
 *
 *  - no confidence, no band, no threshold: a consumer could use it to re-rank
 *    people by how "verifiable" they look, which is a discrimination surface;
 *  - no evidence references, no provider labels, no provider reasons: those
 *    leak both the vendor and the person;
 *  - no anomaly codes: a dating client that knows "this account tripped a reuse
 *    signal" is a dating client that can act on it, and the safety spine
 *    promises it cannot;
 *  - no `latestVerificationId`: the overview's forbidden table names this field
 *    by name. A consumer that can join to the attempt table has left the
 *    boundary, whatever the type says.
 *
 * `IdentityStatusProjection` is a projection, versioned, and rebuilt from the
 * identity record on every change — it is a cache of one boolean and a state,
 * not a read model that accumulates history.
 */

export const IDENTITY_PROJECTION_VERSION = 1;

export interface IdentityStatusProjection {
  readonly projectionVersion: typeof IDENTITY_PROJECTION_VERSION;
  readonly subjectId: SubjectId;
  readonly state: IdentityState;
  /**
   * Monotonic. Increments on every state change so a consumer holding a stale
   * copy can tell that it is stale without comparing timestamps.
   */
  readonly generation: number;
  /**
   * Derived from the kernel's own predicate, so "discoverable" has exactly one
   * definition in the system. Always equal to
   * `isDiscoverableIdentity(toIdentityRecord(projection))`.
   */
  readonly discoverable: boolean;
  readonly updatedAt: Date;
}

/**
 * Projects the internal identity record into the public shape.
 *
 * This is the only construction site, which is what makes the omission
 * guarantees above checkable: a new internal field cannot reach a consumer
 * without a deliberate edit here, and that edit is a review.
 */
export function projectIdentityStatus(
  record: IdentityRecord,
  subjectId: SubjectId,
  updatedAt: Date,
): IdentityStatusProjection {
  return {
    projectionVersion: IDENTITY_PROJECTION_VERSION,
    subjectId,
    state: record.state,
    generation: record.generation,
    discoverable: isDiscoverableIdentity(record),
    updatedAt,
  };
}

/**
 * Rebuilds a kernel `IdentityRecord` from the projection so a consumer can use
 * the shared `isDiscoverableIdentity` predicate directly.
 *
 * `latestVerificationId` is nulled rather than omitted because
 * `isDiscoverableIdentity` does not read it. Carrying the real value would be
 * the exact leak the overview forbids; omitting the field would be a lie about
 * the kernel's type.
 */
export function toIdentityRecord(projection: IdentityStatusProjection): IdentityRecord {
  return {
    state: projection.state,
    latestVerificationId: null,
    generation: projection.generation,
  };
}

/** Generation changes only when the state changes. */
export function hasProjectionChanged(
  previous: IdentityStatusProjection | null,
  next: IdentityStatusProjection,
): boolean {
  return previous === null || previous.generation !== next.generation;
}
