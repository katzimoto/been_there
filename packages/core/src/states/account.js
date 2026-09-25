import { defineStateMachine } from '../transition.js';
export const accountMachine = defineStateMachine({
    domain: 'account',
    initial: 'active',
    transitions: [
        {
            event: 'restrict',
            from: ['active', 'limited'],
            to: 'limited',
            guard: (ctx) => ctx?.caseId !== undefined && (ctx?.removedCapabilities?.length ?? 0) > 0,
            note: 'A restriction must name a case and at least one removed capability.',
        },
        { event: 'lift_restriction', from: ['limited'], to: 'active', guard: (ctx) => ctx?.caseId !== undefined },
        { event: 'suspend', from: ['active', 'limited'], to: 'suspended', guard: (ctx) => ctx?.caseId !== undefined && ctx?.moderatorId !== undefined },
        { event: 'reinstate', from: ['suspended'], to: 'active', guard: (ctx) => ctx?.caseId !== undefined && ctx?.moderatorId !== undefined },
        { event: 'ban', from: ['active', 'limited', 'suspended'], to: 'banned', guard: (ctx) => ctx?.caseId !== undefined && ctx?.moderatorId !== undefined, note: 'Ban is the only terminal-by-default state and is reversible only by a named moderator.' },
        { event: 'lift_ban', from: ['banned'], to: 'active', guard: (ctx) => ctx?.caseId !== undefined && ctx?.moderatorId !== undefined },
    ],
});
/**
 * Capability surface each standing grants. Centralised here so a new product
 * surface cannot accidentally be available to a restricted account: adding a
 * capability means editing this record, which is a reviewable diff.
 */
export const CAPABILITIES_BY_ACCOUNT_STATE = {
    active: [
        'browse_discovery',
        'like',
        'send_message',
        'report',
        'block',
        'edit_profile',
    ],
    limited: ['browse_discovery', 'report', 'block', 'edit_profile'],
    suspended: ['report', 'block', 'edit_profile'],
    banned: ['report', 'appeal_request', 'delete_account'],
};
export function capabilitiesFor(state, context) {
    const base = CAPABILITIES_BY_ACCOUNT_STATE[state];
    const removed = context?.removedCapabilities ?? [];
    if (removed.length === 0) {
        return base;
    }
    return base.filter((capability) => !removed.includes(capability));
}
export function canPerform(user, capability, context) {
    return capabilitiesFor(user.state, context).includes(capability);
}
/** A banned or suspended user must never appear as a normal account surface. */
export function isVisibleInProduct(state) {
    return state !== 'banned';
}
//# sourceMappingURL=account.js.map