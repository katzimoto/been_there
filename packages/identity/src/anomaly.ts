import type { SubjectId } from '@been-there/core';

/**
 * Identity anomaly detection (issue #3).
 *
 * Commitment 2 says automation never enforces, and this module is where that is
 * easiest to break: a detector that "handles" a suspicious account is a
 * detector that has become enforcement. So the vocabulary here is deliberately
 * narrow:
 *
 *  - A detector *only* produces `AnomalyFinding` values. It has no account
 *    state, no capability list, and no import that could reach either.
 *  - A finding is evidence for a human. Its only possible consequence is
 *    `ReviewProposal`, whose `identityEvent` is the single literal
 *    `'flag_for_review'`.
 *
 * A finding never changes account standing. It cannot: the type that carries it
 * out of this module names one identity event and nothing else.
 */

export type AnomalyCode =
  /** The same subject failing attempt after attempt. */
  | 'repeated_failed_attempts'
  /** Declared age and evidence age cannot both be true. */
  | 'implausible_age'
  /** One device presenting many distinct accounts. */
  | 'device_shared_across_accounts'
  /** Two attempts too far apart, too quickly, to be the same person. */
  | 'impossible_travel_between_attempts'
  /** A capture resembling one already accepted for another subject. */
  | 'selfie_reuse_signal'
  /** A document image resembling one already accepted for another subject. */
  | 'document_reuse_signal'
  /** A burst of new accounts from one network signature. */
  | 'high_velocity_signups_from_network'
  /** Identity attributes changed repeatedly in a short window. */
  | 'identity_attributes_changed';

/**
 * How much a finding is allowed to influence the decision:
 *
 *  - `informational` is recorded and never changes an outcome.
 *  - `review` forces a human to look. It cannot fail a verification.
 *  - `blocking` forces a human to look *even when the checks themselves
 *    failed*. A user whose document was rejected and who also tripped a reuse
 *    signal has two plausible explanations, and only one of them is fraud.
 */
export type AnomalySeverity = 'informational' | 'review' | 'blocking';

export interface AnomalyFinding {
  readonly code: AnomalyCode;
  readonly severity: AnomalySeverity;
  readonly detector: string;
  readonly subjectId: SubjectId;
  readonly detectedAt: Date;
  /**
   * Counts that justify the finding, e.g. `{ attempts: 7, windowDays: 30 }`.
   * Numbers only: a finding must be explainable without opening the evidence.
   */
  readonly observations: Readonly<Record<string, number>>;
}

export const ANOMALY_SEVERITY_RANK: Readonly<Record<AnomalySeverity, number>> = {
  informational: 0,
  review: 1,
  blocking: 2,
};

/**
 * Detector thresholds. Named, with the reasoning next to each, because these
 * are the numbers a moderator will be asked to defend and a fair-audit reviewer
 * will ask about. Changing one is a reviewable diff.
 */
export const ANOMALY_THRESHOLDS = {
  /**
   * Repeated failures: 3 in 30 days. Two failures is an ordinary bad photo
   * week; three is a pattern worth a human's ten seconds.
   */
  repeatedFailedAttempts: { count: 3, windowDays: 30 },
  /**
   * Age: a gap of 6 years or more between declared and evidence-derived age.
   * Vendor age estimates are noisy and biased (see Open questions), so the band
   * is wide and the consequence is a human, never a rejection.
   */
  ageDiscrepancyYears: 6,
  /**
   * Shared device: 3 distinct accounts verified from one device. A shared
   * family phone or a repair-shop kiosk is a legitimate explanation.
   */
  sharedDeviceAccountCount: 3,
  /**
   * Impossible travel: 500 km in under 2 hours. Deliberately conservative —
   * the point is to be right, not to be strict.
   */
  travel: { maxKm: 500, minHours: 2 },
  /**
   * Reuse: 1 near-duplicate capture against a *different* subject. One hit is
   * enough to require a human; it is not enough to refuse anyone.
   */
  reuseMatchThreshold: 1,
  /**
   * Velocity: 8 new accounts from one network signature in 24 hours, measured
   * platform-wide rather than per subject.
   */
  networkVelocity: { accounts: 8, hours: 24 },
  /**
   * Attribute churn: 3 changes in 30 days. Two is curiosity; three is a loop.
   */
  identityAttributeChanges: { count: 3, windowDays: 30 },
} as const;

/**
 * Everything a detector may look at. Aggregate counts and coarse values only —
 * no evidence, no provider payloads, no exact coordinates. If a detector needs
 * a new input, it needs a new field here, and that field is a privacy review.
 */
export interface AnomalySignals {
  readonly subjectId: SubjectId;
  readonly now: Date;
  readonly failedAttemptsInWindow: number;
  readonly windowDays: number;
  /** Age the user declared at onboarding. */
  readonly declaredAgeYears: number | null;
  /** Age the provider estimated from the evidence, coarse. */
  readonly evidenceAgeYears: number | null;
  readonly sharedDeviceAccountCount: number;
  readonly lastTwoAttemptsKmApart: number | null;
  readonly lastTwoAttemptsHoursApart: number;
  readonly selfieMatchesAgainstOtherSubjects: number;
  readonly documentMatchesAgainstOtherSubjects: number;
  readonly distinctAccountsFromNetworkIn24h: number;
  readonly identityAttributeChangesIn30d: number;
}

export function detectIdentityAnomalies(signals: AnomalySignals): AnomalyFinding[] {
  const findings: AnomalyFinding[] = [];
  const base = { subjectId: signals.subjectId, detectedAt: signals.now };

  if (
    signals.failedAttemptsInWindow >= ANOMALY_THRESHOLDS.repeatedFailedAttempts.count &&
    signals.windowDays <= ANOMALY_THRESHOLDS.repeatedFailedAttempts.windowDays
  ) {
    findings.push({
      ...base,
      code: 'repeated_failed_attempts',
      // Repeated failure is the signature of a scripted actor, and also of a
      // user with a very old, badly photographed document. Review, not block.
      severity: 'review',
      detector: 'identity.repeated_failures',
      observations: { attempts: signals.failedAttemptsInWindow, windowDays: signals.windowDays },
    });
  }

  const ageGap =
    signals.declaredAgeYears !== null && signals.evidenceAgeYears !== null
      ? Math.abs(signals.declaredAgeYears - signals.evidenceAgeYears)
      : null;
  if (ageGap !== null && ageGap >= ANOMALY_THRESHOLDS.ageDiscrepancyYears) {
    findings.push({
      ...base,
      code: 'implausible_age',
      severity: 'review',
      detector: 'identity.age_discrepancy',
      observations: { gapYears: ageGap, thresholdYears: ANOMALY_THRESHOLDS.ageDiscrepancyYears },
    });
  }

  if (signals.sharedDeviceAccountCount >= ANOMALY_THRESHOLDS.sharedDeviceAccountCount) {
    findings.push({
      ...base,
      code: 'device_shared_across_accounts',
      severity: 'review',
      detector: 'identity.shared_device',
      observations: {
        accounts: signals.sharedDeviceAccountCount,
        threshold: ANOMALY_THRESHOLDS.sharedDeviceAccountCount,
      },
    });
  }

  const km = signals.lastTwoAttemptsKmApart;
  if (
    km !== null &&
    km >= ANOMALY_THRESHOLDS.travel.maxKm &&
    signals.lastTwoAttemptsHoursApart < ANOMALY_THRESHOLDS.travel.minHours
  ) {
    // Two of the very few patterns that indicate a *human* operator rather
    // than a scripted one, so this is the detector that may block.
    findings.push({
      ...base,
      code: 'impossible_travel_between_attempts',
      severity: 'blocking',
      detector: 'identity.impossible_travel',
      observations: {
        km,
        hours: signals.lastTwoAttemptsHoursApart,
        maxKm: ANOMALY_THRESHOLDS.travel.maxKm,
      },
    });
  }

  if (signals.selfieMatchesAgainstOtherSubjects >= ANOMALY_THRESHOLDS.reuseMatchThreshold) {
    findings.push({
      ...base,
      code: 'selfie_reuse_signal',
      // A reused selfie can be a partner or a sibling helping someone through
      // onboarding, which is why this is a human decision and never a refusal.
      severity: 'review',
      detector: 'identity.selfie_reuse',
      observations: { matches: signals.selfieMatchesAgainstOtherSubjects },
    });
  }

  if (signals.documentMatchesAgainstOtherSubjects >= ANOMALY_THRESHOLDS.reuseMatchThreshold) {
    findings.push({
      ...base,
      code: 'document_reuse_signal',
      severity: 'review',
      detector: 'identity.document_reuse',
      observations: { matches: signals.documentMatchesAgainstOtherSubjects },
    });
  }

  if (signals.distinctAccountsFromNetworkIn24h >= ANOMALY_THRESHOLDS.networkVelocity.accounts) {
    findings.push({
      ...base,
      code: 'high_velocity_signups_from_network',
      // Recorded for the fraud team. The identity domain does not act on a
      // network-level signal on its own — a campus or a corporate NAT is not a
      // crime scene.
      severity: 'informational',
      detector: 'identity.network_velocity',
      observations: { accounts: signals.distinctAccountsFromNetworkIn24h, hours: 24 },
    });
  }

  if (signals.identityAttributeChangesIn30d >= ANOMALY_THRESHOLDS.identityAttributeChanges.count) {
    findings.push({
      ...base,
      code: 'identity_attributes_changed',
      severity: 'informational',
      detector: 'identity.attribute_churn',
      observations: { changes: signals.identityAttributeChangesIn30d, windowDays: 30 },
    });
  }

  return findings;
}

/** Highest severity present, or `null` when there are no findings. */
export function maxSeverity(findings: readonly AnomalyFinding[]): AnomalySeverity | null {
  let highest: AnomalySeverity | null = null;
  for (const finding of findings) {
    if (
      highest === null ||
      ANOMALY_SEVERITY_RANK[finding.severity] > ANOMALY_SEVERITY_RANK[highest]
    ) {
      highest = finding.severity;
    }
  }
  return highest;
}

export interface ReviewProposal {
  readonly subjectId: SubjectId;
  readonly detector: string;
  readonly findings: readonly AnomalyFinding[];
  /**
   * The only identity event an anomaly may ever cause. Typed as a single
   * literal so that "add enforcement here" is a compile error, not a code
   * review catch.
   */
  readonly identityEvent: 'flag_for_review';
}

/**
 * Turns findings into the one action this domain is allowed to take on them.
 * Returns `null` when nothing rises to `review`, so informational signals are
 * recorded without generating work for a human.
 */
export function proposeReview(findings: readonly AnomalyFinding[]): ReviewProposal | null {
  const actionable = findings.filter(
    (f) => ANOMALY_SEVERITY_RANK[f.severity] >= ANOMALY_SEVERITY_RANK.review,
  );
  const worst = actionable.reduce<AnomalyFinding | null>((acc, f) => {
    if (acc === null || ANOMALY_SEVERITY_RANK[f.severity] > ANOMALY_SEVERITY_RANK[acc.severity]) {
      return f;
    }
    return acc;
  }, null);
  if (worst === null) {
    return null;
  }
  return {
    subjectId: worst.subjectId,
    detector: worst.detector,
    findings: actionable,
    identityEvent: 'flag_for_review',
  };
}
