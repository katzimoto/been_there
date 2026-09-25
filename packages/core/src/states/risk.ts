import { type StateMachine, defineStateMachine } from '../transition.js';
import type { RiskAssessmentId, SubjectId } from '../ids.js';

/**
 * Behavioural risk (issue #6).
 *
 * Two rules make this safe to operate:
 *  1. Risk is *evidence*, not a verdict. No transition here changes an account
 *     standing — that is moderation's job, and every enforcement action requires
 *     a case and a named moderator.
 *  2. Risk decays. `decay` is always legal, so a user who misbehaves once and
 *     behaves well for weeks is not stuck at `high`.
 */
export type RiskState = 'normal' | 'elevated' | 'high' | 'critical';

export type RiskEvent =
  | 'signal_observed'
  | 'threshold_crossed'
  | 'decay'
  | 'manual_reassess'
  | 'reset_after_review';

export interface RiskContext {
  /** Weighted score contributed by the incoming signal, 0..1. */
  readonly score?: number;
  readonly assessorId?: string;
  /** Decay window, e.g. 14 days elapsed since the last signal. */
  readonly daysSinceLastSignal?: number;
  /** Distinct detectors that fired — combining signals is a risk multiplier. */
  readonly corroboratingDetectors?: number;
}

const ORDER: Readonly<Record<RiskState, number>> = { normal: 0, elevated: 1, high: 2, critical: 3 };

export const riskMachine: StateMachine<RiskState, RiskEvent, RiskContext> =
  defineStateMachine<RiskState, RiskEvent, RiskContext>({
    domain: 'trust-safety',
    initial: 'normal',
    transitions: [
      { event: 'signal_observed', from: ['normal'], to: 'elevated', guard: (ctx) => (ctx?.score ?? 0) >= 0.5, note: 'A single sub-threshold signal never escalates.' },
      { event: 'signal_observed', from: ['elevated'], to: 'high', guard: (ctx) => (ctx?.score ?? 0) >= 0.7, note: 'Escalation to high requires a strong signal or corroboration.' },
      { event: 'signal_observed', from: ['high'], to: 'critical', guard: (ctx) => (ctx?.score ?? 0) >= 0.9 || (ctx?.corroboratingDetectors ?? 0) >= 2, note: 'Critical requires either a near-certain signal or two independent detectors.' },
      { event: 'threshold_crossed', from: ['high'], to: 'critical', note: 'Deliberately unguarded, and declared BEFORE the general row below. The resolver takes the first match, so ordering is load-bearing: swap these two and this edge is shadowed, and high + threshold_crossed silently returns high instead of critical. Trust & Safety never requests it from `high` precisely because it skips the corroboration requirement - see docs/architecture/trust-safety.md.' },
      { event: 'threshold_crossed', from: ['normal', 'elevated'], to: 'high', guard: (ctx) => (ctx?.score ?? 0) >= 0.7 },
      { event: 'decay', from: ['critical'], to: 'high', guard: (ctx) => (ctx?.daysSinceLastSignal ?? 0) >= 30 },
      { event: 'decay', from: ['high'], to: 'elevated', guard: (ctx) => (ctx?.daysSinceLastSignal ?? 0) >= 14 },
      { event: 'decay', from: ['elevated'], to: 'normal', guard: (ctx) => (ctx?.daysSinceLastSignal ?? 0) >= 7 },
      { event: 'manual_reassess', to: 'normal', guard: (ctx) => ctx?.assessorId !== undefined, note: 'A human may always lower risk; only moderation may act on it.' },
      { event: 'reset_after_review', to: 'normal', guard: (ctx) => ctx?.assessorId !== undefined },
    ],
  });

export interface RiskAssessment {
  readonly subjectId: SubjectId;
  readonly state: RiskState;
  readonly assessmentId: RiskAssessmentId;
  readonly lastSignalAt: Date | null;
  /** Names of detectors that fired — shown to moderators as rationale. */
  readonly contributingDetectors: readonly string[];
}

/** Decays by exactly one step at most, never skipping a level. */
export function isEscalation(from: RiskState, to: RiskState): boolean {
  return ORDER[to] > ORDER[from];
}
