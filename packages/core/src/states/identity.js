import { defineStateMachine } from '../transition.js';
export const identityMachine = defineStateMachine({
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
            from: ['pending', 'verified'],
            to: 'review_required',
            note: 'Ambiguous or borderline result — never auto-resolved, never auto-enforced.',
        },
        { event: 'review_cleared', from: ['review_required'], to: 'verified', guard: (ctx) => ctx?.reviewerId !== undefined, note: 'Only a named human reviewer may clear a review.' },
        { event: 'review_confirmed_fraud', from: ['review_required'], to: 'verification_failed', guard: (ctx) => ctx?.reviewerId !== undefined },
        { event: 'expire', from: ['verified'], to: 'expired', note: 'Verification decays; the user stays known but leaves the discoverable pool.' },
        {
            event: 'reverify_requested',
            from: ['verified', 'expired', 'review_required'],
            to: 'pending',
            note: 'Trust-triggered re-verification (issue #15).',
        },
        { event: 'withdraw', to: 'unverified' },
    ],
});
/** The one predicate the dating domain is allowed to ask about identity. */
export function isDiscoverableIdentity(identity) {
    return identity.state === 'verified';
}
//# sourceMappingURL=identity.js.map