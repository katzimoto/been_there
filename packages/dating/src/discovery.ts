import type { UserId } from '@been-there/core';
import { activeBlockBetween } from './blocks.js';
import { currentLikeBetween } from './interaction.js';
import { type DistanceBand, isWithinDistanceLimit } from './location.js';
import { isPassInEffect } from './passes.js';
import { areMutuallyCompatible, type CompatibilitySide } from './preferences.js';
import {
  BROWSE_DISCOVERY_CAPABILITY,
  DATING_READ_MODEL_VERSION,
  DISCOVERABLE_IDENTITY_STATE,
  LIKE_CAPABILITY,
  type CandidateCardProjection,
  type DatingReadModel,
  type RelationshipProjection,
  type SubjectStandingProjection,
} from './read-models.js';

/**
 * Discovery eligibility — the central gate of this domain (commitment 1).
 *
 * Shape of the rule: a deny-list evaluated in a fixed priority order, first
 * match wins. A candidate is shown to a viewer only when no rule fires, so
 * adding a new disqualifying condition is one table entry rather than a new
 * `if` in a query builder, and "why was this person not shown?" has exactly
 * one answer per request instead of one per code path.
 *
 * Order rationale: safety and legality first (is the viewer allowed to browse
 * at all, is the candidate a verified person, is the candidate visible to the
 * product, can the candidate act on what they are shown), then the
 * relationship layer (block, then self, then anything the viewer already
 * decided), then preference filters. Preference rules come last because they are
 * the only ones that can change without anyone being unsafe: a preference change
 * is a product decision, a standing change is not.
 *
 * The gate is a function of the clock as well as of the snapshot, because a pass
 * is a window rather than a tombstone. A snapshot without a time cannot answer
 * "is this pass still in effect", which is why `now` is a required field rather
 * than a call to the system clock: a page that quietly reads the wall clock is a
 * page whose behaviour cannot be reproduced from a test.
 *
 * The reason codes are `internal`. They are diagnostic, never rendered, and a
 * user is told "no new people right now" rather than which rule fired — the
 * reason set must not become a side channel for inferring another user's
 * identity state, account standing or block.
 */

export type EligibilityReason =
  | 'viewer_identity_not_verified'
  | 'viewer_lacks_discovery_capability'
  | 'viewer_profile_not_complete'
  | 'candidate_identity_not_verified'
  | 'candidate_profile_not_complete'
  | 'candidate_account_not_visible'
  | 'candidate_cannot_reciprocate'
  | 'blocked'
  | 'self_view'
  | 'already_passed'
  | 'already_liked'
  | 'already_matched'
  | 'age_out_of_range'
  | 'gender_out_of_scope'
  | 'beyond_distance_limit'
  | 'not_mutually_compatible';

export type EligibilityDecision =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: EligibilityReason };

export interface DiscoverySnapshot {
  readonly viewer: SubjectStandingProjection;
  readonly candidate: SubjectStandingProjection;
  readonly relationship: RelationshipProjection;
  /** Coarse separation, resolved by the platform bucketing rule. */
  readonly distance: DistanceBand | null;
  /** The clock the pass window is read against. */
  readonly now: Date;
}

export interface EligibilityRule {
  readonly reason: EligibilityReason;
  readonly disqualifies: (snapshot: DiscoverySnapshot) => boolean;
}

function compatibilitySide(subject: SubjectStandingProjection): CompatibilitySide {
  return {
    age: subject.profile.age,
    genderIdentities: subject.profile.genderIdentities,
    preferences: subject.preferences,
  };
}

/**
 * Every disqualifying condition, in priority order. Nothing else may exclude a
 * candidate: if a reason is not in this table, it is not a rule.
 */
export const ELIGIBILITY_RULES: readonly EligibilityRule[] = [
  {
    reason: 'viewer_identity_not_verified',
    disqualifies: (s) => s.viewer.identity.state !== DISCOVERABLE_IDENTITY_STATE,
    // note: serving discovery to an unverified viewer is the leak commitment 1 forbids.
  },
  {
    reason: 'viewer_lacks_discovery_capability',
    disqualifies: (s) => !s.viewer.account.capabilities.includes(BROWSE_DISCOVERY_CAPABILITY),
  },
  {
    reason: 'viewer_profile_not_complete',
    disqualifies: (s) => s.viewer.profile.state !== 'complete',
  },
  {
    reason: 'candidate_identity_not_verified',
    disqualifies: (s) => s.candidate.identity.state !== DISCOVERABLE_IDENTITY_STATE,
    // note: unconditional and first among candidate rules — no preference, standing
    // or relationship state may make an unverified user discoverable.
  },
  {
    reason: 'candidate_profile_not_complete',
    disqualifies: (s) => s.candidate.profile.state !== 'complete',
  },
  {
    reason: 'candidate_account_not_visible',
    disqualifies: (s) =>
      !s.candidate.account.visibleInProduct ||
      !s.candidate.account.capabilities.includes(BROWSE_DISCOVERY_CAPABILITY),
  },
  {
    reason: 'candidate_cannot_reciprocate',
    // note: a separate rule from visibility, because the two are separate facts
    // and a card they cannot act on is a page slot spent for nothing. It is kept
    // ahead of every relational rule so a viewer is never offered a decision the
    // candidate is not allowed to make.
    disqualifies: (s) => !s.candidate.account.capabilities.includes('like'),
  },
  {
    reason: 'blocked',
    disqualifies: (s) =>
      activeBlockBetween(s.viewer.userId, s.candidate.userId, s.relationship.blocks) !== null,
  },
  { reason: 'self_view', disqualifies: (s) => s.viewer.userId === s.candidate.userId },
  {
    reason: 'already_passed',
    disqualifies: (s) =>
      s.relationship.passes.some(
        (pass) =>
          isPassInEffect(pass, s.now) && pass.from === s.viewer.userId && pass.to === s.candidate.userId,
      ),
  },
  {
    reason: 'already_liked',
    disqualifies: (s) =>
      currentLikeBetween({ likes: s.relationship.likes }, s.viewer.userId, s.candidate.userId) !== null,
  },
  {
    reason: 'already_matched',
    // note: an unmatched or block-ended match does not block rediscovery; only a live
    // match does, because the two people are already in each other's inbox.
    disqualifies: (s) => s.relationship.match?.ended === null,
  },
  {
    reason: 'age_out_of_range',
    // note: the viewer's own filter. The mutual test below additionally requires
    // both sides to agree, but a viewer's own range is not up for negotiation.
    disqualifies: (s) => {
      const range = s.viewer.preferences.ageRange;
      const age = s.candidate.profile.age;
      if (range === null || age === null) {
        return false;
      }
      return age < range.min || age > range.max;
    },
  },
  {
    reason: 'gender_out_of_scope',
    // note: the viewer's own `seekingGenders` list is a filter on their own page,
    // exactly like the age range. The mutual test below adds the candidate's own
    // `openTo`, which is a different question and the only one that can end a match.
    disqualifies: (s) => {
      const seeking = s.viewer.preferences.seekingGenders;
      if (seeking === null) {
        return false;
      }
      return !s.candidate.profile.genderIdentities.some((identity) => seeking.includes(identity));
    },
  },
  {
    reason: 'beyond_distance_limit',
    disqualifies: (s) => !isWithinDistanceLimit(s.distance ?? 'unknown', s.viewer.preferences.maxDistanceKm),
  },
  {
    reason: 'not_mutually_compatible',
    disqualifies: (s) =>
      !areMutuallyCompatible(compatibilitySide(s.viewer), compatibilitySide(s.candidate), s.distance)
        .compatible,
  },
];

/**
 * Pure gate over a read-model snapshot. The candidate's verified identity is
 * re-checked after the table rather than being trusted to rule 4 alone: if a
 * future edit dropped or reordered that rule, the eligible branch would still
 * be unreachable for a non-verified candidate. `rules` is injectable only so
 * that this property is testable; production callers use the table.
 */
export function evaluateEligibility(
  snapshot: DiscoverySnapshot,
  rules: readonly EligibilityRule[] = ELIGIBILITY_RULES,
): EligibilityDecision {
  for (const rule of rules) {
    if (rule.disqualifies(snapshot)) {
      return { eligible: false, reason: rule.reason };
    }
  }
  if (snapshot.candidate.identity.state !== DISCOVERABLE_IDENTITY_STATE) {
    return { eligible: false, reason: 'candidate_identity_not_verified' };
  }
  return { eligible: true };
}

/**
 * What discovery actually serves. Unranked and in the order the candidate
 * store returned: eligibility is a filter, and choosing an order is a ranking
 * decision that is not made here (see open questions in the design doc).
 */
export function selectEligibleCards(
  viewerId: UserId,
  model: DatingReadModel,
  candidateIds: readonly UserId[],
  at: Date,
): CandidateCardProjection[] {
  if (model.version !== DATING_READ_MODEL_VERSION) {
    // A consumer that cannot read the shape must refuse it, not guess at it.
    return [];
  }
  const viewer = model.standingFor(viewerId);
  if (viewer === null) {
    return [];
  }
  const cards: CandidateCardProjection[] = [];
  for (const candidateId of candidateIds) {
    if (candidateId === viewerId) {
      continue;
    }
    const candidate = model.standingFor(candidateId);
    const card = model.cardFor(viewerId, candidateId);
    if (candidate === null || card === null) {
      continue;
    }
    const decision = evaluateEligibility({
      viewer,
      candidate,
      relationship: model.relationshipFor(viewerId, candidateId),
      distance: card.distance,
      now: at,
    });
    if (decision.eligible) {
      cards.push(card);
    }
  }
  return cards;
}
