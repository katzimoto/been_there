import { type StateMachine } from '../transition.js';
import type { VerificationId } from '../ids.js';
/**
 * Identity verification lifecycle (issue #3).
 *
 * The single hard rule: `verified` is the only state that makes a user
 * discoverable. Every other state is non-discoverable by construction, so
 * "an unverified account leaked into discovery" is a bug in a transition table
 * above, not in ad-hoc checks sprinkled through discovery.
 */
export type IdentityState = 'unverified' | 'pending' | 'verified' | 'review_required' | 'verification_failed' | 'expired';
export type IdentityEvent = 'submit_verification' | 'liveness_passed' | 'likeness_passed' | 'provider_result_received' | 'fail' | 'flag_for_review' | 'review_cleared' | 'review_confirmed_fraud' | 'expire' | 'reverify_requested' | 'withdraw';
export interface IdentityContext {
    /** Set when a human reviewer or a rule cleared the flag. */
    readonly reviewerId?: string;
    /** Identity confidence reported by the verification provider, 0..1. */
    readonly confidence?: number;
    /** True when the verification attempt was triggered by a trust change. */
    readonly reVerification?: boolean;
}
export declare const identityMachine: StateMachine<IdentityState, IdentityEvent, IdentityContext>;
export interface IdentityRecord {
    readonly state: IdentityState;
    readonly latestVerificationId: VerificationId | null;
    /** Monotonic counter; any increment forces re-verification downstream. */
    readonly generation: number;
}
/** The one predicate the dating domain is allowed to ask about identity. */
export declare function isDiscoverableIdentity(identity: IdentityRecord): boolean;
//# sourceMappingURL=identity.d.ts.map