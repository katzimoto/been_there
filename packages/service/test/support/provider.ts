import {
  type ProviderSession,
  type ProviderSessionRequest,
  type ProviderVerificationResult,
  type VerificationCheck,
  type VerificationProvider,
} from '@been-there/identity';
import { type Result, ok } from '@been-there/core';

/**
 * The verification provider a suite runs against.
 *
 * ## Why the harness owns one at all
 *
 * `ServiceDependencies.verification` is required, so a harness that did not supply
 * a provider could not construct a service. That is the intended consequence: it
 * is what stops any composition root — test, demo or deployment — from falling
 * back to reading a score off the request body.
 *
 * But a suite needs to reach *both* sides of the 0.9 floor, and
 * `service.test.ts` asserts that a result below it routes to a human instead of
 * granting `verified`. A stub with one fixed confidence cannot do that, so this
 * is the production stub with its score made settable per attempt.
 *
 * ## What it deliberately does not do
 *
 * It does not invent a second port, and it does not reimplement the decision.
 * `confidence` and `checks` still flow into `completeFromProvider` and the
 * identity machine exactly as a vendor's would; only the *source* of the number
 * is a fixture, which is the whole of what is being simulated.
 */
export class HarnessVerificationProvider implements VerificationProvider {
  readonly mode = 'stub' as const;
  readonly label = 'harness-stub';

  /** Every session this provider opened, oldest first. */
  readonly started: ProviderSessionRequest[] = [];
  /** Every result this provider handed back, oldest first. */
  readonly answered: ProviderVerificationResult[] = [];

  private score: number;
  private checks: readonly VerificationCheck[];
  private pending = false;

  /**
   * @param confidence The score to hand back. Defaults above the 0.9 floor, which
   * is the common case in the suites that are not about the threshold.
   */
  constructor(
    confidence = 0.96,
    checks: readonly VerificationCheck[] = ['document_authenticity', 'liveness', 'likeness'],
  ) {
    this.score = confidence;
    this.checks = checks;
  }

  /**
   * The score the next `fetchResult` reports.
   *
   * Set per attempt rather than per harness because a suite needs both sides of
   * the floor inside one harness: `service.test.ts` proves a borderline result
   * routes to review and a passing one grants verified, in the same suite.
   */
  scoreAs(confidence: number): void {
    this.score = confidence;
  }

  /**
   * Makes the next `fetchResult` return `null` — the ordinary "not finished yet".
   *
   * Only reachable from a suite, and it exists because the port's waiting branch
   * is the one the production stub never exercises: `stubProvider` answers
   * immediately, so nothing else in the repository would cover the 202 path.
   */
  deferOnce(): void {
    this.pending = true;
  }

  async startSession(request: ProviderSessionRequest): Promise<Result<ProviderSession, never>> {
    this.started.push(request);
    return ok({
      sessionId: `harness-session-${request.correlationId}`,
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
  }

  async fetchResult(
    _session: ProviderSession,
  ): Promise<Result<ProviderVerificationResult | null, never>> {
    if (this.pending) {
      this.pending = false;
      return ok(null);
    }
    const result: ProviderVerificationResult = {
      // Prefixed like the production stub's, so a row written by a suite is
      // identifiable in a development database by the same rule as any other.
      providerReference: `harness-session-${this.score}`,
      confidence: this.score,
      checks: this.checks.map((check) => ({
        check,
        outcome: 'passed' as const,
        score: null,
        reason: 'asserted by the harness provider; no capture was examined',
      })),
      completedAt: new Date(),
    };
    this.answered.push(result);
    return ok(result);
  }

  async releaseSession(_session: ProviderSession): Promise<Result<void, never>> {
    return ok(undefined);
  }
}

/**
 * A provider for a suite that assembles its own service.
 *
 * These suites build `ServiceDependencies` directly rather than through
 * `startHarness` — because they need faulted stores, a controlled clock, or a
 * child process — so they cannot reach the instance `Harness` carries. They get
 * this instead.
 *
 * A fresh instance per call, not a shared singleton: a suite that moves the score
 * across the floor must not silently move it for a suite running beside it in the
 * same process.
 */
export function harnessVerificationProvider(confidence = 0.96): HarnessVerificationProvider {
  return new HarnessVerificationProvider(confidence);
}