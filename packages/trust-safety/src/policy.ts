import {
  type DomainError,
  type Result,
  type RiskEvent,
  type RiskState,
  domainError,
  isEscalation,
  riskMachine,
} from '@been-there/core';
import type { Corroboration } from './correlation.js';
import {
  FRICTION_KINDS,
  REVERSIBLE_FRICTION,
  type ReversibleFriction,
  proposeFriction,
} from './friction.js';
import type { ReviewCandidate, ReviewTarget } from './review.js';
import { type DetectorReliability, type Signal, TRUST_SAFETY_DOMAIN } from './signal.js';
import { addHours, daysBetween } from './time.js';

export const RISK_RANK: Readonly<Record<RiskState, number>> = {
  normal: 0,
  elevated: 1,
  high: 2,
  critical: 3,
};

/**
 * How much a detector's declared weight counts for. A `low` reliability detector
 * is not silenced, it is discounted — over time it can still carry a subject
 * upward, it just cannot do it in one observation.
 */
export const RELIABILITY_DISCOUNT: Readonly<Record<DetectorReliability, number>> = {
  low: 0.7,
  medium: 0.85,
  high: 1,
};

/** Each repeat of the same detector on the same behaviour adds this much. */
export const REPEAT_STEP = 0.05;

/** Repeats stop paying at this multiplier; a spammable detector must not compound. */
export const REPEAT_MULTIPLIER_CAP = 1.25;

/** Two independent detectors multiplying together. */
export const CORROBORATION_MULTIPLIER = 1.15;

/**
 * A single detector may never produce a score that reaches the shared machine's
 * `score >= 0.9` critical branch, however loudly it repeats itself. Corroboration
 * by a second, independent detector is the only way past this ceiling — which is
 * how "corroboration is genuinely required for the highest escalation" is
 * enforced without reimplementing the machine: the policy layer caps what one
 * source may claim, and `riskMachine` still owns every transition.
 */
export const SINGLE_DETECTOR_SCORE_CEILING = 0.85;

/** Score at which corroboration alone is enough to reach `high` from below. */
export const CORROBORATION_FAST_PATH_SCORE = 0.7;

export type RiskDecisionReason =
  | 'escalated_by_signal'
  | 'escalated_by_corroboration'
  | 'below_threshold'
  | 'already_critical'
  | 'report_not_risk_bearing'
  | 'mass_report_quarantined';

export interface PolicyInput {
  readonly current: RiskState;
  readonly signal: Signal;
  readonly corroboration: Corroboration;
  /** An open dispute suppresses all new friction. Risk itself is untouched. */
  readonly disputeOpen: boolean;
}

export interface PolicyDecision {
  readonly next: RiskState;
  readonly changed: boolean;
  /** The shared machine's event, or `null` when no event was legal. */
  readonly event: RiskEvent | null;
  readonly effectiveScore: number;
  readonly reason: RiskDecisionReason;
  readonly friction: readonly ReversibleFriction[];
  /** Queue entry this decision would open, if any. */
  readonly candidate: ReviewCandidate | null;
  /**
   * The signal describes something done *to* the subject and contributed
   * nothing: no state, no detector, no clock, no friction. It stays in the
   * ledger, because that is what makes a campaign visible to a human.
   */
  readonly discarded: boolean;
}

/** The weighted evidence, before the shared machine is asked anything. */
function effectiveScoreOf(signal: Signal, corroboration: Corroboration): number {
  const base = signal.weight * RELIABILITY_DISCOUNT[signal.reliability];
  const repeatMultiplier = Math.min(
    1 + corroboration.repetitions * REPEAT_STEP,
    REPEAT_MULTIPLIER_CAP,
  );
  if (corroboration.independentDetectors < 2) {
    return Math.min(base * repeatMultiplier, SINGLE_DETECTOR_SCORE_CEILING);
  }
  return Math.min(base * repeatMultiplier * CORROBORATION_MULTIPLIER, 1);
}

/**
 * Which shared event to ask for.
 *
 * `threshold_crossed` is the corroborated fast path from `normal`/`elevated`
 * straight to `high`, and it is deliberately never used from `high`: in the
 * shared table that edge carries no guard, so asking for it from `high` would
 * skip the corroboration requirement for `critical` entirely.
 */
function selectEvent(current: RiskState, effectiveScore: number, corroborated: boolean): RiskEvent | null {
  if (current === 'critical') {
    return null;
  }
  if (current === 'high') {
    return 'signal_observed';
  }
  return corroborated && effectiveScore >= CORROBORATION_FAST_PATH_SCORE
    ? 'threshold_crossed'
    : 'signal_observed';
}

/** Every friction the resulting state justifies — never more, and always expiring. */
function selectFriction(
  state: RiskState,
  subjectId: Signal['subjectId'],
  reason: string,
  now: Date,
  disputeOpen: boolean,
): readonly ReversibleFriction[] {
  if (disputeOpen) {
    return [];
  }
  return FRICTION_KINDS.filter(
    (kind) => RISK_RANK[state] >= RISK_RANK[REVERSIBLE_FRICTION[kind].minRiskState],
  ).map((kind) => proposeFriction(kind, subjectId, reason, now));
}

/**
 * The policy layer. It converts one signal plus the current risk state into a
 * decision, and it is the *only* layer that decides anything: detectors emit
 * evidence, this decides what that evidence means, and nothing here decides
 * what happens to the account.
 */
export function assessSignal(input: PolicyInput, now: Date): PolicyDecision {
  const { current, signal, corroboration } = input;
  const reason = `${signal.detector} observed ${signal.behaviour.kind}`;

  // A report is an accusation, not evidence. Whatever the reports say, the
  // account being reported keeps the risk state it had: not because reporting
  // is unimportant, but because a risk state is a statement about observed
  // behaviour, and "other people said so" is not observed behaviour. It is also
  // the only defence against retaliation, where an attacker with three accounts
  // buys a stranger a `critical` risk state in under a minute.
  //
  // The signals stay in the ledger, because a *pattern* of them is evidence —
  // about the reporters. The moment three distinct reporters show up, the
  // campaign, not the victim, is what goes in front of a human.
  if (signal.behaviour.kind === 'report_against') {
    const cluster = corroboration.massReport;
    return {
      next: current,
      changed: false,
      event: null,
      effectiveScore: 0,
      reason: cluster === null ? 'report_not_risk_bearing' : 'mass_report_quarantined',
      friction: [],
      discarded: true,
      candidate:
        cluster === null
          ? null
          : {
              target: {
                kind: 'cluster',
                key: cluster.key,
                members: cluster.reporters,
              },
              state: 'high',
              origin: 'mass_report_attack',
              raisedAt: now,
              expiresAt: addHours(now, REVERSIBLE_FRICTION.human_review_candidate.ttlHours),
              detectors: corroboration.detectors,
              independentDetectors: cluster.reporters.length,
              confidence: signal.weight,
            },
    };
  }

  const effectiveScore = effectiveScoreOf(signal, corroboration);
  const corroborated = corroboration.independentDetectors >= 2;
  const event = selectEvent(current, effectiveScore, corroborated);
  const moved =
    event === null
      ? undefined
      : riskMachine.next(current, event, {
          score: effectiveScore,
          corroboratingDetectors: corroboration.independentDetectors,
        });

  const next = moved !== undefined && moved.ok ? moved.value : current;
  const changed = next !== current;
  const escalated = changed && isEscalation(current, next);

  const candidate: ReviewCandidate | null =
    escalated && RISK_RANK[next] >= RISK_RANK.high
      ? {
          target: { kind: 'account', subjectId: signal.subjectId },
          state: next,
          origin: 'detection',
          raisedAt: now,
          expiresAt: addHours(now, REVERSIBLE_FRICTION.human_review_candidate.ttlHours),
          detectors: corroboration.detectors,
          independentDetectors: corroboration.independentDetectors,
          confidence: effectiveScore,
        }
      : null;

  const decisionReason: RiskDecisionReason =
    current === 'critical'
      ? 'already_critical'
      : escalated
        ? corroborated
          ? 'escalated_by_corroboration'
          : 'escalated_by_signal'
        : 'below_threshold';

  return {
    next,
    changed,
    event,
    effectiveScore,
    reason: decisionReason,
    friction: selectFriction(next, signal.subjectId, reason, now, input.disputeOpen),
    candidate,
    discarded: false,
  };
}

/**
 * Decay is a question about the clock, not about behaviour. The shared machine
 * owns the thresholds (7 / 14 / 30 days) and the one-step guarantee; this only
 * measures the silence.
 */
export function assessDecay(
  current: RiskState,
  lastSignalAt: Date | null,
  now: Date,
): Result<RiskState, DomainError> {
  const daysSinceLastSignal =
    lastSignalAt === null ? Number.POSITIVE_INFINITY : daysBetween(lastSignalAt, now);
  return riskMachine.next(current, 'decay', { daysSinceLastSignal });
}

/**
 * Only a named human lowers risk. The assessor is a required, non-empty value
 * rather than an optional context field, so "the detector cleared the subject"
 * is not a call anyone can make here.
 */
export function assessHumanReassessment(
  current: RiskState,
  assessorId: string,
): Result<RiskState, DomainError> {
  if (assessorId.length === 0) {
    return domainError('permission_denied', TRUST_SAFETY_DOMAIN, 'a named assessor is required to lower risk');
  }
  return riskMachine.next(current, 'manual_reassess', { assessorId });
}
