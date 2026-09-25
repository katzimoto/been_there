import type { ActorId } from '@been-there/core';

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

declare const humanSession: unique symbol;

/**
 * An `ActorId` that a human-facing entry point resolved to a person.
 *
 * A non-null actor id is not evidence of a human: any service can mint one,
 * which is why `moderatorId: ActorId | null` was not a commitment. This type is
 * the compile-time half of "automation never enforces" — an `ActorId` a service
 * already holds is not assignable to it, so `applyDecision` cannot be called
 * with the identity the caller happens to have. It is not a capability in its
 * own right: the runtime half is the `automated` claim `DecisionCommand`
 * carries, and a forged id is still refused when that claim is false.
 */
export type HumanActorId = ActorId & { readonly [humanSession]: true };

/**
 * The one place a `HumanActorId` is minted, and the reason the brand is worth
 * anything: outside this module there is no way to produce one without a
 * deliberate downcast at the call site, which a reviewer can see. `decide` and
 * `reverseDecision` call it only after `canWorkCase` has refused an automated
 * actor, so the cast they perform is a narrowing the gate has already made
 * true, not an assertion the domain takes on trust.
 *
 * Not re-exported from the package barrel on purpose: outside callers are
 * meant to reach enforcement through `decide`, which enforces everything.
 */
export function asHumanActor(actorId: ActorId): HumanActorId {
  return actorId as HumanActorId;
}
