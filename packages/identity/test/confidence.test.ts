import { describe, expect, it } from 'vitest';
import { type Result, identityMachine } from '@been-there/core';
import {
  CONFIDENCE_THRESHOLDS,
  type VerificationCheck,
  classifyConfidence,
  decideVerificationOutcome,
  makeConfidence,
} from '../src/index.js';
import { check, finding, passingChecks } from './support.js';

function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

function errorCode<T, E extends { code: string }>(result: Result<T, E>): string {
  if (result.ok) {
    throw new Error('expected a rejection');
  }
  return result.error.code;
}

describe('confidence bounds', () => {
  it('rejects the values a broken adapter produces', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01]) {
      expect(errorCode(makeConfidence(value))).toBe('validation_failed');
      expect(classifyConfidence(value)).toBe('unusable');
    }
  });

  it('accepts the closed interval and classifies every band', () => {
    expect(succeeded(makeConfidence(0)).value).toBe(0);
    expect(succeeded(makeConfidence(1)).value).toBe(1);
    expect(classifyConfidence(0)).toBe('insufficient');
    expect(classifyConfidence(CONFIDENCE_THRESHOLDS.autoFailFloor - 0.01)).toBe('insufficient');
    expect(classifyConfidence(CONFIDENCE_THRESHOLDS.autoFailFloor)).toBe('borderline');
    expect(classifyConfidence(CONFIDENCE_THRESHOLDS.verifiedFloor - 0.01)).toBe('borderline');
    expect(classifyConfidence(CONFIDENCE_THRESHOLDS.verifiedFloor)).toBe('sufficient');
  });

  it('agrees with the shared kernel about where verified begins', () => {
    // The guard in packages/core/src/states/identity.ts is the other half of
    // this policy. If the two ever disagree, someone gets verified the hard
    // way or fails the easy way, so the boundary is asserted from both sides.
    const at = CONFIDENCE_THRESHOLDS.verifiedFloor;
    expect(identityMachine.can('pending', 'provider_result_received', { confidence: at })).toBe(
      true,
    );
    expect(
      identityMachine.can('pending', 'provider_result_received', { confidence: at - 0.001 }),
    ).toBe(false);
    expect(decideVerificationOutcome({ confidence: at, checks: passingChecks() }).decision).toBe(
      'pass',
    );
    expect(
      decideVerificationOutcome({ confidence: at - 0.001, checks: passingChecks() }).decision,
    ).toBe('manual_review');
  });
});

describe('verification decision precedence', () => {
  it('never auto-resolves on an unusable confidence value', () => {
    const decision = decideVerificationOutcome({ confidence: Number.NaN, checks: passingChecks() });
    expect(decision.decision).toBe('manual_review');
    expect(decision.confidence.band).toBe('unusable');
  });

  it('sends a missing required check to a human rather than passing it', () => {
    const withoutLikeness = passingChecks().filter((c) => c.check !== 'likeness');
    const decision = decideVerificationOutcome({ confidence: 0.99, checks: withoutLikeness });
    expect(decision.decision).toBe('manual_review');
    expect(decision.missingChecks).toEqual<VerificationCheck[]>(['likeness']);
  });

  it('sends an inconclusive required check to a human and ignores unperformed extras', () => {
    const inconclusive = decideVerificationOutcome({
      confidence: 0.99,
      checks: passingChecks().map((c) =>
        c.check === 'liveness' ? check('liveness', 'inconclusive', 0.6) : c,
      ),
    });
    expect(inconclusive.decision).toBe('manual_review');

    // `document_to_selfie_match` is not required, so a provider that does not
    // offer it must not hold up a real verification.
    const extraNotPerformed = decideVerificationOutcome({
      confidence: 0.99,
      checks: [...passingChecks(), check('document_to_selfie_match', 'not_performed', null)],
    });
    expect(extraNotPerformed.decision).toBe('pass');
  });

  it('lets a blocking anomaly outrank a hard check failure', () => {
    const decision = decideVerificationOutcome({
      confidence: 0.2,
      checks: passingChecks().map((c) =>
        c.check === 'likeness' ? check('likeness', 'failed', 0.1) : c,
      ),
      anomalies: [finding('impossible_travel_between_attempts', 'blocking')],
    });
    expect(decision.decision).toBe('manual_review');
    expect(decision.rationale[0]).toContain('impossible_travel_between_attempts');
  });

  it('fails a hard check failure that the provider itself agrees with', () => {
    const decision = decideVerificationOutcome({
      confidence: 0.3,
      checks: passingChecks().map((c) =>
        c.check === 'likeness' ? check('likeness', 'failed', 0.1) : c,
      ),
    });
    expect(decision.decision).toBe('fail');
  });

  it('refuses to auto-decide on a result that contradicts itself', () => {
    // A failed required check reported next to a 0.98 overall score is either a
    // broken adapter or a person with two identities. Neither is a reason to
    // auto-fail a human.
    const decision = decideVerificationOutcome({
      confidence: 0.98,
      checks: passingChecks().map((c) =>
        c.check === 'likeness' ? check('likeness', 'failed', 0.1) : c,
      ),
    });
    expect(decision.decision).toBe('manual_review');
  });

  it('splits the confidence bands exactly as the policy states', () => {
    expect(decideVerificationOutcome({ confidence: 0.2, checks: passingChecks() }).decision).toBe(
      'fail',
    );
    expect(decideVerificationOutcome({ confidence: 0.6, checks: passingChecks() }).decision).toBe(
      'manual_review',
    );
    expect(decideVerificationOutcome({ confidence: 0.95, checks: passingChecks() }).decision).toBe(
      'pass',
    );
  });

  it('lets a review-level anomaly outrank a passing score', () => {
    const decision = decideVerificationOutcome({
      confidence: 0.99,
      checks: passingChecks(),
      anomalies: [finding('selfie_reuse_signal', 'review')],
    });
    expect(decision.decision).toBe('manual_review');
  });

  it('leaves an informational anomaly alone', () => {
    const decision = decideVerificationOutcome({
      confidence: 0.99,
      checks: passingChecks(),
      anomalies: [finding('high_velocity_signups_from_network', 'informational')],
    });
    expect(decision.decision).toBe('pass');
  });

  it('always explains itself, quoting the value it decided on', () => {
    for (const confidence of [0.2, 0.6, 0.95]) {
      const decision = decideVerificationOutcome({ confidence, checks: passingChecks() });
      expect(decision.rationale.length).toBeGreaterThan(0);
      expect(decision.rationale.join(' ')).toContain(String(confidence));
    }
  });
});
