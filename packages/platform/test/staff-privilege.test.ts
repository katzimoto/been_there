/**
 * Least privilege for the staff identity: the capability floor holds against a
 * staff actor, and the two role vocabularies — the SQL `CHECK` and
 * `STAFF_ROLES` — are the same list.
 *
 * Three things are proved here that were previously implicit.
 *
 * 1. The SQL `role IN (...)` on `app.staff_identities` and the exported
 *    `STAFF_ROLES` are compared as sets. They are two hand-maintained copies of
 *    one fact; nothing else forces them to agree, and the failure mode is quiet
 *    in both directions. A role in TS but not in SQL is an identity that cannot
 *    be stored; a role in SQL but not in TS is a row that authenticates into a
 *    role `authorize` has never heard of, which is the row that is refused at
 *    the first gate with no way to tell a broken directory from a revoked one.
 *
 * 2. A staff role is not a member role with extra keys. Membership brings
 *    `discovery.read`, `profile.write.own`, `media.read.own` and
 *    `auth.recover.own`; the staff roles hold none of them. This is asserted
 *    against the intersection rather than a hardcoded list, so adding a member
 *    permission widens the assertion instead of leaving it stale.
 *
 * 3. The unrestrictable capabilities are enforced where the grant is computed,
 *    which is the only position from which a staff actor — whose job is acting
 *    on other people's accounts — cannot subtract them. The kernel-side floor is
 *    proved in `packages/core/test/staff-privilege.test.ts`; this is the same
 *    floor seen through `capabilityGrantFor`, `isCapabilityGranted` and
 *    `requireCapability`, which is the shape every product command actually
 *    receives.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { capabilitiesFor, castId, ok as succeed, type AccountState } from '@been-there/core';
import {
  APPOINTMENT_BY_ROLE,
  CLEARANCE_BY_ROLE,
  PERMISSIONS_BY_ROLE,
  STAFF_ROLES,
  authorize,
  capabilityGrantFor,
  hasPermission,
  isCapabilityGranted,
  requireCapability,
  UNRESTRICTABLE_CAPABILITIES,
  isStaffRole,
  type ActiveRestriction,
  type Permission,
  type Principal,
  type Role,
} from '../src/index.js';
import { rejected, succeeded } from './helpers.js';

/**
 * Read as source rather than imported as a value: the SQL has no runtime form,
 * and the platform package must not take a dependency on the database package
 * for the sake of a test. The relative path is the sibling-package pattern
 * `communication-signal-contract.test.ts` already uses.
 */
const STAFF_IDENTITY_MIGRATION = new URL(
  '../../database/migrations/008_staff_identity.sql',
  import.meta.url,
);

/**
 * The `role` column's CHECK, captured rather than pattern-matched loosely: the
 * first statement that declares a `role text NOT NULL CHECK (role IN (...))`
 * column inside `staff_identities` is this table's, and a match that fails to
 * parse must fail the test rather than yield an empty list that compares equal
 * to nothing.
 */
function sqlRoleVocabulary(): readonly string[] {
  const sql = readFileSync(STAFF_IDENTITY_MIGRATION, 'utf8');
  const match = sql.match(/role\s+text\s+NOT\s+NULL\s+CHECK\s*\(\s*role\s+IN\s*\(([^)]*)\)/s);
  if (match?.[1] === undefined) {
    throw new Error(
      `no "role ... CHECK (role IN (...))" column found in ${STAFF_IDENTITY_MIGRATION.pathname}`,
    );
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1] as string);
}

function principalWith(role: Role): Principal {
  return { userId: castId<'UserId'>('u-alice'), role };
}

function restriction(removedCapabilities: readonly string[]): ActiveRestriction {
  return {
    caseId: castId<'CaseId'>('case-9'),
    moderatorId: castId<'ActorId'>('mod-3'),
    removedCapabilities,
    appliedAt: new Date('2026-02-01T00:00:00.000Z'),
  };
}

function grantIn(state: AccountState, restrictions: readonly ActiveRestriction[] = []) {
  return capabilityGrantFor(
    { userId: castId<'UserId'>('u-alice'), accountId: castId<'AccountId'>('acct-1'), state },
    restrictions,
  );
}

/** `delete_account` is granted only by `banned`; the rest of the floor everywhere. */
const FLOOR_STATE: Readonly<Record<string, AccountState>> = {
  report: 'active',
  block: 'active',
  delete_account: 'banned',
};

/** A restrictable capability each standing really grants, for the subtraction half. */
const RESTRICTABLE_NEIGHBOUR: Readonly<Record<AccountState, string>> = {
  active: 'send_message',
  limited: 'like',
  suspended: 'browse_discovery',
  banned: 'appeal_request',
};

describe('the SQL and TS staff role vocabularies agree', () => {
  it('parses a non-empty role list out of the staff_identities CHECK', () => {
    // Guards the test above it: an empty list would make every set comparison
    // below pass vacuously.
    expect(sqlRoleVocabulary().length).toBeGreaterThan(0);
  });

  it('admits exactly STAFF_ROLES, no more and no fewer', () => {
    const sql = sqlRoleVocabulary();
    const ts = STAFF_ROLES;

    const sqlOnly = sql.filter((role) => !ts.includes(role as Role));
    const tsOnly = ts.filter((role) => !sql.includes(role));

    expect(
      { sqlOnly, tsOnly },
      'the staff role CHECK and STAFF_ROLES have drifted apart',
    ).toEqual({ sqlOnly: [], tsOnly: [] });

    // Order is not part of the agreement, but a duplicate in either list would
    // make a length comparison look right while the set is wrong, so it is
    // ruled out directly.
    expect(new Set(sql).size).toBe(sql.length);
    expect(new Set(ts).size).toBe(ts.length);
    expect([...ts].sort()).toEqual([...sql].sort());
  });

  it('never lets the directory mint a member or a machine', () => {
    // `user` would turn the staff directory into a second way to be a member;
    // `system` would let a human directory mint automation, which is what makes
    // "a decision requires a person" a directory-management decision instead.
    for (const forbidden of ['user', 'system']) {
      expect(STAFF_ROLES).not.toContain(forbidden as Role);
      expect(sqlRoleVocabulary()).not.toContain(forbidden);
    }
  });

  it('gives every stored role a permission set, a clearance and an appointment', () => {
    // A role the SQL admits is a role `authorize` will look up. A missing entry
    // in any of these three records is an unhandled access, not a denial.
    for (const role of STAFF_ROLES) {
      expect(isStaffRole(role)).toBe(true);
      expect(PERMISSIONS_BY_ROLE[role], `${role} has no permissions`).toBeDefined();
      expect(CLEARANCE_BY_ROLE[role], `${role} has no clearance`).toBeDefined();
      expect(APPOINTMENT_BY_ROLE[role], `${role} has no appointment`).toBeDefined();
      // Nobody on the staff ladder is simultaneously the automation role.
      expect(PERMISSIONS_BY_ROLE[role]).not.toContain('system.integration.call');
    }
  });
});

describe('a staff session is not a superset of a member', () => {
  /** Everything membership buys. Computed, so a new member permission widens the check. */
  const MEMBER_ONLY: readonly Permission[] = PERMISSIONS_BY_ROLE.user;

  it('holds a member-only permission, so the intersection below is not vacuous', () => {
    expect(MEMBER_ONLY.length).toBeGreaterThan(0);
    expect(MEMBER_ONLY).toContain('discovery.read');
    expect(MEMBER_ONLY).toContain('profile.write.own');
    expect(MEMBER_ONLY).toContain('media.read.own');
    expect(MEMBER_ONLY).toContain('auth.recover.own');
  });

  it('grants every staff role none of them', () => {
    for (const role of STAFF_ROLES) {
      const leaked = PERMISSIONS_BY_ROLE[role].filter((permission) =>
        MEMBER_ONLY.includes(permission),
      );
      expect(leaked, `role "${role}" reaches member capabilities: ${leaked.join(', ')}`).toEqual([]);
    }
  });

  it('reports the same answer through hasPermission', () => {
    for (const role of STAFF_ROLES) {
      for (const permission of MEMBER_ONLY) {
        expect(hasPermission(role, permission), `${role} has ${permission}`).toBe(false);
      }
    }
  });
});

describe('a staff actor cannot strip the capability floor', () => {
  it('names report and delete_account as unrestrictable', () => {
    expect(UNRESTRICTABLE_CAPABILITIES).toContain('report');
    expect(UNRESTRICTABLE_CAPABILITIES).toContain('delete_account');
  });

  for (const capability of UNRESTRICTABLE_CAPABILITIES) {
    // The standing that actually grants the capability: `delete_account` is
    // `banned` only, so a floor asserted against `active` would pass for the
    // wrong reason — the name is absent, not protected.
    const state = FLOOR_STATE[capability] as AccountState;
    // A restrictable name this standing really grants, so the subtraction half
    // of every assertion below is a real observation.
    const neighbour = RESTRICTABLE_NEIGHBOUR[state] as string;

    it(`keeps ${capability} in the grant when a staff-authored restriction names it`, () => {
      const grant = grantIn(state, [restriction([neighbour, capability])]);

      expect(grant.granted).toContain(capability);
      // The restrictable neighbour is still removed, or the filter is inert and
      // the floor proves nothing.
      expect(grant.granted).not.toContain(neighbour);
      expect(isCapabilityGranted(grant, { capability })).toBe(true);
      expect(isCapabilityGranted(grant, { capability: neighbour })).toBe(false);
    });

    it(`keeps ${capability} granted at the gate and through requireCapability`, () => {
      const grant = grantIn(state, [restriction([capability])]);

      expect(isCapabilityGranted(grant, { capability })).toBe(true);
      expect(succeeded(requireCapability(grant, { capability }, () => succeed('used')))).toBe('used');
    });

    it(`keeps ${capability} granted when the removal arrives as caller context`, () => {
      // The context path is the one that bypassed intake. It merges under the
      // grant's own removals and may only subtract, so the floor has to survive
      // it as well.
      const grant = grantIn(state);
      expect(
        isCapabilityGranted(grant, { capability, context: { removedCapabilities: [capability] } }),
      ).toBe(true);
      expect(
        succeeded(
          requireCapability(
            grant,
            { capability, context: { removedCapabilities: [capability] } },
            () => succeed('used'),
          ),
        ),
      ).toBe('used');
    });

    it(`keeps ${capability} when the grant is computed from the raw state`, () => {
      expect(capabilitiesFor(state, { removedCapabilities: [capability] })).toContain(capability);
    });
  }

  it('still refuses a capability no standing grants', () => {
    // The complement of the floor tests: an unrestrictable name a standing does
    // not grant is not granted, so the floor is not a grant-by-omission.
    const grant = grantIn('active');
    expect(isCapabilityGranted(grant, { capability: 'delete_account' })).toBe(false);
    expect(isCapabilityGranted(grant, { capability: 'not_a_capability' })).toBe(false);
    expect(
      rejected(requireCapability(grant, { capability: 'delete_account' }, () => succeed('used'))).code,
    ).toBe('not_eligible');
  });
});

describe('a staff role cannot act as a member', () => {
  it('gives no staff role the recovery permission', () => {
    for (const role of STAFF_ROLES) {
      expect(hasPermission(role, 'auth.recover.own'), `${role} holds auth.recover.own`).toBe(false);
    }
  });

  it('refuses auth.recover to every staff role, even with a case and a moderator', () => {
    // Recovery is the account-takeover path: it mints a credential for someone
    // else's account. Naming a case and a moderator is exactly what a staff
    // principal can supply, so the refusal has to come from the permission gate
    // and not from a missing argument.
    const context = {
      caseId: castId<'CaseId'>('case-9'),
      moderatorId: castId<'ActorId'>('mod-3'),
    };
    for (const role of STAFF_ROLES) {
      const result = authorize(principalWith(role), 'auth.recover', context);
      expect(rejected(result).code, `${role} was authorised to recover an account`).toBe(
        'permission_denied',
      );
      expect(rejected(result).message).toContain(role);
    }
  });

  it('refuses auth.recover to a staff role given a case and a moderator on every surface', () => {
    // Same refusal with the context omitted entirely, to show it is the role and
    // not the shape of the arguments.
    for (const role of STAFF_ROLES) {
      expect(
        rejected(authorize(principalWith(role), 'auth.recover')).code,
        `${role} was authorised to recover an account`,
      ).toBe('permission_denied');
    }
  });

  it('leaves recovery to the owner, who does hold the permission', () => {
    // The floor is a boundary, not an absence: the member role keeps the path
    // it is supposed to keep.
    expect(hasPermission('user', 'auth.recover.own')).toBe(true);
    expect(succeeded(authorize(principalWith('user'), 'auth.recover')).action).toBe('auth.recover');
  });
});