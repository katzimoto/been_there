# Where the v0.1 build stands

> First written 2026-09-25. A map of what exists, what is proven, and what is
> decided but not built, updated as the delivery proceeds. Every count and every
> named module below has been re-checked against the code at `29564dd`; where an
> earlier version of this file claimed something that is no longer true, the
> correction says so rather than quietly replacing it.

## The MVP chain, end to end

Issue [#1](https://github.com/katzimoto/been_there/issues/1) defines the flow:

```
verified identity → profile → discovery → like → match → chat
  → block/report → risk detection → moderation → enforcement
```

Where each link stands:

| Link | State | Proven by |
|---|---|---|
| Persistence | **built** | 10 stores composed in `compose.ts`, 159 tests against real Postgres |
| HTTP service | **built** | real server, real HTTP, real database |
| Verified identity | **built** | identity machine; a provider result below the floor does not grant `verified` |
| Profile & preferences | **built** | four route modules — body, photos, preferences and the legacy surface — all funnelling writes through one `saveProfile` |
| Discovery | **built** | `evaluateEligibility`; an unverified viewer gets an empty page and is not told why |
| Like → match | **built** | reciprocal like creates exactly one match |
| Chat | **built** | through the communication gate; refusal is symmetric |
| Block & report | **built** | a report after an unmatch works — evidence is retained independently |
| Risk detection | **wired; the metric cannot move** | routes now emit observations and `createServiceSafety` feeds the risk store, and `replaySignals` rebuilds a ledger that survives a restart — but no detector reaches `high`/`critical` without depending on a report, so **`safety.detected_before_first_report` is structurally unmeasurable**, not merely unwired. See below |
| Moderation | **built** | a decision with no named human, or by an automated actor, is refused |
| Enforcement | **built** | restrictions cannot strip `report` or `block` |

**The chain runs end to end through the service.** The gaps are in the *product
around* it — onboarding, profiles, the moderator's view — not in the safety core.

### Why the safety metric is stuck, and why that may be correct

Every detector in `packages/trust-safety/src/detectors.ts` is
`corroboration_only`, and the escalation gate is `0.5` (`ESCALATION_GATE`,
`escalation.ts`). Computed through the policy layer rather than asserted —
`highestReachableFromNormal` grants every `corroboration_only` detector two
independent corroborating detectors and repeats at their cap — the highest any
detector reaches from `normal` is `elevated`, except
`interaction.unmatch_report`, which reaches `high` (`0.6 × 1.25 × 1.15 = 0.8625`
against the `0.7` high gate).

**The repository ships a value for `RISK_PAIRING_SECRET`, and setting it does
not make this metric move.** `Makefile:37` defaults it to
`been_there_local_pairing_only` and exports it, and `.env.example:63` ships the
same value, so `interaction.unmatch_report` is constructible in every `make`
workflow. It still cannot be the *first* thing to have raised a subject: the
metric's numerator is an account whose risk first reached `high` or `critical`
**before the first report naming it** (`safety-metric.ts`, §3.6), and this
detector only fires once such a report already exists. That is also why
`detectionReachability` reports `measurable: false` — it asks whether any
detector that does *not* depend on reports reaches a counted state, and none
does.

So the wiring can be perfect and the metric still read zero, forever. The
reason is the metric's own definition, not a missing secret.

**This may be the correct policy, not a defect.** "Two accounts behaving like
this is a pattern; one is an anecdote" is the reason every detector is
corroboration-only. A single detector is never trusted to move a person. That is
the same commitment as *automation never enforces*: the system is built so that
one noisy signal cannot act on its own.

What must not happen is a threshold lowered so the number moves. A safety metric
that reads non-zero because the bar was lowered is worse than one that is visibly
stuck, because it is indistinguishable from detection working.

Two related gaps are known and not fixed:

- **`risk_signals` can replay a ledger, and says how much of it it could not
  use.** Migration 007 added the author and actor columns, and `replaySignals`
  rebuilds a `SignalLedger` from the log through `createSignal` — so corroboration
  now survives a restart. A row the domain cannot accept is **skipped and
  counted** per reason, never backfilled: a null author is reported as
  `no_author` rather than given a reliability derived from its detector name, and
  `SafetyRecorder.replays()` exposes the tally to the caller. A subject scored on
  a partial history is therefore visible instead of silent. What is still
  process-local is the observation window behind `createSafetySeam`, not the
  ledger.
- **`report_against` is produced, and is discarded on purpose.** The detector
  `report.pattern.coordinated_target` emits one such signal per report, with the
  *reporter* as the actor and the reported account as the subject, fed by the
  `moderation.report_submitted` reduction. It is never scored: `assessSignal`
  returns `next: current, discarded: true` before any score is computed, so no
  number of reports can move the victim's risk state. The signals exist for
  `corroborate`, which counts their distinct actors; at
  `MASS_REPORT_CLUSTER_SIZE` distinct reporters the campaign itself becomes a
  cluster review candidate. The quarantine is therefore reachable from a real
  detector — and unreachable as a way to escalate the account reported.


## What is decided but not built

**Account deletion completes on the account's own next undo attempt, not on a
clock.** `DELETE /v1/accounts/me` is a real request with a 30-day window, and
the completion path — anonymise to a pseudonym, tombstone the subject's own
messages, retain moderation evidence — is implemented and tested. But **no
scheduler exists in this repository**, so an account whose owner never returns is
never completed. The spec's "after 30 days the job runs to completion" is
therefore not true of this build.

The partial index `account_deletions_due` is in place for a real sweeper, and the
sweeper was left unwritten deliberately rather than approximated. Two things
someone writing it must know: `delete_account` being on
`UNRESTRICTABLE_CAPABILITIES` is correct for *requesting* deletion and must not
be unrestrictable for a background process completing one irreversibly; and the
sweeper must not complete a deletion whose subject has an open case or appeal.

**#48–#53, social events**, deferred to a later version by decision. The safety
model they need is already written, because they are the first change that
removes the match gate — see
[`event-chat-safety.md`](./architecture/event-chat-safety.md).

## The two things nobody should assume are true

**The age gate is enforced, and an earlier version of this file said it was
not.** That claim — "nothing is gated until the age gate is reachable over
HTTP" — was true once and stopped being true when a route started calling the
gate. `POST /v1/accounts` evaluates `evaluateAgeGate` before any write: an
under-18 date of birth returns `422 not_eligible` with no row created, and an
empty body is refused rather than defaulted. `npm run demo:journey` step 1
asserts that 422, and the check fires in `accounts/sign-up.ts` before the
password is even hashed.

**There is a web client; there is no iOS app yet.** `web/` is a working browser
client against the real service — `node web/server.mjs`, then
<http://127.0.0.1:5173>. It covers sign-up, verification, discovery, matches,
block, report and a moderator desk, and it renders service refusals verbatim rather
than interpreting them.

**There is no iOS app, and there is a macOS one.** `client/BeenThereKit` is the
tested safety gate. The SwiftUI views now live in a shared target,
`client/BeenThereViews`, and `client/BeenThereMac` is a macOS app that consumes
them and compiles — macOS needs no simulator runtime, so it builds and runs on a
machine with zero runtimes installed. The views are written against a fixed
iPhone-width frame so the layout survives the move to a phone, which is the
point of the shared target: the iOS app will consume the same files. (An earlier
version of this file said no such app had been built.) So no issue can be
*accepted* in the sense of "a person did the thing on a phone" — but the UI
layer is no longer hypothetical.

## What the service now answers about itself

Issue [#43](https://github.com/katzimoto/been_there/issues/43) added the surface
that lets the running build be *observed*, and three of its claims are now tested
rather than asserted:

| Endpoint | Session | Answers |
|---|---|---|
| `GET /v1/health/live` | none | The process is up. Deliberately never consults the store: a restart cannot fix a database, and a fleet that restarts on one turns a degradation into an outage. |
| `GET /v1/health/ready` | none | The transactional store answered `SELECT 1`, and the process is still serving rather than draining. 200 or 503, with the failing check named and no driver text. |
| `GET /v1/health/metrics` | **required** | The safety catalogue and the health catalogue, including the detection-before-report ratio. A request asking for a high-cardinality label is refused with `validation_failed`. |

All three are non-transactional, which is what makes the first two answerable
while the database is unreachable. `make check` proves this by starting real
processes, not by calling a function: `packages/service/test/health-restart.test.ts`
spawns child processes, `SIGKILL`s them, and reads the database from a process
that never saw the writes.

One thing a reader should not assume:

- **The metrics endpoint is not anonymous on purpose.** A safety ratio is a
  statement about the detection pipeline; any session can read it, an outsider
  cannot. Liveness and readiness are public because a probe needs to be.

**The edge-wide response counter now exists.** `edge.response`, served at the
metrics endpoint beside the rest, counts every response the edge finishes
writing under two labels and no others: `class`, which is `completed`,
`refused` or `outage`, and `code`, which is the domain code, `store_unavailable`,
`store_failure`, or `none` for a completion. The two are kept apart because
they are opposites — a refusal is the safety system working and an outage is the
service failing — and a number that averages them cannot tell a rising refusal
rate from a falling availability. The classification is applied once, in
`http/server.ts`'s `finalise`, from the error rather than from the status, so a
refusal decided in a domain function and a store fault raised inside the
transaction wrapper land in the same place. `readiness.probe` was the only
service-side metric; it is no longer the only one.

The counter needed no change to `src/ports.ts`. It is a process-wide meter that
the HTTP layer writes and `ServiceMetrics.snapshot` reads, because the layer
that decides a response is the layer that knows whether it was refused, and it
sits below the dependency seam. Two consequences worth stating rather than
hiding: `edge.response` is therefore per process and not per
`ServiceDependencies`, and a label set carrying an identifier is refused at the
counter rather than in a review comment.

No status code moved. The mapping was already right and is now asserted beside
the metric it feeds — a domain refusal is a 4xx with the domain's own code, a
retryable `StoreError` is 503, and a non-retryable one is 500.

**Committed work across a restart is now proved, not argued.** ADR 0001's claim
that a like, its match and its conversation commit together has been through an
actual process boundary: acknowledged in one process, `SIGKILL`ed, and read by a
third that never saw either write. A transaction left open when a process is
killed leaves nothing behind — asserted against the rows, not a count.

## What CI proves, and what it does not

Thirteen steps, parity-checked against `make check` so a green local run and a
green CI run mean the same thing: workflow, typecheck, typecheck-tests, test,
docs, research-check, stale-artifacts, lockfile, migrate, seed, client-test,
client-ios, parity. (An earlier version of this file said nine. The steps were
added since; the parity check itself was what failed to notice.)

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
| Whether identity verification is ever backed by a real vendor, and what a user is told when it is not | `identity-and-verification.md` §6 | **The provider is a stub by decision, and it now says so.** The score is asserted; the machine and its 0.9 floor are real. `ServiceDependencies.verification` is required, the score is refused from a client, and `GET /v1/health/ready` reports `verification.mode: "stub"` with a caveat. What is still open is whether a vendor is ever bought, and how evidence crosses to one — `ProviderSessionRequest` carries no artefacts, so an adapter cannot be handed the captures |
| Whether a moderator authenticates as a person or as a role | `staff-identity.md` | Today a static bearer token stands in for a human, so **no real person can reach a moderation queue in a deployment.** Everything else — evidence retention, restricted accounts, capability floors — is unreachable by anyone not holding a hardcoded string |

## Next in the delivery order

Per [#32](https://github.com/katzimoto/been_there/issues/32): resolve contract
gaps, establish the running application, **deliver onboarding and discovery**,
then matching and chat with safety controls, then proactive detection and
moderation, then quality and readiness.

The first two are done, and so is profile (#35) — four route modules funnel every
write through one `saveProfile`. Onboarding (#34) is in progress: the order is
now read from the server's own `OnboardingReadiness.Step` walk rather than
restated client-side, but the moderator's view is still to come.