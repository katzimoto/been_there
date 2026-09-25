import { type DomainError, type Result, domainError, ok } from '@been-there/core';
import type { AnomalyFinding } from './anomaly.js';
import { ANOMALY_SEVERITY_RANK } from './anomaly.js';
import { REQUIRED_CHECKS, type ProviderCheckResult, type VerificationCheck } from './provider.js';

/**
 * Identity confidence and the decision it drives (issue #3).
 *
 * Confidence is a bounded number, and a bounded number with no policy attached
 * is just a score someone can argue about. The policy is here, named, and
 * shared by the transition guards in `verification-request.ts` and by the guard
 * in the shared kernel's identity machine. There is exactly one floor.
 */

export type ConfidenceBand = 'unusable' | 'insufficient' | 'borderline' | 'sufficient';

/**
 * Threshold policy. `verifiedFloor` is not a tunable: it is the value the
 * shared kernel's `provider_result_received` guard checks, and the two must not
 * drift. The other two bound the band where a human decides.
 */
export const CONFIDENCE_THRESHOLDS = {
  /**
   * At or above this, a provider result may grant `verified` — provided every
   * required check passed and no anomaly fired. 0.9 is deliberately strict:
   * the cost of a false accept is a fake account in someone's dating life,
   * which is the single worst failure this product has, while the cost of a
   * false reject is one extra human review. The asymmetry, not the round
   * number, sets the value.
   */
  verifiedFloor: 0.9,
  /**
   * Below this the attempt fails automatically. Providers reserve their very
   * low scores for "this is not a match at all", where a human adds nothing.
   */
  autoFailFloor: 0.55,
} as const;

export interface IdentityConfidence {
  /** Guaranteed within [0, 1] and finite. */
  readonly value: number;
  readonly band: ConfidenceBand;
}

export function isBoundedConfidence(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * Rejects the inputs a provider can produce that would otherwise poison a
 * decision: NaN, infinities, negative values, values above 1. A confidence of
 * 1.4 is not a pass, it is a broken adapter.
 */
export function makeConfidence(value: number): Result<IdentityConfidence, DomainError> {
  if (!isBoundedConfidence(value)) {
    return domainError(
      'validation_failed',
      'identity',
      'provider confidence is not a bounded 0..1 value',
      {
        value: Number.isFinite(value) ? value : null,
      },
    );
  }
  return ok({ value, band: classifyConfidence(value) });
}

export function classifyConfidence(value: number): ConfidenceBand {
  if (!isBoundedConfidence(value)) {
    return 'unusable';
  }
  if (value < CONFIDENCE_THRESHOLDS.autoFailFloor) {
    return 'insufficient';
  }
  if (value < CONFIDENCE_THRESHOLDS.verifiedFloor) {
    return 'borderline';
  }
  return 'sufficient';
}

export type VerificationDecision = 'pass' | 'fail' | 'manual_review';

export interface DecisionInput {
  readonly confidence: number;
  readonly checks: readonly ProviderCheckResult[];
  readonly anomalies?: readonly AnomalyFinding[];
}

export interface VerificationDecisionRecord {
  readonly decision: VerificationDecision;
  readonly confidence: IdentityConfidence;
  /**
   * Ordered, human-readable reasons. Rendered in the moderator tool and in the
   * user's "why wasn't I verified?" screen after review. Never a product
   * surface, and never a reason string a provider can author directly.
   */
  readonly rationale: readonly string[];
  /** Required checks the provider did not report on, if any. */
  readonly missingChecks: readonly VerificationCheck[];
}

/**
 * The decision, in one readable precedence list. The order is the policy:
 *
 *  1. Unusable confidence never auto-resolves. A broken adapter is our bug,
 *     and our bugs do not decide whether a real person gets verified.
 *  2. A `blocking` anomaly outranks everything, including a failed check. A
 *     person with a rejected document *and* an impossible-travel signal has two
 *     plausible explanations and only one of them is fraud.
 *  3. A required check the provider did not run, or ran inconclusively, is a
 *     human's job — never a pass and never a fail.
 *  4. A failed required check fails the attempt, but only when the provider's
 *     own confidence agrees it is a bad result. A failed check reported
 *     alongside a 0.95 overall score is internally contradictory evidence, and
 *     contradictory evidence goes to a human, never to an auto-decision.
 *  5. Confidence bands decide the rest, and a `review`-level anomaly outranks a
 *     passing score: the account may be genuine while the account *pattern* is
 *     not, and only a human can tell those apart.
 */
export function decideVerificationOutcome(input: DecisionInput): VerificationDecisionRecord {
  const confidenceResult = makeConfidence(input.confidence);
  const missing = REQUIRED_CHECKS.filter((check) => !input.checks.some((c) => c.check === check));
  const unresolved = REQUIRED_CHECKS.filter((check) => {
    const result = input.checks.find((c) => c.check === check);
    return (
      result === undefined ||
      result.outcome === 'inconclusive' ||
      result.outcome === 'not_performed'
    );
  });
  const failed = REQUIRED_CHECKS.filter((check) =>
    input.checks.some((c) => c.check === check && c.outcome === 'failed'),
  );
  const worstAnomaly = (input.anomalies ?? []).reduce<AnomalyFinding | null>((acc, finding) => {
    if (
      acc === null ||
      ANOMALY_SEVERITY_RANK[finding.severity] > ANOMALY_SEVERITY_RANK[acc.severity]
    ) {
      return finding;
    }
    return acc;
  }, null);
  /**
   * The worst finding that a human must actually see. An `informational`
   * finding is recorded and stops here: it must not change an outcome, which
   * is the whole difference between the two lowest severities.
   */
  const actionableAnomaly =
    worstAnomaly !== null &&
    ANOMALY_SEVERITY_RANK[worstAnomaly.severity] >= ANOMALY_SEVERITY_RANK.review
      ? worstAnomaly
      : null;

  if (!confidenceResult.ok) {
    return {
      decision: 'manual_review',
      confidence: { value: 0, band: 'unusable' },
      rationale: ['provider returned an unusable confidence value'],
      missingChecks: missing,
    };
  }

  const confidence = confidenceResult.value;

  if (actionableAnomaly?.severity === 'blocking') {
    return {
      decision: 'manual_review',
      confidence,
      rationale: [`anomaly requires human review: ${actionableAnomaly.code}`],
      missingChecks: missing,
    };
  }

  if (unresolved.length > 0) {
    return {
      decision: 'manual_review',
      rationale: [`required check not conclusively performed: ${unresolved.join(', ')}`],
      confidence,
      missingChecks: missing,
    };
  }

  if (failed.length > 0) {
    if (confidence.band === 'sufficient') {
      return {
        decision: 'manual_review',
        confidence,
        rationale: [
          `provider reported a failed check (${failed.join(', ')}) alongside a confident overall score`,
        ],
        missingChecks: missing,
      };
    }
    return {
      decision: 'fail',
      confidence,
      rationale: [`required check failed: ${failed.join(', ')}`],
      missingChecks: missing,
    };
  }

  if (confidence.band === 'insufficient') {
    return {
      decision: 'fail',
      confidence,
      rationale: [`confidence ${confidence.value} is below the automatic failure floor`],
      missingChecks: missing,
    };
  }

  if (confidence.band === 'borderline') {
    return {
      decision: 'manual_review',
      confidence,
      rationale: [`confidence ${confidence.value} is in the human-review band`],
      missingChecks: missing,
    };
  }

  if (actionableAnomaly !== null) {
    return {
      decision: 'manual_review',
      confidence,
      rationale: [`anomaly requires human review: ${actionableAnomaly.code}`],
      missingChecks: missing,
    };
  }

  return {
    decision: 'pass',
    confidence,
    rationale: [`all required checks passed at confidence ${confidence.value}`],
    missingChecks: missing,
  };
}
