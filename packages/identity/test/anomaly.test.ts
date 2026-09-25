import { describe, expect, it } from 'vitest';
import {
  ANOMALY_THRESHOLDS,
  type AnomalyFinding,
  detectIdentityAnomalies,
  maxSeverity,
  proposeReview,
} from '../src/index.js';
import { SUBJECT, finding, quietSignals } from './support.js';

const codes = (findings: readonly AnomalyFinding[]) => findings.map((f) => f.code).sort();

describe('anomaly detectors', () => {
  it('finds nothing in a quiet account', () => {
    expect(detectIdentityAnomalies(quietSignals())).toEqual([]);
  });

  it('stays quiet just below every threshold', () => {
    const just = quietSignals({
      failedAttemptsInWindow: ANOMALY_THRESHOLDS.repeatedFailedAttempts.count - 1,
      declaredAgeYears: 30,
      evidenceAgeYears: 30 + ANOMALY_THRESHOLDS.ageDiscrepancyYears - 1,
      sharedDeviceAccountCount: ANOMALY_THRESHOLDS.sharedDeviceAccountCount - 1,
      lastTwoAttemptsKmApart: ANOMALY_THRESHOLDS.travel.maxKm - 1,
      lastTwoAttemptsHoursApart: 1,
      selfieMatchesAgainstOtherSubjects: ANOMALY_THRESHOLDS.reuseMatchThreshold - 1,
      documentMatchesAgainstOtherSubjects: ANOMALY_THRESHOLDS.reuseMatchThreshold - 1,
      distinctAccountsFromNetworkIn24h: ANOMALY_THRESHOLDS.networkVelocity.accounts - 1,
      identityAttributeChangesIn30d: ANOMALY_THRESHOLDS.identityAttributeChanges.count - 1,
    });
    expect(detectIdentityAnomalies(just)).toEqual([]);
  });

  it('fires every detector when every signal is extreme', () => {
    const findings = detectIdentityAnomalies(
      quietSignals({
        failedAttemptsInWindow: 7,
        declaredAgeYears: 25,
        evidenceAgeYears: 47,
        sharedDeviceAccountCount: 6,
        lastTwoAttemptsKmApart: 1200,
        lastTwoAttemptsHoursApart: 1,
        selfieMatchesAgainstOtherSubjects: 2,
        documentMatchesAgainstOtherSubjects: 1,
        distinctAccountsFromNetworkIn24h: 40,
        identityAttributeChangesIn30d: 9,
      }),
    );
    expect(codes(findings)).toEqual([
      'device_shared_across_accounts',
      'document_reuse_signal',
      'high_velocity_signups_from_network',
      'identity_attributes_changed',
      'implausible_age',
      'impossible_travel_between_attempts',
      'repeated_failed_attempts',
      'selfie_reuse_signal',
    ]);
  });

  it('never lets age estimation alone reach a blocking severity', () => {
    // Face-based age estimation is biased; a wide gap is a question, not a
    // verdict, so it can only ever ask for a human.
    const findings = detectIdentityAnomalies(
      quietSignals({ declaredAgeYears: 22, evidenceAgeYears: 52 }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe('implausible_age');
    expect(findings[0]?.severity).toBe('review');
  });

  it('ignores a fast journey that is also far enough apart in time to be possible', () => {
    expect(
      detectIdentityAnomalies(
        quietSignals({
          lastTwoAttemptsKmApart: ANOMALY_THRESHOLDS.travel.maxKm + 100,
          lastTwoAttemptsHoursApart: ANOMALY_THRESHOLDS.travel.minHours,
        }),
      ),
    ).toEqual([]);
  });

  it('reports counts and codes only, never an artefact', () => {
    const [reuse] = detectIdentityAnomalies(quietSignals({ selfieMatchesAgainstOtherSubjects: 3 }));
    expect(reuse).toBeDefined();
    expect(Object.keys(reuse!).sort()).toEqual([
      'code',
      'detectedAt',
      'detector',
      'observations',
      'severity',
      'subjectId',
    ]);
    for (const value of Object.values(reuse!.observations)) {
      expect(typeof value).toBe('number');
    }
  });

  it('ranks severities with the worst finding winning', () => {
    const findings = [
      finding('selfie_reuse_signal', 'review'),
      finding('high_velocity_signups_from_network', 'informational'),
      finding('impossible_travel_between_attempts', 'blocking'),
    ];
    expect(maxSeverity(findings)).toBe('blocking');
    expect(maxSeverity([findings[0]!, findings[1]!])).toBe('review');
    expect(maxSeverity([])).toBeNull();
  });
});

describe('turning findings into an action', () => {
  it('does nothing for informational findings alone', () => {
    const findings = detectIdentityAnomalies(
      quietSignals({ distinctAccountsFromNetworkIn24h: 50, identityAttributeChangesIn30d: 5 }),
    );
    expect(findings).toHaveLength(2);
    expect(proposeReview(findings)).toBeNull();
  });

  it('can only ever propose a flag for review', () => {
    const findings = detectIdentityAnomalies(quietSignals({ failedAttemptsInWindow: 9 }));
    const proposal = proposeReview(findings);
    expect(proposal?.identityEvent).toBe('flag_for_review');
    // The proposal has no field that could carry an enforcement action, and it
    // names no account state, so "just ban them from here" is unrepresentable.
    expect(Object.keys(proposal!).sort()).toEqual([
      'detector',
      'findings',
      'identityEvent',
      'subjectId',
    ]);
    expect(JSON.stringify(proposal)).not.toMatch(/suspend|ban|restrict|limited|account_state/);
  });

  it('reports the worst detector and only the actionable findings', () => {
    const findings = [
      ...detectIdentityAnomalies(quietSignals({ distinctAccountsFromNetworkIn24h: 50 })),
      ...detectIdentityAnomalies(quietSignals({ selfieMatchesAgainstOtherSubjects: 1 })),
    ];
    const proposal = proposeReview(findings);
    expect(proposal?.detector).toBe('identity.selfie_reuse');
    expect(proposal?.findings.map((f) => f.code)).toEqual(['selfie_reuse_signal']);
    expect(proposal?.subjectId).toBe(SUBJECT);
  });
});
