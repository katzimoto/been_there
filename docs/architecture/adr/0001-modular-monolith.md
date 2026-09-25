# ADR 0001 — Modular monolith for v0.1

**Status:** accepted · **Issue:** [#2](https://github.com/katzimoto/been_there/issues/2)

## Context

The end-to-end flow in issue #1 spans identity, dating, messaging, safety and
moderation, with heavy read/write coupling between them: discovery depends on
identity state, messaging depends on account capabilities, moderation depends on
risk, risk depends on interaction signals.

Deploying those as separate services would buy independent scaling on exactly the
paths that do not need it (identity verification, moderation review), and pay for
it with distributed transactions on the paths that do: a like that becomes a
match and emits two notifications must not half-succeed.

## Decision

A single deployable unit, with enforced module boundaries inside it. One
transactional store. Domain packages may not import each other's internals.

## Consequences

- Cross-domain consistency is a local transaction, not a saga. A like/match
  write and its event outbox record commit together.
- We can split a domain out later *without* having paid for it in advance,
  because the boundary is already expressed in code and enforced by a review
  rule plus the package graph.
- Blast radius is the whole service. Mitigated by keeping writes domain-scoped
  and the schema partitioned per domain.
- We do not need service-to-service auth, distributed tracing propagation, or
  inter-service retries to ship v0.1.

## Revisit when

A single domain's throughput or deploy cadence becomes an actual bottleneck —
measured, not anticipated.
