import type { EventId, RiskAssessment, RiskAssessmentId, RiskState, SubjectId } from '@been-there/core';
import { addHours } from './time.js';
import { REVERSIBLE_FRICTION, type FrictionKind, type ReversibleFriction, isActiveFriction } from './friction.js';
import type { ReviewCandidate } from './review.js';

/**
 * A user contesting a risk state.
 *
 * The right to dispute is part of the design, not an exception to it: risk is
 * the one automated judgement a user cannot see, so the only way they can ever
 * object to it is by contesting the *friction* it caused. That is why friction
 * must be observable to the user (it is: a rate limit, a re-verification
 * prompt) and why risk itself must not be.
 */
export interface RiskDispute {
  /** The `risk.disputed` request event minted by the app layer. */
  readonly disputeId: EventId;
  readonly subjectId: SubjectId;
  readonly assessmentId: RiskAssessmentId;
  /** The state being contested, recorded so a decline is explainable later. */
  readonly disputedState: RiskState;
  readonly raisedAt: Date;
  /** The user's own words. Never copied into a signal, a risk event, or a notice. */
  readonly statedReason: string;
  /** Set when a human closes the dispute. Open disputes suppress new friction. */
  readonly resolvedAt: Date | null;
}

export interface DisputeOutcome {
  /**
   * Literal `none`.
   *
   * A dispute is the user asking a question, and the system has no authority to
   * answer it about itself. Risk is lowered by `manual_reassess` with a named
   * assessor, or by decay. Never by the subject's objection, however sincere —
   * otherwise "dispute your risk" becomes a way to buy immunity.
   */
  readonly stateChange: 'none';
  /** Every reversible proposal is withdrawn the moment it is contested. */
  readonly frictionLifted: readonly FrictionKind[];
  /** The dispute itself becomes a review item, at a discounted priority. */
  readonly candidate: ReviewCandidate;
}

export function isOpenDispute(dispute: RiskDispute): boolean {
  return dispute.resolvedAt === null;
}

/**
 * What happens when a user disputes their risk state.
 *
 * The system fails *open*: every reversible proposal is withdrawn immediately,
 * the subject is not left waiting behind friction while a queue is worked, and
 * the case goes to a human who is the only party in the system allowed to
 * decide anything. What the system never does is quietly lower the risk, or
 * tell the user it did.
 */
export function handleDispute(
  friction: readonly ReversibleFriction[],
  assessment: Pick<RiskAssessment, 'subjectId' | 'assessmentId' | 'state' | 'contributingDetectors'>,
  dispute: RiskDispute,
  now: Date,
): DisputeOutcome {
  return {
    stateChange: 'none',
    frictionLifted: friction
      .filter((entry) => isActiveFriction(entry, now))
      .map((entry) => entry.kind),
    candidate: {
      target: { kind: 'account', subjectId: assessment.subjectId },
      state: assessment.state,
      origin: 'dispute',
      raisedAt: now,
      expiresAt: addHours(now, REVERSIBLE_FRICTION.human_review_candidate.ttlHours),
      detectors: assessment.contributingDetectors,
      independentDetectors: assessment.contributingDetectors.length,
      confidence: 0,
    },
  };
}
