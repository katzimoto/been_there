import { describe, expect, it } from 'vitest';
import { CAPABILITIES_BY_ACCOUNT_STATE, accountMachine, assertMachineIsTotal, canPerform, castId, capabilitiesFor, identityMachine, InMemoryEventBus, isClearedToConsume, isDiscoverableIdentity, isVisibleInProduct, riskMachine, } from '../src/index.js';
describe('identity machine', () => {
    const reviewer = { reviewerId: 'mod-1' };
    it('starts unverified and non-discoverable', () => {
        expect(identityMachine.initial).toBe('unverified');
        expect(isDiscoverableIdentity({ state: 'unverified', latestVerificationId: null, generation: 0 })).toBe(false);
    });
    it('only grants verified at or above the confidence floor', () => {
        const pending = identityMachine.next('unverified', 'submit_verification').value;
        expect(pending).toBe('pending');
        const weak = identityMachine.next(pending, 'provider_result_received', { confidence: 0.89 });
        expect(weak.ok).toBe(false);
        const strong = identityMachine.next(pending, 'provider_result_received', { confidence: 0.9 });
        expect(strong.value).toBe('verified');
    });
    it('never lets a review clear without a named human reviewer', () => {
        expect(identityMachine.next('review_required', 'review_cleared', {}).ok).toBe(false);
        expect(identityMachine.next('review_required', 'review_cleared', reviewer).value).toBe('verified');
    });
    it('drops a user out of discovery on expiry but keeps them known', () => {
        const expired = identityMachine.next('verified', 'expire').value;
        expect(expired).toBe('expired');
        expect(isDiscoverableIdentity({ state: 'expired', latestVerificationId: null, generation: 1 })).toBe(false);
    });
    it('re-verification re-enters pending from any trusted state', () => {
        for (const from of ['verified', 'expired', 'review_required']) {
            expect(identityMachine.next(from, 'reverify_requested', { reVerification: true }).value).toBe('pending');
        }
    });
    it('has no way to reach verified from review_required without a review', () => {
        expect(identityMachine.allowedEvents('review_required')).not.toContain('provider_result_received');
    });
    it('makes verified reachable from the initial state', () => {
        expect(identityMachine.legalEvents('unverified')).toContain('submit_verification');
    });
});
describe('account machine', () => {
    const caseAndModerator = { caseId: 'case-1', moderatorId: 'mod-1' };
    it('requires a case for every enforcement action', () => {
        for (const event of ['restrict', 'suspend', 'ban']) {
            expect(accountMachine.next('active', event, {}).ok).toBe(false);
        }
    });
    it('requires a restriction to name a removed capability', () => {
        const nameless = accountMachine.next('active', 'restrict', { caseId: 'case-1' });
        expect(nameless.ok).toBe(false);
        const named = accountMachine.next('active', 'restrict', {
            caseId: 'case-1',
            removedCapabilities: ['send_message'],
        });
        expect(named.value).toBe('limited');
    });
    it('escalates from limited to suspended', () => {
        expect(accountMachine.next('limited', 'suspend', caseAndModerator).value).toBe('suspended');
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
    const RISK_STATES = ['normal', 'elevated', 'high', 'critical'];
    it('never escalates on a weak signal', () => {
        expect(riskMachine.next('normal', 'signal_observed', { score: 0.49 }).ok).toBe(false);
    });
    it('requires a very strong signal or corroboration to reach critical', () => {
        const fromHigh = riskMachine.next('high', 'signal_observed', { score: 0.8 });
        expect(fromHigh.ok).toBe(false);
        const corroborated = riskMachine.next('high', 'signal_observed', {
            score: 0.8,
            corroboratingDetectors: 2,
        });
        expect(corroborated.value).toBe('critical');
    });
    it('decays by at most one step and only after a long enough quiet period', () => {
        expect(riskMachine.next('high', 'decay', { daysSinceLastSignal: 3 }).ok).toBe(false);
        expect(riskMachine.next('high', 'decay', { daysSinceLastSignal: 14 }).value).toBe('elevated');
        expect(riskMachine.next('critical', 'decay', { daysSinceLastSignal: 30 }).value).toBe('high');
    });
    it('lets a human lower risk but never lets a detector clear it', () => {
        expect(riskMachine.next('critical', 'manual_reassess', {}).ok).toBe(false);
        expect(riskMachine.next('critical', 'manual_reassess', { assessorId: 'mod-1' }).value).toBe('normal');
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
    const event = (sensitivity) => ({
        eventId: castId('e-1'),
        type: 'test.event',
        version: 1,
        occurredAt: new Date('2026-01-01T00:00:00Z'),
        actorId: 'system',
        correlationId: castId('c-1'),
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
        const seen = [];
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
        expect(castId('u-1')).toBe(castId('u-1'));
        expect(castId('u-1')).not.toBe(castId('m-1'));
    });
});
//# sourceMappingURL=states.test.js.map