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
/**
 * The counterparty's standing, reduced to the one fact the send gate needs.
 *
 * `docs/features/account-restrictions-and-reverification.md` §8.4 promises a
 * *symmetric* refusal — a restricted account has the composer disabled not
 * only for itself but for the person it is talking to, so a restriction can
 * neither be probed nor used to make a counterpart look unreliable. Answering
 * that needs the far side of the conversation, and this is all of it that
 * crosses over.
 *
 * **Why one bit and not a `CapabilityProjection`.** A capability set is a
 * many-to-one *consequence* of an account state, but not a constant function
 * of it: `banned` grants `appeal_request` and `delete_account` while `limited`
 * does not, and `suspended` differs from `limited` in `browse_discovery`.
 * Handing that set across would let the transport tell a banned peer from a
 * limited one — the profile-reachability leak of §8.5, and the reason-reading
 * leak that the capability projection above exists to prevent in the first
 * place. A single boolean collapses `limited`, `suspended` and `banned` into
 * one answer, so a sender learns *that* the conversation is closed to them and
 * cannot learn why, or in what state the other person is.
 *
 * **The clearance it carries is none.** This is not a subscription to another
 * domain's events and not a read of an account record: it is an argument,
 * computed at the boundary by whoever holds moderation's capability
 * projection, about a conversation the sender already participates in. No
 * account state, no case id, no reason, no timestamp, no history — so there is
 * nothing here to escalate, and nothing a moderation clearance could reach.
 *
 * The field on `CommunicationDependencies` is required rather than optional
 * for the same reason `blocking` is: absent is exactly the shape that would
 * default to "allowed".
 */
export interface PeerStanding {
  readonly userId: UserId;
  readonly canSendMessages: boolean;
}

export interface CommunicationDependencies {
  readonly match: MatchProjection;
  readonly blocking: BlockingReadModel;
  readonly senderStanding: CapabilityProjection;
  /**
   * Required, never optional: see above. The send gate refuses when it cannot
   * identify the counterparty this projection claims to describe, so a caller
   * cannot forget it.
   */
  readonly peerStanding: PeerStanding;
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
