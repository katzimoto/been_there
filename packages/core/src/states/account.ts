import { type StateMachine, defineStateMachine } from '../transition.js';

/**
 * Account standing (issue #4/#7/#15). Owned by moderation; the product domains
 * only ever read it. Enforcement is never a soft, negotiable hint: `limited`
 * removes named capabilities, and the product must not attempt to route around
 * it.
 */
export type AccountState = 'active' | 'limited' | 'suspended' | 'banned';

export type AccountEvent =
  | 'restrict'
  | 'lift_restriction'
  | 'suspend'
  | 'reinstate'
  | 'ban'
  | 'lift_ban';

export interface AccountContext {
  /** Case that justifies the action — mandatory for every enforcement move. */
  readonly caseId?: string;
  readonly moderatorId?: string;
  /** Capability names removed by `limited`, e.g. `send_message`, `discover`. */
  readonly removedCapabilities?: readonly string[];
}

export const accountMachine: StateMachine<AccountState, AccountEvent, AccountContext> =
  defineStateMachine<AccountState, AccountEvent, AccountContext>({
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
      { event: 'lift_restriction', from: ['limited'], to: 'active', guard: (ctx) => ctx?.caseId !== undefined && ctx?.moderatorId !== undefined, note: 'A restriction is a moderator decision, so undoing it is one too. Without this, automation could reverse a human sanction, which is the same violation as automation applying one.' },
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
export const CAPABILITIES_BY_ACCOUNT_STATE: Readonly<
  Record<AccountState, readonly string[]>
> = {
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

/**
 * Capabilities a restriction may never take away, owned here beside the
 * capability record rather than in whichever package happens to accept a
 * removal. The authoritative list has to live at the point the grant is
 * computed: a floor enforced only where a removal is *accepted* is one package
 * downstream of every other caller, and the next caller that is not that
 * package walks straight past it.
 *
 * Each entry earns its place:
 *
 * - `report` — the intake valve for abuse reports. A restricted user with a
 *   genuine safety concern is exactly the person who must still reach a human,
 *   so every state grants it including `banned`. Removing it stops reports
 *   arriving at all, and that failure shows up in no metric.
 * - `block` — how a user protects themselves. A victim who cannot block the
 *   account targeting them has lost the one control the product gave them.
 * - `delete_account` — the recommended action on the banned screen. Removing it
 *   strands a banned account: sanctioned, unappealable, and unable to leave.
 */
export const UNRESTRICTABLE_CAPABILITIES: readonly string[] = [
  'report',
  'block',
  'delete_account',
];

export function capabilitiesFor(
  state: AccountState,
  context?: AccountContext,
): readonly string[] {
  // Defence in depth: the floor is applied where the grant is computed, so a
  // hand-built context cannot strip it even if the intake valve was bypassed.
  // Rejecting at intake (`applyDecision`) is the other half — a moderator who
  // types `report` is told no rather than silently ignored — but correctness
  // cannot depend on every caller having remembered to check first.
  const base = CAPABILITIES_BY_ACCOUNT_STATE[state];
  const removed = (context?.removedCapabilities ?? []).filter(
    (capability) => !UNRESTRICTABLE_CAPABILITIES.includes(capability),
  );
  if (removed.length === 0) {
    return base;
  }
  return base.filter((capability) => !removed.includes(capability));
}

export function canPerform(
  user: { readonly state: AccountState },
  capability: string,
  context?: AccountContext,
): boolean {
  return capabilitiesFor(user.state, context).includes(capability);
}

/** A banned or suspended user must never appear as a normal account surface. */
export function isVisibleInProduct(state: AccountState): boolean {
  return state !== 'banned';
}
