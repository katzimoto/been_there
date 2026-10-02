import { describe, expect, it } from 'vitest';
import {
  canPerform,
  capabilitiesFor,
  castId,
  ok as succeed,
  type AccountState,
  type ActorId,
  type CaseId,
  type UserId,
} from '@been-there/core';
import {
  APPOINTMENT_BY_ROLE,
  authorize,
  capabilityGrantFor,
  isCapabilityGranted,
  protectedActionForAccountEvent,
  requireCapability,
  type ActiveRestriction,
  type Principal,
  type Role,
} from '../src/index.js';
import { rejected, succeeded } from './helpers.js';

const ALICE = castId<'UserId'>('u-alice') as UserId;
const CASE = castId<'CaseId'>('case-9') as CaseId;
const MODERATOR = castId<'ActorId'>('mod-3') as ActorId;

function principalFor(role: Role): Principal {
  return { userId: ALICE, role };
}

function restriction(removedCapabilities: readonly string[]): ActiveRestriction {
  return {
    caseId: CASE,
    moderatorId: MODERATOR,
    removedCapabilities,
    appliedAt: new Date('2026-02-01T00:00:00.000Z'),
  };
}

function grantIn(state: AccountState, restrictions: readonly ActiveRestriction[] = []) {
  return capabilityGrantFor(
    { userId: ALICE, accountId: castId<'AccountId'>('acct-1'), state },
    restrictions,
  );
}

const delivered = <T>(value: T) => succeed({ value });

describe('role boundaries', () => {
  it('reserves lifting a ban for a senior moderator', () => {
    const context = { caseId: CASE, moderatorId: MODERATOR };

    expect(succeeded(authorize(principalFor('senior_moderator'), 'account.enforce.lift_ban', context)).action).toBe(
      'account.enforce.lift_ban',
    );
    expect(rejected(authorize(principalFor('moderator'), 'account.enforce.lift_ban', context)).code).toBe(
      'permission_denied',
    );
  });

  it('refuses automation the judgement actions', () => {
    // `system` is the role a detector, a queue worker, or a scheduled job runs
    // as. If it could open a case or read evidence, the "humans enforce" rule
    // would be a convention.
    const withCase = { caseId: CASE, moderatorId: MODERATOR };

    expect(rejected(authorize(principalFor('system'), 'case.read_evidence', withCase)).code).toBe(
      'permission_denied',
    );
    expect(rejected(authorize(principalFor('system'), 'case.open', withCase)).code).toBe(
      'permission_denied',
    );
    expect(rejected(authorize(principalFor('system'), 'account.enforce.ban', withCase)).code).toBe(
      'permission_denied',
    );
  });

  it('refuses support the ability to act on a credential', () => {
    // Support reads session metadata to answer tickets. Completing a recovery
    // would let a support agent become the account.
    expect(rejected(authorize(principalFor('support'), 'auth.recover')).code).toBe(
      'permission_denied',
    );
    expect(succeeded(authorize(principalFor('user'), 'auth.recover')).action).toBe('auth.recover');
  });

  it('binds the clearance ceiling to the role, not just the permission', () => {
    // `moderator` holds case.decide.ban, so it passes the permission gate, and
    // it is stopped by clearance: a moderator may not read the restricted audit
    // trail. A senior moderator may.
    expect(rejected(authorize(principalFor('moderator'), 'audit.read')).details).toMatchObject({
      role: 'moderator',
    });
    expect(succeeded(authorize(principalFor('senior_moderator'), 'audit.read')).clearance).toEqual({
      upTo: 'restricted',
    });
  });

  it('requires a case and a named moderator for every enforcement action', () => {
    const senior = principalFor('senior_moderator');

    expect(rejected(authorize(senior, 'account.enforce.ban', { moderatorId: MODERATOR })).details).toEqual({
      action: 'account.enforce.ban',
    });
    expect(rejected(authorize(senior, 'account.enforce.ban', { caseId: CASE })).details).toEqual({
      action: 'account.enforce.ban',
    });
    expect(succeeded(authorize(senior, 'account.enforce.ban', { caseId: CASE, moderatorId: MODERATOR })).action).toBe(
      'account.enforce.ban',
    );
  });

  it('lets a plain moderator work a case, and reserves only the audit trail and the ban lift', () => {
    const moderator = principalFor('moderator');
    const context = { caseId: CASE, moderatorId: MODERATOR };

    // `platform.md` §3 gives a moderator the case work — open, read, decide,
    // restrict, suspend, ban — and withholds exactly two things: lifting a ban
    // and the restricted audit trail. A clearance that stopped the role before
    // the permission did would have made the "cannot" column true for the wrong
    // reason and the "can" column false.
    expect(succeeded(authorize(moderator, 'case.open', context)).action).toBe('case.open');
    expect(succeeded(authorize(moderator, 'case.read')).action).toBe('case.read');
    expect(succeeded(authorize(moderator, 'case.decide', context)).action).toBe('case.decide');
    expect(succeeded(authorize(moderator, 'account.enforce.ban', context)).action).toBe('account.enforce.ban');
    // Lifting a restriction is not a senior act; lifting a ban is.
    expect(succeeded(authorize(moderator, 'account.enforce.restrict', context)).action).toBe(
      'account.enforce.restrict',
    );
    expect(rejected(authorize(moderator, 'account.enforce.lift_ban', context)).code).toBe('permission_denied');
    expect(rejected(authorize(moderator, 'audit.read')).code).toBe('permission_denied');
  });

  it('reads the queue on its own authority, which needs neither a case nor a moderator', () => {
    // Seeing the queue and acting on a case are different authorities. The queue
    // gate is the only one that names neither a case nor a person, because a
    // moderator with nothing assigned still has to be able to see the queue.
    expect(succeeded(authorize(principalFor('moderator'), 'case.read')).clearance).toEqual({ upTo: 'sensitive' });
    expect(rejected(authorize(principalFor('support'), 'case.read')).code).toBe('permission_denied');
    expect(rejected(authorize(principalFor('user'), 'case.read')).code).toBe('permission_denied');
    expect(rejected(authorize(principalFor('system'), 'case.read')).code).toBe('permission_denied');
  });

  it('gives the identity privacy officer the identity read and no judgement at all', () => {
    const officer = principalFor('identity_privacy_officer');
    const context = { caseId: CASE, moderatorId: MODERATOR };

    // The appointment is in the identity domain and is not a promotion of a
    // moderator, so it can read a case's evidence and nothing else about it.
    expect(succeeded(authorize(officer, 'identity.read_evidence')).action).toBe('identity.read_evidence');
    expect(succeeded(authorize(officer, 'case.read_evidence', context)).action).toBe('case.read_evidence');
    expect(rejected(authorize(officer, 'case.decide', context)).code).toBe('permission_denied');
    expect(rejected(authorize(officer, 'account.enforce.ban', context)).code).toBe('permission_denied');
    // Nor is it a lead: the evidence ladder is computed from the appointment, and
    // an officer is not one.
    expect(APPOINTMENT_BY_ROLE.identity_privacy_officer.isLead).toBe(false);
    expect(APPOINTMENT_BY_ROLE.senior_moderator.isLead).toBe(true);
    // And the clearance stops at `sensitive`, so the restricted audit trail is
    // still the single cell `platform.md` §4 reserves for senior moderation.
    expect(rejected(authorize(officer, 'audit.read')).code).toBe('permission_denied');
  });

  it('authorises a reversal by the lift it performs, not by the sanction it answers', () => {
    // The mapping a reversal endpoint depends on: `lift_ban` is the senior-only
    // authority and nothing else is, so a reversal of a ban is refused to a plain
    // moderator while a reversal of a restriction is not.
    expect(protectedActionForAccountEvent('lift_ban')).toBe('account.enforce.lift_ban');
    expect(protectedActionForAccountEvent('lift_restriction')).toBe('account.enforce.restrict');
    expect(protectedActionForAccountEvent('reinstate')).toBe('account.enforce.suspend');
    expect(protectedActionForAccountEvent('ban')).toBe('account.enforce.ban');

    const context = { caseId: CASE, moderatorId: MODERATOR };
    expect(rejected(authorize(principalFor('moderator'), protectedActionForAccountEvent('lift_ban'), context)).code).toBe(
      'permission_denied',
    );
    expect(
      succeeded(authorize(principalFor('moderator'), protectedActionForAccountEvent('reinstate'), context)).action,
    ).toBe('account.enforce.suspend');
  });
});

describe('capability grant', () => {
  it('removes a capability a restriction names, and keeps the rest', () => {
    const grant = grantIn('limited', [restriction(['send_message'])]);

    expect(rejected(requireCapability(grant, { capability: 'send_message' }, () => delivered('sent'))).code).toBe(
      'not_eligible',
    );
    expect(succeeded(requireCapability(grant, { capability: 'report' }, () => delivered('reported')))).toEqual({
      value: 'reported',
    });
    expect(isCapabilityGranted(grant, { capability: 'browse_discovery' })).toBe(true);
    expect(isCapabilityGranted(grant, { capability: 'like' })).toBe(false);
  });

  it('cannot be widened by a caller-supplied context', () => {
    const grant = grantIn('active', [restriction(['send_message'])]);

    // The bypass this guards against is real and looks like this: a call site
    // that asks the account machine directly with a context it built itself.
    // `capabilitiesFor('active', {})` returns the unrestricted list, and
    // `canPerform` with the same empty context happily says yes.
    expect(capabilitiesFor('active', {})).toContain('send_message');
    expect(canPerform({ state: 'active' }, 'send_message', {})).toBe(true);

    // Through the gate, the removal travels with the grant and a context that
    // removes nothing cannot put the capability back.
    expect(
      rejected(
        requireCapability(
          grant,
          { capability: 'send_message', context: { removedCapabilities: [] } },
          () => delivered('sent'),
        ),
      ).details,
    ).toEqual({ capability: 'send_message', state: 'active' });
    expect(
      rejected(
        requireCapability(grant, { capability: 'send_message', context: { caseId: CASE } }, () => delivered('sent')),
      ).code,
    ).toBe('not_eligible');
  });

  it('lets a caller narrow further but never widen', () => {
    const grant = grantIn('active');

    expect(
      rejected(
        requireCapability(
          grant,
          { capability: 'like', context: { removedCapabilities: ['like'] } },
          () => delivered('liked'),
        ),
      ).code,
    ).toBe('not_eligible');
    expect(succeeded(requireCapability(grant, { capability: 'like' }, () => delivered('liked')))).toEqual({
      value: 'liked',
    });
  });

  it('refuses a capability name the account machine never grants', () => {
    const grant = grantIn('active');

    // A typo must fail closed. `send_messages` is not a capability anyone has,
    // and an unrecognised name is "not granted", never "not restricted".
    expect(isCapabilityGranted(grant, { capability: 'send_messages' })).toBe(false);
    expect(rejected(requireCapability(grant, { capability: 'delete_everything' }, () => delivered('x'))).code).toBe(
      'not_eligible',
    );
  });

  it('refuses to let a restriction take away reporting or blocking', () => {
    // A restriction that removed `report` would stop abuse reports arriving, and
    // one that removed `block` would leave a victim unable to protect
    // themselves. Neither failure is visible in any metric the platform can see,
    // so the removals are filtered rather than trusted.
    const grant = grantIn('active', [restriction(['send_message', 'report', 'block'])]);

    expect(isCapabilityGranted(grant, { capability: 'report' })).toBe(true);
    expect(isCapabilityGranted(grant, { capability: 'block' })).toBe(true);
    expect(isCapabilityGranted(grant, { capability: 'send_message' })).toBe(false);
    // The same holds for a caller's own narrowing context.
    expect(
      isCapabilityGranted(grant, { capability: 'report', context: { removedCapabilities: ['report'] } }),
    ).toBe(true);
  });

  it('unions the removals of every active restriction', () => {
    const grant = grantIn('limited', [
      restriction(['like']),
      restriction(['browse_discovery']),
    ]);

    expect(grant.granted).toEqual(['report', 'block', 'edit_profile']);
    expect(isCapabilityGranted(grant, { capability: 'like' })).toBe(false);
    expect(isCapabilityGranted(grant, { capability: 'browse_discovery' })).toBe(false);
  });

  it('keeps a banned account inside the appeal surface and nothing else', () => {
    const grant = grantIn('banned');

    expect(isCapabilityGranted(grant, { capability: 'browse_discovery' })).toBe(false);
    expect(isCapabilityGranted(grant, { capability: 'send_message' })).toBe(false);
    expect(isCapabilityGranted(grant, { capability: 'appeal_request' })).toBe(true);
    // Reporting is never taken away, not even from a banned account: the
    // evidence of an abuse case must keep flowing.
    expect(isCapabilityGranted(grant, { capability: 'report' })).toBe(true);
  });

  it('lets a suspended account report and block but not browse', () => {
    const grant = grantIn('suspended');

    expect(isCapabilityGranted(grant, { capability: 'report' })).toBe(true);
    expect(isCapabilityGranted(grant, { capability: 'block' })).toBe(true);
    expect(isCapabilityGranted(grant, { capability: 'browse_discovery' })).toBe(false);
    expect(isCapabilityGranted(grant, { capability: 'like' })).toBe(false);
  });
});
