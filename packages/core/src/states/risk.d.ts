import { type StateMachine } from '../transition.js';
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
export type RiskEvent = 'signal_observed' | 'threshold_crossed' | 'decay' | 'manual_reassess' | 'reset_after_review';
export interface RiskContext {
    /** Weighted score contributed by the incoming signal, 0..1. */
    readonly score?: number;
    readonly assessorId?: string;
    /** Decay window, e.g. 14 days elapsed since the last signal. */
    readonly daysSinceLastSignal?: number;
    /** Distinct detectors that fired — combining signals is a risk multiplier. */
    readonly corroboratingDetectors?: number;
}
export declare const riskMachine: StateMachine<RiskState, RiskEvent, RiskContext>;
export interface RiskAssessment {
    readonly subjectId: SubjectId;
    readonly state: RiskState;
    readonly assessmentId: RiskAssessmentId;
    readonly lastSignalAt: Date | null;
    /** Names of detectors that fired — shown to moderators as rationale. */
    readonly contributingDetectors: readonly string[];
}
/** Decays by exactly one step at most, never skipping a level. */
export declare function isEscalation(from: RiskState, to: RiskState): boolean;
//# sourceMappingURL=risk.d.ts.map