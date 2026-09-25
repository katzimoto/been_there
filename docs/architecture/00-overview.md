# Been There — System Domains & Boundaries

> Issue [#2](https://github.com/katzimoto/been_there/issues/2). Parent: [#1](https://github.com/katzimoto/been_there/issues/1).
> This document is the contract every other design in `docs/` builds on. If a
> feature document contradicts it, this document wins and the feature document
> is wrong.

## 1. What we are building

A dating product whose differentiator is that **every user is verified and the
platform is safe by construction**. The core promise in issue #1 is:

```
verified identity → profile → discovery → like → match → chat
  → block/report → automated risk detection → moderation → enforcement
```

That chain is the product. Everything below is organised so that each arrow is a
bounded, auditable contract rather than an assumption.

## 2. Design commitments

These are not aspirations. Each one is enforced by a type, a transition table, or
a test somewhere in `packages/`.

1. **Unverified means undiscoverable.** Discoverability is a pure function of the
   identity state machine. There is no code path that grants discovery without
   `verified`. See `packages/core/src/states/identity.ts`.
2. **Automation never enforces.** A detector may raise risk. Only a human
   moderator, acting on a recorded case, may restrict, suspend, or ban. Every
   enforcement transition requires a `caseId`; suspend/ban also require a
   `moderatorId`. See `packages/core/src/states/account.ts`.
3. **Risk decays.** Risk is evidence about behaviour over time, not a permanent
   verdict. Every non-normal risk state has a decay path, and decay moves at most
   one step. See `packages/core/src/states/risk.ts`.
4. **Unmatch does not destroy the right to report.** Evidence for a moderation
   case is retained independently of the dating relationship that produced it.
5. **Exact location is never exposed.** Location is reduced to a coarse
   distance bucket before it leaves the platform. The raw coordinate is `sensitive`.
6. **Domains never call each other's internals.** They publish events and read
   each other's public read-models. Direct calls across a boundary are a review
   rejection.
7. **Sensitive data is classified per field, not per table.** See
   `DataSensitivity` in `packages/core/src/domain-event.ts`.
8. **Every state is a reviewable table.** Lifecycles are declared as transition
   tables in code, so "what can happen here?" is answerable in one readable block
   and is unit-tested.

## 3. Domain map

Seven domains. Product domains (2–5) own user value; safety domains (6–7) own
user protection; platform (8) owns shared capability and is nobody's product
feature.

| # | Domain | Owns | Never owns | Design doc |
|---|--------|------|-----------|-----------|
| 1 | **Identity & Verification** | Verification lifecycle, identity confidence, identity anomalies, biometric/liveness evidence | Risk scoring, account enforcement, profile content | [identity-and-verification.md](./identity-and-verification.md) |
| 2 | **Dating Core** | Profiles, preferences, likes, passes, matches, discovery eligibility | Messaging transport, safety scoring, enforcement | [dating-core.md](./dating-core.md) |
| 3 | **Communication** | Conversations, messages, messaging permissions | Moderation logic, discovery, identity evidence | [communication.md](./communication.md) |
| 4 | **Trust & Safety Engine** | Signal intake, risk states, corroboration, risk decay | Enforcement, identity evidence, user-facing copy | [trust-safety.md](./trust-safety.md) |
| 5 | **Moderation & Enforcement** | Reports, cases, evidence, moderator decisions, account state, audit log | Detection heuristics, product eligibility rules | [moderation-enforcement.md](./moderation-enforcement.md) |
| 6 | **Platform** | Authn/authz, media, notifications, coarse location, audit, analytics, external integrations | Any product rule | [platform.md](./platform.md) |
| 7 | **Cross-cutting** | Shared kernel: ids, result type, state-machine helper, event envelope, sensitivity | — | `packages/core` |

## 4. The safety spine

The most important relationship in the system. Read it as *"information flows
down, authority flows up"*.

```
Identity ──(identity_status.changed: public)──▶ Dating Core ──eligibility──▶ Discovery
    │                                                                │
    │ (verification.anomaly: sensitive)                                │ (interaction signals)
    ▼                                                                ▼
    └──────────────────────▶ Trust & Safety ◀──(behavioural signals)── Communication
                                    │                                      │
                       (risk.changed: internal)                        (message.reported: restricted)
                                    ▼                                      ▼
                              Moderation & Enforcement ──(account_state.changed: public)──▶ all product domains
                                    │
                                    ▼
                             Audit log  /  Analytics
```

Rules encoded by this diagram:

- **Information flows toward safety; authority flows back as one state change.**
  Safety sees *signals*. It never sees identity evidence, never sees a
  human-readable reason, and never acts on its own.
- **The only thing enforcement publishes outward is
  `account_state.changed`.** Product domains react to a capability set, not to
  "there was a report about you". A dating client must not be able to infer that
  a user was reported, reviewed, or restricted — the information is not in the
  product's read-model.
- **Risk never blocks a legitimate flow by itself.** Risk at `high` or `critical`
  feeds a moderation queue and may trigger re-verification. It does not hide a
  user from discovery. Only an account state does that.

## 5. Shared state model

Three independent state machines. Keeping them independent is the point: a
verification failure, a behaviour risk, and an enforcement decision are different
facts with different remedies, and collapsing them into one "status" field is how
platforms end up banning people for being bad at selfies.

| Machine | States | Owner | Meaning |
|---------|--------|-------|---------|
| Identity | `unverified` `pending` `verified` `review_required` `verification_failed` `expired` | Identity | Is this a sufficiently real person? |
| Account | `active` `limited` `suspended` `banned` | Moderation | What may this account do? |
| Risk | `normal` `elevated` `high` `critical` | Trust & Safety | How suspicious is recent behaviour? |

Interactions:

- `verified` is the **only** discoverable identity state.
- `limited` is **capability-based**, not a blanket mute. Every restriction names
  the capabilities it removes, so "restricted" is always explainable to the user
  and to a moderator.
- `risk` may *propose* re-verification (identity) or a case (moderation). Neither
  happens without the owning domain's rules being satisfied.

## 6. Boundary rules

### 6.1 Allowed communication

```
Domain A ──publishes DomainEvent──▶ Bus ──delivers by clearance──▶ Domain B
Domain B ──reads──▶ A's public read-model (a projection, versioned)
Domain B ──calls──▶ A's command interface (e.g. Identity.markExpired())
```

An event carries a `sensitivity`. A consumer declares `clearance`. An event above
the consumer's clearance is never delivered, not filtered after delivery. This is
what lets Trust & Safety subscribe broadly while Identity keeps its evidence
private.

### 6.2 Forbidden

| Forbidden | Why | Instead |
|---|---|---|
| Dating Core reading `IdentityRecord.latestVerificationId` | Leaks identity internals into product logic | Read `identity_status.changed` / `isDiscoverableIdentity` |
| Any domain writing `AccountState` | Enforcement authority must be single-sourced | Moderation publishes `account_state.changed` |
| Communication deciding a message is abusive | Moderation logic in the transport | Publish a signal to Trust & Safety |
| Trust & Safety calling Moderation directly to "flag" a user | Bypasses the case record | Raise a signal; Moderation decides whether to open a case |
| Any domain logging exact coordinates or verification evidence | Data-sensitivity violation | Field-level redaction at the logger |
| Cross-domain import of another domain's `src/` internals | Coupling that outlives the design | Public entry point (`index.ts`) only |

### 6.3 Data sensitivity

| Class | Examples | Access |
|---|---|---|
| `public` | display name, age band, coarse distance, bio, photos | Any authenticated eligible user |
| `user` | full preference values, notification settings, message history | Owner only |
| `internal` | risk state, detector names, eligibility reasons, moderation notes | Platform services; never rendered to a user |
| `sensitive` | selfie/liveness artefacts, exact location, provider responses | Identity + Trust & Safety only; every read logged |
| `restricted` | report evidence, moderator decisions, case notes, audit records | Moderation role only; every read logged |

## 7. Repository layout

```
packages/core          shared kernel — no domain imports this domain
packages/<domain>      one package per domain, owning its state machines,
                       types, and pure domain logic
docs/architecture       domain boundaries and ADRs
docs/features          one spec per MVP feature issue (#9–#18)
docs/research          evidence-backed external research
```

Dependencies point inward: `feature → domain → core`. No domain depends on
another domain's package. Cross-domain data arrives as events or read-models.

## 8. Decision log

Architecture decisions live in [`./adr/`](./adr/). Each records context, the
decision, and its consequences, so a later reader can tell the difference between
"we chose this" and "this is how it fell out".

| ADR | Decision |
|-----|----------|
| [0001](./adr/0001-modular-monolith.md) | Modular monolith over microservices for v0.1 |
| [0002](./adr/0002-state-machines-as-data.md) | Lifecycles as transition tables in code |
| [0003](./adr/0003-events-not-calls.md) | Domains communicate by events, not cross-domain calls |
| [0004](./adr/0004-automation-never-enforces.md) | Detectors raise risk; only humans enforce |
| [0005](./adr/0005-sensitive-data-classification.md) | Per-field sensitivity classification |

## 9. Open questions

Recorded rather than answered, because guessing is worse than writing down the
gap.

- Verification provider selection and whether likeness scoring is a build or a
  buy. Depends on vendor pricing/latency research.
- Whether `limited` states compose (a suspended-then-restricted account) or are
  strictly a ladder. Current model is a strict ladder; composition is a v0.2
  question.
- Evidence retention period. Needs a regulatory answer per market, not a
  technical one.
