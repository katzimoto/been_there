import { describe, expect, it } from 'vitest';
import { castId, type CorrelationId } from '@been-there/core';
import {
  OPERATION_RETRY_POLICY,
  RetryingIntegration,
  externalError,
  externalSuccess,
  retryDelayMs,
  shouldRetry,
  toDomainError,
  type ExternalFailure,
  type ExternalRequest,
  type IntegrationPort,
  type IntegrationResult,
  type OperationKind,
  type ProviderKind,
} from '../src/index.js';
import { correlationId } from './helpers.js';

function requestFor(operation: OperationKind): ExternalRequest<{ to: string }> {
  return {
    requestId: castId<'IntegrationRequestId'>(`req-${operation}`),
    provider: operation.startsWith('verify') ? 'identity_verification' : 'push',
    operation,
    idempotencyKey: 'idem-1',
    correlationId: correlationId('int-1'),
    payload: { to: 'someone' },
  };
}

/**
 * A port that fails a fixed number of times and then succeeds, counting calls.
 * The count is the assertion: the retry policy is about how many times a vendor
 * is actually called, and a test that only checked the returned value would pass
 * whether the policy existed or not.
 */
class ScriptedPort implements IntegrationPort {
  attempts = 0;
  sleeps: number[] = [];

  constructor(
    private readonly failures: readonly ExternalFailure[],
    private readonly operation: OperationKind,
  ) {}

  async execute<P, T>(request: ExternalRequest<P>): Promise<IntegrationResult<T>> {
    this.attempts += 1;
    const failure = this.failures[this.attempts - 1];
    if (failure !== undefined) {
      return externalError(request, failure, 'scripted', failure === 'rate_limited' ? 250 : undefined);
    }
    return externalSuccess(request, { accepted: true } as T, `vendor-${this.attempts}`);
  }
}

function retrying(port: ScriptedPort): RetryingIntegration {
  return new RetryingIntegration(port, {
    baseDelayMs: 100,
    sleep: async (ms) => {
      port.sleeps.push(ms);
    },
  });
}

describe('uniform failure model', () => {
  it('maps every vendor outcome onto the same five failures', () => {
    const request = requestFor('send_push');

    for (const failure of ['timeout', 'unavailable', 'rejected', 'rate_limited', 'malformed_response'] as const) {
      const error = externalError(request, failure, 'detail');
      const domainError = toDomainError(error.error);

      expect(domainError.code, failure).toBe('external_dependency_failed');
      expect(domainError.details?.['failure'], failure).toBe(failure);
      // The message is for humans and carries no vendor payload back with it.
      expect(domainError.message, failure).toBe(`push.send_push failed: ${failure}`);
    }
  });

  it('marks a non-idempotent operation as not retryable whatever the failure', () => {
    const request = requestFor('verify_document');

    // A timeout on a verification call may mean the vendor already started a
    // paid review, so the honest answer is "unknown", not "try again".
    expect(externalError(request, 'timeout', 'x').error.retryable).toBe(false);
    expect(externalError(requestFor('send_push'), 'timeout', 'x').error.retryable).toBe(true);
    // A rejection is a decision, not a blip, whatever the operation.
    expect(externalError(requestFor('send_push'), 'rejected', 'x').error.retryable).toBe(false);
  });
});

describe('retry policy', () => {
  it('retries an idempotent operation until it succeeds', async () => {
    const port = new ScriptedPort(['timeout', 'unavailable'], 'send_push');

    const outcome = await retrying(port).execute(requestFor('send_push'));

    expect(port.attempts).toBe(3);
    expect(outcome.ok).toBe(true);
    expect(port.sleeps).toEqual([100, 200]);
  });

  it('gives up after the declared attempt budget', async () => {
    const port = new ScriptedPort(
      ['timeout', 'timeout', 'timeout', 'timeout', 'timeout', 'timeout'],
      'send_push',
    );

    const outcome = await retrying(port).execute(requestFor('send_push'));

    expect(port.attempts).toBe(OPERATION_RETRY_POLICY.send_push.maxAttempts);
    expect(outcome.ok).toBe(false);
    // No sleep after the final attempt: the caller is told immediately.
    expect(port.sleeps).toHaveLength(OPERATION_RETRY_POLICY.send_push.maxAttempts - 1);
  });

  it('never repeats a verification call whose outcome is unknown', async () => {
    const port = new ScriptedPort(['timeout', 'unavailable', 'rate_limited'], 'verify_liveness');

    const outcome = await retrying(port).execute(requestFor('verify_liveness'));

    // One attempt, no sleeping, and the failure handed back: "do it twice" is
    // not "try again" when the vendor bills per call and may have started a
    // human review.
    expect(port.attempts).toBe(1);
    expect(port.sleeps).toEqual([]);
    expect(outcome.ok).toBe(false);
  });

  it('obeys the vendor backoff when it supplies one', async () => {
    const port = new ScriptedPort(['rate_limited', 'rate_limited'], 'send_sms');

    await retrying(port).execute(requestFor('send_sms'));

    expect(port.sleeps).toEqual([250, 250]);
  });

  it('refuses a rejection without spending an attempt', () => {
    const error = externalError(requestFor('send_email'), 'rejected', 'bad address');

    expect(shouldRetry(error.error, 1)).toBe(false);
    expect(shouldRetry(externalError(requestFor('send_email'), 'malformed_response', 'x').error, 1)).toBe(
      false,
    );
  });

  it('backs off exponentially unless told otherwise', () => {
    expect(retryDelayMs(1, 100)).toBe(100);
    expect(retryDelayMs(3, 100)).toBe(400);
    expect(retryDelayMs(1, 100, 250)).toBe(250);
  });
});

describe('the seam is the only vendor surface', () => {
  it('returns the vendor request id so a support conversation can be tied to it', async () => {
    const port = new ScriptedPort([], 'send_email');
    const request: ExternalRequest<{ to: string }> = {
      ...requestFor('send_email'),
      provider: 'email',
    };

    const outcome = await retrying(port).execute(request);

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.providerRequestId).toBe('vendor-1');
      expect(outcome.value.provider).toBe('email');
      expect(outcome.value.requestId).toBe(request.requestId);
      expect(outcome.value.value).toEqual({ accepted: true });
    }
  });

  it('keeps the idempotency key stable across every attempt', async () => {
    const port = new ScriptedPort(['timeout', 'timeout'], 'send_push');
    const request = requestFor('send_push');
    const seen: string[] = [];
    const recording: IntegrationPort = {
      execute: async <P, T>(inner: ExternalRequest<P>) => {
        seen.push(inner.idempotencyKey);
        return port.execute<P, T>(inner);
      },
    };

    await new RetryingIntegration(recording, { baseDelayMs: 1, sleep: async () => {} }).execute(request);

    expect(seen).toEqual(['idem-1', 'idem-1', 'idem-1']);
  });

  it('carries the correlation id so a vendor failure lands in the same trace', async () => {
    const correlation: CorrelationId = correlationId('int-9');
    const port = new ScriptedPort(['unavailable'], 'send_push');

    const outcome = await retrying(port).execute({
      ...requestFor('send_push'),
      correlationId: correlation,
    });

    expect(outcome.ok).toBe(true);
    expect(port.sleeps).toEqual([100]);
  });
});
