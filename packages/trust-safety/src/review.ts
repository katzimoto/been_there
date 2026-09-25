import { type RiskState, type SubjectId } from '@been-there/core';
import type { BehaviourKey } from './signal.js';
import { daysBetween } from './time.js';

/**
 * Who a review candidate is about.
 *
 * An `account` candidate is one user's risk. A `cluster` candidate is a group
 * of accounts behaving in a coordinated way — the retaliatory mass-reporting
 * case — where the right unit of review is the group, because one moderator
 * decision protects every member and because reviewing the accounts one by one
 * would review the victims first.
 */
export type ReviewTarget =
  | { readonly kind: 'account'; readonly subjectId: SubjectId }
  | { readonly kind: 'cluster'; readonly key: BehaviourKey; readonly members: readonly SubjectId[] };

/** How the candidate entered the queue. Weighted, because the costs differ. */
export type ReviewOrigin = 'detection' | 'dispute' | 'mass_report_attack';

export interface ReviewCandidate {
  readonly target: ReviewTarget;
  readonly state: RiskState;
  readonly origin: ReviewOrigin;
  readonly raisedAt: Date;
  /** A candidate nobody acted on lapses, so a stale suspicion cannot haunt a user. */
  readonly expiresAt: Date;
  /** How many independent detectors supported the raise. */
  readonly independentDetectors: number;
  /** Effective score at raise time, 0..1. Shown to a moderator as confidence. */
  readonly confidence: number;
  /** Detector names behind the raise. Never a verdict, never user copy. */
  readonly detectors: readonly string[];
}

/**
 * Ranking weights, in one record so the policy is reviewable as data.
 *
 * Severity dominates because a `critical` account is still interacting with
 * people. Recency is weighted second, and above corroboration, because the
 * metric issue #1 commits to is *detected before another user reports them*:
 * a detection that is a week old has already had a week of friction and a week
 * of decay working on it, and the human's marginal value is lowest there.
 * Corroboration ranks last on purpose — a second detector makes a case cheaper
 * to review, but it does not make it more urgent.
 */
export const RANKING_WEIGHTS: Readonly<{
  state: number;
  recency: number;
  corroboration: number;
  confidence: number;
}> = {
  state: 0.5,
  recency: 0.25,
  corroboration: 0.15,
  confidence: 0.1,
};

/** Two independent detectors are as much corroboration as the ranking rewards. */
export const CORROBORATION_SATURATION = 2;

/** A candidate's priority has decayed to nothing by this age. */
export const RECENCY_HORIZON_DAYS = 30;

/** One decision covering a cluster is worth more than one covering an account. */
export const CLUSTER_EFFICIENCY_BONUS = 0.1;

/**
 * A disputed account has already had its friction lifted — the system fails
 * open for them — so their case must not outrank an account we may still be
 * actively harming.
 */
export const DISPUTE_PRIORITY_DISCOUNT = 0.35;

const STATE_WEIGHT: Readonly<Record<RiskState, number>> = {
  normal: 0,
  elevated: 0.3,
  high: 0.7,
  critical: 1,
};

export interface RankedReviewCandidate {
  readonly candidate: ReviewCandidate;
  readonly priority: number;
}

function targetKey(target: ReviewTarget): string {
  return target.kind === 'account'
    ? `account:${target.subjectId}`
    : `cluster:${target.key.kind}:${target.key.entityId}`;
}

/** Fraction of the recency weight still unspent, saturating at the horizon. */
function recencyWeight(candidate: ReviewCandidate, now: Date): number {
  const age = daysBetween(candidate.raisedAt, now);
  return Math.max(0, 1 - age / RECENCY_HORIZON_DAYS);
}

function priorityOf(candidate: ReviewCandidate, now: Date): number {
  const base =
    RANKING_WEIGHTS.state * STATE_WEIGHT[candidate.state] +
    RANKING_WEIGHTS.recency * recencyWeight(candidate, now) +
    RANKING_WEIGHTS.corroboration *
      Math.min(candidate.independentDetectors / CORROBORATION_SATURATION, 1) +
    RANKING_WEIGHTS.confidence * candidate.confidence +
    (candidate.target.kind === 'cluster' ? CLUSTER_EFFICIENCY_BONUS : 0) -
    (candidate.origin === 'dispute' ? DISPUTE_PRIORITY_DISCOUNT : 0);
  return Math.min(Math.max(base, 0), 1);
}

/**
 * Orders the review queue. Pure, total, and the only place queue order is
 * decided.
 *
 * Expired candidates are dropped rather than ranked: a suspicion nobody acted
 * on stops being information, and leaving it in the queue would let an old
 * automated guess outrank a fresh observation. Ties break oldest-first, then by
 * target, so two candidates with identical evidence always appear in the same
 * order for every reviewer on every shift.
 */
export function rankReviewCandidates(
  candidates: readonly ReviewCandidate[],
  now: Date,
): readonly RankedReviewCandidate[] {
  return candidates
    .filter((candidate) => candidate.expiresAt.getTime() > now.getTime())
    .map((candidate) => ({ candidate, priority: priorityOf(candidate, now) }))
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        a.candidate.raisedAt.getTime() - b.candidate.raisedAt.getTime() ||
        targetKey(a.candidate.target).localeCompare(targetKey(b.candidate.target)),
    );
}
