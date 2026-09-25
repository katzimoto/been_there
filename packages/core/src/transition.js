import { domainError, ok } from './result.js';
export function defineStateMachine(spec) {
    const legal = (state, event, context) => spec.transitions.find((t) => t.event === event && (t.from === undefined || t.from.includes(state)));
    const passes = (t, context) => t.guard === undefined || t.guard(context);
    return {
        domain: spec.domain,
        initial: spec.initial,
        states: [spec.initial, ...spec.transitions.map((t) => t.to)].filter((state, index, all) => all.indexOf(state) === index),
        rejectionReasons: {
            invalid_transition: `${spec.domain}: event is not legal from the current state`,
            guard_failed: `${spec.domain}: a precondition for this transition is not met`,
        },
        can(state, event, context) {
            const t = legal(state, event, context);
            return t !== undefined && passes(t, context);
        },
        next(state, event, context) {
            const t = legal(state, event, context);
            if (t === undefined) {
                return domainError('invalid_transition', spec.domain, `cannot apply '${event}' from '${state}'`, {
                    state,
                    event,
                });
            }
            if (!passes(t, context)) {
                return domainError('validation_failed', spec.domain, `'${event}' is blocked by a precondition`, {
                    state,
                    event,
                });
            }
            return ok(t.to);
        },
        legalEvents(state) {
            return spec.transitions
                .filter((t) => t.from === undefined || t.from.includes(state))
                .map((t) => t.event);
        },
        allowedEvents(state, context) {
            return spec.transitions
                .filter((t) => (t.from === undefined || t.from.includes(state)) && passes(t, context))
                .map((t) => t.event);
        },
    };
}
/**
 * Fails loudly when a declared state is a structural dead end, or when a state
 * marked terminal has a way out. Run by each domain's test suite. Guards are
 * deliberately ignored: a guard is a runtime gate, not a structural edge, and
 * treating it as one made every guard-gated machine look terminal.
 */
export function assertMachineIsTotal(machine, deadStates = []) {
    for (const state of deadStates) {
        if (machine.legalEvents(state).length > 0) {
            throw new Error(`${machine.domain}: state '${state}' was declared terminal but has outgoing transitions`);
        }
    }
    if (machine.legalEvents(machine.initial).length === 0) {
        throw new Error(`${machine.domain}: initial state '${machine.initial}' has no outgoing transitions`);
    }
}
//# sourceMappingURL=transition.js.map