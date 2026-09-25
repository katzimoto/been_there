import { type DomainError, type Err, type Result, err } from '@been-there/core';

/**
 * The external verification boundary (issue #3).
 *
 * Everything the domain knows about liveness, document authenticity and
 * likeness arrives through this port. The port is deliberately vendor-neutral:
 * no vendor concept appears in any type below, so swapping vendors is a change
 * to one adapter file and not a change to the domain.
 *
 * Two rules shape the vocabulary:
 *
 *  - The provider *scores*, the domain *decides*. `ProviderVerificationResult`
 *    carries observations; it never carries a verdict. The verdict comes from
 *    `decideVerificationOutcome`, so the threshold policy is ours and lives in
 *    one reviewable table rather than in whatever a vendor default happens to
 *    be.
 *  - A provider failure is data, not an exception. Vendor errors are normalised
 *    to `ProviderFailureReason`, so "the vendor was down" can never be confused
 *    with "this person is not real".
 */

/** A check in the vendor-neutral vocabulary the domain reasons about. */
export type VerificationCheck =
  | 'document_authenticity'
  | 'liveness'
  | 'likeness'
  | 'document_to_selfie_match'
  | 'age_consistency';

/**
 * Checks that must all be satisfied before a verification can pass. A check the
 * provider did not perform is a `not_performed` result and routes to a human; it
 * is never treated as a pass.
 */
export const REQUIRED_CHECKS: readonly VerificationCheck[] = [
  'document_authenticity',
  'liveness',
  'likeness',
];

export type ProviderCheckOutcome = 'passed' | 'failed' | 'inconclusive' | 'not_performed';

export interface ProviderCheckResult {
  readonly check: VerificationCheck;
  readonly outcome: ProviderCheckOutcome;
  /** 0..1 provider score, or `null` when the provider cannot score the check. */
  readonly score: number | null;
  /**
   * Provider wording. Never rendered on a product surface and never part of the
   * decision — it exists for the moderator tool, and it is `sensitive`.
   */
  readonly reason: string | null;
}

export interface ProviderVerificationResult {
  /**
   * Opaque handle to the vendor's stored artefacts. It is an identifier, not a
   * locator: it must not be resolvable without the access path in `evidence.ts`.
   */
  readonly providerReference: string;
  /** Overall 0..1 confidence. Untrusted input; bounds are enforced downstream. */
  readonly confidence: number;
  readonly checks: readonly ProviderCheckResult[];
  readonly completedAt: Date;
}

/** A started vendor session. The domain holds no assumptions about its shape. */
export interface ProviderSession {
  readonly sessionId: string;
  readonly startedAt: Date;
  /** When the provider stops accepting capture for this session. */
  readonly expiresAt: Date;
}

export interface ProviderSessionRequest {
  readonly correlationId: string;
  readonly reVerification: boolean;
  /** Checks the domain intends to run. A provider may support a subset. */
  readonly checks: readonly VerificationCheck[];
}

export type ProviderFailureReason =
  /** Vendor cannot answer right now; retryable, and not the user's fault. */
  | 'unavailable'
  /** Vendor throttled us; retryable after a delay. */
  | 'rate_limited'
  /** Capture unreadable (blur, glare, wrong side); user-fixable. */
  | 'rejected_capture'
  /** Document type unsupported for the user's market. */
  | 'unsupported_document'
  /** Vendor answered with something we cannot parse. Never a pass. */
  | 'malformed_response';

export interface ProviderFailure {
  readonly reason: ProviderFailureReason;
  readonly retryable: boolean;
  /** Adapter-level detail for operators. Never shown to a user. */
  readonly detail: string | null;
}

/**
 * What a failure does to the *attempt*, not to the person. A retryable failure
 * leaves the attempt waiting; a terminal failure ends it. The mapping lives in
 * the domain so no adapter can decide, on its own, that a user failed.
 */
export type ProviderFailureEffect = 'retry_later' | 'attempt_failed' | 'attempt_needs_review';

export function classifyProviderFailure(failure: ProviderFailure): ProviderFailureEffect {
  switch (failure.reason) {
    case 'unavailable':
    case 'rate_limited':
      return 'retry_later';
    case 'malformed_response':
      // A vendor we cannot understand is our problem, not the user's fault. It
      // must never read as a failed verification.
      return 'attempt_needs_review';
    case 'rejected_capture':
    case 'unsupported_document':
      return 'attempt_failed';
  }
}

/** The port. Implementations are adapters; the domain only ever sees this shape. */
export interface VerificationProvider {
  /** Opaque label for operations and audit ("primary", "fallback"). */
  readonly label: string;
  startSession(request: ProviderSessionRequest): Promise<Result<ProviderSession, DomainError>>;
  /**
   * `null` means "the provider has not finished yet" — the ordinary waiting
   * case, not a failure.
   */
  fetchResult(
    session: ProviderSession,
  ): Promise<Result<ProviderVerificationResult | null, DomainError>>;
  /**
   * Frees vendor-side artefacts for a session that will not complete, so an
   * erasure request can be propagated to the processor. Best effort: the
   * domain's retention policy in `evidence.ts` is the real deadline.
   */
  releaseSession(session: ProviderSession): Promise<Result<void, DomainError>>;
}

/**
 * The single normalisation point for a provider failure. Adapters call this
 * instead of letting vendor error text escape into a `Result`.
 */
export function providerFailureError(failure: ProviderFailure): Err<DomainError> {
  return err({
    code: failure.retryable ? 'external_dependency_failed' : 'validation_failed',
    domain: 'identity',
    message: `verification provider failure: ${failure.reason}`,
    details: {
      reason: failure.reason,
      ...(failure.detail === null ? {} : { detail: failure.detail }),
    },
    retryable: failure.retryable,
  });
}
