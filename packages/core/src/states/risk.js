import { defineStateMachine } from '../transition.js';
const ORDER = { normal: 0, elevated: 1, high: 2, critical: 3 };
export const riskMachine = defineStateMachine({
    domain: 'trust-safety',
    initial: 'normal',
    transitions: [
        { event: 'signal_observed', from: ['normal'], to: 'elevated', guard: (ctx) => (ctx?.score ?? 0) >= 0.5, note: 'A single sub-threshold signal never escalates.' },
        { event: 'signal_observed', from: ['elevated'], to: 'high', guard: (ctx) => (ctx?.score ?? 0) >= 0.7, note: 'Escalation to high requires a strong signal or corroboration.' },
        { event: 'signal_observed', from: ['high'], to: 'critical', guard: (ctx) => (ctx?.score ?? 0) >= 0.9 || (ctx?.corroboratingDetectors ?? 0) >= 2, note: 'Critical requires either a near-certain signal or two independent detectors.' },
        { event: 'threshold_crossed', from: ['normal', 'elevated', 'high'], to: 'high', guard: (ctx) => (ctx?.score ?? 0) >= 0.7 },
        { event: 'threshold_crossed', from: ['high'], to: 'critical' },
        { event: 'decay', from: ['critical'], to: 'high', guard: (ctx) => (ctx?.daysSinceLastSignal ?? 0) >= 30 },
        { event: 'decay', from: ['high'], to: 'elevated', guard: (ctx) => (ctx?.daysSinceLastSignal ?? 0) >= 14 },
        { event: 'decay', from: ['elevated'], to: 'normal', guard: (ctx) => (ctx?.daysSinceLastSignal ?? 0) >= 7 },
        { event: 'manual_reassess', to: 'normal', guard: (ctx) => ctx?.assessorId !== undefined, note: 'A human may always lower risk; only moderation may act on it.' },
        { event: 'reset_after_review', to: 'normal', guard: (ctx) => ctx?.assessorId !== undefined },
    ],
});
/** Decays by exactly one step at most, never skipping a level. */
export function isEscalation(from, to) {
    return ORDER[to] > ORDER[from];
}
//# sourceMappingURL=risk.js.map