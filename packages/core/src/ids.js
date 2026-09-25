/**
 * Opaque, branded identifiers. Each aggregate owns its id type; ids from one
 * domain are never interchangeable with another's, which turns an accidental
 * cross-domain mixup into a compile error rather than a data bug.
 *
 * Construction goes through the single `castId` crossing point so that
 * validation added later has exactly one place to live.
 */
export function castId(value) {
    return value;
}
//# sourceMappingURL=ids.js.map