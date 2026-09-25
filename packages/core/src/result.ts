/**
 * Explicit result type. Domain boundaries never use exceptions for expected
 * outcomes (rejected transitions, ineligible candidates, permission denials) —
 * a caller must be forced by the type system to handle the failure branch.
 */

export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E = DomainError> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

export function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T {
  return result.ok ? result.value : fallback;
}

/** Maps the success branch, leaving the error branch untouched. */
export function mapOk<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

export function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(fn(result.error));
}

export function andThen<T, U, E>(result: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}

/**
 * Machine-readable failure taxonomy shared by every domain. `code` is a stable
 * contract for clients and analytics; `message` is for humans and is never
 * load-bearing.
 */
export type DomainErrorCode =
  | 'invalid_transition'
  | 'not_found'
  | 'not_eligible'
  | 'permission_denied'
  | 'conflict'
  | 'validation_failed'
  | 'rate_limited'
  | 'external_dependency_failed'
  | 'internal';

export interface DomainError {
  readonly code: DomainErrorCode;
  /** Owning domain, e.g. `identity`, `dating`, `trust-safety`. */
  readonly domain: string;
  readonly message: string;
  /** Stable machine-readable detail, e.g. `{ field: 'birthdate' }`. */
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
  readonly retryable?: boolean;
}

export function domainError(
  code: DomainErrorCode,
  domain: string,
  message: string,
  details?: DomainError['details'],
): Err<DomainError> {
  return err({
    code,
    domain,
    message,
    ...(details === undefined ? {} : { details }),
    retryable: code === 'external_dependency_failed' || code === 'rate_limited',
  });
}
