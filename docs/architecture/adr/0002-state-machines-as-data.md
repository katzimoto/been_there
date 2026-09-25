# ADR 0002 — Lifecycles are transition tables in code

**Status:** accepted · **Issue:** [#2](https://github.com/katzimoto/been_there/issues/2)

## Context

Identity, account standing, risk, and messaging all have lifecycles. Expressing
them as `if (status === 'x') status = 'y'` scattered through services produces
two defects we care about a lot:

1. **Unreachable states.** A user can end up `pending` forever because the
   timeout that clears them lives in a different file from the code that set it.
2. **Illegitimate transitions.** A suspended account gets an `active` value from
   a race, and nothing notices.

Both are invisible in review and obvious in an incident.

## Decision

Each lifecycle is a `TransitionTable` passed to `defineStateMachine` in
`packages/core/src/transition.ts`. Transitions are pure data with optional guards.
Illegal transitions return a `Result` error rather than throwing or silently
succeeding.

`legalEvents(state)` (guards ignored) and `allowedEvents(state, context)` (guards
applied) are both exposed, because they answer different questions: "is this a
dead end?" is structural, "can this happen right now?" is contextual.

## Consequences

- The complete set of legal behaviours for a domain is one readable block.
- Exhaustive rules are testable without a database, a clock, or a network.
- Guards are evaluated *after* the state check, so a guard never sees an event
  that is illegal from the current state.
- Totality is checked by `assertMachineIsTotal`, which ignores guards — an
  early version evaluated them and reported every guarded machine as terminal.

## Revisit when

A lifecycle needs history/audit of its transitions beyond what the moderation
audit log already stores.
