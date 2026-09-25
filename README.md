# Been There

A dating product where every user is verified and safety is structural rather
than reactive.

**Status:** v0.1 design. The domain contracts, state machines and design
documents for the end-to-end flow in
[#1 — MVP v0.1](https://github.com/katzimoto/been_there/issues/1) are in place;
the service and clients are not built yet.

## What "structural safety" means here

The product claims two things that are easy to *say* and hard to *enforce*:

- **Everyone is real.** Discoverability is a pure function of the identity state
  machine. `verified` is the only state that reaches the discovery pool.
- **The platform acts before users have to.** Behavioural risk is computed
  continuously and drives reversible friction and human review. It can never
  suspend or ban anyone.

Both are enforced in code — transition tables with guards, and tests that fail if
the guard is removed. The full argument is in
[docs/architecture/00-overview.md](docs/architecture/00-overview.md).

## Layout

```
packages/core     shared kernel: ids, Result, state-machine helper, event envelope,
                  sensitivity classes, and the three shared state machines
docs/architecture domain boundaries + ADRs
docs/features     one specification per MVP feature issue
docs/research     evidence-backed external research
```

## Conventions

- **Dependencies point inward**: feature → domain → `core`. No domain package
  imports another domain package.
- **Cross-domain data** arrives as a `DomainEvent` or a versioned read-model
  projection. Direct cross-domain storage access is a review rejection.
- **Lifecycles are transition tables**, not scattered status assignment.
- **Expected failures are `Result` values**, not exceptions.
- **Sensitive fields are classified per field** (`public`/`user`/`internal`/
  `sensitive`/`restricted`); logs and analytics drop anything above their
  clearance.

## Working on this repository

```bash
npm install
npm run typecheck   # tsc --build across the package graph
npm test            # vitest
npm run check       # both
```

## Issue map

| Issue | Subject | Document |
|-------|---------|----------|
| [#2](https://github.com/katzimoto/been_there/issues/2) | Architecture: domains & boundaries | [00-overview.md](docs/architecture/00-overview.md) |
| [#3](https://github.com/katzimoto/been_there/issues/3) | Identity & Verification | [identity-and-verification.md](docs/architecture/identity-and-verification.md) |
| [#4](https://github.com/katzimoto/been_there/issues/4) | Dating Core | [dating-core.md](docs/architecture/dating-core.md) |
| [#5](https://github.com/katzimoto/been_there/issues/5) | Communication | [communication.md](docs/architecture/communication.md) |
| [#6](https://github.com/katzimoto/been_there/issues/6) | Trust & Safety Engine | [trust-safety.md](docs/architecture/trust-safety.md) |
| [#7](https://github.com/katzimoto/been_there/issues/7) | Moderation & Enforcement | [moderation-enforcement.md](docs/architecture/moderation-enforcement.md) |
| [#8](https://github.com/katzimoto/been_there/issues/8) | Platform, Privacy & Shared Capabilities | [platform.md](docs/architecture/platform.md) |
| [#9](https://github.com/katzimoto/been_there/issues/9) | Account & Onboarding | [features/](docs/features/) |
| [#10](https://github.com/katzimoto/been_there/issues/10) | Profile & Personalization | [features/](docs/features/) |
| [#11](https://github.com/katzimoto/been_there/issues/11) | Preferences & Discovery | [features/](docs/features/) |
| [#12](https://github.com/katzimoto/been_there/issues/12) | Likes & Matching | [features/](docs/features/) |
| [#13](https://github.com/katzimoto/been_there/issues/13) | Messaging Experience | [features/](docs/features/) |
| [#14](https://github.com/katzimoto/been_there/issues/14) | User Safety Controls | [features/](docs/features/) |
| [#15](https://github.com/katzimoto/been_there/issues/15) | Account Restrictions & Re-verification | [features/](docs/features/) |
| [#16](https://github.com/katzimoto/been_there/issues/16) | Notifications | [features/](docs/features/) |
| [#17](https://github.com/katzimoto/been_there/issues/17) | Privacy & User Settings | [features/](docs/features/) |
| [#18](https://github.com/katzimoto/been_there/issues/18) | Product Quality & Measurement | [features/](docs/features/) |
