import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { UserId } from '@been-there/core';
import {
  CONFIDENCE_THRESHOLDS,
  DEFAULT_STUB_CONFIG,
  REQUIRED_CHECKS,
  StubVerificationProvider,
  stubProvider,
} from '@been-there/identity';
import { type Caller, type Harness, call, member, startHarness } from './support/harness.js';
import {
  BORDERLINE_RESULT,
  COMPLETE_PROFILE,
  PASSING_RESULT,
  createAccount,
} from './support/fixtures.js';

process.env['RISK_PAIRING_SECRET'] = 'verification-boundary-secret';

/** One artefact per required check, mirroring the capture rule in `verification.ts`. */
const ARTEFACTS = [
  { check: 'document_authenticity', kind: 'government_id_image' },
  { check: 'liveness', kind: 'liveness_video' },
  { check: 'likeness', kind: 'selfie_image' },
] as const;

/**
 * The verification boundary, asserted from outside the service.
 *
 * These exist because the boundary was not there. `provider-result` read
 * `confidence` and `checks` from the request body, so the subject could post
 * their own passing score and reach `verified` in one request — and the 0.9 floor
 * was applied faithfully, to a number they had chosen. A floor applied to a
 * subject-chosen number is not a weaker verification; it is no verification at
 * all.
 *
 * So each test here is a claim about a *route*, not about the domain. The domain
 * tests in `packages/identity` were green throughout and would have stayed green
 * with the route still reading the body, which is precisely why the wiring needed
 * evidence of its own.
 */
describe('the verification boundary', () => {
  let harness: Harness;
  const callers: Caller[] = [];

  beforeAll(async () => {
    harness = await startHarness(callers);
  });

  afterAll(async () => {
    await harness?.close();
  });

  /** A brand new account with a session of its own. */
  async function freshAccount(token: string): Promise<{ userId: UserId; token: string }> {
    const caller = member(token);
    callers.push(caller);
    const created = await createAccount(harness, token);
    caller.userId = created.userId;
    await call(harness, 'PUT', `/v1/accounts/${created.userId}/profile`, token, COMPLETE_PROFILE);
    return { userId: created.userId, token };
  }

  /** Open an attempt, capture one artefact per required check, and submit it. */
  async function startAndSubmit(
    userId: UserId,
    token: string,
  ): Promise<{ verificationId: string }> {
    const started = await call(
      harness,
      'POST',
      `/v1/accounts/${userId}/verification/attempts`,
      token,
      { reason: 'onboarding' },
    );
    expect(started.status).toBe(201);
    const verificationId = String(started.body['verificationId']);
    for (const artefact of ARTEFACTS) {
      const captured = await call(
        harness,
        'POST',
        `/v1/accounts/${userId}/verification/attempts/${verificationId}/captures`,
        token,
        {
          ...artefact,
          storageRef: `ref:${artefact.check}`,
          digest: artefact.check.padEnd(64, '0'),
        },
      );
      expect(captured.status).toBe(200);
    }
    const submitted = await call(
      harness,
      'POST',
      `/v1/accounts/${userId}/verification/attempts/${verificationId}/submit`,
      token,
    );
    expect(submitted.status).toBe(200);
    return { verificationId };
  }

  function askForResult(userId: UserId, token: string, verificationId: string, body?: unknown) {
    return call(
      harness,
      'POST',
      `/v1/accounts/${userId}/verification/attempts/${verificationId}/provider-result`,
      token,
      body,
    );
  }

  async function identityStateOf(userId: UserId, token: string): Promise<Record<string, unknown>> {
    const read = await call(harness, 'GET', `/v1/accounts/${userId}`, token);
    return read.body['identity'] as Record<string, unknown>;
  }

  /**
   * The regression this whole change exists to prevent.
   *
   * A member posts `confidence: 0.96` and every check `passed` — a score above
   * the floor, using the harness provider's own passing number. Before the change
   * this returned 200 with `identityState: "verified"`.
   */
  it('refuses a provider score posted by the subject, and does not grant verified', async () => {
    const { userId, token } = await freshAccount('selfcert');
    const { verificationId } = await startAndSubmit(userId, token);

    const posted = await askForResult(userId, token, verificationId, {
      providerReference: 'self-asserted',
      confidence: 0.96,
      checks: REQUIRED_CHECKS.map((check) => ({ check, outcome: 'passed', score: 1, reason: null })),
    });

    expect(posted.status).toBe(400);
    const error = posted.body['error'] as Record<string, unknown>;
    expect(error['code']).toBe('validation_failed');

    // The account is untouched: still `pending`, and nothing was decided.
    const identity = await identityStateOf(userId, token);
    expect(identity['state']).toBe('pending');
    expect(identity['discoverable']).toBe(false);
  });

  /**
   * The refusal has to be specific, or a caller cannot tell a rejected score from
   * a malformed request and will "fix" it by retrying the same thing.
   */
  it('names the refused fields and the provider mode in the refusal', async () => {
    const { userId, token } = await freshAccount('refusaldetail');
    const { verificationId } = await startAndSubmit(userId, token);
    const posted = await askForResult(userId, token, verificationId, { confidence: 0.99 });

    expect(posted.status).toBe(400);
    const error = posted.body['error'] as Record<string, unknown>;
    expect(error['message']).toContain('not accepted from a client');
    const details = error['details'] as Record<string, unknown>;
    expect(details['refusedFields']).toBe('confidence');
    // The mode rides in the refusal as well as in readiness, so a caller
    // debugging a rejected score learns why there was a provider to ask at all.
    expect(details['providerMode']).toBe('stub');
  });

  /**
   * The positive case, and it is a separate assertion on purpose.
   *
   * "Refused a client score" and "reached verified" are opposite failures, and a
   * suite asserting only the first would stay green if the route were simply
   * disconnected — refusing everything and verifying nobody. This proves the path
   * is live by driving it through the provider.
   */
  it('does reach verified when the configured provider reports a passing score', async () => {
    const { userId, token } = await freshAccount('passing');
    const { verificationId } = await startAndSubmit(userId, token);
    harness.verification.scoreAs(PASSING_RESULT.confidence);

    const recorded = await askForResult(userId, token, verificationId);
    expect(recorded.status).toBe(200);
    expect(recorded.body['decision']).toBe('pass');
    expect(recorded.body['identityState']).toBe('verified');
    expect((await identityStateOf(userId, token))['state']).toBe('verified');
  });

  /**
   * The floor is still a real control, and it is applied to the provider's number
   * rather than to the subject's. This is the assertion that would catch a "fix"
   * which lowered the threshold to keep the old body-posting tests passing.
   */
  it('still routes a below-floor provider score to a human', async () => {
    const { userId, token } = await freshAccount('borderline');
    const { verificationId } = await startAndSubmit(userId, token);
    harness.verification.scoreAs(BORDERLINE_RESULT.confidence);

    const recorded = await askForResult(userId, token, verificationId);
    expect(recorded.status).toBe(200);
    expect(recorded.body['decision']).toBe('manual_review');
    expect(recorded.body['identityState']).toBe('review_required');
    expect(Number(recorded.body['confidence'])).toBeLessThan(CONFIDENCE_THRESHOLDS.verifiedFloor);
  });

  /**
   * A provider that has not finished is the ordinary waiting case, not a failure.
   *
   * Nothing in the production stub reaches it — `stubProvider` answers
   * immediately — so this is the only coverage of the port's `null` branch
   * anywhere in the repository.
   */
  it('answers 202 and decides nothing while the provider is still working', async () => {
    const { userId, token } = await freshAccount('pending');
    const { verificationId } = await startAndSubmit(userId, token);
    harness.verification.deferOnce();

    const pending = await askForResult(userId, token, verificationId);
    expect(pending.status).toBe(202);
    expect(pending.body['pending']).toBe(true);
    expect(pending.body['providerMode']).toBe('stub');
    expect((await identityStateOf(userId, token))['state']).not.toBe('verified');

    // And the next poll, once the provider answers, decides normally — so the 202
    // is a wait rather than a dead end.
    harness.verification.scoreAs(PASSING_RESULT.confidence);
    const finished = await askForResult(userId, token, verificationId);
    expect(finished.status).toBe(200);
    expect(finished.body['identityState']).toBe('verified');
  });

  /**
   * The provider reference actually reaches the database.
   *
   * The erasure path in `evidence.ts` propagates to the adapter by session id, and
   * `releaseSession` was unreachable because the column was never written — the
   * old code passed a hardcoded `null`. If this regresses to `null` the adapter
   * becomes unfreeable and nobody would notice until an erasure request.
   */
  it('persists the provider session id that the submit call opened', async () => {
    const { userId, token } = await freshAccount('sessionref');
    const { verificationId } = await startAndSubmit(userId, token);

    const row = await harness.transaction.run(async (tx) =>
      harness.stores.verificationAttempts.find(verificationId, tx),
    );
    expect(row).not.toBeNull();
    expect(row?.['providerReference']).toBe(`harness-session-${verificationId}`);
    expect(
      harness.verification.started.some((request) => request.correlationId === verificationId),
    ).toBe(true);
  });
});

describe('the stub provider declares itself', () => {
  it('reports mode stub, never vendor, and has no default to fall into', () => {
    const provider = stubProvider();
    expect(provider.mode).toBe('stub');
    expect(provider.label).toBe('stub');
  });

  it('answers every required check, so the domain machinery is fully exercised', async () => {
    const provider = stubProvider();
    const session = await provider.startSession({
      correlationId: 'attempt-1',
      reVerification: false,
      checks: REQUIRED_CHECKS,
    });
    expect(session.ok).toBe(true);
    if (!session.ok) {
      return;
    }
    const result = await provider.fetchResult(session.value);
    expect(result.ok).toBe(true);
    if (!result.ok || result.value === null) {
      throw new Error('the stub answered nothing');
    }
    expect(result.value.checks.map((check) => check.check).sort()).toEqual(
      [...REQUIRED_CHECKS].sort(),
    );
    // Every asserted check says so. A `passed` that reads as measured is the exact
    // misreading this whole change exists to prevent.
    for (const check of result.value.checks) {
      expect(check.reason).toContain('no capture was examined');
    }
  });

  it('writes a provider reference that names the stub, for every reference it mints', async () => {
    const provider = new StubVerificationProvider(DEFAULT_STUB_CONFIG);
    const session = await provider.startSession({
      correlationId: 'attempt-1',
      reVerification: false,
      checks: REQUIRED_CHECKS,
    });
    if (!session.ok) {
      throw new Error('the stub refused to start');
    }
    // The session id reaches the `provider_reference` column, so this prefix is
    // what a future reader can match on in a database.
    expect(session.value.sessionId.startsWith('stub-session-')).toBe(true);
    const result = await provider.fetchResult(session.value);
    if (!result.ok || result.value === null) {
      throw new Error('the stub answered nothing');
    }
    expect(result.value.providerReference.startsWith('stub-session-')).toBe(true);
  });

  it('clears the 0.9 floor by default, so the machine stays reachable', () => {
    expect(DEFAULT_STUB_CONFIG.confidence).toBeGreaterThanOrEqual(
      CONFIDENCE_THRESHOLDS.verifiedFloor,
    );
  });

  it('refuses a configuration that could never be a real confidence', async () => {
    for (const confidence of [Number.NaN, -0.1, 1.4]) {
      const provider = stubProvider({
        confidence,
        referenceSuffix: 'misconfigured',
        sessionTtlMs: 1000,
      });
      const session = await provider.startSession({
        correlationId: 'attempt-1',
        reVerification: false,
        checks: REQUIRED_CHECKS,
      });
      expect(session.ok).toBe(false);
    }
  });

  it('refuses a session asked to run nothing, rather than asserting a vacuous pass', async () => {
    const provider = stubProvider();
    const session = await provider.startSession({
      correlationId: 'attempt-1',
      reVerification: false,
      checks: [],
    });
    expect(session.ok).toBe(false);
  });
});