import type { RiskState } from '@been-there/core';

/**
 * What a detector declares about its own standing, and the one arithmetic both
 * of those declarations are read through.
 *
 * A detector says two things about itself: how far its weight is trusted before
 * any evidence is seen, and whether it may move a subject on that weight alone.
 * The second is a product decision with a written rationale
 * (`docs/architecture/detector-escalation-policy.md`) and it is declared per
 * detector, never inferred from a list of names — adding a detector to the
 * catalogue cannot quietly put it in the set that escalates on its own.
 *
 * This module is the bottom of the package: the signal layer checks a
 * declaration against `ESCALATION_GATE` before a signal can exist, and the
 * policy layer reads the same two declarations when it decides what a signal is
 * worth. Neither imports the other, so neither can drift from the gate.
 */

/**
 * How much a detector is trusted *a priori*, before any evidence is seen.
 *
 * Reliability discounts the score in the policy layer; a `low` detector can
 * still accumulate risk over time, it just cannot do it in one observation.
 */
/**
 * Every reliability, as data and not only as a type.
 *
 * A closed vocabulary that exists only as a union cannot be checked at
 * runtime, so a value read back out of storage has to be tested against
 * something. `replay.ts` needs exactly that: a row's stored `reliability` is
 * `text` in the database, and narrowing it to this union is the difference
 * between skipping the row and folding a reliability nobody declared.
 *
 * Declared before the type so the type is derived from it, the same way
 * `BEHAVIOUR_KINDS` produces `BehaviourKind` in `signal.ts`.
 */
export const RELIABILITIES = ['low', 'medium', 'high'] as const;

export type DetectorReliability = (typeof RELIABILITIES)[number];

/**
 * Whether a detector may move a subject on its own evidence.
 *
 * `corroboration_only` detectors contribute evidence and cannot conclude: they
 * need a second, independent detector, and repetition is not one. Every detector
 * in the implemented catalogue is `corroboration_only`, because no statistical
 * pattern of ordinary behaviour justifies putting a real user in front of a
 * moderator on one source's say-so.
 *
 * `self_escalating` is reserved for evidence that is a fact about a person
 * rather than a pattern in their behaviour — an identity anomaly the provider
 * attributes with high confidence. It is a strong status, so it is checked: a
 * detector that declares it must be able to clear `ESCALATION_GATE` unaided, and
 * `createSignal` refuses the declaration otherwise. A detector cannot hold this
 * status and quietly never fire.
 */
/** As data for the same reason as `RELIABILITIES`, and derived the same way. */
export const ESCALATION_STATUSES = ['corroboration_only', 'self_escalating'] as const;

export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

/**
 * How much a detector's declared weight counts for. A `low` reliability detector
 * is not silenced, it is discounted — it just cannot do the work of a `high` one
 * on the same numbers, which is why the discount is part of the gate check and
 * not only part of the score.
 */
export const RELIABILITY_DISCOUNT: Readonly<Record<DetectorReliability, number>> = {
  low: 0.7,
  medium: 0.85,
  high: 1,
};

/**
 * The lowest score at which the shared machine moves a subject off `normal`.
 *
 * It is the shared table's own guard (`signal_observed` from `normal` requires
 * `score >= 0.5`), restated here because the policy layer has to reason about
 * what a detector can reach unaided, and restating a threshold is cheaper than
 * importing a private one out of the kernel.
 */
export const ESCALATION_GATE = 0.5;

/**
 * What a detector's declared weight is worth on its own: no repeats, no second
 * detector. This is the number a `self_escalating` declaration is checked
 * against, and the first term of the policy layer's score.
 */
export function unaidedScore(weight: number, reliability: DetectorReliability): number {
  return weight * RELIABILITY_DISCOUNT[reliability];
}

/** The risk states §3.6's detection metric counts a subject reaching. */
export type DetectionCountedState = 'high' | 'critical';

/** The states that count, in ascending order. */
const COUNTED_STATES: readonly DetectionCountedState[] = ['high', 'critical'];

export interface DetectorReach {
  readonly detector: string;
  /** True when the detector's only evidence is a report about the subject. */
  readonly dependsOnReports: boolean;
  /**
   * The highest state this detector can reach from `normal` on its own numbers,
   * with full corroboration and repeats at their cap. Computed through the
   * policy layer rather than asserted, so a weight edit cannot leave a stale
   * claim here.
   */
  readonly highestReachable: RiskState;
}

export interface DetectionReachability {
  readonly detectors: readonly DetectorReach[];
  /**
   * Whether `safety.detected_before_first_report` can be non-zero at all.
   *
   * True only when some detector both reaches a counted state **and** can fire
   * without a prior report. A detector that reaches `high` only after a report
   * is downstream of the very event the metric compares against, so it can
   * never be the *first* thing to raise the state — which is the whole
   * definition of the metric.
   */
  readonly measurable: boolean;
  /** The detectors whose reach is bounded below the counted states. */
  readonly belowThreshold: readonly string[];
  /** The detectors that reach a counted state, and why they cannot fill it. */
  readonly reportDependent: readonly string[];
}

/**
 * Whether this catalogue can detect anything *before* a report.
 *
 * This is the answer to "the metric reads zero — is that a wiring failure or
 * the arithmetic?", and it is computed from the catalogue rather than written
 * down. The failure this exists to prevent is a number that sits at zero
 * forever and is read as broken detection when it is in fact a property of the
 * catalogue: with the verification provider a stub, the only detectors loud
 * enough to reach `high` are downstream of a report, so the metric's
 * comparison is unsatisfiable. Declared as data, a new `self_escalating`
 * detector flips this to `true` on its own, with nothing else to remember.
 */
export function detectionReachability(
  detectors: readonly Pick<DetectorReach, 'detector' | 'dependsOnReports' | 'highestReachable'>[],
): DetectionReachability {
  const belowThreshold: string[] = [];
  const reportDependent: string[] = [];
  for (const entry of detectors) {
    if (!COUNTED_STATES.includes(entry.highestReachable as DetectionCountedState)) {
      belowThreshold.push(entry.detector);
    } else if (entry.dependsOnReports) {
      reportDependent.push(entry.detector);
    }
  }
  const measurable = detectors.some(
    (entry) =>
      !entry.dependsOnReports && COUNTED_STATES.includes(entry.highestReachable as DetectionCountedState),
  );
  return { detectors, measurable, belowThreshold: belowThreshold.sort(), reportDependent: reportDependent.sort() };
}

/** Repetitions are capped; the cap is the most a detector can ever be paid. */
const MAX_REPEAT_MULTIPLIER = 1.25;

/** Two independent detectors multiplying together, as the policy layer does. */
const CORROBORATED_MULTIPLIER = 1.15;

/** The shared table's own guards, restated because this module sits below it. */
const STATE_GATE: Readonly<Record<'elevated' | 'high' | 'critical', number>> = {
  elevated: 0.5,
  high: 0.7,
  critical: 0.9,
};

/**
 * The highest state one detector can move a fresh subject to.
 *
 * This asks "what would the policy layer decide at this detector's best legal
 * moment?" rather than keeping a second table of which detector is loud
 * enough. Best legal means two independent corroborating detectors and repeats
 * at their cap — a `corroboration_only` detector is granted all of it, so
 * anything it still cannot reach is genuinely unreachable.
 *
 * The multipliers and gates are restated rather than imported from
 * `policy.ts`, which imports this module and would make a cycle. A test in
 * `test/escalation.test.ts` asserts they equal the policy layer's own
 * constants, so the duplication cannot quietly rot.
 */
export function highestReachableFromNormal(weight: number, reliability: DetectorReliability): RiskState {
  const score = Math.min(unaidedScore(weight, reliability) * MAX_REPEAT_MULTIPLIER * CORROBORATED_MULTIPLIER, 1);
  if (score >= STATE_GATE.critical) {
    return 'critical';
  }
  if (score >= STATE_GATE.high) {
    return 'high';
  }
  return score >= STATE_GATE.elevated ? 'elevated' : 'normal';
}
