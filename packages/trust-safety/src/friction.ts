import { type RiskState, type SubjectId } from '@been-there/core';
import { addHours } from './time.js';

/**
 * The complete list of things this domain is ever allowed to propose.
 *
 * There is no fourth kind. Adding one is a one-line diff here, which is the
 * point: "what can the automated system do to a user?" is answered by reading
 * this record, and it is the *only* place the answer lives.
 *
 * Every kind is reversible and every kind expires. `ReversibleFriction` types
 * `reversible` as the literal `true`, so a proposal that cannot be undone does
 * not typecheck in this package at all.
 */
export const FRICTION_KINDS = ['rate_limit', 'reverification_request', 'human_review_candidate'] as const;

export type FrictionKind = (typeof FRICTION_KINDS)[number];

/**
 * The only three things a user may ever be told by this domain.
 *
 * Risk itself is not in the list, and neither is any synonym of it. A user may
 * be told that we are checking something again; they may never be told that
 * they are risky, suspicious, or flagged. A user who reads "you are high risk"
 * learns a verdict about themselves that a human has not made and that no
 * evidence in the system can actually support.
 */
export const USER_NOTICES = ['none', 'generic_reverification', 'generic_rate_limit'] as const;

export type UserNotice = (typeof USER_NOTICES)[number];

export interface FrictionRule {
  readonly kind: FrictionKind;
  /** Risk state from which this friction may be proposed. */
  readonly minRiskState: RiskState;
  /** How long the proposal stays live if no human intervenes. */
  readonly ttlHours: number;
  /** Product capabilities it throttles. Documentation and handoff, not enforcement. */
  readonly throttles: readonly string[];
  /** The only user-visible string this friction may ever produce. */
  readonly userNotice: UserNotice;
  readonly rationale: string;
}

export const REVERSIBLE_FRICTION: Readonly<Record<FrictionKind, FrictionRule>> = {
  rate_limit: {
    kind: 'rate_limit',
    minRiskState: 'elevated',
    ttlHours: 24,
    throttles: ['like', 'send_message'],
    userNotice: 'generic_rate_limit',
    rationale: 'Caps outbound activity so a spammy account cannot flood the product while a human looks. Reverses on expiry.',
  },
  reverification_request: {
    kind: 'reverification_request',
    minRiskState: 'critical',
    ttlHours: 168,
    throttles: [],
    userNotice: 'generic_reverification',
    rationale: 'Asks Identity to re-run verification. Identity owns whether to act and may refuse. Reserved for critical because it is the one friction with a real cost to a legitimate user: while verification is pending they are not discoverable.',
  },
  human_review_candidate: {
    kind: 'human_review_candidate',
    minRiskState: 'high',
    ttlHours: 72,
    throttles: [],
    userNotice: 'none',
    rationale: 'Places the subject in front of a moderator. This is the primary safety metric of issue #1: a confirmed malicious account detected before another user reports it. A moderator sees behaviour metadata, never a verdict.',
  },
};

/** A live, expiring, undoable proposal. Never an applied enforcement action. */
export interface ReversibleFriction {
  readonly kind: FrictionKind;
  readonly subjectId: SubjectId;
  /** Detector names behind the proposal. Never user-facing copy. */
  readonly reason: string;
  readonly raisedAt: Date;
  readonly expiresAt: Date;
  /** Literal `true`; see the note on `ReversibleFriction`. */
  readonly reversible: true;
}

export function proposeFriction(
  kind: FrictionKind,
  subjectId: SubjectId,
  reason: string,
  now: Date,
): ReversibleFriction {
  return {
    kind,
    subjectId,
    reason,
    raisedAt: now,
    expiresAt: addHours(now, REVERSIBLE_FRICTION[kind].ttlHours),
    reversible: true,
  };
}

/** Expiry is the failure mode that matters: a proposal nobody reviewed lapses. */
export function isActiveFriction(friction: ReversibleFriction, now: Date): boolean {
  return friction.expiresAt.getTime() > now.getTime();
}

export function expireFriction(
  friction: readonly ReversibleFriction[],
  now: Date,
): readonly ReversibleFriction[] {
  return friction.filter((entry) => isActiveFriction(entry, now));
}

/**
 * What, if anything, the user is told.
 *
 * The input is the active friction list — never the risk state. That is the
 * whole design: the risk state is not renderable, so no code path can render
 * it, and the copy that does reach a user is generic and reversible by
 * definition. The wording itself lives in the owning product domains.
 */
export function userNoticeFor(
  friction: readonly ReversibleFriction[],
  now: Date,
): UserNotice {
  const active = friction.filter((entry) => isActiveFriction(entry, now)).map((entry) => entry.kind);
  if (active.includes('reverification_request')) {
    return 'generic_reverification';
  }
  if (active.includes('rate_limit')) {
    return 'generic_rate_limit';
  }
  return 'none';
}
