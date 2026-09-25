import type { ConversationId, MatchId, UserId } from '@been-there/core';

/**
 * Cross-domain *inputs* to communication (issue #5).
 *
 * Communication never imports another domain's `src/`. Everything it needs to
 * make a permission decision arrives as a published, versioned projection:
 * the match projection is written by Dating Core, the block edges and the
 * capability projection by Moderation & Enforcement. If a projection is wrong
 * the projection is wrong — this domain cannot repair it and must not try.
 */

export type MatchState = 'active' | 'unmatched';

export interface MatchProjection {
  readonly matchId: MatchId;
  /** Dating Core decides the 1:1 conversation binding at match time. */
  readonly conversationId: ConversationId;
  readonly participants: readonly [UserId, UserId];
  readonly state: MatchState;
  readonly matchedAt: Date;
}

/**
 * A block is a *user* safety action, not enforcement: it is unilateral,
 * immediate, and requires no case. Lifting one is a normal product event, not
 * a moderation decision, which is why the edge records `liftedAt` instead of a
 * case id.
 */
export interface BlockEdge {
  readonly blockerId: UserId;
  readonly blockedId: UserId;
  readonly appliedAt: Date;
  readonly liftedAt: Date | null;
}

/** Read side of the block ledger. Symmetric and directional views are separate. */
export interface BlockingReadModel {
  /** True when an un-lifted block exists in either direction. */
  isBlockedEitherWay(a: UserId, b: UserId): boolean;
  /** True when `blockerId` currently blocks `blockedId`. */
  isBlockedBy(blockerId: UserId, blockedId: UserId): boolean;
}

/**
 * The moderation-owned account standing, projected as a capability set. The
 * product reacts to capabilities, never to the reason a capability was removed,
 * so a user can never infer that they were reported or reviewed.
 */
export interface CapabilityProjection {
  readonly userId: UserId;
  readonly capabilities: readonly string[];
}

export interface CommunicationDependencies {
  readonly match: MatchProjection;
  readonly blocking: BlockingReadModel;
  readonly senderStanding: CapabilityProjection;
}

/**
 * Builds the read view from the block ledger. A projection constructor, not a
 * store: the ledger itself belongs to moderation, and this is the only shape
 * communication is allowed to hold.
 */
export function activeBlockView(edges: readonly BlockEdge[]): BlockingReadModel {
  const active = edges.filter((edge) => edge.liftedAt === null);
  return {
    isBlockedEitherWay: (a, b) =>
      active.some(
        (edge) =>
          (edge.blockerId === a && edge.blockedId === b) ||
          (edge.blockerId === b && edge.blockedId === a),
      ),
    isBlockedBy: (blockerId, blockedId) =>
      active.some((edge) => edge.blockerId === blockerId && edge.blockedId === blockedId),
  };
}
