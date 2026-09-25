/**
 * Explicit result type. Domain boundaries never use exceptions for expected
 * outcomes (rejected transitions, ineligible candidates, permission denials) —
 * a caller must be forced by the type system to handle the failure branch.
 */
export type Ok<T> = {
    readonly ok: true;
    readonly value: T;
};
export type Err<E> = {
    readonly ok: false;
    readonly error: E;
};
export type Result<T, E = DomainError> = Ok<T> | Err<E>;
export declare function ok<T>(value: T): Ok<T>;
export declare function err<E>(error: E): Err<E>;
export declare function isOk<T, E>(result: Result<T, E>): result is Ok<T>;
export declare function isErr<T, E>(result: Result<T, E>): result is Err<E>;
export declare function unwrapOr<T, E>(result: Result<T, E>, fallback: T): T;
/** Maps the success branch, leaving the error branch untouched. */
export declare function mapOk<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E>;
export declare function mapErr<T, E, F>(result: Result<T, E>, fn: (error: E) => F): Result<T, F>;
export declare function andThen<T, U, E>(result: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E>;
/**
 * Machine-readable failure taxonomy shared by every domain. `code` is a stable
 * contract for clients and analytics; `message` is for humans and is never
 * load-bearing.
 */
export type DomainErrorCode = 'invalid_transition' | 'not_found' | 'not_eligible' | 'permission_denied' | 'conflict' | 'validation_failed' | 'rate_limited' | 'external_dependency_failed' | 'internal';
export interface DomainError {
    readonly code: DomainErrorCode;
    /** Owning domain, e.g. `identity`, `dating`, `trust-safety`. */
    readonly domain: string;
    readonly message: string;
    /** Stable machine-readable detail, e.g. `{ field: 'birthdate' }`. */
    readonly details?: Readonly<Record<string, string | number | boolean | null>>;
    readonly retryable?: boolean;
}
export declare function domainError(code: DomainErrorCode, domain: string, message: string, details?: DomainError['details']): Err<DomainError>;
//# sourceMappingURL=result.d.ts.map