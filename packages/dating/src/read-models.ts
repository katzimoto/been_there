import type { AccountState, IdentityState, PhotoId, UserId } from '@been-there/core';
import type { BlockRecord } from './blocks.js';
import type { LikeRecord, MatchRecord, PassRecord } from './interaction.js';
import type { DistanceBand } from './location.js';
import type { DatingPreferences } from './preferences.js';
import type { GenderIdentity, ProfileSnapshot } from './profile.js';

/**
 * Read models this domain publishes for others to read (commitment 6).
 *
 * These are the *only* way another domain learns anything about identity
 * standing, account standing or blocks. Dating Core never imports, calls or
 * mirrors another domain's internals: it consumes their published projections
 * and publishes its own, and each projection carries the version it was built
 * at so a consumer can refuse a shape it does not understand instead of
 * silently misreading it.
 */

export const DATING_READ_MODEL_VERSION = 1;
export const STANDING_PROJECTION_VERSION = 1;

/** Built from `identity_status.changed` (public). No evidence, ever. */
export interface IdentityStandingProjection {
  readonly projectionVersion: number;
  readonly state: IdentityState;
  /** Increments on every re-verification; a bump invalidates cached eligibility. */
  readonly generation: number;
}

/**
 * Built from `account_state.changed` (public). It carries the capability set
 * and nothing else: a dating client must not be able to infer that a user was
 * reported, reviewed or restricted, so the reason for the standing is not in
 * this projection and never will be.
 */
export interface AccountStandingProjection {
  readonly projectionVersion: number;
  readonly state: AccountState;
  readonly capabilities: readonly string[];
  readonly visibleInProduct: boolean;
}

/** Everything eligibility needs to know about one user. */
export interface SubjectStandingProjection {
  readonly userId: UserId;
  readonly profile: ProfileSnapshot;
  readonly identity: IdentityStandingProjection;
  readonly account: AccountStandingProjection;
  readonly preferences: DatingPreferences;
}

export interface BlockListProjection {
  readonly blocks: readonly BlockRecord[];
}

export interface InteractionLedgerProjection {
  readonly likes: readonly LikeRecord[];
  readonly passes: readonly PassRecord[];
}

export interface MatchProjection {
  readonly match: MatchRecord | null;
}

/** The pairwise view the gate consumes, assembled from the three above. */
export interface RelationshipProjection {
  readonly blocks: readonly BlockRecord[];
  readonly likes: readonly LikeRecord[];
  readonly passes: readonly PassRecord[];
  readonly match: MatchRecord | null;
}

/**
 * A discovery card. `distance` is a coarse band, never metres and never a
 * coordinate. Cards are viewer-scoped: `distance` is the separation from the
 * viewer this page was rendered for.
 */
export interface CandidateCardProjection {
  readonly projectionVersion: number;
  readonly userId: UserId;
  readonly displayName: string;
  readonly age: number;
  readonly genderIdentities: readonly GenderIdentity[];
  readonly bio: string;
  readonly photoIds: readonly PhotoId[];
  readonly distance: DistanceBand;
}

/**
 * The projection discovery and messaging read. Versioned as a whole, because a
 * consumer that has not been rebuilt against a new version must see a
 * `unsupported_version` refusal rather than a mis-parsed card.
 */
export interface DatingReadModel {
  readonly version: number;
  standingFor(userId: UserId): SubjectStandingProjection | null;
  cardFor(viewerId: UserId, candidateId: UserId): CandidateCardProjection | null;
  relationshipFor(a: UserId, b: UserId): RelationshipProjection;
}
