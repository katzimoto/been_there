import { type DomainError, type DomainErrorCode, type Err, domainError } from '@been-there/core';
import { StoreError } from '@been-there/contracts';

/**
 * How a refusal becomes a status code.
 *
 * The one rule that matters here: a safety refusal is never an outage. A domain
 * `Err` means the request was refused and that is the answer — 4xx, with the
 * domain's own error code in the body, so the client can branch on it. A
 * `StoreError` means the answer is *unknown*, and only that is 5xx. Conflating
 * them in either direction is a real harm: a 500 for a refusal tells a user the
 * platform is broken when it is protecting them, and a 4xx for a timeout tells
 * them the refusal was deliberate when it may not have been.
 *
 * The mapping is a table rather than a chain of comparisons so that adding a
 * `DomainErrorCode` to the kernel makes this file fail to compile until somebody
 * decides what it means over HTTP, rather than falling through to a default that
 * nobody chose.
 */

const STATUS_BY_DOMAIN_CODE: Readonly<Record<DomainErrorCode, number>> = {
  validation_failed: 400,
  not_found: 404,
  not_eligible: 422,
  permission_denied: 403,
  conflict: 409,
  invalid_transition: 409,
  rate_limited: 429,
  // The provider is somebody else's problem and the caller's retry is the fix,
  // so it is the one domain code that is genuinely an outage from here.
  external_dependency_failed: 503,
  internal: 500,
};

export function statusForDomainError(error: DomainError): number {
  return STATUS_BY_DOMAIN_CODE[error.code];
}

/**
 * 503 when the store says the fault is transient, 500 when it does not. The flag
 * comes from the store's own classification of the Postgres error code, so the
 * service is not re-deciding what is retryable.
 */
export function statusForStoreError(error: StoreError): number {
  return error.retryable ? 503 : 500;
}

export interface FailureBody {
  readonly error: {
    readonly code: string;
    readonly domain: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly details?: Readonly<Record<string, string | number | boolean | null>>;
  };
}

export function failureBodyFromDomain(error: DomainError): FailureBody {
  return {
    error: {
      code: error.code,
      domain: error.domain,
      message: error.message,
      retryable: error.retryable === true,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

/**
 * A storage fault is reported without its message.
 *
 * A `StoreError` wraps a driver error, and a driver error carries a SQL
 * fragment, a constraint name and occasionally a row value. None of that may
 * reach a client: a constraint name is a schema disclosure and a row value in an
 * error message is a data leak that only shows up under failure. The log gets
 * the real error; the client gets a code.
 */
export function failureBodyFromStore(error: StoreError): FailureBody {
  return {
    error: {
      code: error.retryable ? 'store_unavailable' : 'store_failure',
      domain: 'service.store',
      message: error.retryable
        ? 'the request could not be completed and may be retried'
        : 'the request could not be completed',
      retryable: error.retryable,
    },
  };
}

/** Transport-level refusals, phrased in the same shape as every other failure. */
export const INVALID_JSON = (): Err<DomainError> =>
  domainError('validation_failed', 'service.http', 'the request body is not valid JSON');

export const MISSING_FIELD = (field: string): Err<DomainError> =>
  domainError('validation_failed', 'service.http', 'a required field is missing or malformed', {
    field,
  });

export const UNKNOWN_FIELD_VALUE = (field: string, allowed: readonly string[]): Err<DomainError> =>
  domainError('validation_failed', 'service.http', 'unrecognised value', {
    field,
    allowed: allowed.join(','),
  });

export const NOT_FOUND = (what: string): Err<DomainError> =>
  domainError('not_found', 'service.http', `${what} was not found`);

export const ROUTE_NOT_FOUND = (): Err<DomainError> =>
  domainError('not_found', 'service.http', 'no such endpoint');

export const METHOD_NOT_ALLOWED = (method: string): Err<DomainError> =>
  domainError('validation_failed', 'service.http', 'that method is not allowed on this endpoint', {
    method,
  });
