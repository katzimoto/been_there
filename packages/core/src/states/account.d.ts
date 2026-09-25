import { type StateMachine } from '../transition.js';
/**
 * Account standing (issue #4/#7/#15). Owned by moderation; the product domains
 * only ever read it. Enforcement is never a soft, negotiable hint: `limited`
 * removes named capabilities, and the product must not attempt to route around
 * it.
 */
export type AccountState = 'active' | 'limited' | 'suspended' | 'banned';
export type AccountEvent = 'restrict' | 'lift_restriction' | 'suspend' | 'reinstate' | 'ban' | 'lift_ban';
export interface AccountContext {
    /** Case that justifies the action — mandatory for every enforcement move. */
    readonly caseId?: string;
    readonly moderatorId?: string;
    /** Capability names removed by `limited`, e.g. `send_message`, `discover`. */
    readonly removedCapabilities?: readonly string[];
}
export declare const accountMachine: StateMachine<AccountState, AccountEvent, AccountContext>;
/**
 * Capability surface each standing grants. Centralised here so a new product
 * surface cannot accidentally be available to a restricted account: adding a
 * capability means editing this record, which is a reviewable diff.
 */
export declare const CAPABILITIES_BY_ACCOUNT_STATE: Readonly<Record<AccountState, readonly string[]>>;
export declare function capabilitiesFor(state: AccountState, context?: AccountContext): readonly string[];
export declare function canPerform(user: {
    readonly state: AccountState;
}, capability: string, context?: AccountContext): boolean;
/** A banned or suspended user must never appear as a normal account surface. */
export declare function isVisibleInProduct(state: AccountState): boolean;
//# sourceMappingURL=account.d.ts.map