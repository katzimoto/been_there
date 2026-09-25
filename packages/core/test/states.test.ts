import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES_BY_ACCOUNT_STATE,
  accountMachine,
  assertMachineIsTotal,
  canPerform,
  castId,
  capabilitiesFor,
  identityMachine,
  InMemoryEventBus,
  isClearedToConsume,
  isDiscoverableIdentity,
  isVisibleInProduct,
  riskMachine,
  type AccountState,
  type DomainEvent,
  type IdentityState,
  type Result,
  type RiskState,
} from '../src/index.js';

/**
 * Test seams for the Result sum type. Reading `.value` directly is a type
 * error by design; these make a test fail with the error code instead.
 */
function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.error.code}`);
  }
  return result.value;
}

function rejected<T, E>(result: Result<T, E>): boolean {
  return !result.ok;
}

describe('identity machine', () => {
  const reviewer = { reviewerId: 'mod-1' };

  it('starts unverified and non-discoverable', () => {
    expect(identityMachine.initial).toBe<IdentityState>('unverified');
    expect(
      isDiscoverableIdentity({ state: 'unverified', latestVerificationId: null, generation: 0 }),
    ).toBe(false);
  });

  it('only grants verified at or above the confidence floor', () => {
    const pending = succeeded(identityMachine.next('unverified', 'submit_verification'));
    expect(pending).toBe<IdentityState>('pending');

    expect(rejected(identityMachine.next(pending, 'provider_result_received', { confidence: 0.89 }))).toBe(
      true,
    );
    expect(
      succeeded(identityMachine.next(pending, 'provider_result_received', { confidence: 0.9 })),
    ).toBe<IdentityState>('verified');
  });

  it('never lets a review clear without a named human reviewer', () => {
    expect(rejected(identityMachine.next('review_required', 'review_cleared', {}))).toBe(true);
    expect(succeeded(identityMachine.next('review_required', 'review_cleared', reviewer))).toBe<IdentityState>(
      'verified',
    );
  });

  it('drops a user out of discovery on expiry but keeps them known', () => {
    const expired = succeeded(identityMachine.next('verified', 'expire'));
    expect(expired).toBe<IdentityState>('expired');
    expect(
      isDiscoverableIdentity({ state: 'expired', latestVerificationId: null, generation: 1 }),
    ).toBe(false);
  });

  it('re-verification re-enters pending from any trusted state', () => {
    for (const from of ['verified', 'expired', 'review_required'] as const) {
      expect(
        succeeded(identityMachine.next(from, 'reverify_requested', { reVerification: true })),
      ).toBe<IdentityState>('pending');
    }
  });

  it('has no way to reach verified from review_required without a review', () => {
    expect(identityMachine.allowedEvents('review_required')).not.toContain('provider_result_received');
    expect(identityMachine.legalEvents('review_required')).toContain('review_cleared');
  });

  it('makes verified reachable from the initial state', () => {
    expect(identityMachine.legalEvents('unverified')).toContain('submit_verification');
  });
});

describe('account machine', () => {
  const caseAndModerator = { caseId: 'case-1', moderatorId: 'mod-1' };

  it('requires a case for every enforcement action', () => {
    for (const event of ['restrict', 'suspend', 'ban'] as const) {
      expect(rejected(accountMachine.next('active', event, {}))).toBe(true);
    }
  });

  it('requires a restriction to name a removed capability', () => {
    expect(rejected(accountMachine.next('active', 'restrict', { caseId: 'case-1' }))).toBe(true);
    expect(
      succeeded(
        accountMachine.next('active', 'restrict', {
          caseId: 'case-1',
          removedCapabilities: ['send_message'],
        }),
      ),
    ).toBe<AccountState>('limited');
  });

  it('escalates from limited to suspended', () => {
    expect(succeeded(accountMachine.next('limited', 'suspend', caseAndModerator))).toBe<AccountState>(
      'suspended',
    );
  });

  it('grants a limited account a strict subset of an active account', () => {
    const active = CAPABILITIES_BY_ACCOUNT_STATE.active;
    const limited = CAPABILITIES_BY_ACCOUNT_STATE.limited;
    expect(limited.length).toBeLessThan(active.length);
    for (const capability of limited) {
      expect(active).toContain(capability);
    }
    expect(limited).not.toContain('send_message');
  });

  it('removes the messaging capability a restriction explicitly names', () => {
    const capabilities = capabilitiesFor('limited', { removedCapabilities: ['send_message'] });
    expect(capabilities).not.toContain('send_message');
    expect(capabilities).toContain('report');
  });

  it('keeps a suspended user able to report, never to browse', () => {
    expect(canPerform({ state: 'suspended' }, 'browse_discovery')).toBe(false);
    expect(canPerform({ state: 'suspended' }, 'report')).toBe(true);
    expect(canPerform({ state: 'banned' }, 'delete_account')).toBe(true);
    expect(canPerform({ state: 'banned' }, 'send_message')).toBe(false);
  });

  it('hides banned accounts from the product surface', () => {
    expect(isVisibleInProduct('banned')).toBe(false);
    expect(isVisibleInProduct('suspended')).toBe(true);
  });
});

describe('risk machine', () => {
  const RISK_STATES: readonly RiskState[] = ['normal', 'elevated', 'high', 'critical'];

  it('never escalates on a weak signal', () => {
    expect(rejected(riskMachine.next('normal', 'signal_observed', { score: 0.49 }))).toBe(true);
  });

  it('requires a very strong signal or corroboration to reach critical', () => {
    expect(rejected(riskMachine.next('high', 'signal_observed', { score: 0.8 }))).toBe(true);
    expect(
      succeeded(
        riskMachine.next('high', 'signal_observed', { score: 0.8, corroboratingDetectors: 2 }),
      ),
    ).toBe<RiskState>('critical');
  });

  it('decays by at most one step and only after a long enough quiet period', () => {
    expect(rejected(riskMachine.next('high', 'decay', { daysSinceLastSignal: 3 }))).toBe(true);
    expect(succeeded(riskMachine.next('high', 'decay', { daysSinceLastSignal: 14 }))).toBe<RiskState>(
      'elevated',
    );
    expect(
      succeeded(riskMachine.next('critical', 'decay', { daysSinceLastSignal: 30 })),
    ).toBe<RiskState>('high');
  });

  it('lets a human lower risk but never lets a detector clear it', () => {
    expect(rejected(riskMachine.next('critical', 'manual_reassess', {}))).toBe(true);
    expect(
      succeeded(riskMachine.next('critical', 'manual_reassess', { assessorId: 'mod-1' })),
    ).toBe<RiskState>('normal');
  });

  it('offers a decay path out of every non-normal state', () => {
    for (const state of RISK_STATES) {
      if (state === 'normal') {
        expect(riskMachine.legalEvents(state)).toContain('signal_observed');
        continue;
      }
      expect(riskMachine.legalEvents(state)).toContain('decay');
    }
  });
});

describe('machine totality', () => {
  it('leaves no declared state structurally stranded', () => {
    assertMachineIsTotal(identityMachine);
    assertMachineIsTotal(accountMachine);
    assertMachineIsTotal(riskMachine);
  });

  it('leaves no account state without a way out, including a ban', () => {
    for (const state of accountMachine.states) {
      expect(accountMachine.legalEvents(state).length).toBeGreaterThan(0);
    }
    expect(accountMachine.legalEvents('banned')).toContain('lift_ban');
  });
});

describe('event clearance', () => {
  const event = (sensitivity: DomainEvent['sensitivity']): DomainEvent => ({
    eventId: castId<'EventId'>('e-1'),
    type: 'test.event',
    version: 1,
    occurredAt: new Date('2026-01-01T00:00:00Z'),
    actorId: 'system',
    correlationId: castId<'CorrelationId'>('c-1'),
    sensitivity,
    payload: {},
  });

  it('hides an event a consumer is not cleared for', () => {
    expect(isClearedToConsume({ upTo: 'internal' }, event('internal'))).toBe(true);
    expect(isClearedToConsume({ upTo: 'internal' }, event('sensitive'))).toBe(false);
    expect(isClearedToConsume({ upTo: 'public' }, event('user'))).toBe(false);
  });

  it('delivers only cleared events to a subscriber', async () => {
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe({ upTo: 'internal' }, (e) => {
      seen.push(e.sensitivity);
    });

    await bus.publish(event('public'));
    await bus.publish(event('internal'));
    await bus.publish(event('sensitive'));

    expect(seen).toEqual(['public', 'internal']);
  });
});

describe('id branding', () => {
  it('keeps distinct aggregate id types nominally separate', () => {
    expect(castId<'UserId'>('u-1')).toBe(castId<'SubjectId'>('u-1'));
    expect(castId<'UserId'>('u-1')).not.toBe(castId<'MatchId'>('m-1'));
  });
});
