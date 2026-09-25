/**
 * Explicit result type. Domain boundaries never use exceptions for expected
 * outcomes (rejected transitions, ineligible candidates, permission denials) —
 * a caller must be forced by the type system to handle the failure branch.
 */
export function ok(value) {
    return { ok: true, value };
}
export function err(error) {
    return { ok: false, error };
}
export function isOk(result) {
    return result.ok;
}
export function isErr(result) {
    return !result.ok;
}
export function unwrapOr(result, fallback) {
    return result.ok ? result.value : fallback;
}
/** Maps the success branch, leaving the error branch untouched. */
export function mapOk(result, fn) {
    return result.ok ? ok(fn(result.value)) : result;
}
export function mapErr(result, fn) {
    return result.ok ? result : err(fn(result.error));
}
export function andThen(result, fn) {
    return result.ok ? fn(result.value) : result;
}
export function domainError(code, domain, message, details) {
    return err({
        code,
        domain,
        message,
        ...(details === undefined ? {} : { details }),
        retryable: code === 'external_dependency_failed' || code === 'rate_limited',
    });
}
//# sourceMappingURL=result.js.map