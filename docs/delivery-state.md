# Where the v0.1 build stands

> Written 2026-09-25, against commit `d668ab3`. A map of what exists, what is
> proven, and what is decided but not built. Updated as the delivery proceeds.

## The MVP chain, end to end

Issue [#1](https://github.com/katzimoto/been_there/issues/1) defines the flow:

```
verified identity → profile → discovery → like → match → chat
  → block/report → risk detection → moderation → enforcement
```

Where each link stands:

| Link | State | Proven by |
|---|---|---|
| Persistence | **built** | 8 stores, 131 tests against real Postgres |
| HTTP service | **built** | real server, real HTTP, real database |
| Verified identity | **built** | identity machine; a provider result below the floor does not grant `verified` |
| Profile & preferences | in progress (#35) | — |
| Discovery | **built** | `evaluateEligibility`; an unverified viewer gets an empty page and is not told why |
| Like → match | **built** | reciprocal like creates exactly one match |
| Chat | **built** | through the communication gate; refusal is symmetric |
| Block & report | **built** | a report after an unmatch works — evidence is retained independently |
| Risk detection | **built** | no behavioural detector escalates alone; corroboration is required |
| Moderation | **built** | a decision with no named human, or by an automated actor, is refused |
| Enforcement | **built** | restrictions cannot strip `report` or `block` |

**The chain runs end to end through the service.** The gaps are in the *product
around* it — onboarding, profiles, the moderator's view — not in the safety core.

## What is decided but not built

**#48–#53, social events**, deferred to a later version by decision. The safety
model they need is already written, because they are the first change that
removes the match gate — see
[`event-chat-safety.md`](./architecture/event-chat-safety.md).

## The two things nobody should assume are true

**Nothing is gated until the age gate is reachable over HTTP.** `evaluateAgeGate`
exists and is unit-testable; the account route still accepted an empty body when
this was written, so an account could be created with no date of birth at all.
The foundation was built first and the surface second, and only the first is
done. Check `POST /v1/accounts` before assuming the 18+ requirement is enforced.

**There is no client.** The moderator workspace is a server half with no UI, and
the file says so at the top. No issue in the current delivery can be *accepted* in
the sense of "a person did the thing on a phone" until an iOS build exists, and
that needs Xcode, which is not installed here.

## What CI proves, and what it does not

Nine steps, parity-checked against `make check` so a green local run and a green
CI run mean the same thing.

Two limits worth naming, both learned the hard way:

- **The parity check compares step names and commands, not their order within
  CI.** A migration step placed after `Test` passed every local check and failed
  on the runner. Local ordering was right and CI's was wrong, and nothing
  compared them.
- **A workflow that does not parse has no steps to compare.** A `services:`
  block accidentally placed above `jobs:` was rejected by GitHub in 0s, and
  `make check` stayed green throughout.

Neither is a reason to distrust CI. It is a reason to know precisely what it is
for, and to let it be the oracle for the things a local run cannot see.

## Decisions a human still owns

| Question | Where | Why it is not mine |
|---|---|---|
| Who is accountable when a detector's input is a report about an identifiable person, and what a user is told when such a signal moves their risk state | `trust-safety.md` §13 | Governance, not design |
| Whether event messaging may bypass the match gate at all | `event-chat-safety.md` | It changes who can reach whom |
| Whether existing event conversations stay writable after an event ends | `event-chat-safety.md` — **decided: read-only** | Was genuinely open |
| Evidence retention period per market | `review-findings.md` | Regulatory, not technical |
| Whether `limited` states compose or are a strict ladder | `00-overview.md` §9 | Product, currently a ladder by decision |

## Next in the delivery order

Per [#32](https://github.com/katzimoto/been_there/issues/32): resolve contract
gaps, establish the running application, **deliver onboarding and discovery**,
then matching and chat with safety controls, then proactive detection and
moderation, then quality and readiness.

The first two are done. Onboarding (#34) and profile (#35) are in progress.