import { type DomainError, type Result } from './result.js';
/**
 * A state machine expressed as a transition table. Every domain in this
 * repository models its lifecycle with one of these, so that "can this happen?"
 * is answered by data, is unit-testable in isolation, and is reviewable as a
 * single readable block.
 *
 * Invariants enforced here:
 *  - an event not listed for the current state is rejected, never ignored;
 *  - `from` may be omitted for a transition that is legal from any state;
 *  - the result of a transition is a pure function of (table, from, event).
 */
export interface Transition<S extends string, E extends string, C = undefined> {
    readonly event: E;
    /** Legal entry states. Omitted means "legal from any state". */
    readonly from?: readonly S[];
    readonly to: S;
    /**
     * Domain-specific gate, e.g. `reverification_triggered`. Evaluated only after
     * the state check passes, so guards never see an illegal event.
     */
    readonly guard?: (context: C) => boolean;
    /** Why the transition exists — audit/review aid. */
    readonly note?: string;
}
export type TransitionTable<S extends string, E extends string, C = undefined> = readonly Transition<S, E, C>[];
export interface TransitionTableSpec<S extends string, E extends string, C = undefined> {
    readonly domain: string;
    readonly initial: S;
    readonly transitions: TransitionTable<S, E, C>;
}
export interface StateMachine<S extends string, E extends string, C = undefined> {
    readonly domain: string;
    readonly initial: S;
    readonly states: readonly S[];
    /** Rejection reasons, exposed so clients can render an explanation. */
    readonly rejectionReasons: Readonly<Record<string, string>>;
    can(state: S, event: E, context?: C): boolean;
    next(state: S, event: E, context?: C): Result<S, DomainError>;
    /** Events legal from `state` for a given context (guards applied). */
    allowedEvents(state: S, context?: C): E[];
    /**
     * Events structurally legal from `state`, ignoring guards. Guards depend on
     * runtime context that a static check does not have, so structural legality
     * is what "is this state a dead end" must be answered with.
     */
    legalEvents(state: S): E[];
}
export declare function defineStateMachine<S extends string, E extends string, C = undefined>(spec: TransitionTableSpec<S, E, C>): StateMachine<S, E, C>;
/**
 * Fails loudly when a declared state is a structural dead end, or when a state
 * marked terminal has a way out. Run by each domain's test suite. Guards are
 * deliberately ignored: a guard is a runtime gate, not a structural edge, and
 * treating it as one made every guard-gated machine look terminal.
 */
export declare function assertMachineIsTotal<S extends string, E extends string, C>(machine: StateMachine<S, E, C>, deadStates?: readonly S[]): void;
//# sourceMappingURL=transition.d.ts.map