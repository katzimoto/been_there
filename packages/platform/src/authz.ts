import {
  CAPABILITIES_BY_ACCOUNT_STATE,
  type AccountEvent,
  type AccountContext,
  type AccountId,
  type AccountState,
  type ActorId,
  type CaseId,
  type Clearance,
  type DataSensitivity,
  type DomainError,
  type Result,
  type UserId,
  capabilitiesFor,
  UNRESTRICTABLE_CAPABILITIES,
  domainError,
  ok,
} from '@been-there/core';
import { isWithinClearance } from './redaction.js';

/**
 * Least privilege, expressed twice: which *role* may perform an action, and how
 * *sensitive* a field the role is allowed to observe at all. Both gates run on
 * every protected action and a caller must satisfy both — a moderator with the
 * right permission still cannot read a `restricted` field unless the role's
 * clearance covers it.
 *
 * `identity_privacy_officer` is the one name here that is not a rung on the
 * moderation ladder. It is an appointment in the identity domain, and it is
 * named in this package rather than in `packages/moderation` because identity
 * artefacts are classified `sensitive` and this is the package that owns what a
 * role may observe at all. It holds no decision permission: an officer who may
 * read a selfie may not act on a case.
 */
export type Role =
  | 'user'
  | 'moderator'
  | 'senior_moderator'
  | 'support'
  | 'identity_privacy_officer'
  | 'system';

/**
 * The appointment a role carries, which is a different question from which
 * permissions it holds. These are the two facts the moderation package's
 * clearance ladder is computed from, stated in the package that decides who is
 * who, so that a service builds its actor from the authenticated role rather
 * than from anything the request body claimed. A caller that read `isLead` off a
 * JSON body would be handing the lead clearance to anyone who typed it.
 */
export interface ReviewerAppointment {
  readonly isLead: boolean;
  readonly identityPrivacyRole: boolean;
}

export const APPOINTMENT_BY_ROLE: Readonly<Record<Role, ReviewerAppointment>> = {
  user: { isLead: false, identityPrivacyRole: false },
  support: { isLead: false, identityPrivacyRole: false },
  moderator: { isLead: false, identityPrivacyRole: false },
  senior_moderator: { isLead: true, identityPrivacyRole: false },
  identity_privacy_officer: { isLead: false, identityPrivacyRole: true },
  system: { isLead: false, identityPrivacyRole: false },
};

/**
 * Which protected action governs each move of the account machine.
 *
 * A reversal performs the lift event, and the lift is a different authority
 * from the sanction it answers: `lift_restriction` and `lift_ban` are not the
 * same permission, and this is the record that says so. `reinstate` is the
 * suspension authority and `lift_restriction` the restriction one, because
 * neither is senior-only — only lifting a ban is, and that is the one event
 * with no other event mapped alongside it.
 */
const PROTECTED_ACTION_BY_ACCOUNT_EVENT: Readonly<Record<AccountEvent, ProtectedAction>> = {
  restrict: 'account.enforce.restrict',
  lift_restriction: 'account.enforce.restrict',
  suspend: 'account.enforce.suspend',
  reinstate: 'account.enforce.suspend',
  ban: 'account.enforce.ban',
  lift_ban: 'account.enforce.lift_ban',
};

export function protectedActionForAccountEvent(event: AccountEvent): ProtectedAction {
  return PROTECTED_ACTION_BY_ACCOUNT_EVENT[event];
}

export type Permission =
  | 'discovery.read'
  | 'profile.write.own'
  | 'auth.recover.own'
  | 'media.read.own'
  | 'media.read.reported'
  | 'case.open'
  | 'case.read'
  | 'case.evidence.read'
  | 'case.decide.restriction'
  | 'case.decide.suspension'
  | 'case.decide.ban'
  | 'case.decide.lift_ban'
  | 'identity.evidence.read'
  | 'analytics.read'
  | 'audit.read.internal'
  | 'audit.read.restricted'
  | 'support.session.read'
  | 'system.integration.call';

export const PERMISSIONS_BY_ROLE: Readonly<Record<Role, readonly Permission[]>> = {
  user: ['discovery.read', 'profile.write.own', 'media.read.own', 'auth.recover.own'],
  moderator: [
    'media.read.reported',
    'case.open',
    'case.read',
    'case.evidence.read',
    'case.decide.restriction',
    'case.decide.suspension',
    'case.decide.ban',
  ],
  senior_moderator: [
    'media.read.reported',
    'case.open',
    'case.read',
    'case.evidence.read',
    'case.decide.restriction',
    'case.decide.suspension',
    'case.decide.ban',
    'case.decide.lift_ban',
    'audit.read.restricted',
  ],
  support: ['support.session.read', 'audit.read.internal'],
  // Automation gets the mechanical permissions and none of the judgement ones.
  // In particular `system` cannot read case evidence: a detector that could
  // read evidence would be an enforcement decision made by a machine.
  system: ['system.integration.call', 'audit.read.internal'],
  identity_privacy_officer: ['case.read', 'case.evidence.read', 'identity.evidence.read'],
};

/**
 * The data-sensitivity ceiling per role, independent of permission. This is the
 * half of least privilege that a new permission cannot accidentally widen:
 * granting a role more powers does not raise what that role may observe.
 */
export const CLEARANCE_BY_ROLE: Readonly<Record<Role, Clearance>> = {
  user: { upTo: 'user' },
  support: { upTo: 'internal' },
  moderator: { upTo: 'sensitive' },
  senior_moderator: { upTo: 'restricted' },
  system: { upTo: 'internal' },
  // `sensitive`, not `restricted`: the artefacts this role exists to read are
  // classified `sensitive`, and granting `restricted` as well would put a
  // second role in the single cell `platform.md` §4 reserves for senior
  // moderation.
  identity_privacy_officer: { upTo: 'sensitive' },
};

export interface Principal {
  readonly userId: UserId;
  readonly role: Role;
}

export type ProtectedAction =
  | 'account.enforce.restrict'
  | 'account.enforce.suspend'
  | 'account.enforce.ban'
  | 'account.enforce.lift_ban'
  | 'case.open'
  | 'case.read'
  | 'case.read_evidence'
  | 'case.decide'
  | 'identity.read_evidence'
  | 'media.read_any'
  | 'audit.read'
  | 'auth.recover'
  | 'analytics.read';

export interface ProtectedActionSpec {
  readonly permission: Permission;
  /** Highest classification this action may return. */
  readonly requiredClearance: DataSensitivity;
  /** Enforcement authority is meaningless without the case that justifies it. */
  readonly caseRequired: boolean;
  /** A named human must be attributable for irreversible decisions. */
  readonly moderatorRequired: boolean;
}

export const PROTECTED_ACTIONS: Readonly<Record<ProtectedAction, ProtectedActionSpec>> = {
  'account.enforce.restrict': { permission: 'case.decide.restriction', requiredClearance: 'sensitive', caseRequired: true, moderatorRequired: true },
  'account.enforce.suspend': { permission: 'case.decide.suspension', requiredClearance: 'sensitive', caseRequired: true, moderatorRequired: true },
  'account.enforce.ban': { permission: 'case.decide.ban', requiredClearance: 'sensitive', caseRequired: true, moderatorRequired: true },
  'account.enforce.lift_ban': { permission: 'case.decide.lift_ban', requiredClearance: 'sensitive', caseRequired: true, moderatorRequired: true },
  'case.open': { permission: 'case.open', requiredClearance: 'sensitive', caseRequired: false, moderatorRequired: true },
  // Seeing the queue is not the authority to act on a case, and it is the one
  // gate that needs neither: a moderator with nothing assigned still reads it.
  'case.read': { permission: 'case.read', requiredClearance: 'sensitive', caseRequired: false, moderatorRequired: false },
  'case.read_evidence': { permission: 'case.evidence.read', requiredClearance: 'sensitive', caseRequired: true, moderatorRequired: false },
  'case.decide': { permission: 'case.decide.ban', requiredClearance: 'sensitive', caseRequired: true, moderatorRequired: true },
  'identity.read_evidence': { permission: 'identity.evidence.read', requiredClearance: 'sensitive', caseRequired: false, moderatorRequired: false },
  'media.read_any': { permission: 'media.read.reported', requiredClearance: 'internal', caseRequired: true, moderatorRequired: false },
  'audit.read': { permission: 'audit.read.restricted', requiredClearance: 'restricted', caseRequired: false, moderatorRequired: false },
  // Recovery is the account takeover path, so it belongs to the owner and to
  // nobody with support duties. Support may read session metadata; it may not
  // mint a credential.
  'auth.recover': { permission: 'auth.recover.own', requiredClearance: 'user', caseRequired: false, moderatorRequired: false },
  'analytics.read': { permission: 'analytics.read', requiredClearance: 'internal', caseRequired: false, moderatorRequired: false },
};

export interface AuthorizedAction {
  readonly principal: Principal;
  readonly action: ProtectedAction;
  /** The clearance the caller must use for anything this action reads. */
  readonly clearance: Clearance;
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return PERMISSIONS_BY_ROLE[role].includes(permission);
}

/**
 * Authorises a protected action, or explains the refusal. All four gates must
 * pass: the role holds the permission, the role's clearance covers the highest
 * classification the action can return, enforcement actions carry a case, and
 * irreversible ones name a moderator.
 */
export function authorize(
  principal: Principal,
  action: ProtectedAction,
  context: { readonly caseId?: CaseId; readonly moderatorId?: ActorId } = {},
): Result<AuthorizedAction, DomainError> {
  const spec = PROTECTED_ACTIONS[action];
  if (!hasPermission(principal.role, spec.permission)) {
    return domainError('permission_denied', 'platform', `role "${principal.role}" may not ${action}`, {
      action,
      role: principal.role,
    });
  }

  const clearance = CLEARANCE_BY_ROLE[principal.role];
  if (!isWithinClearance(clearance, spec.requiredClearance)) {
    return domainError('permission_denied', 'platform', `role "${principal.role}" clearance is below ${spec.requiredClearance}`, {
      action,
      role: principal.role,
    });
  }

  if (spec.caseRequired && context.caseId === undefined) {
    return domainError('permission_denied', 'platform', `${action} requires a case`, { action });
  }
  if (spec.moderatorRequired && context.moderatorId === undefined) {
    return domainError('permission_denied', 'platform', `${action} requires a named moderator`, {
      action,
    });
  }

  return ok({ principal, action, clearance });
}

/**
 * The capability vocabulary is derived from the account machine's own record, so
 * a capability moderation never grants cannot be smuggled in through a typo:
 * `send_messages` is not `send_message`, and an unknown name is refused rather
 * than treated as "not restricted".
 */
const CAPABILITY_VOCABULARY: ReadonlySet<string> = new Set(
  Object.values(CAPABILITIES_BY_ACCOUNT_STATE).flat(),
);

export interface ActiveRestriction {
  readonly caseId: CaseId;
  readonly moderatorId: ActorId;
  readonly removedCapabilities: readonly string[];
  readonly appliedAt: Date;
}

export interface CapabilityGrant {
  readonly userId: UserId;
  readonly accountId: AccountId;
  /** Published by moderation as `account_state.changed`; the platform never writes it. */
  readonly state: AccountState;
  /** Every restriction in force, each naming the case that justifies it. */
  readonly restrictions: readonly ActiveRestriction[];
  /** Account-state grant minus every removal, resolved once and immutably. */
  readonly granted: readonly string[];
}

/**
 * Re-exported from the kernel, which owns the capability record and computes
 * the grant. Platform is a *consumer* of the floor, not its author: a second
 * list here is what let a removal accepted in moderation reach a `public`
 * payload with `report` and `block` stripped from it.
 */
export { UNRESTRICTABLE_CAPABILITIES };

export function capabilityGrantFor(
  account: {
    readonly userId: UserId;
    readonly accountId: AccountId;
    readonly state: AccountState;
  },
  restrictions: readonly ActiveRestriction[],
): CapabilityGrant {
  const removed = effectiveRemovals(restrictions);
  return {
    userId: account.userId,
    accountId: account.accountId,
    state: account.state,
    restrictions,
    granted: capabilitiesFor(account.state, { removedCapabilities: removed }),
  };
}

export interface CapabilityAttempt {
  readonly capability: string;
  /**
   * Extra narrowing supplied by the calling surface (a per-request moderation
   * hold, say). It is merged *under* the grant's own removals, so a caller
   * context can only subtract. There is deliberately no way to pass a context
   * that adds capabilities back.
   */
  readonly context?: AccountContext;
}

export function isCapabilityGranted(grant: CapabilityGrant, attempt: CapabilityAttempt): boolean {
  if (!CAPABILITY_VOCABULARY.has(attempt.capability)) {
    return false;
  }
  const extraRemovals = (attempt.context?.removedCapabilities ?? []).filter(
    (capability) => !UNRESTRICTABLE_CAPABILITIES.includes(capability),
  );
  const removed = effectiveRemovals(grant.restrictions);
  return capabilitiesFor(grant.state, {
    removedCapabilities: [...removed, ...extraRemovals],
  }).includes(attempt.capability);
}

function effectiveRemovals(restrictions: readonly ActiveRestriction[]): readonly string[] {
  return restrictions
    .flatMap((restriction) => restriction.removedCapabilities)
    .filter((capability) => !UNRESTRICTABLE_CAPABILITIES.includes(capability));
}

/**
 * The only gate a product command passes through. It takes the grant rather
 * than the raw account state, because "raw state plus a hand-built context" is
 * exactly the shape of the bug where a restriction is forgotten:
 * `capabilitiesFor(state, {})` cheerfully returns the unrestricted list. Here
 * the removals travel with the grant, so no call site can forget them.
 */
export function requireCapability<T>(
  grant: CapabilityGrant,
  attempt: CapabilityAttempt,
  run: () => Result<T, DomainError>,
): Result<T, DomainError> {
  if (!isCapabilityGranted(grant, attempt)) {
    return domainError('not_eligible', 'platform', `capability "${attempt.capability}" is not available`, {
      capability: attempt.capability,
      state: grant.state,
    });
  }
  return run();
}
