import type { AccountState, IdentityState, PhotoId, UserId } from '@been-there/core';
import type { BlockRecord } from './blocks.js';
import type { LikeRecord } from './likes.js';
import type { MatchRecord, MatchStanding } from './interaction.js';
import type { DistanceBand } from './location.js';
import type { PassRecord } from './passes.js';
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

/**
 * The vocabulary every standing is read through. These four names are the whole
 * of what this domain knows about another domain's state: an identity state, a
 * capability set and a product-visibility bit. It never learns a *reason* — not
 * that somebody was reported, reviewed or restricted — because a projection
 * that carried one would turn a dating client into a moderation surface.
 */
export const DISCOVERABLE_IDENTITY_STATE: IdentityState = 'verified';
export const BROWSE_DISCOVERY_CAPABILITY = 'browse_discovery';
export const LIKE_CAPABILITY = 'like';
export const MESSAGE_CAPABILITY = 'send_message';

/** Built from `identity.status_changed` (public). No evidence, ever. */
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

/** The pairwise view the gate consumes, derived from the three projections above. */
export interface RelationshipProjection {
  readonly blocks: readonly BlockRecord[];
  readonly likes: readonly LikeRecord[];
  readonly passes: readonly PassRecord[];
  readonly match: MatchRecord | null;
}

/**
 * The one question a read of this pair must be able to answer about a user,
 * resolved against the projections as they stand *now*.
 */
export type StandingLookup = (user: UserId) => SubjectStandingProjection | null;

/**
 * Assembles that view from the three projections, so the gate can never see a
 * relationship assembled by two different code paths that disagree about the
 * same pair.
 *
 * The match it carries is re-derived, not passed through: `MatchRecord.standings`
 * is written when the match is created and when it ends, and a counterpart who
 * was restricted or removed afterwards must degrade their party's row without
 * anyone writing to the match. Reading through this function is therefore the
 * only way to get a standing, which is what keeps the degraded rows reachable
 * rather than documented.
 */
export function relationshipView(
  blocks: BlockListProjection,
  ledger: InteractionLedgerProjection,
  match: MatchProjection,
  standingOf: StandingLookup,
): RelationshipProjection {
  return {
    blocks: blocks.blocks,
    likes: ledger.likes,
    passes: ledger.passes,
    match: match.match === null ? null : { ...match.match, standings: deriveMatchStandings(match.match, standingOf) },
  };
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

/**
 * The standing each party sees of one match, recomputed from the two current
 * standing projections.
 *
 * This is the rule that makes commitment 1 and the moderation model legible
 * without a lost row: a counterpart whose verification lapsed degrades *their*
 * party's view only, and the other party is untouched. A single status on the
 * record could not express that, and an implementation that filtered a match
 * list by the target's current standing would make a moderated removal look
 * identical to a mutual unmatch.
 *
 * Every branch reads a capability or a visibility bit, never a reason, so a
 * `restricted_by_target` line can name the capability that is missing without
 * ever naming the case that removed it. An end outranks a degradation: once a
 * match is closed, a standing change does not reopen it.
 *
 * `relationshipView` is the caller: it is the only path that assembles a
 * relationship for a reader, so this rule runs on every read rather than only
 * when a match happens to be written.
 */
export function deriveMatchStandings(
  match: MatchRecord,
  standingOf: StandingLookup,
): readonly [MatchStanding, MatchStanding] {
  if (match.standings.some((standing) => CLOSED_STANDINGS[standing])) {
    return match.standings;
  }
  const [first, second] = match.participants;
  const firstStanding = standingOf(first);
  const secondStanding = standingOf(second);
  if (firstStanding === null || secondStanding === null) {
    // A participant with no standing projection is a gap in the read model
    // rather than an expected domain outcome, so it is not a DomainError.
    throw new RangeError('deriveMatchStandings: standingOf must resolve both participants');
  }
  return [standingOfTarget(secondStanding), standingOfTarget(firstStanding)];
}

const CLOSED_STANDINGS: Readonly<Record<MatchStanding, boolean>> = {
  active: false,
  dormant_target_unverified: false,
  restricted_by_target: false,
  closed_by_target: true,
  closed_by_actor: true,
};

/** The standing a party sees, given the other party's standing alone. */
function standingOfTarget(counterpart: SubjectStandingProjection): MatchStanding {
  if (
    !counterpart.account.visibleInProduct ||
    !counterpart.account.capabilities.includes(BROWSE_DISCOVERY_CAPABILITY)
  ) {
    return 'closed_by_target';
  }
  if (counterpart.identity.state !== DISCOVERABLE_IDENTITY_STATE) {
    return 'dormant_target_unverified';
  }
  if (!counterpart.account.capabilities.includes(MESSAGE_CAPABILITY)) {
    return 'restricted_by_target';
  }
  return 'active';
}
