# Documentation map

Read in this order. Each document is self-contained but assumes the one above it.

## Architecture

1. [System domains & boundaries](./architecture/00-overview.md) — **start here.**
   Domain map, the safety spine, shared state model, boundary rules, and the
   data-sensitivity table every other document inherits.

### Domain designs

| Document | Issue | Package |
|----------|-------|---------|
| [Identity & Verification](./architecture/identity-and-verification.md) | [#3](https://github.com/katzimoto/been_there/issues/3) | `packages/identity` |
| [Dating Core](./architecture/dating-core.md) | [#4](https://github.com/katzimoto/been_there/issues/4) | `packages/dating` — §12 also covers the dating goal and completed-date counter, [#48](https://github.com/katzimoto/been_there/issues/48) and [#49](https://github.com/katzimoto/been_there/issues/49), specified in [Profile & Personalization §9](./features/profile-and-personalization.md) |
| [Communication](./architecture/communication.md) | [#5](https://github.com/katzimoto/been_there/issues/5) | `packages/communication` |
| [Trust & Safety Engine](./architecture/trust-safety.md) | [#6](https://github.com/katzimoto/been_there/issues/6) | `packages/trust-safety` |
| [Moderation & Enforcement](./architecture/moderation-enforcement.md) | [#7](https://github.com/katzimoto/been_there/issues/7) | `packages/moderation` |
| [Platform & Privacy](./architecture/platform.md) | [#8](https://github.com/katzimoto/been_there/issues/8) | `packages/platform` |

### Architecture decision records

| ADR | Decision |
|-----|----------|
| [0001](./architecture/adr/0001-modular-monolith.md) | Modular monolith over microservices for v0.1 |
| [0002](./architecture/adr/0002-state-machines-as-data.md) | Lifecycles as transition tables in code |
| [0003](./architecture/adr/0003-events-not-calls.md) | Domains communicate by events, not cross-domain calls |
| [0004](./architecture/adr/0004-automation-never-enforces.md) | Automation never enforces |
| [0005](./architecture/adr/0005-sensitive-data-classification.md) | Per-field data sensitivity classification |

## Features

One specification per MVP feature issue, in `features/`:

| Document | Issue |
|----------|-------|
| [Account & Onboarding](./features/account-and-onboarding.md) | [#9](https://github.com/katzimoto/been_there/issues/9) |
| [Profile & Personalization](./features/profile-and-personalization.md) | [#10](https://github.com/katzimoto/been_there/issues/10) · also [#48](https://github.com/katzimoto/been_there/issues/48) dating goal, [#49](https://github.com/katzimoto/been_there/issues/49) completed-date counter (§9) |
| [Preferences & Discovery](./features/preferences-and-discovery.md) | [#11](https://github.com/katzimoto/been_there/issues/11) |
| [Likes & Matching](./features/likes-and-matching.md) | [#12](https://github.com/katzimoto/been_there/issues/12) |
| [Messaging Experience](./features/messaging-experience.md) | [#13](https://github.com/katzimoto/been_there/issues/13) |
| [User Safety Controls](./features/user-safety-controls.md) | [#14](https://github.com/katzimoto/been_there/issues/14) |
| [Social Events](./features/social-events.md) | [#50](https://github.com/katzimoto/been_there/issues/50) · [#51](https://github.com/katzimoto/been_there/issues/51) · [#52](https://github.com/katzimoto/been_there/issues/52) · [#53](https://github.com/katzimoto/been_there/issues/53) — deferred by decision, specified ahead of it |
| [Avatar Introductions](./features/avatar-introductions.md) | [#54](https://github.com/katzimoto/been_there/issues/54) · [#55](https://github.com/katzimoto/been_there/issues/55) · [#56](https://github.com/katzimoto/been_there/issues/56) · [#57](https://github.com/katzimoto/been_there/issues/57) · [#58](https://github.com/katzimoto/been_there/issues/58) · [#59](https://github.com/katzimoto/been_there/issues/59) · awaiting [the decision record](./decisions/avatar-introductions.md) for [#62](https://github.com/katzimoto/been_there/issues/62) |
| [Account Restrictions & Re-verification](./features/account-restrictions-and-reverification.md) | [#15](https://github.com/katzimoto/been_there/issues/15) |
| [Notifications](./features/notifications.md) | [#16](https://github.com/katzimoto/been_there/issues/16) |
| [Privacy & User Settings](./features/privacy-and-user-settings.md) | [#17](https://github.com/katzimoto/been_there/issues/17) |
| [Product Quality & Measurement](./features/product-quality-and-measurement.md) | [#18](https://github.com/katzimoto/been_there/issues/18) |
| [Social Sign-In](./features/social-sign-in.md) | Google, Apple, Meta alongside email and password — domain, schema and verification built; no route, no button, pending OAuth client credentials and a paid Apple Developer team |

### Review

| Document | Covers |
|----------|--------|
| [Event chat safety model](./architecture/event-chat-safety.md) —
  event messaging without a prior match: the new risks, the rules, and the two
  open questions decided before implementation
| [Detector escalation policy](./architecture/detector-escalation-policy.md) —
  which detectors may escalate a subject alone, and which require corroboration
| [Baseline review findings](./architecture/review-findings.md) | Independent review of the eight commitments, the domain boundaries, and doc/code agreement, with a runnable reproduction per finding |
| [Fix verification](./architecture/fix-verification.md) | Adversarial pass over the fixes: which claimed fixes hold, which are cosmetic, and what the fix pass introduced |

## Research

External, evidence-backed research with sources and dates. Conclusions are marked
as adopted, rejected, or open.

- [Agent workflow research](./research/agent-workflow-research.md) — context
  engineering, verification loops, tool selection, multi-agent orchestration
- [Agent memory and learning across sessions](./research/agent-memory-and-learning.md)
  — what persists, and which failures a written note cannot fix
- [Multi-agent precision](./research/multi-agent-precision.md) — partitioning,
  briefing, and detecting a subagent failure
- [Trust & safety and verification reference research](./research/trust-safety-reference-research.md)

### Session reviews

Each records what was verified, what was assumed, what broke, and what became a
lasting check rather than a note.

- [2026-09-25 — architecture baseline](./research/session-reviews/2026-09-25-architecture-baseline.md)
- [2026-09-25 — review findings](./research/session-reviews/2026-09-25-review-findings.md)

## Development

- [Running the iOS app in a simulator](./ios-simulator-setup.md) — the two
  `sudo` commands needed, and why the client has no views yet

- [Local environment](./development/local-environment.md) — bring up the
  dependencies, seed a dataset, and observe the safety model from a REPL
- [`AGENTS.md`](../AGENTS.md) — the working agreement, and [`skills/`](../skills/)
  for the procedures it points to

## Where the build stands

- [Status](./status.md) — **start here if you are new to the repository.** What
  this is, a per-capability built/partial/stubbed table with the artefact that
  proves each row, where each of the eight commitments is enforced and whether a
  regression would be caught, what is genuinely missing, the commands to run it,
  and the traps that have cost real time here
- [Delivery state](./delivery-state.md) — the dated narrative of the same
  territory. Several of its claims predate the current code; `status.md` §4.6
  lists the ones the code does not support, quoted.

## Document conventions

- A document starts with the issue it satisfies and links to the documents it
  depends on.
- Boundaries are stated as tables: what this domain owns, what it never owns.
- Cross-domain references use the vocabulary in the overview's state model, not
  ad-hoc synonyms.
- Anything undecided goes in an **Open questions** section. It does not get
  guessed in the body.
