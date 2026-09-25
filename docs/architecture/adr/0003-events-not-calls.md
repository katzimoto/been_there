# ADR 0003 — Domains communicate by events, not cross-domain calls

**Status:** accepted · **Issue:** [#2](https://github.com/katzimoto/been_there/issues/2)

## Context

Discovery needs to know whether a user is verified. Messaging needs to know
whether a user may send. Moderation needs to know what behaviour looked like.
A direct call from each of those into the owning domain couples them to its
internals and makes the owner's refactor everyone's release.

Direct calls are still needed for *commands* — "re-verify this user" is a
request with a caller that needs an answer. What must not happen is one domain
reaching into another's storage or decision logic.

## Decision

Two permitted patterns:

1. **Command** — call the owning domain's public command interface. Caller gets
   a `Result`. Use for anything requiring an immediate answer.
2. **Event** — publish a `DomainEvent`; interested domains consume it and update
   their own read-models asynchronously. Use for reactions.

`packages/core/src/domain-event.ts` defines the envelope. Every event declares a
`version` and a `sensitivity`.

## Consequences

- Consumers are reactive, so a consumer can be rebuilt or deleted without the
  producer changing.
- Reads that must be immediate (am I discoverable?) go through a *projection* the
  consumer maintains, not a live call into the owner.
- We must handle events at-least-once: consumers are idempotent, and event ids
  are the dedup key.
- Asynchronous propagation means a change is briefly inconsistent across
  domains. Acceptable and bounded, because the safety-critical path
  (enforcement) publishes `account_state.changed` and consumers are the ones
  caching it — a stale cache fails *closed* by re-reading before a write.

## Revisit when

Read-your-writes consistency is required across a domain boundary for a
user-visible action, and the projection lag becomes user-visible.
