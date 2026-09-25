import { type StateMachine, defineStateMachine } from '../transition.js';
import type { VerificationId } from '../ids.js';

/**
 * Identity verification lifecycle (issue #3).
 *
 * The single hard rule: `verified` is the only state that makes a user
 * discoverable. Every other state is non-discoverable by construction, so
 * "an unverified account leaked into discovery" is a bug in a transition table
 * above, not in ad-hoc checks sprinkled through discovery.
 */
export type IdentityState =
  | 'unverified'
  | 'pending'
  | 'verified'
  | 'review_required'
  | 'verification_failed'
  | 'expired';

export type IdentityEvent =
  | 'submit_verification'
  | 'liveness_passed'
  | 'likeness_passed'
  | 'provider_result_received'
  | 'fail'
  | 'flag_for_review'
  | 'review_cleared'
  | 'review_confirmed_fraud'
  | 'expire'
  | 'reverify_requested'
  | 'withdraw';

export interface IdentityContext {
  /** Set when a human reviewer or a rule cleared the flag. */
  readonly reviewerId?: string;
  /** Identity confidence reported by the verification provider, 0..1. */
  readonly confidence?: number;
  /** True when the verification attempt was triggered by a trust change. */
  readonly reVerification?: boolean;
}

export const identityMachine: StateMachine<IdentityState, IdentityEvent, IdentityContext> =
  defineStateMachine<IdentityState, IdentityEvent, IdentityContext>({
    domain: 'identity',
    initial: 'unverified',
    transitions: [
      { event: 'submit_verification', from: ['unverified', 'expired', 'verification_failed'], to: 'pending' },
      { event: 'liveness_passed', from: ['pending'], to: 'pending' },
      { event: 'likeness_passed', from: ['pending'], to: 'pending' },
      {
        event: 'provider_result_received',
        from: ['pending'],
        to: 'verified',
        guard: (ctx) => (ctx?.confidence ?? 0) >= 0.9,
        note: 'Only a provider result at or above the confidence floor grants verified.',
      },
      { event: 'fail', from: ['pending'], to: 'verification_failed' },
      {
        event: 'flag_for_review',
        from: ['pending', 'verified', 'verification_failed'],
        to: 'review_required',
        note: 'Ambiguous or borderline result — never auto-resolved, never auto-enforced. Reachable from verification_failed so repeated failure escalates to a person (spec rule R7) rather than looping the user back into a fresh attempt forever; the identity package decides when the repeats threshold is met.',
      },
      { event: 'review_cleared', from: ['review_required'], to: 'verified', guard: (ctx) => ctx?.reviewerId !== undefined, note: 'Only a named human reviewer may clear a review.' },
      { event: 'review_confirmed_fraud', from: ['review_required'], to: 'verification_failed', guard: (ctx) => ctx?.reviewerId !== undefined },
      { event: 'expire', from: ['verified'], to: 'expired', note: 'Verification decays; the user stays known but leaves the discoverable pool.' },
      {
        event: 'reverify_requested',
        from: ['verified', 'expired'],
        to: 'pending',
        note: "Trust-triggered re-verification (issue #15). Deliberately NOT reachable from review_required: while a human is looking at a case, an automatic request must not be able to walk the account back out of it. That is commitment 2 in shape — automation must not undo a human's involvement — and the kernel is the right place for it, because a policy check in the calling package can be bypassed by a direct call here. A flagged case leaves review only through review_cleared or review_confirmed_fraud.",
      },
      { event: 'withdraw', from: ['unverified', 'pending', 'verified', 'expired', 'verification_failed'], to: 'unverified', note: 'Not reachable from review_required. Withdrawing is safe in itself - it only ever removes discoverability - but it would strand an open case with nobody able to resolve it, and that is commitment 2 in shape: a case a human is looking at must not be walkable out from under them. A user who wants out deletes the account, which is a different and terminal path.' },
    ],
  });

export interface IdentityRecord {
  readonly state: IdentityState;
  readonly latestVerificationId: VerificationId | null;
  /** Monotonic counter; any increment forces re-verification downstream. */
  readonly generation: number;
}

/** The one predicate the dating domain is allowed to ask about identity. */
export function isDiscoverableIdentity(identity: IdentityRecord): boolean {
  return identity.state === 'verified';
}
