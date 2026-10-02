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
export type DetectorReliability = 'low' | 'medium' | 'high';

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
export type EscalationStatus = 'corroboration_only' | 'self_escalating';

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
