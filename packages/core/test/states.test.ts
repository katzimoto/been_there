import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES_BY_ACCOUNT_STATE,
  accountMachine,
  UNRESTRICTABLE_CAPABILITIES,
  assertMachineIsTotal,
  canPerform,
  castId,
  capabilitiesFor,
  defineStateMachine,
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
  type RiskContext,
  type RiskEvent,
  type RiskState,
  type StateMachine,
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

function rejectionCode<T, E extends { code: string }>(result: Result<T, E>): string {
  if (result.ok) {
    throw new Error(`expected a rejection, got the value ${String(result.value)}`);
  }
  return result.error.code;
}

/**
 * `defineStateMachine` resolves a transition with `transitions.find(...)`, so
 * when two rows share an `(event, from)` pair the second is unreachable and
 * `legalEvents` reports the same event twice. A repeated name is therefore the
 * observable signature of a shadowed row — the one symptom a table gets
 * structurally wrong.
 */
function shadowedEvents<S extends string, E extends string, C>(
  machine: StateMachine<S, E, C>,
): string[] {
  const shadowed: string[] = [];
  for (const state of machine.states) {
    const seen = new Set<E>();
    for (const event of machine.legalEvents(state)) {
      if (seen.has(event)) {
        shadowed.push(`${machine.domain} ${state} ${event}`);
      }
      seen.add(event);
    }
  }
  return shadowed;
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

  it('re-verification re-enters pending from verified and expired', () => {
    for (const from of ['verified', 'expired'] as const) {
      expect(
        succeeded(identityMachine.next(from, 'reverify_requested', { reVerification: true })),
      ).toBe<IdentityState>('pending');
    }
  });

  it('refuses to re-verify an account out of human review, by any requester', () => {
    // Automation must not walk a case back out from under a reviewer. The
    // caller-supplied context claims a re-verification; the kernel still refuses.
    expect(
      identityMachine.can('review_required', 'reverify_requested', { reVerification: true }),
    ).toBe(false);
    expect(
      rejected(identityMachine.next('review_required', 'reverify_requested', { reVerification: true })),
    ).toBe(true);
  });

  it('leaves a flagged account only through a human decision, or by withdrawing', () => {
    // `withdraw` is legal from every state by design - a user may always
    // leave. What must not be possible is an automatic route out.
    const exits = identityMachine.legalEvents('review_required');
    expect(exits).toContain('review_cleared');
    expect(exits).toContain('review_confirmed_fraud');
    expect(exits).not.toContain('reverify_requested');
    expect(exits).not.toContain('provider_result_received');
    expect(exits).not.toContain('expire');
  });

  it('reaches a human review from a repeated verification failure', () => {
    expect(
      succeeded(identityMachine.next('verification_failed', 'flag_for_review', { reviewerId: 'mod-1' })),
    ).toBe<IdentityState>('review_required');
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

  it('refuses to lift a restriction without a named moderator', () => {
    // A restriction is a human decision; reversing it is one too. Anything that
    // can name a case id but is not a moderator must not undo a sanction, or
    // automation can reverse enforcement — the same violation as applying it.
    expect(rejectionCode(accountMachine.next('limited', 'lift_restriction', { caseId: 'case-1' }))).toBe(
      'validation_failed',
    );
    expect(rejectionCode(accountMachine.next('limited', 'lift_restriction', {}))).toBe(
      'validation_failed',
    );
    expect(
      succeeded(accountMachine.next('limited', 'lift_restriction', caseAndModerator)),
    ).toBe<AccountState>('active');
  });

  it('reverses a ban only for a named moderator, matching the sanction path', () => {
    expect(rejectionCode(accountMachine.next('banned', 'lift_ban', { caseId: 'case-1' }))).toBe(
      'validation_failed',
    );
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

  it('refuses to strip a capability no restriction may take, whatever the context claims', () => {
    // A limited account that has had every restrictable capability removed must
    // still reach a human and still protect itself. The filter is the floor, so
    // it is checked against a removal list that names the floor explicitly.
    const capabilities = capabilitiesFor('limited', {
      removedCapabilities: ['report', 'block', 'browse_discovery', 'edit_profile'],
    });
    expect(capabilities).toContain('report');
    expect(capabilities).toContain('block');
    expect(capabilities).not.toContain('browse_discovery');
    expect(capabilities).not.toContain('edit_profile');
  });

  it('keeps delete_account on a banned account no matter what a restriction names', () => {
    expect(
      capabilitiesFor('banned', { removedCapabilities: ['delete_account', 'report', 'block'] }),
    ).toContain('delete_account');
  });

  it('leaves a limited account able to report and block, the spec claim end to end', () => {
    // The whole report/block floor, exercised through canPerform rather than
    // the raw list, because canPerform is what a product surface actually calls.
    for (const removed of [
      ['send_message', 'like', 'browse_discovery'],
      ['report', 'block', 'send_message', 'like', 'browse_discovery', 'edit_profile'],
    ]) {
      expect(canPerform({ state: 'limited' }, 'report', { removedCapabilities: removed })).toBe(true);
      expect(canPerform({ state: 'limited' }, 'block', { removedCapabilities: removed })).toBe(true);
    }
  });

  it('never names an unrestrictable capability that no account state grants', () => {
    // If the list drifts out of the capability vocabulary the filter becomes
    // vacuous — it would silently pass everything and protect nothing.
    const vocabulary = Object.values(CAPABILITIES_BY_ACCOUNT_STATE).flat();
    for (const capability of UNRESTRICTABLE_CAPABILITIES) {
      expect(vocabulary, `${capability} is granted by no state`).toContain(capability);
    }
  });

  it('keeps every unrestrictable capability in every state that grants it', () => {
    // The floor is only meaningful if the state lists themselves keep it: a
    // future edit that drops `report` from `banned` would defeat the filter
    // before it ever ran.
    for (const [state, capabilities] of Object.entries(CAPABILITIES_BY_ACCOUNT_STATE)) {
      for (const capability of capabilities) {
        if (UNRESTRICTABLE_CAPABILITIES.includes(capability)) {
          expect(
            capabilitiesFor(state as AccountState, { removedCapabilities: [capability] }),
            `${state} lost ${capability}`,
          ).toContain(capability);
        }
      }
    }
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

  it('reaches critical from high on an unguarded threshold_crossed, with no context at all', () => {
    // The trust-safety policy layer never requests this edge from `high`
    // precisely because it has no guard and so skips corroboration
    // (docs/architecture/trust-safety.md §6). That argument only holds if the
    // edge is live, and a row ordered after the guarded
    // `normal|elevated|high → high` row is dead: `find` returns the first match,
    // so `high + threshold_crossed` would land back on `high`.
    expect(succeeded(riskMachine.next('high', 'threshold_crossed'))).toBe<RiskState>('critical');
    expect(succeeded(riskMachine.next('high', 'threshold_crossed', { score: 0.95 }))).toBe<RiskState>(
      'critical',
    );
    expect(
      riskMachine.legalEvents('high').filter((event) => event === 'threshold_crossed'),
    ).toHaveLength(1);
  });

  it('reaches high from below only when the score clears the threshold', () => {
    expect(rejectionCode(riskMachine.next('normal', 'threshold_crossed', { score: 0.2 }))).toBe(
      'validation_failed',
    );
    expect(succeeded(riskMachine.next('normal', 'threshold_crossed', { score: 0.8 }))).toBe<RiskState>(
      'high',
    );
    expect(
      succeeded(riskMachine.next('elevated', 'threshold_crossed', { score: 0.8 })),
    ).toBe<RiskState>('high');
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

describe('shadowed transition rows', () => {
  it('never offers the same event twice from any state of any machine', () => {
    expect(shadowedEvents(identityMachine)).toEqual([]);
    expect(shadowedEvents(accountMachine)).toEqual([]);
    expect(shadowedEvents(riskMachine)).toEqual([]);
  });

  it('detects a shadowed row in a table that has one', () => {
    // Proves the check above can fail: a second `high → high` row shadows the
    // `high → critical` row behind it, exactly as the risk table once did.
    const shadowed = defineStateMachine<RiskState, RiskEvent, RiskContext>({
      domain: 'shadow-repro',
      initial: 'normal',
      transitions: [
        { event: 'threshold_crossed', from: ['normal', 'elevated', 'high'], to: 'high' },
        { event: 'threshold_crossed', from: ['high'], to: 'critical' },
      ],
    });
    expect(shadowedEvents(shadowed)).toEqual(['shadow-repro high threshold_crossed']);
    expect(succeeded(shadowed.next('high', 'threshold_crossed'))).toBe<RiskState>('high');
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
