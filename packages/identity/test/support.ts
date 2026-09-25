import { type SubjectId, type VerificationId, castId } from '@been-there/core';
import type {
  AnomalyCode,
  AnomalyFinding,
  AnomalySeverity,
  AnomalySignals,
  ProviderCheckOutcome,
  ProviderCheckResult,
  ProviderVerificationResult,
  VerificationAttempt,
  VerificationCheck,
} from '../src/index.js';

/**
 * Shared fixtures. Deliberately builders with explicit overrides rather than
 * one frozen "golden" object, so a test that cares about a single input can say
 * so in one line and a test that changes one signal cannot accidentally change
 * another.
 */

export const T0 = new Date('2026-03-01T09:00:00.000Z');

export function hoursLater(hours: number, from: Date = T0): Date {
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

export function daysLater(days: number, from: Date = T0): Date {
  return hoursLater(days * 24, from);
}

export const SUBJECT: SubjectId = castId<'SubjectId'>('user-1');

export function check(
  name: VerificationCheck,
  outcome: ProviderCheckOutcome,
  score: number | null = 0.97,
): ProviderCheckResult {
  return {
    check: name,
    outcome,
    score,
    reason: outcome === 'passed' ? null : `${name} ${outcome}`,
  };
}

export function passingChecks(): readonly ProviderCheckResult[] {
  return [
    check('document_authenticity', 'passed', 0.98),
    check('liveness', 'passed', 0.99),
    check('likeness', 'passed', 0.97),
  ];
}

export function providerResult(
  overrides: {
    confidence?: number;
    checks?: readonly ProviderCheckResult[];
    completedAt?: Date;
  } = {},
): ProviderVerificationResult {
  return {
    providerReference: 'prov-ref-1',
    confidence: overrides.confidence ?? 0.95,
    checks: overrides.checks ?? passingChecks(),
    completedAt: overrides.completedAt ?? hoursLater(1),
  };
}

export function quietSignals(overrides: Partial<AnomalySignals> = {}): AnomalySignals {
  return {
    subjectId: SUBJECT,
    now: T0,
    failedAttemptsInWindow: 0,
    windowDays: 30,
    declaredAgeYears: 30,
    evidenceAgeYears: 31,
    sharedDeviceAccountCount: 1,
    lastTwoAttemptsKmApart: null,
    lastTwoAttemptsHoursApart: 24,
    selfieMatchesAgainstOtherSubjects: 0,
    documentMatchesAgainstOtherSubjects: 0,
    distinctAccountsFromNetworkIn24h: 0,
    identityAttributeChangesIn30d: 0,
    ...overrides,
  };
}

export function finding(
  code: AnomalyCode,
  severity: AnomalySeverity,
  subjectId: SubjectId = SUBJECT,
): AnomalyFinding {
  return {
    code,
    severity,
    detector: `test.${code}`,
    subjectId,
    detectedAt: T0,
    observations: { n: 1 },
  };
}

export function attemptInFlight(overrides: Partial<VerificationAttempt> = {}): VerificationAttempt {
  return {
    verificationId: castId<'VerificationId'>('vrf-live'),
    subjectId: SUBJECT,
    state: 'awaiting_provider',
    reVerification: false,
    reason: { code: 'onboarding' },
    startedAt: T0,
    updatedAt: T0,
    expiresAt: hoursLater(24),
    submittedAt: hoursLater(1),
    completedChecks: ['document_authenticity', 'liveness', 'likeness'],
    evidence: [],
    confidence: null,
    decision: null,
    reviewerId: null,
    ...overrides,
  };
}
