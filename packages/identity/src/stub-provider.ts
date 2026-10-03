import { type DomainError, type Result, domainError, ok } from '@been-there/core';
import {
  type ProviderCheckResult,
  type ProviderMode,
  type ProviderSession,
  type ProviderSessionRequest,
  type ProviderVerificationResult,
  type VerificationCheck,
  type VerificationProvider,
} from './provider.js';

/**
 * The stub provider, and the only implementation of the port in this repository.
 *
 * ## What this is
 *
 * A decision was taken to keep verification stubbed, and it stands: the identity
 * machine, the attempt lifecycle, the evidence retention table and the 0.9 floor
 * are all real, and only the score is chosen. This class is where that choice
 * lives, so it is a first-class citizen of the domain package rather than a
 * helper buried in a test file.
 *
 * ## Why it has to announce itself
 *
 * Before this existed, the port had no implementation outside a test, and the
 * service route that consumes a provider result read `confidence` and `checks`
 * out of the request body. The fixture was therefore not merely unwired — it was
 * *inverted*. The subject could post their own score, the 0.9 floor was applied
 * faithfully, and the product reported a verified account. A real floor applied
 * to a number the subject chose is not a weaker verification; it is no
 * verification at all, and nothing in readiness, metrics or logs said so.
 *
 * So this stub is deliberately incapable of being mistaken for a vendor:
 *
 *  - it declares `mode: 'stub'`, which `ServiceHealth` reports at
 *    `/v1/health/ready` and refuses to default;
 *  - every `providerReference` it mints is prefixed `stub-session-`, so a row
 *    written through this adapter is identifiable in the database years later
 *    without asking the code that wrote it;
 *  - it examines nothing, because it *cannot* — see the artefact gap documented
 *    on the port. It has no captures, and a score is not a measurement it made.
 *
 * ## What it will not do
 *
 * It will not fail a person. A stub that returned failures would make lookalike
 * accounts unreportable for reasons no human chose, which is a worse artefact
 * than a fixture that passes everyone. So it is configured with an explicit
 * score and it returns that, and `mode: 'stub'` is what tells a deployment the
 * score meant nothing.
 */

/**
 * What the stub was configured to say.
 *
 * The checks are *asserted*, not performed. They are recorded as `passed` so the
 * domain's own `REQUIRED_CHECKS` machinery and the 0.9 floor run exactly as they
 * would against a vendor — the decision machinery is under test, which is the
 * thing worth having from a stub. What is not under test is whether the person
 * is real, and nothing here claims to be.
 */
export interface StubProviderConfig {
  readonly confidence: number;
  /** The reference the stub reports having produced its answer. Prefixed by the stub. */
  readonly referenceSuffix: string;
  /** How long a started session accepts polling. */
  readonly sessionTtlMs: number;
}

/**
 * The default, and the reason it is named rather than inlined.
 *
 * 0.96 clears `CONFIDENCE_THRESHOLDS.verifiedFloor` (0.9) with margin, which is
 * what makes the machine and the floor reachable in a demo without someone having
 * to know the number. It is a *declared* default: a deployment that never calls
 * `stubProvider()` still has to be handed a provider explicitly, so nothing here
 * can become a silent default for the service.
 */
export const DEFAULT_STUB_CONFIG: StubProviderConfig = {
  confidence: 0.96,
  referenceSuffix: 'declared-default',
  sessionTtlMs: 30 * 60 * 1000,
};

/**
 * The checks the stub answers for.
 *
 * Copied from `REQUIRED_CHECKS` rather than imported so this file stands alone as
 * the thing a reader opens when asking "what does the stub actually do?". The
 * adapter tests assert the copy agrees with the published list, so it cannot
 * drift silently.
 */
const ASSERTED_CHECKS: readonly ProviderCheckResult[] = ([
  'document_authenticity',
  'liveness',
  'likeness',
] as const satisfies readonly VerificationCheck[]).map((check) => ({
  check,
  outcome: 'passed' as const,
  score: null,
  // Stated in the row rather than left to be inferred. A reviewer opening this
  // evidence years later should not have to guess whether a `passed` meant
  // somebody checked.
  reason: 'asserted by the stub provider; no capture was examined',
}));

/**
 * A `VerificationProvider` that asserts a configured score and says so.
 *
 * Deliberately constructed rather than exported as a ready-made singleton: the
 * point is that a deployment has to hold one, and holding it is what lets the
 * readiness report say anything at all.
 */
export class StubVerificationProvider implements VerificationProvider {
  readonly mode: ProviderMode = 'stub';
  readonly label = 'stub';

  /** Sessions started and released. Read by the adapter tests to assert the lifecycle. */
  readonly started: string[] = [];
  readonly released: string[] = [];

  constructor(
    private readonly config: StubProviderConfig = DEFAULT_STUB_CONFIG,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async startSession(request: ProviderSessionRequest): Promise<Result<ProviderSession, DomainError>> {
    const at = this.now();
    // Validated here rather than at the point of use: a stub configured with a
    // confidence outside 0..1 would otherwise reach `makeConfidence` as a
    // confusing validation failure much later, attributed to a provider that
    // never ran.
    if (!Number.isFinite(this.config.confidence) || this.config.confidence < 0 || this.config.confidence > 1) {
      return domainError(
        'external_dependency_failed',
        'identity',
        'stub provider configured with a confidence outside 0..1',
        { confidence: this.config.confidence, mode: 'stub' },
      );
    }
    if (request.checks.length === 0) {
      return domainError(
        'external_dependency_failed',
        'identity',
        'stub provider was asked to run no checks',
        { correlationId: request.correlationId, mode: 'stub' },
      );
    }
    this.started.push(request.correlationId);
    return ok({
      // Prefixed, always. This string reaches the `provider_reference` column,
      // which is the one place a future reader can ask "was this a real vendor?"
      // without trusting a process that has since been redeployed.
      sessionId: `stub-session-${request.correlationId}`,
      startedAt: at,
      expiresAt: new Date(at.getTime() + this.config.sessionTtlMs),
    });
  }

  /**
   * Answers immediately.
   *
   * A real vendor is asynchronous and returns `null` for the ordinary waiting
   * case; the stub has nothing to wait for, so it answers on the first poll. The
   * `null` branch is therefore *not* exercised by this adapter, which is worth
   * knowing: the waiting path is covered by the adapter tests, not here.
   */
  async fetchResult(
    _session: ProviderSession,
  ): Promise<Result<ProviderVerificationResult | null, DomainError>> {
    return ok({
      providerReference: `stub-session-${this.config.referenceSuffix}`,
      confidence: this.config.confidence,
      checks: ASSERTED_CHECKS,
      completedAt: this.now(),
    });
  }

  async releaseSession(session: ProviderSession): Promise<Result<void, DomainError>> {
    this.released.push(session.sessionId);
    return ok(undefined);
  }
}

/** The stub, built the way a composition root would build it. */
export function stubProvider(
  config: StubProviderConfig = DEFAULT_STUB_CONFIG,
  now: () => Date = () => new Date(),
): VerificationProvider {
  return new StubVerificationProvider(config, now);
}