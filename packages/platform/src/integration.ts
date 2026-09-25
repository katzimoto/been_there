import {
  type CorrelationId,
  type DomainError,
  type Result,
  domainError,
  ok,
} from '@been-there/core';
import { type IntegrationRequestId } from './ids.js';

/**
 * The vendor boundary. No domain imports an SDK: a verification provider, an
 * email relay, APNs, and an SMS gateway all arrive here as the same three
 * shapes — a request with an idempotency key, a uniform failure taxonomy, and
 * a retry policy keyed off whether repeating the call is safe.
 *
 * The reason is not tidiness. It is that a vendor SDK is where timeouts,
 * retries, and payload shapes go to become product behaviour, and a domain that
 * calls one directly inherits all three without deciding any of them.
 */

export type ProviderKind = 'identity_verification' | 'email' | 'push' | 'sms';

export type OperationKind =
  | 'verify_document'
  | 'verify_liveness'
  | 'send_email'
  | 'send_push'
  | 'send_sms';

/**
 * One taxonomy for every vendor. Callers branch on these five, never on a
 * vendor status code, so swapping a provider is a change to an adapter and
 * nothing else.
 */
export type ExternalFailure =
  | 'timeout'
  | 'unavailable'
  | 'rejected'
  | 'rate_limited'
  | 'malformed_response';

export interface ExternalRequest<P> {
  readonly requestId: IntegrationRequestId;
  readonly provider: ProviderKind;
  readonly operation: OperationKind;
  /**
   * Stable across retries and across the duplicate that an at-least-once caller
   * produces. The adapter forwards it to the vendor's own idempotency support
   * where one exists.
   */
  readonly idempotencyKey: string;
  readonly correlationId: CorrelationId;
  readonly payload: P;
}

export interface ExternalSuccess<T> {
  readonly requestId: IntegrationRequestId;
  readonly provider: ProviderKind;
  readonly operation: OperationKind;
  readonly providerRequestId: string;
  readonly value: T;
  /** Present when the vendor told us when to come back. */
  readonly retryAfterMs?: number;
}

export interface ExternalError {
  readonly failure: ExternalFailure;
  readonly provider: ProviderKind;
  readonly operation: OperationKind;
  readonly requestId: IntegrationRequestId;
  readonly retryable: boolean;
  /** Safe to log. Vendor messages frequently echo the payload back. */
  readonly detail: string;
  /** Vendor-supplied backoff, when it told us when to come back. */
  readonly retryAfterMs?: number;
}

export type IntegrationResult<T> = Result<ExternalSuccess<T>, ExternalError>;

export interface IntegrationPort {
  execute<P, T>(request: ExternalRequest<P>): Promise<IntegrationResult<T>>;
}

/**
 * Whether repeating a call is safe. This is the property the retry policy turns
 * on, and it is declared per operation rather than per attempt because it is a
 * fact about the vendor's semantics, not about our mood at 3am.
 */
export const OPERATION_RETRY_POLICY: Readonly<
  Record<OperationKind, { readonly idempotent: boolean; readonly maxAttempts: number; readonly timeoutMs: number }>
> = {
  // Verification is billed per call and may start a human review, so a repeat
  // on an unknown outcome is a duplicate charge and a duplicate review.
  verify_document: { idempotent: false, maxAttempts: 1, timeoutMs: 20_000 },
  verify_liveness: { idempotent: false, maxAttempts: 1, timeoutMs: 20_000 },
  // Notifications are keyed by the caller's idempotency key and are safe to
  // repeat; the duplicate-notification risk is handled at the ledger, upstream.
  send_email: { idempotent: true, maxAttempts: 4, timeoutMs: 10_000 },
  send_push: { idempotent: true, maxAttempts: 4, timeoutMs: 5_000 },
  send_sms: { idempotent: true, maxAttempts: 3, timeoutMs: 10_000 },
};

export const RETRYABLE_FAILURES: readonly ExternalFailure[] = [
  'timeout',
  'unavailable',
  'rate_limited',
];

/**
 * Whether attempt `attempt` (1-based) may be repeated.
 *
 * The subtle case is `timeout` on a non-idempotent operation: the vendor may
 * well have processed it, and a retry is not "try again", it is "do it twice".
 * Those operations get exactly one attempt, and the caller decides what a
 * possibly-completed verification means.
 */
export function shouldRetry(error: ExternalError, attempt: number): boolean {
  const policy = OPERATION_RETRY_POLICY[error.operation];
  if (attempt >= policy.maxAttempts) {
    return false;
  }
  if (!RETRYABLE_FAILURES.includes(error.failure)) {
    return false;
  }
  if (!policy.idempotent && (error.failure === 'timeout' || error.failure === 'unavailable')) {
    return false;
  }
  return true;
}

/** Exponential backoff with the vendor's own `Retry-After` taking precedence. */
export function retryDelayMs(attempt: number, baseMs: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) {
    return retryAfterMs;
  }
  return baseMs * 2 ** (attempt - 1);
}

export function toDomainError(error: ExternalError): DomainError {
  return {
    code: 'external_dependency_failed',
    domain: 'platform',
    message: `${error.provider}.${error.operation} failed: ${error.failure}`,
    details: {
      provider: error.provider,
      operation: error.operation,
      failure: error.failure,
    },
    retryable: error.retryable,
  };
}

export interface RetryDeps {
  readonly baseDelayMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * The adapter every vendor call goes through. It is a class rather than a
 * helper because it is the composition point: the port implementation and the
 * clock are both injected, so a test drives the whole failure path without a
 * network and without a fake timer that lies.
 */
export class RetryingIntegration implements IntegrationPort {
  #port: IntegrationPort;
  #deps: RetryDeps;

  constructor(port: IntegrationPort, deps: RetryDeps) {
    this.#port = port;
    this.#deps = deps;
  }

  async execute<P, T>(request: ExternalRequest<P>): Promise<IntegrationResult<T>> {
    let attempt = 1;
    for (;;) {
      const outcome = await this.#port.execute<P, T>(request);
      if (outcome.ok) {
        return outcome;
      }
      const error = outcome.error;
      if (!shouldRetry(error, attempt)) {
        return outcome;
      }
      await this.#deps.sleep(retryDelayMs(attempt, this.#deps.baseDelayMs, error.retryAfterMs));
      attempt += 1;
    }
  }
}

export function externalSuccess<T>(
  request: ExternalRequest<unknown>,
  value: T,
  providerRequestId: string,
): ExternalSuccess<T> {
  return {
    requestId: request.requestId,
    provider: request.provider,
    operation: request.operation,
    providerRequestId,
    value,
  };
}

export function externalError(
  request: ExternalRequest<unknown>,
  failure: ExternalFailure,
  detail: string,
  retryAfterMs?: number,
): ExternalError {
  const policy = OPERATION_RETRY_POLICY[request.operation];
  return {
    failure,
    provider: request.provider,
    operation: request.operation,
    requestId: request.requestId,
    retryable: RETRYABLE_FAILURES.includes(failure) && policy.idempotent,
    detail,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}
