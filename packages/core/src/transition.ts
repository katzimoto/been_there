import { type DomainError, type Result, domainError, ok } from './result.js';

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

export type TransitionTable<S extends string, E extends string, C = undefined> = readonly Transition<
  S,
  E,
  C
>[];

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

export function defineStateMachine<S extends string, E extends string, C = undefined>(
  spec: TransitionTableSpec<S, E, C>,
): StateMachine<S, E, C> {
  const legal = (state: S, event: E, context: C | undefined): Transition<S, E, C> | undefined =>
    spec.transitions.find(
      (t) => t.event === event && (t.from === undefined || t.from.includes(state)),
    );

  const passes = (t: Transition<S, E, C>, context: C | undefined): boolean =>
    t.guard === undefined || t.guard(context as C);

  return {
    domain: spec.domain,
    initial: spec.initial,
    states: [spec.initial, ...spec.transitions.map((t) => t.to)].filter(
      (state, index, all) => all.indexOf(state) === index,
    ),
    rejectionReasons: {
      invalid_transition: `${spec.domain}: event is not legal from the current state`,
      guard_failed: `${spec.domain}: a precondition for this transition is not met`,
    },
    can(state: S, event: E, context?: C): boolean {
      const t = legal(state, event, context);
      return t !== undefined && passes(t, context);
    },
    next(state: S, event: E, context?: C): Result<S, DomainError> {
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
    legalEvents(state: S): E[] {
      return spec.transitions
        .filter((t) => t.from === undefined || t.from.includes(state))
        .map((t) => t.event);
    },
    allowedEvents(state: S, context?: C): E[] {
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
export function assertMachineIsTotal<S extends string, E extends string, C>(
  machine: StateMachine<S, E, C>,
  deadStates: readonly S[] = [],
): void {
  for (const state of deadStates) {
    if (machine.legalEvents(state).length > 0) {
      throw new Error(
        `${machine.domain}: state '${state}' was declared terminal but has outgoing transitions`,
      );
    }
  }
  if (machine.legalEvents(machine.initial).length === 0) {
    throw new Error(`${machine.domain}: initial state '${machine.initial}' has no outgoing transitions`);
  }
}

