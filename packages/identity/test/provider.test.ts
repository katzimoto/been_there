import { describe, expect, it } from 'vitest';
import { type Result, type VerificationId, castId, ok } from '@been-there/core';
import {
  type ProviderSession,
  type ProviderSessionRequest,
  type ProviderVerificationResult,
  type VerificationAttempt,
  type VerificationProvider,
  classifyProviderFailure,
  completeFromProvider,
  providerFailureError,
  submitToProvider,
  type AnomalyFinding,
} from '../src/index.js';
import { SUBJECT, T0, hoursLater, providerResult } from './support.js';

function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

/**
 * A vendor adapter expressed only in the port's vocabulary. The point of this
 * double is that it contains no vendor concept at all: if a future adapter
 * needs one, the port has drifted and this file stops compiling.
 */
class VendorNeutralAdapter implements VerificationProvider {
  readonly label = 'primary';
  readonly requests: ProviderSessionRequest[] = [];
  readonly polled: string[] = [];
  readonly released: string[] = [];

  constructor(private readonly outcome: ProviderVerificationResult | null) {}

  async startSession(request: ProviderSessionRequest): Promise<Result<ProviderSession, never>> {
    this.requests.push(request);
    return ok({ sessionId: 'sess-1', startedAt: T0, expiresAt: hoursLater(1) });
  }

  async fetchResult(
    session: ProviderSession,
  ): Promise<Result<ProviderVerificationResult | null, never>> {
    this.polled.push(session.sessionId);
    return ok(this.outcome);
  }

  async releaseSession(session: ProviderSession): Promise<Result<void, never>> {
    this.released.push(session.sessionId);
    return ok(undefined);
  }
}

describe('provider failure classification', () => {
  it('treats a vendor outage as retryable and never as a user failure', () => {
    for (const reason of ['unavailable', 'rate_limited'] as const) {
      expect(classifyProviderFailure({ reason, retryable: true, detail: null })).toBe(
        'retry_later',
      );
    }
  });

  it('sends an unreadable capture back to the user', () => {
    for (const reason of ['rejected_capture', 'unsupported_document'] as const) {
      expect(classifyProviderFailure({ reason, retryable: false, detail: null })).toBe(
        'attempt_failed',
      );
    }
  });

  it('treats an unparseable vendor answer as our problem, not theirs', () => {
    expect(
      classifyProviderFailure({ reason: 'malformed_response', retryable: false, detail: null }),
    ).toBe('attempt_needs_review');
  });

  it('normalises a vendor error into the shared taxonomy', () => {
    const retryable = providerFailureError({
      reason: 'unavailable',
      retryable: true,
      detail: 'vendor 503',
    });
    expect(retryable.error.code).toBe('external_dependency_failed');
    expect(retryable.error.retryable).toBe(true);
    expect(retryable.error.details).toEqual({ reason: 'unavailable', detail: 'vendor 503' });

    const terminal = providerFailureError({
      reason: 'rejected_capture',
      retryable: false,
      detail: null,
    });
    expect(terminal.error.code).toBe('validation_failed');
    expect(terminal.error.retryable).toBe(false);
    expect(terminal.error.details).toEqual({ reason: 'rejected_capture' });
  });
});

describe('an adapter in the port vocabulary', () => {
  const attemptState: VerificationAttempt = {
    verificationId: castId<'VerificationId'>('vrf-1'),
    subjectId: SUBJECT,
    state: 'awaiting_provider',
    reVerification: false,
    reason: { code: 'onboarding' },
    startedAt: T0,
    updatedAt: T0,
    expiresAt: hoursLater(24),
    submittedAt: T0,
    completedChecks: ['document_authenticity', 'liveness', 'likeness'],
    evidence: [],
    confidence: null,
    decision: null,
    reviewerId: null,
  };

  it('turns a provider result into a domain decision with no vendor vocabulary in between', async () => {
    const adapter = new VendorNeutralAdapter(providerResult({ confidence: 0.96 }));
    const session = succeeded(
      await adapter.startSession({ correlationId: 'c', reVerification: false, checks: [] }),
    );
    const result = succeeded(await adapter.fetchResult(session));
    expect(result).not.toBeNull();
    expect(adapter.polled).toEqual([session.sessionId]);
    expect(adapter.requests).toEqual([{ correlationId: 'c', reVerification: false, checks: [] }]);

    const completed = succeeded(
      completeFromProvider(
        attemptState,
        'pending',
        result!,
        [] as readonly AnomalyFinding[],
        hoursLater(1),
      ),
    );
    expect(completed.attempt.state).toBe('passed');
    expect(completed.identity.state).toBe('verified');
    expect(completed.decision.rationale[0]).toContain('0.96');
  });

  it('treats an unfinished provider answer as waiting, not as a failure', async () => {
    const adapter = new VendorNeutralAdapter(null);
    const session = succeeded(
      await adapter.startSession({ correlationId: 'c', reVerification: false, checks: [] }),
    );
    expect(succeeded(await adapter.fetchResult(session))).toBeNull();
    // The attempt is still awaiting the provider, and is not terminal.
    expect(attemptState.state).toBe('awaiting_provider');
  });

  it('lets an adapter hand back a vendor session for erasure', async () => {
    const adapter = new VendorNeutralAdapter(null);
    const session = succeeded(
      await adapter.startSession({ correlationId: 'c', reVerification: false, checks: [] }),
    );
    await adapter.releaseSession(session);
    expect(adapter.released).toEqual(['sess-1']);
  });

  it('never lets a provider submission happen without the required checks', () => {
    const partial: VerificationAttempt = {
      ...attemptState,
      state: 'capturing',
      completedChecks: ['liveness'],
    };
    expect(submitToProvider(partial, T0).ok).toBe(false);
  });
});
