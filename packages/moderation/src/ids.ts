/**
 * Moderation declares two identifier kinds the shared kernel does not name.
 *
 * The kernel brands every id through `castId` and keeps the `Brand` helper
 * private, so a domain cannot name a new branded kind without duplicating the
 * branding mechanism — and a second crossing point is worse than an unbranded
 * one, because validation added later would have two homes. These two ids are
 * therefore plain strings, declared once here so every reference in the package
 * goes through the same documented alias. Recorded as an open question in
 * `docs/architecture/moderation-enforcement.md`: the kernel should re-export
 * `Brand` so domains can declare their own ids and keep using `castId`.
 */
export type EvidenceId = string;
export type DecisionId = string;
