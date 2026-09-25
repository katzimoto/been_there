# Architecture baseline — review findings

> Reviewer pass over the six parallel domain deliveries (identity, dating,
> communication, trust-safety, moderation, platform) plus the shared kernel.
> Authority for the eight commitments is
> [`00-overview.md`](./00-overview.md) and the five ADRs in [`./adr/`](./adr/).
>
> Method: `npx tsc --build` (clean) and `npx vitest run` (43 files, 558 tests,
> all passing) as of the first pass. Every finding below was reproduced against
> the built `dist/` artefacts or by direct grep of the source, not inferred from
> reading prose — the four Blocker findings each have a runnable reproduction
> in their entry.
>
> One caveat on the test count: concurrent agents were still landing work in
> `packages/moderation` and a new `packages/integration` appeared mid-review
> (recorded as **B-7**). A later run showed 4 failures in
> `packages/moderation/test/case.test.ts` against in-flight edits to
> `moderation/src/case.ts`. Those are not mine — this review authored exactly
> one file, a Markdown document — and the moderation findings below are stated
> against the source as of the first green run.
>
> This document records findings. It fixes nothing.

## 1. Summary

### 1.1 By severity

| Severity | Count | What they cluster around |
|----------|-------|--------------------------|
| **Blocker** | 6 | A restriction can strip `report`/`block`; an attacker can pull a victim out of discovery; `lift_restriction` needs no moderator; a shadowed risk transition row changes escalation semantics; nine audit actions throw; the event router drops every moderation event |
| **Major** | 30 | Doc/code contract disagreements in dating, identity, trust-safety, moderation, notifications, media, onboarding, sessions, the event-name split, the analytics catalogue, and an undeclared-dependency gap |
| **Minor** | 14 | Naming drift, a dead link, dangling types, unbacked "tested" claims, a doc-only copy catalogue, committed build artefacts, a duplicated comment |
| **Clean** | 4 | Cross-domain imports, commitment 5, commitment 3, commitment 1's core predicate |

### 1.2 By commitment

| # | Commitment | Verdict | Enforcement | Findings |
|---|-----------|---------|-------------|----------|
| 1 | `verified` is the only discoverable identity state | **Enforced, twice over** | Type + transition guard + post-loop re-check + test | — |
| 2 | Automation never enforces; a human on a recorded case is required | **Partially enforced** | Transition-table guards on `caseId`/`moderatorId` — but `lift_restriction` has no `moderatorId`, and the capability filter that protects `report` lives one package too far downstream | B-1, B-3 |
| 3 | Risk decays, at most one step | **Enforced, cleanly** | Transition table; verified by probe at 7/14/30-day boundaries | — |
| 4 | Unmatch never destroys the right to report | **Enforced** | Machine has no delete-transition; `submitReport` takes a frozen snapshot; `evidenceForReport`; `MatchEndedPayload.conversationRetained: true` | — |
| 5 | Exact location never exposed; coarse bucket only | **Enforced** | `RawCoordinate` is genuinely unexported (confirmed in `.d.ts`); `CoarseLocation` has no coordinate field; analytics forbids `latitude`/`longitude` | — |
| 6 | Domains never import each other's internals | **Clean** | Zero non-core cross-package imports, verified by grep over `src/` and `test/` | — |
| 7 | Sensitive data classified per field | **Enforced at the sink, not at every producer** | `redact`/`serializeForSink`, `ClassifiedField`, `ANALYTICS_FORBIDDEN_PROPERTIES` | M-6 |
| 8 | Every lifecycle is a transition table | **Enforced** | `defineStateMachine` used for all 11 machines | B-4 (a table whose semantics the table itself gets wrong) |

### 1.3 The one-paragraph version

The kernel is strong. `defineStateMachine`, the sensitivity vocabulary, the
branded ids, and the profile/attempt/media machines are all genuinely
load-bearing, and the trust-safety detector port is the best structural
argument in the repository. Six of eight commitments are enforced by a type or
a table and verified by a test. The two that are not — commitment 2's
capability floor and its reversal authority — fail in the *same place*: a
moderator decision is validated for "does this capability exist" but not for
"may this capability ever be removed", and the resulting capability set is
published on a `public` event. Everything in Major is doc/code disagreement
from six agents writing in parallel without reading each other; none of it is a
type error, which is why the build is green.

---

## 2. Part A — Do the eight commitments hold in code?

### 1. `verified` is the only discoverable identity state — **holds**

Three independent mechanisms, and the strongest of them is the least obvious:

- `packages/core/src/states/identity.ts:88` — `isDiscoverableIdentity` returns
  `identity.state === 'verified'`. One definition in the system.
- `packages/dating/src/discovery.ts:36` — `DISCOVERABLE_IDENTITY_STATE = 'verified'`,
  read by rule 1 (viewer) and rule 4 (candidate).
- `packages/dating/src/discovery.ts:195-197` — an **explicit re-check of the
  candidate's identity state after the rule loop**. The `rules` parameter is
  injectable solely so this property is testable, and
  `packages/dating/test/discovery.test.ts:76-88` proves an *empty* rule table
  still refuses an unverified candidate.

The post-loop re-check is the load-bearing property. Without it, commitment 1
would be a table entry that a future edit could delete or reorder away; with
it, deleting rule 4 changes nothing. This is the model the other commitments
should have had.

### 2. Automation never enforces — **holds for the transitions, not for the capabilities**

Enforced where claimed: `packages/core/src/states/account.ts:33-47`. Every
enforcement row guards on `caseId`; `suspend`/`reinstate`/`ban`/`lift_ban` also
guard on `moderatorId`. `packages/moderation/src/decision.ts:97-125`
(`validateAuthority`) independently refuses a null case, a null moderator, and a
rationale under 20 characters, with the message `"automation never enforces: a
decision requires a named moderator"`.

Two holes, both Blocker-class:

- **B-3**: `lift_restriction` at `account.ts:39` guards on `caseId` only. Probe:
  `accountMachine.next('limited','lift_restriction',{caseId:'case-77'})` →
  `{ok:true, value:'active'}`. `lift_ban` in the same table requires
  `moderatorId` and refuses. A caller that can name a case id but is not a
  moderator can lift a restriction with no human in the loop. `PROTECTED_ACTIONS`
  in `packages/platform/src/authz.ts` has `lift_ban` and no
  lift-restriction entry, so the platform layer offers no role gate either.
- **B-1**: see §3.1. The `report`/`block` floor exists only in
  `platform/src/authz.ts:224`, downstream of where removals are accepted.

Also worth recording as honoured: `docs/architecture/trust-safety.md`'s claim
that "the word *ban* does not appear in this package's types" is **true**.
`grep -rnoE "'(ban|suspended|banned|limited|restrict|suspend)'" packages/trust-safety/src`
returns nothing, and `test/type-guarantees.test.ts` asserts the detector
surface is three fields wide with no enforcement vocabulary. This is the best
structural guarantee in the repository.

### 3. Risk decays, at most one step — **holds**

`packages/core/src/states/risk.ts:46-48`. Probed at every boundary:

```
critical decay after 31 d => high        critical decay after 29 d => validation_failed
high     decay after 15 d => elevated    high     decay after 13 d => validation_failed
elevated decay after  8 d => normal      elevated decay after  6 d => validation_failed
```

One row per state, one step each, no skip. `applyDecay`
(`packages/trust-safety/src/assessment.ts:220-232`) additionally withdraws the
friction the fallen state justified and closes the queue entry below `high`, so
decay releases the *consequence*, not just the label. Clean — the only
commitment in the set with nothing to say about it.

The one caveat is B-4, which is not a decay defect but a table-semantics defect
that touches escalation.

### 4. Unmatch never destroys the right to report — **holds**

Four independent mechanisms:

- `packages/communication/src/conversation.ts` — the machine has **no
  delete-transition of any kind**, and the module comment (lines 30-35) says so
  explicitly. `ended_by_unmatch` and `ended` are both terminal but both retain.
- `packages/moderation/src/report.ts:30-37` — `submitReport` takes a frozen
  `RelationshipSnapshot` and captures evidence at that moment, so no code path
  connects an unmatch to an invalidated report.
- `packages/dating/src/interaction.ts` `evidenceForReport` — returns evidence
  for any recorded interaction in any state; `not_found` only for a pair that
  never interacted. Covered at `interaction.test.ts:214-245`.
- `packages/dating/src/events.ts:67` — `MatchEndedPayload.conversationRetained:
  true`, pinned as a literal type so a future edit cannot drop it.

### 5. Exact location is never exposed — **holds**

Verified as instructed rather than reported: `RawCoordinate` at
`packages/dating/src/location.ts:28` is declared with `interface RawCoordinate`
and no `export`, and `packages/dating/dist/location.d.ts:26` confirms it
appears in the emitted declarations **without** `export` and without appearing
in any exported signature's reachable type. It appears only as a parameter of
`coarseDistanceBand`, which returns a `DistanceBand`. This is genuine.

Supporting: `CoarseLocation` (`packages/platform/src/location.ts:78-84`) has
`band`/`label`/`observedAt` and no coordinate field; `StoredAnchor.coordinate`
is pinned to `sensitivity: 'sensitive'`; and
`ANALYTICS_FORBIDDEN_PROPERTIES` lists `latitude`, `longitude`, `coordinate`,
and `location`. Clean.

**One unbacked claim** (Minor, M-6): `docs/architecture/platform.md` §7 says
the coordinate-free projection is "checked at compile time in
`test/location.test.ts`, not by review." The test exists
(`packages/platform/test/location.test.ts`, 11 tests) but a `NotAKey<>` type
assertion is not visible in it. Cosmetic; the property holds regardless.

### 6. Domains never import each other's internals — **clean**

`grep -rn "from '@been-there/" packages/*/src packages/*/test` returns **zero
matches** for any package other than `@been-there/core`. Every non-core package
declares only `@been-there/core` as a dependency (`packages/*/package.json`).
`packages/dating/tsconfig.json` and `packages/trust-safety`/`moderation`
reference `../core`; `identity`, `communication`, `platform` import it without a
project reference, which works because `core` is a workspace symlink — worth
noting but not a boundary violation.

Also checked and clean: no domain reads another's storage; the only cross-domain
data shapes are `IdentityStatusProjection` (identity, six fields, `discoverable`
derived from the kernel predicate), `AccountStandingProjection` (dating, no
reason field), and the four communication signals (metadata-only, enforced by
`containsUserContent: false` as a literal type in
`packages/communication/src/signals.ts:104-110`).

### 7. Sensitive data classified per field — **holds at the sink**

`packages/platform/src/redaction.ts` requires a `sensitivity` on every
`ClassifiedField` (no constructor produces an unclassified field), recurses
into nested `ClassifiedRecord`, and filters against the **destination's**
clearance. `requestLogEntry()` takes a fixed `internal` clearance the caller
cannot raise. Duplicate field names throw. This is the enforcement point ADR
0005 names, and it is in the right place.

The gap is upstream, and it is Minor: classification is applied at the sink, so
a producer that forgets to classify a field produces a *record* that will pass
through whatever clearance the sink has. The identity domain's answer to this is
structural and excellent — `VerificationEvidence` has no field that can carry an
image, a video, or a URL, and `sensitivity` is pinned to the literal
`'restricted'` (`evidence.ts:45`). That pattern is not applied everywhere.

### 8. Every lifecycle is a transition table — **holds, with one broken table**

All 11 machines use `defineStateMachine`. `assertMachineIsTotal` runs in
`packages/core/test/states.test.ts` and in
`packages/identity/test/attempt-lifecycle.test.ts`.

The profile machine (`packages/dating/src/profile.ts:48-58`) is the best of
them: `mark_complete` and `mark_incomplete` are guarded in *opposite*
directions on the same predicate and are both reachable from every non-`deleted`
state, so content — not an edge — decides how far a paused or hidden profile
returns. `hide` requires a `ProfileHiddenReason`, so a client cannot self-hide.
`assertMachineIsTotal(profileMachine, ['deleted'])` proves no other dead end.

The worst is the risk table (B-4).

---

## 3. Part B — Boundary violations

No cross-domain imports. What follows is data that crosses a boundary carrying
more than the consumer is cleared for, or being decided in the wrong domain.

### B-1 (Blocker) — a restriction can strip `report` and `block`, and the stripped set is published on a `public` event

**Reproduce:**
```js
applyDecision({ action:'restrict', currentAccountState:'active',
  removedCapabilities:['report','block','send_message'],
  caseId:'case-1', moderatorId:'mod-1',
  rationale:'a long enough rationale string here', /* … */ })
// => ok, decision.removedCapabilities = ['report','block','send_message']
capabilitiesFor('limited', { removedCapabilities:['report','block','send_message'] })
// => ['browse_discovery','edit_profile']   // report and block are GONE
```

**Where:**
- `packages/core/src/states/account.ts:68-78` — `capabilitiesFor` is a plain
  `base.filter(c => !removed.includes(c))`. No unrestrictable list.
- `packages/moderation/src/decision.ts:146` — validation is
  `removed.filter(capability => !held.includes(capability))`. It asks *"does
  this account have it?"*, never *"may this ever be taken?"*. `report` is in
  every base list, so it passes.
- `packages/moderation/src/decision.ts:333` — the accepted removals are then
  applied to the **outward** payload:
  `capabilities: capabilitiesFor(decision.resultingAccountState, { removedCapabilities: decision.removedCapabilities })`,
  emitted as `account_state.changed` at `sensitivity: 'public'`
  (`events.ts:37-41`).
- `packages/platform/src/authz.ts:224` — `UNRESTRICTABLE_CAPABILITIES = ['report','block']`
  exists, and `effectiveRemovals` filters through it at `authz.ts:271`. **One
  layer too far downstream.**

**Why it matters.** The spec `docs/features/account-restrictions-and-reverification.md:70-73`
promises the opposite: *"a restriction can never remove `report`, `block` or
`delete_account` from any state."* And
`docs/architecture/moderation-enforcement.md` §3 says *"every account state in
the shared kernel grants the `report` capability, including `banned`, because a
banned user with a genuine safety concern is exactly the person who must still
reach a human."*

So two surfaces now disagree from one moderator input: the published
`account_state.changed` says the account cannot report; platform's own gate
says it can. Anything consuming the event — which is every product domain —
believes the wrong one. The failure mode is exactly the intake valve closing:
moderation stops receiving reports, and the metric that would show it
(§"neither failure shows up in any metric the platform can see") does not
exist. `delete_account` is likewise removable from `banned` end-to-end,
including through platform's filter, and the spec calls it *"the recommended
action"* on the banned screen.

No test covers it. `packages/moderation/test/decision.test.ts:70-83` tests only
the *unknown* capability (`'teleport'`) and the not-held case.

### B-2 (Blocker) — a user can demand another user's re-verification

**Reproduce:**
```js
requestReVerification(
  { subjectId:'VICTIM', reason:'user_requested',
    requester:{ kind:'subject', actorId:'ATTACKER' }, now:… },
  { identityState:'expired', history:[] })
// => ok({ subjectId:'VICTIM', viaEvent:'reverify_requested',
//         nextIdentityState:'pending' })
```

**Where:** `packages/identity/src/reverification.ts:145-215`. The function
receives `command.subjectId` and `command.requester.actorId` and **never
compares them**. The check order is: reason→requester-kind table (`:157`),
subject-state rule (`:167`), open attempt (`:175`), 30-day cap (`:180`),
cooldown (`:196`).

**Why it matters.** `docs/features/account-restrictions-and-reverification.md:343`
(R3) states: *"**No user can request another user's re-verification.** There is
no 'report as unverified', no 'flag this person's age'."* The same document
gives the reason — *"a harassment and an escalation-abuse vector"* — and
`docs/architecture/identity-and-verification.md:282` grants the `subject`
requester only *"while not already `verified`"*, on the reasoning that the
dating core's refusal is refused *"in code rather than in a review comment."*

Today the only thing standing between a stranger and a victim's visibility is
the 3-per-30-days cap and the 24-hour cooldown. After three days, an attacker
with one account can pull a named victim out of discovery four times a month,
and because `docs/architecture/identity-and-verification.md:329` says a plan
carries no evidence, **nothing is recorded about who asked**. This is the exact
primitive the anti-abuse section of that document claims does not exist, and it
exists because `ReverificationRequester['subject'].actorId` is a field that is
checked against nothing.

`packages/identity/test/reverification.test.ts` exercises every
kind × reason pair and the dating-core refusal. It never passes a `subject`
requester with a different `actorId`.

### B-3 (Blocker) — `lift_restriction` requires no moderator

Covered in §2 above. Probe and citations in the commitment-2 entry. The
asymmetry inside one table is the tell: `lift_ban` requires `moderatorId`,
`lift_restriction` does not. A restriction is a lesser sanction than a ban, so
the argument for the asymmetry is obvious — but the consequence is that
automation can undo a human's decision, and commitment 2 is phrased about
*reversals* as much as about sanctions.

### B-4 (Blocker) — a shadowed transition row silently changes the risk escalation contract

`packages/core/src/states/risk.ts:43-44`:
```ts
{ event: 'threshold_crossed', from: ['normal','elevated','high'], to: 'high',   guard: score >= 0.7 },
{ event: 'threshold_crossed', from: ['high'],                   to: 'critical' },  // ← never reached
```

`defineStateMachine`'s resolver is `spec.transitions.find(...)`
(`packages/core/src/transition.ts:60-64`) — **first match wins**. From `high`,
row 43 matches, so row 44 is dead. Probe:
```
high + threshold_crossed score 0.95 => { ok:true, value:'high' }   // not 'critical'
legalEvents('high') => ['signal_observed','threshold_crossed','threshold_crossed','decay',...]
```

This is a blocker not because it is currently wrong — `assessSignal` never asks
for `threshold_crossed` from `high` (`policy.ts:120-122`, and its comment
explains exactly why) — but because **the safety argument in
`docs/architecture/trust-safety.md:143-146` is written against a table that
does not exist**:

> *"`threshold_crossed` is never requested from `high`: in the shared table that
> edge has no guard, so using it there would skip the corroboration requirement
> entirely."*

The doc's reasoning is that the high→critical edge is **live and unguarded**,
which is why the policy layer avoids it. The code's reality is that the edge is
**dead**, which is why the policy layer's avoidance is currently harmless. Those
are opposite failure modes. An implementer who reads the doc, believes the edge
is live, and "simplifies" the policy layer's `high` branch to use
`threshold_crossed` will get `high → high` and a silently broken escalation —
not the `critical` the doc warns about, so the guard they thought they were
relying on is not what fires.

`legalEvents('high')` also returns `'threshold_crossed'` **twice**, which any
consumer rendering an action list will show as a duplicate.

Fix is one line: delete row 44, or reorder so `from:['high']` precedes the
guarded row — but pick deliberately, and fix the doc either way.

### B-5 (Major) — trust-safety's observation vocabulary has no producer

`packages/trust-safety/src/detector.ts:20-31` declares ten `ObservationKind`s:
`identity_status_changed`, `verification_attempted`, `unmatch_initiated`,
`match_ended`, `message_sent`, `message_reported`, `block_created`, …
No domain publishes any of them. Dating publishes `unmatch.performed`,
`like.recorded`, `block.created`. Communication publishes
`communication.message_sent`. Identity publishes `identity.status_changed`.
Moderation publishes `moderation.report_submitted`.

So `interaction.unmatch_report` (§5 of the trust-safety doc — the detector the
whole worked-numbers section is built on) consumes `unmatch_initiated`, which
no one emits; the correct name is `unmatch.performed`. And `report.coordinated_target`
consumes `message_reported`, which is moderation's `moderation.report_submitted`
and is `restricted`-adjacent, not an `internal` behaviour observation.

This is the reduction seam ADR 0003 is about, and it is the one seam with no
contract written down anywhere. Nothing converts a published event into an
`Observation`, so the reduction the doc describes in §3 ("reduced on arrival to
metadata only") has no code and no owner.

### B-6 (Major) — a counterpart-side messaging check the spec relies on does not exist

`docs/features/account-restrictions-and-reverification.md:119,137,353` state
that a restriction disables the composer *"for this user **and for every
counterpart**"*, *"both ways"*, and that *"the refusal is symmetric."*

`packages/communication/src/permissions.ts:112-122` — `SEND_CHECKS` rule 6 reads
`dependencies.senderStanding.capabilities`. `CommunicationDependencies`
(`read-models.ts:57-61`) is `{match, blocking, senderStanding}`. There is no
peer standing, so there is nothing to check symmetrically. A `limited` user as
the **other** party in a thread can still send into it.

The whole "cannot be probed" argument in §8.4 of that spec — that a restriction
cannot be used to make a counterpart look unreliable — is therefore
unimplemented, and an implementer will not discover this until the client
behaves asymmetrically in production.

### B-7 (Major) — three domain packages import `@been-there/core` without declaring it

`packages/identity`, `packages/communication`, and `packages/platform` each have
`"dependencies": {}` or no `dependencies` key at all in `package.json`, yet
all three import `@been-there/core` in 12–20 files. They resolve today only
because npm workspaces hoists a symlink to the repo root `node_modules`. The
other three (`dating`, `moderation`, `trust-safety`) declare it correctly.

This is a packaging defect, not a boundary violation, but it is the kind that
surfaces on someone else's machine: an install that does not hoist (`npm ci
--workspaces=false`, a Docker layer that copies one package, a CI matrix that
installs per-package) resolves `@been-there/core` to nothing and every one of
those three packages fails to build. Nothing in the current config catches it —
`tsc --build` is green today only because the hoisted symlink happens to be
there.

Related, same family: `packages/integration` (a cross-domain composition test
harness, added after this review's first pass) is **not listed in the root
`tsconfig.json` references**, so `npx tsc --build` does not typecheck it. Its 19
tests run under vitest (`vitest.config.ts` globs `packages/*/test/**`) and pass,
but the type-level half of the safety chain is unchecked by the build. It does
import only public entry points and no `src/` internals, so it does **not**
violate commitment 6 — a test harness composing domains is not a domain.

### B-9 (Blocker) — nine of moderation's sixteen audit actions throw when appended to the platform audit log

`packages/moderation/src/audit.ts:24-40` defines a 16-value `AuditAction`
union: `report.submitted`/`triaged`/`merged`/`status_changed`,
`case.opened`/`assigned`/`review_started`/`escalated`/`reports_merged`/`resolved`/`reopened`,
`evidence.captured`/`read`/`read_denied`, `decision.recorded`/`reversed`.

`packages/platform/src/audit.ts` defines its **own, different** `AuditAction`
union plus an `AUDIT_ACTIONS` record mapping each name to a policy
(`audit.ts:81-83` and following). The two unions overlap on exactly three
strings: `case.opened`, `case.evidence_read` vs `evidence.read`, and
`case.decision_recorded` vs `decision.recorded` — and even those three use
*different spellings*, so in practice only `case.opened` matches.

`InMemoryAuditLog.append` does `const policy = AUDIT_ACTIONS[request.action]`
(`audit.ts:138`) and then reads `policy.sensitivity`. Reproduced:

```
OK     case.opened
THROWS case.assigned        TypeError: Cannot read properties of undefined (reading 'sensitivity')
THROWS case.resolved        TypeError: ...
THROWS case.review_started  TypeError: ...
THROWS case.reopened        TypeError: ...
THROWS evidence.captured    TypeError: ...
THROWS evidence.read        TypeError: ...
THROWS decision.recorded    TypeError: ...
THROWS decision.reversed    TypeError: ...
THROWS report.submitted     TypeError: ...
```

Nine of sixteen throw. So the moderation audit chain the doc calls
*"append-only by construction"* and the appeal record it is supposed to
produce — case assignment, review start, evidence capture and read, decision
recorded and reversed, case resolution and reopen, report submission — cannot
be written through the platform sink at all. TypeScript cannot catch this:
`AuditAction` is a string union in each package independently, so an
`action: 'case.assigned'` literal from moderation is a perfectly well-typed
string at the call site.

`packages/moderation/src/audit.ts:8` says the log has *"append and three read
projections"*; it has four. `docs/architecture/moderation-enforcement.md` §7
lists all sixteen as part of the record. This is the same second-vocabulary
problem as B-11, one layer more consequential.

### B-10 (Blocker) — `routeEvent` silently drops every moderation event from both sinks

`AUDIT_REQUIRED_PREFIXES` (`packages/platform/src/audit.ts:180-186`) is
`['identity.', 'case.', 'account_state.', 'auth.']`. Those prefixes were
written for a `case.opened` naming scheme. Moderation actually publishes
`moderation.case_opened`, `moderation.case_resolved`,
`moderation.report_submitted`, `moderation.evidence_captured`,
`moderation.decision_recorded` (`packages/moderation/src/events.ts:24-35`) —
**none of which starts with `case.`**. Reproduced:

```
moderation.case_opened        {"audit":false,"analytics":false}
moderation.case_resolved      {"audit":false,"analytics":false}
moderation.decision_recorded  {"audit":false,"analytics":false}
moderation.report_submitted   {"audit":false,"analytics":false}
identity.status_changed       {"audit":true,"analytics":false,"rejection":"audited_only"}
```

The `{"audit":false,"analytics":false}` result with **no `rejection` field** is
the tell: it is not a deliberate refusal, it is `isAuditRequired` returning
false and then `isWithinClearance({upTo:'internal'}, 'restricted')` returning
false. The event falls off the end of the router.

`docs/architecture/platform.md` §6 names this router as the enforcement
mechanism — *"Safety and identity events go to audit and nowhere else"* — and
`docs/features/account-and-onboarding.md:513` states the guarantee as
*"the platform's router returns `{ audit: true, analytics: false }` for them,
so a bug cannot promote a safety fact into a metrics sink."* The router does
not promote anything; it **loses** the safety fact. The good news is the
failure direction is safe (nothing leaks into analytics); the bad news is that
the audit half of the promise is currently false for the entire moderation
domain, and silently so.

### B-11 (Minor) — the unrestrictable list is a second capability vocabulary

The spec at `docs/features/account-restrictions-and-reverification.md:36` says
the capability surface is *"**read, never restated in code**"*. The table is in
`core`. The list that actually enforces the invariant is a hand-maintained
two-element array in `platform`. Two places to update when a capability is
added; neither is derived from the other. This is exactly the "second crossing
point" the moderation doc's open questions section warns against for
`castId`/`Brand` — applied, unremarked, to capabilities.

---

## 4. Part C — Doc/code divergences

Ordered by what it costs an implementer.

### 4.1 Event names and payloads

| # | Claim | Source | Actual | Fix |
|---|-------|--------|--------|-----|
| **C-1** | The identity status event is `identity_status.changed` | `00-overview.md:71,140`; `dating-core.md:302,362`; `trust-safety.md:49,128,135`; `platform.md:191`; and **six** feature specs | Identity publishes `identity.status_changed` (`identity/src/events.ts:34`) | Rename in one place, then the other. The domain that owns the emission binds. |
| **C-2** | `dating-core.md:302` names the consumed event `identity_status.changed`; `dating/src/events.ts:104,181` **declares the same wrong string** in `CONSUMED_EVENT_CATALOGUE` | `dating-core.md`, `dating/src/events.ts` | The producer emits a name the consumer does not subscribe to. `platform/src/audit.ts:195` papers over it by listing *both* `identity_status.changed` (types) and an `identity.` prefix (prefixes), so `isAuditRequired` returns `true` for both spellings — which is why nobody noticed. | Fix the catalogue to the producer's name; drop the duplicate entry in `AUDIT_REQUIRED_TYPES`. |
| **C-3** | `trust-safety.md:49` says the engine consumes `unmatch_initiated`; §5 builds `interaction.unmatch_report` on it | `trust-safety.md` | Dating publishes `unmatch.performed` (`dating/src/events.ts:99,149`). No producer emits `unmatch_initiated`. | Add the reduction mapping, or rename. See B-5. |
| **C-4** | `preferences-and-discovery.md:368` — `preferences.updated` payload is `{ subjectId, changedAxes: string[] }`; `:379-380` — *"No preference values are ever published"* | feature spec | `dating/src/events.ts:33-40` publishes **full values**: `ageRange`, `maxDistanceKm`, `interestedIn`. | Decide which is right. Note the spec's stated *reason* is incoherent either way: it justifies `changedAxes` by saying "analytics is a `public`-clearance consumer", but the event is `user`, so a `public` consumer can never see either shape. |
| **C-5** | `likes-and-matching.md:318` — `match.ended` and `unmatch.performed` are **`user`** sensitivity | feature spec §8.2 | `dating/src/events.ts:152,157` — both `internal`. The same spec's §9 table (`:392-393`) says `internal`, and §9.5 (`:395-398`) explains why every Dating envelope is `internal`. **The spec contradicts itself three paragraphs apart**, and the code follows §9. | Fix §8.2. |
| **C-6** | `likes-and-matching.md:393` — `unmatch.performed` payload is `{ matchId, actorId, idempotencyKey }` | feature spec | `dating/src/events.ts:149-154` — no payload interface at all; no `idempotencyKey` anywhere in the package. | Declare the payload or drop the field. |
| **C-7** | `preferences-and-discovery.md:57` — profile state is learned via `profile.published` / `profile.state_changed` | feature spec | `DATING_EVENT_CATALOGUE` has `profile.completed` and `profile.deleted` only. Worse: `ProfileStateChangedPayload` (`events.ts:27-31`) is **declared and registered to no event** — a dangling type. | Either add the event or delete the payload. The spec also never mentions `profile.deleted`, which *is* implemented and has different visibility semantics from `hidden`. |
| **C-8** | `moderation-enforcement.md:320-322` lists `moderation.*` events; §7 lists the audit action catalogue | moderation doc | `moderation.case_reports_merged` and `moderation.evidence_read` are declared in `ModerationEventType` (`moderation/src/events.ts:30,33`) and **emitted from zero sites**. `evidence.read`/`evidence.read_denied` *are* appended to the audit log (`evidence.ts:319`), so the audit row exists without a corresponding event. | Emit them, or delete them from the union. A declared-but-unemitted event is a promise the bus will not keep. |
| **C-9** | `platform.md:206` names `identity_status.changed` as `audit: true, analytics: false` via `routeEvent()` | platform doc | True for both spellings only because of the belt-and-braces in `audit.ts:180-199`. The mechanism is correct; the *name* is the wrong one. | Follows C-1. |
| **C-10** | `AUDIT_REQUIRED_TYPES` includes `message.reported` and `media.scan_result` | `platform/src/audit.ts:197,199` | No package publishes either. `message_sent` exists as `communication.message_sent`; the media machine has states but publishes no event. | Dead entries in an allowlist are a silent no-op today and a false sense of coverage. |
| **C-11** | `CONTENT_BEARING_TYPES` = `message.sent`, `message.edited`, `message.content_rendered`, `profile.bio_updated` | `platform/src/analytics.ts:301-306` | Communication publishes `communication.message_sent`. **None of the four strings is ever emitted**, so the "content goes nowhere" rule currently protects nothing. This is the one that should worry a reader: the guard is real, the list is wrong, and the failure is silent. | Rename to the real event names. |

### 4.2 State names and transition tables

| # | Claim | Source | Actual | Fix |
|---|-------|--------|--------|-----|
| **C-12** | Eligibility rule order: 13 `gender_out_of_scope`, 14 `beyond_distance_limit` | `dating-core.md:208-209`; `preferences-and-discovery.md:167-170` (P2 gender, P3 distance) and §4.2 | `dating/src/discovery.ts:155-170` is **distance at 156, gender at 160** — reversed. `evaluateEligibility` returns the first match only, so a candidate failing both gets `beyond_distance_limit` from code and `gender_out_of_scope` from both documents. | Reorder the array, or change both docs. `dating/test/discovery.test.ts:162-166` currently pins the code's order. |
| **C-13** | "A pass is a soft hide, not a veto: … a later like clears it" | `dating-core.md:101-102` | Half true. `interactionMachine` allows `like` from `passed` (`interaction.ts:81`, note: *"A pass is a soft hide, not a veto: liking after a pass is allowed and clears it"*) — but `resolveMatch` (`interaction.ts:186-192`) refuses across **any** pass in either direction. Probed: `passed + like` → `liked`; then `resolveMatch` with the same pass still present → `match_refused: passed`. The machine and the resolver disagree, and **no test composes them**. | Pick one. `likes-and-matching.md:105-111` (A5) sides with the machine; `dating-core.md:107-109` and `interaction.test.ts:110-121` side with the resolver. Three sources, two answers. |
| **C-14** | A like after a pass *"supersedes"* the pass and *"exactly one match exists"* | `likes-and-matching.md:105-111`, A5 `:445-448` | `resolveMatch` returns `match_refused: passed`. The **feature spec is the outlier** here — the architecture doc, the code, and the test all agree with each other. | Correct the feature spec. |
| **C-15** | `LikeState = 'live' \| 'superseded' \| 'withdrawn' \| 'matched'` with `supersededPassId` | `likes-and-matching.md:56,62-64` | `LikeRecord` (`interaction.ts:50-55`) is `{likeId, from, to, createdAt}`. No state, no `supersededPassId`. `withdrawLike` (`:146-149`) **filters the record out** — a physical delete, where the spec models `withdrawn` as retained. That collides with `likes-and-matching.md:352-356` (*"no part of the unmatch path may cascade-delete into the evidence store"*) — `unmatch` does retain, but `withdrawLike` does not. | Either model the states or correct the spec. The delete-vs-retain question needs an answer, not a rename. |
| **C-16** | A like followed by a pass **withdraws the like**; *"the state machine must be total"* | `likes-and-matching.md:113-115` | `interaction.ts:82` — `pass` is `from: ['none','passed']`, so `liked + pass` → `invalid_transition`. Probed. The documented sequence is unreachable, and `likes-and-matching.md:178-181` lists it as one of four M1 test obligations. | Add the edge or correct the spec. Note `assertMachineIsTotal` cannot catch this — it checks for dead ends, not for expressible sequences. |
| **C-17** | *"Liking someone you are already matched with is a no-op, not an error"* | `likes-and-matching.md:79-81` | `interaction.ts:81` — `like` is `from: ['none','passed','unmatched']`. `matched + like` → `invalid_transition`. Probed. | Add the self-transition or correct the spec. |
| **C-18** | Four match standings: `dormant_target_unverified`, `restricted_by_target`, `closed_by_target`, `closed_by_actor`; M2: *"a match is never removed from a party's list"* | `likes-and-matching.md:273-284` | `MatchStatus` (`interaction.ts:89`) is `active \| unmatched \| ended_by_block`. `MatchRecord` has one `status`, not a per-party standing. **A single status cannot represent what §7.2 requires** (Alice sees `restricted_by_target`, Bob sees `dormant_target_unverified`). | This is a data-model gap, not a rename. An implementer following the spec must redesign `MatchRecord`; one following the code will reproduce the "silently losing rows" failure §7.2 exists to prevent. |
| **C-19** | `AccountCapabilityProjection { accountState, removedCapabilities, effectiveCapabilities }`; *"read from the capability projection, which is the state plus the removed set"* | `account-restrictions-and-reverification.md:36,452-454` | `AccountStateChangedPayload` (`moderation/src/events.ts:42-45`) is exactly `{accountState, capabilities}` — **the removed set is never published**, and `decision.test.ts:170` asserts `Object.keys(payload)` is exactly those two. | This breaks the spec's own explainability promise: `§6.1`'s `{capability_line}` and `notifications.md:113` (*"Names each removed capability"*) **cannot be generated from the published event.** A client would have to diff against a local copy of the base table — which §3.1 explicitly forbids. |
| **C-20** | A pass suppresses for **30 days** | `preferences-and-discovery.md:164,243,427` (A7); `likes-and-matching.md:22,332` | `discovery.ts:122-128` — `passes.some(...)`, **no date comparison**. `PassRecord.createdAt` exists (`interaction.ts:57-62`) and is read by nothing in the package. `grep` for a window constant in `packages/dating` returns nothing. **Passes are permanent.** | Both specs state the window; nothing implements it. This is a user-visible product decision currently decided by omission. |
| **C-21** | `maxDistanceKm` is *"one of the published bucket edges: 1, 5, 15, 50, 100 km. Not a free number"* | `preferences-and-discovery.md:87` | `preferences.ts:67-77` accepts any finite number in `[1,500]`; `PREFERENCE_LIMITS` is `{minDistanceKm:1, maxDistanceKm:500}`. And **the edge list matches neither banding module** — `1` and `15` are edges nowhere; dating's edges are 5/25/50/100, platform's are 8/40/160. `dating-core.md:293` sides with the code. | The feature spec is the outlier. Note the third band vocabulary (see M-2). |
| **C-22** | Age range *"width at least 5 years"*; §10 says *"Currently rejected"* | `preferences-and-discovery.md:86,494-496` | `preferences.ts:53-66` checks integer-ness, `min<18`, `max>120`, `min>max`. **No width check.** `{min:30,max:31}` is accepted. The open question claims a decision that was made and implemented. | Implement it or retract the claim. |
| **C-23** | Two gender axes: `seekingGenders` (one-sided, drives P2) and `openTo: OrientationGroup[]` (pair-wise, drives P4) | `preferences-and-discovery.md:74-75,88-89,112-117` | One field, `interestedIn` (`preferences.ts:33`), read in **both** roles: as the one-sided filter (`discovery.ts:163-170`) and as half of the pair-wise test (`preferences.ts:153-163`). `OrientationGroup` appears **nowhere** in `packages/`. | A user who wants to *see* women but is not *open to being matched with* women cannot be expressed. Affects the settings screen and the §6 widen actions, which offer "Include any gender" and "Include all orientations" as two distinct actions. |
| **C-24** | Six preference axes (`ageRange`, `maxDistanceKm`, `seekingGenders`, `openTo`, `locationPrecision`, `hidden`) | `preferences-and-discovery.md:71-92` | Three. `locationPrecision` (a privacy commitment: *"may only be coarser than the platform default; a request to refine is rejected with `validation_failed`"*) has no type and no validation. `hidden` — the reversible "pause being discoverable" switch — does not exist, which combined with C-20 (permanent passes) means a user has **no reversible way to disappear**. | Three of six axes have no representation. The settings service cannot be built from this record. |
| **C-25** | R3: candidate is denied if they lack `browse_discovery` *"or `like` (may reciprocate)"*; §3.2: *"Every one of these is re-evaluated at action time against current projections"* | `preferences-and-discovery.md:161,72-83`; `likes-and-matching.md:72,83` | `discovery.ts:111-115` reads only `browse_discovery`. And `recordLike` (`interaction.ts:129-144`) checks **self-like and duplicate-pair only** — not identity, not capability, not profile, not block. `InteractionContext` (`:39-46`) has no field in which a standing could be passed. | Two gaps. (a) A `browse_discovery`-but-not-`like` candidate consumes a page slot for a card they cannot act on. (b) The "cannot like after verification lapses" guarantee and the block check are both **enforced only by a state machine the writer is not required to pass through** — calling `recordLike` directly writes a like across a live block. The block guard is a `interactionMachine.can` test, never a `recordLike` test. |
| **C-26** | `banned` grants `block`: *"`report` and `block` are in every state including `banned`"* | `account-restrictions-and-reverification.md:476` (§11 scenario 4), `:167` (§5.5) | `account.ts:65` — `banned: ['report', 'appeal_request', 'delete_account']`. **No `block`.** §5.4 of the same spec is correct; §5.5 and §11 are the two that are wrong. | A banned user cannot block. Given the spec's own rationale for `UNRESTRICTABLE_CAPABILITIES` (*"a victim cannot protect themselves"*), this is the state where a subject most plausibly wants to block. One word. |
| **C-27** | R2: *"Past the cap, Trust & Safety raises a signal and stops requesting"* | `account-restrictions-and-reverification.md:342` | `reverification.ts:180-190` returns `domainError('rate_limited', …)`. No signal, no audit row, no case, no record. Same for the cooldown at `:196-204`. | An implementer builds "on cap → raise signal → human sees a case" and gets an error with no side effect. The moderation queue never learns a subject was pulled out of discovery three times in a month. |
| **C-28** | R7: *"repeated failure leads to `review_required` (a human)"* | `account-restrictions-and-reverification.md:347` | `identityMachine.flag_for_review` is `from: ['pending','verified']` (`identity.ts:55-59`). From `verification_failed` there is **no** outgoing event except `submit_verification`. Nothing in `identity/` counts failures. | The implementer writes the escalation and gets `invalid_transition`. |
| **C-29** | §12: *"The re-verification rate cap… the mechanism is settled (a cap that degrades to a signal); **the number is not**"* | `account-restrictions-and-reverification.md:~483` | `reverification.ts:83-88` — `maxPerSubjectPer30Days: 3`, `cooldownHours: 24`, both exported and both asserted in `reverification.test.ts:145-170`. | The numbers exist, are pinned by CI, and the open question says they don't. |
| **C-30** | A missing `caseId` is rejected as a structural impossibility | `account-restrictions-and-reverification.md:474` | `transition.ts:100` — a failed guard is `validation_failed`, not `invalid_transition`. `decision.test.ts:44-49` asserts `validation_failed`. | The distinction matters to a client: `invalid_transition` means impossible, `validation_failed` means incomplete context. The doc claims the stronger; the weaker ships. |
| **C-31** | `subjectMayRequestOnlyWhen: ['expired','verification_failed']` vs `reverify_requested` `from: ['verified','expired','review_required']` | not mentioned in any doc | A subject in `verification_failed` **passes** the policy gate (`reverification.ts:167`) and is then refused by the kernel with `invalid_transition` (`:206` → `transition.ts:95`). The policy constant actively invites a call the machine will reject. | Latent. Worth aligning the two lists. |

### 4.2a The analytics catalogue: 35 of 55 declared events do not exist

`product-quality-and-measurement.md` presents itself as the index of what the
metrics sink receives, and it is written that way — §2.1 onwards is a table of
`Event | Source | Emitted when | Sensitivity | Role`, and §6.3 is a per-event
sampling policy. I extracted every backticked `domain.event` from those tables
and checked each against `ANALYTICS_EVENTS`
(`packages/platform/src/analytics.ts:32-146`):

**20 of 55 are registered. 35 are not.** The missing ones the spec treats as
*implementable analytics inputs* rather than as indexed domain events:

| Spec-declared analytics event | Spec site | In `ANALYTICS_EVENTS`? |
|---|---|---|
| `account.recovery_completed` (carries `sessions_revoked_count`) | `:73` | no |
| `discovery.entered`, `discovery.page_served`, `discovery.exhausted`, `discovery.viewer_ineligible` | `:149,415,469-470` | no |
| `message.recorded`, `message.delivered`, `message.read`, `message.withheld_by_system` | `:183,415,470` | no |
| `conversation.created`, `conversation.activity`, `conversation.flagged_pattern` | `:415,467` | no |
| `settings.updated` | `:103,470` | no |
| `moderation.appealed` | `:470` | no |
| `risk.assessed` (carries `state`, `detectorCount`) | `:210` | no |
| `slo.error_budget_exhausted`, `alert.fired`, `dependency.failed`, `provider.verification_call` | `:229,470` | no |
| `block.changed` | `:467` | no |
| `notification.dispatched`, `notification.failed`, `notification.duplicate_prevented` | `:470` | no — the catalogue has `notification.delivered` and `notification.suppressed` instead |

The consequence is concrete and mechanical: `recordAnalyticsEvent`
(`analytics.ts:207-212`) **refuses an unregistered name** with
`validation_failed`. An implementer wiring §3's funnels to the names §2
declares gets a hard refusal on the majority of the catalogue, and the failure
is at the sink, in a function that looks like it is doing its job.

Two secondary points make this sharper rather than cosmetic:

- The spec assigns **`discovery.page_served` a 10% sample rate with a specific
  deterministic hash of `userId` + `sessionId`** (`:469`). `isSampled`
  (`analytics.ts:326-341`) hashes the `correlationId` only, and
  `ANALYTICS_FORBIDDEN_PROPERTIES` lists both `userId` and `sessionId` — so the
  spec's sampling scheme is not implementable as written, and the two hashes
  would disagree if it were.
- The spec's own §6.3 rule (*"sampling is chosen per event, once, in this
  table… an ad-hoc sample rate on an unlisted event is a schema change"*)
  describes a discipline the code does not have: `recordAnalyticsEvent` takes
  `sampleRate` as a **caller-supplied argument** and checks it only against
  `[0, 1]`. The rule the spec calls a schema guard is currently a per-call-site
  choice.

The domain events the spec merely *indexes* (`like.recorded`, `match.created`,
`risk.changed`, `report.submitted`, `verification.anomaly`, `account_state.changed`)
are a different matter and mostly correct: those are published by their owners
and routed by `routeEvent`, and the spec's §2.2 note that the metrics sink never
receives the identity status stream is the right rule. `like.recorded` and
`match.created` genuinely should not be in the analytics catalogue — but the
spec lists them in a *sampling* table alongside events that should, and that
ambiguity is worth resolving in one sentence.

### 4.2b Remaining specs, spot-checked

The other six specs were swept more lightly than the two above. These are the
concrete results.

| # | Claim | Source | Actual | Fix |
|---|-------|--------|--------|-----|
| **C-33** | `NotificationKind` is *"the stable notification identifier"* and every catalogue row is one; the spec enumerates **20** of them, each with a class, per-channel opt-in, content rules, and an idempotency key | `notifications.md:94,103-124` | No `NotificationKind` type exists anywhere in `packages/`. `packages/platform/src/notifications.ts:13-19` has a seven-value `NotificationCategory` (`safety`, `account`, `like`, `match`, `message`, `marketing`, `system`) and `CATEGORY_CHANNELS` (`:33-43`) — a *routing* taxonomy, not the spec's *content* taxonomy. There is no per-kind registry, so nothing enforces the spec's rule that a notification's content is reviewable. | Add the registry, or scope the spec to categories. |
| **C-34** | Idempotency keys are per-kind and hand-written, e.g. `match:{matchId}`, `message:{messageId}:{recipientUserId}`, `restriction:{caseId}:{subjectUserId}:{capability}` | `notifications.md:120-124` | `idempotencyKeyFor` (`notifications.ts:108-110`) derives `[sourceEventId, recipientId, channel]`. Compatible in spirit — a retry of the same event collapses — but the shape is entirely different, and the spec's `restriction:…:{capability}` shape implies one notification **per removed capability**, which no code supports. | Pick one derivation. Note the spec's shape would emit N notices for an N-capability restriction. |
| **C-35** | `account.restriction.applied` *"Names each removed capability, the case reference, the date, and the appeal route"* | `notifications.md:112` | Cannot be built. `AccountStateChangedPayload` is exactly `{accountState, capabilities}` (see **C-19**) — the removed set and the case id are both absent from the only event this notification is triggered by. This is the second independent consumer that C-19 breaks, and the one with user-facing consequences. | Resolves with C-19. |
| **C-36** | Media screening produces `approved` / `rejected` / `needs_human`; per-photo state `uploading → screening → approved \| rejected \| needs_human` | `profile-and-personalization.md:330-345` | `mediaMachine` (`platform/src/media.ts:23-62`) has four states — `initiated`, `scanning`, `approved`, `rejected` — and `needs_human` appears **nowhere** in `packages/`. The spec's own §"Routed to a moderator rather than auto-approved or auto-rejected" (`:302`) has no state to live in. | The architecture doc's four-state diagram is right; the feature spec invents a fifth. |
| **C-37** | A photo must be `approved` before it counts toward profile completeness | `dating-core.md:64`; `profile-and-personalization.md:341-343` | **Correct and enforced.** `evaluateProfileCompleteness` (`dating/src/profile.ts:164-166`) filters `photo.approval === 'approved'`, and `PhotoApproval` (`:80`) is `'pending' \| 'approved' \| 'rejected'`. | — |
| **C-38** | The `SAFETY_*` copy tokens (`SAFETY_BLOCK_RECEIVED`, `SAFETY_ACCOUNT_REINSTATED`, `SAFETY_APPEAL_REQUESTED`, `SAFETY_REVERIFICATION_REQUESTED`, `SAFETY_VERIFICATION_REVIEW`) are the reviewed user-facing strings | `user-safety-controls.md:528-538`, referenced from `notifications.md:118` | They exist **only** as rows in that markdown table. No constant of that shape exists in `packages/`, so there is no enum and nothing prevents the two documents' spellings from drifting. | Acceptable as a copy catalogue, but say so explicitly, or add the enum. Note `SAFETY_REVERIFICATION_REQUESTED` is keyed to `verification.re_verification.requested`, which — per C-8's sibling problem — no `src/` code emits. |
| **C-39** | Report reason taxonomy: 11 reasons with intake priority, statement requirement, and person-safety flag | `moderation-enforcement.md` §3 | **Correct against the architecture doc.** `packages/moderation/src/report.ts:43-77` — `ReportReason` (11 values) and `REPORT_REASON_POLICY` match `moderation-enforcement.md`'s table name-for-name and priority-for-priority, including `other` as the only `requiresStatement: true`. | — |
| **C-39b** | Report reason taxonomy: **seven** user-facing codes | `user-safety-controls.md:183-189` and the contract sketch at `:552-559` | The feature spec gives seven — `harassment`, `hate`, `sexual_content`, `scam`, `minor`, `unsafe_contact`, `other` — with user-facing labels (*"I think this person may be under 18"*). The code has the other **eleven** (`moderation/src/report.ts:40-51`): the four 7→11 mismatches are `hate`/`hate_or_discrimination`, `minor`/`minor_safety`, `scam`/`scam_or_solicitation`, and `unsafe_contact` which has **no counterpart at all** — it is absent from the code entirely, while `threats_or_violence`, `non_consensual_intimacy`, `impersonation`, `fake_or_misleading_profile`, and `spam` exist in the code and in no feature spec. The statement cap diverges too: `MAX_STATEMENT_LENGTH = 2000` (`report.ts:78`) against the feature spec's 500. | `moderation-enforcement.md` matches the code, so **`user-safety-controls.md` is the outlier** — as with C-14 and C-21. A reporter UI built from it would send four codes the server rejects and would be unable to send one it offers. |
| **C-40** | Conversation retention: ≤180 d `live_history`, ≤365 d `reportable_only`, >365 d `purged` | `communication.md` §9 | **Correct.** `packages/communication/src/retention.ts:20-39` — `conversationHistoryDays: 180`, `reportEvidenceDays: 365`, and the three outcomes. | — |
| **C-41** | Message body capped at 4000 characters, may not be blank | `communication.md` §3 | **Correct.** `MAX_MESSAGE_BODY_LENGTH = 4000` (`message.ts:59`) and the blank check at `:80`. | — |
| **C-42** | Evidence retention 30 / 180 / 2555 days | `identity-and-verification.md` §11 | **Correct.** `EVIDENCE_RETENTION` (`identity/src/evidence.ts:67-95`) — `biometricArtefactDays: 30`, `derivedExtractDays: 180`, `accessLogDays: 2555`. | — |

The pattern across the six is consistent and worth stating once: **where a spec
describes a mechanism, the code usually has it** (C-37 through C-42 are all
clean, and the retention, taxonomy, and limit numbers are exact). **Where a
spec describes a *registry*, *identifier*, or *per-item enumeration*, the code
usually does not** — C-33 (notification kinds), C-34 (idempotency keys), C-35
(the removed-capability set), and the analytics catalogue in §4.2a are the same
defect four times over: a spec that enumerates 20–55 items against a code that
carries 7 categories or 20 registered names, with nothing on either side
reconciling the two.

### 4.2c Onboarding, sessions, and the remaining spec sweeps

Verified against the source rather than taken on report.

| # | Claim | Source | Actual | Fix |
|---|-------|--------|--------|-----|
| **C-43** | Session lifetime is *"30 days rolling, refreshed on activity; idle timeout 14 days"*, and *"Concurrent sessions 10 per account; the 11th evicts the oldest and notifies the owner"* | `account-and-onboarding.md:269,272` | `SESSION_TTL_SECONDS = 15 * 60` (`platform/src/authn.ts:26`) — **15 minutes**, with the comment *"a leaked access token is useless within a quarter hour"* (`:25`). `REFRESH_WINDOW_SECONDS = 30 * 24 * 60 * 60` (`:27`) is the 30 days, but it is a **refresh window that does not slide** (`:136-137`, explicitly), which is the opposite of "rolling, refreshed on activity". The 14-day idle timeout is absent, and **no concurrent-session cap exists** — nothing counts sessions, so "the 11th evicts the oldest" is unimplemented. | The doc's "30 days" and the code's 30 days are different things that happen to share a number. Name them differently. |
| **C-44** | Verification copy tells the user *"you can retry as often as you like"*, and acceptance A2 says *"the attempt is allowed with no cooldown and no capability loss"* | `account-and-onboarding.md:411,583` | `ATTEMPT_POLICY` (`identity/src/verification-request.ts:185-192`) sets `maxAttemptsPerDay: 5` and `retakeCooldownMinutes: 15`, enforced at `:263-268` and `:345-352` with `rate_limited`. The doc's own rate-limit table (`:437-445`) has **no verification-attempt row** — its "Verification code attempts / 5 per issued code" is a contact-channel OTP limit, not a selfie-attempt limit. | The user-visible string "Try again now" is backed by a policy that will refuse it three times. Either the copy or the cap is wrong; the copy is the one a real person reads. |
| **C-45** | Verification-outcome notifications are a **non-suppressible** class: *"A user cannot opt out of being told that verification passed, failed, needs review, or expired"* | `notifications.md:47-52` | `NON_SUPPRESSIBLE_CATEGORIES = ['safety', 'account']` (`platform/src/notifications.ts:31`). There is no `verification` category, so the four critical verification notices have no category that maps to critical. Filing them under `system` makes them suppressible. | §2.1 rule 2 is unimplementable without a new category. |
| **C-46** | Block separation: *"No push/in-app notification generated by the pair is delivered to either side"* | `user-safety-controls.md:107`; suppression reasons at `product-quality-and-measurement.md:217` | `SuppressionReason` (`notifications.ts:67-72`) is `user_preference`/`quiet_hours`/`channel_muted`/`channel_unavailable`/`duplicate`. No `block_separation`. `planNotification` takes only `{request, preference, availableChannels}` (`:137-140`) — **no input carries a block edge at all**, so the most safety-relevant suppression in the spec is unrepresentable. | This is the code-side gap behind "blocked users get no notifications". |
| **C-47** | Notification channels are `push`, `email`, `in_app`; non-critical email is a **digest**, and non-critical push is *"deferred, not dropped"* | `notifications.md:339,355-358` | `NotificationChannel` includes `sms` (`notifications.ts:11`) and `safety: ['in_app','push','email','sms']` (`:36`) — the only category with it. `CATEGORY_CHANNELS` (`:33-45`) makes email **structurally forbidden** for `like`/`message` rather than deferred, and `planNotification` rejects any pair not in the table (`:145-150`). `deliverAt: request.now` (`:194`) confirms there is no defer path: quiet hours **suppress** (`:180-186`). | An unauthorised fourth channel, and digest modelled as a prohibition instead of a schedule. |
| **C-48** | Profile completeness thresholds: displayName ≤ 40, bio ≥ 30 chars, **≥ 1 photo** (*"One is enough to enter discovery"*), **exactly 2** answered prompts, plus required `interests` (3–8), `datingIntent`, `pronouns`, and `intentDetail` | `profile-and-personalization.md` R1/R3/R5/R7 and the field inventory at `:63-76` | `PROFILE_REQUIREMENTS` (`dating/src/profile.ts:59-67`) is `maxDisplayNameChars: 50`, `minBioChars: 20`, `minPhotos: 3`, `minAnsweredPrompts: 1`. The code is looser on three counts and **3× stricter on photos** — it rejects every 1- and 2-photo profile the spec says is valid. `ProfileContent` (`:91-101`) has no `interests`, `datingIntent`, `pronouns`, or `intentDetail` field, and the code *adds* a requirement the spec never lists: a resolvable `location`. `MissingProfileField` (`:69-76`) is 7 values against the spec's 13-row inventory. | The spec and `docs/architecture/dating-core.md:62-68` disagree with each other; the architecture doc matches the code, so the feature spec is the outlier — as with C-14, C-21, and C-39b. |

Two things the sweep got wrong that are worth recording so nobody chases them:

- **The messaging send path has no identity gate, and that is not a divergence.**
  `SEND_CHECKS` contains no identity check and `CommunicationDependencies` carries
  no identity projection — but `docs/architecture/communication.md` never claims
  one, and a match can only exist between two people who were both discoverable
  at match time. Correct the *feature* spec if it claims otherwise; the
  authority document is silent and silence is not a contract.
- **`ReportReason` is not wrong.** I initially marked the report taxonomy clean
  by generalising from `moderation-enforcement.md`; `user-safety-controls.md`
  disagrees. See C-39b — the correction is recorded rather than quietly fixed.

### 4.3 Capability names vs `CAPABILITIES_BY_ACCOUNT_STATE`

**The table itself is transcribed correctly.** §4.1 of
`account-restrictions-and-reverification.md:79-82` matches
`core/src/states/account.ts:52-66` name-for-name and set-for-set, and
`preferences-and-discovery.md:312`'s claim about the banned set
(`report`, `appeal_request`, `delete_account`) is literally exact. Every
capability name invoked by any of the ten specs exists in the table. The
divergences are all *around* the table (B-1, C-25, C-26), not in it.

One under-tested coupling: `discovery.ts:111-115` catches `suspended` only
because `CAPABILITIES_BY_ACCOUNT_STATE.suspended` omits `browse_discovery`
(`account.ts:64`) — the rule depends on a moderation table dating does not own.
If a future moderation change gives `suspended` accounts `browse_discovery`,
discovery silently starts serving suspended users. No test guards it.

### 4.4 Dead links and missing documents

- **M-1 (Minor).** `docs/README.md:54` links to `./research/agent-workflow-research.md`. The file does not exist. It is the only dead relative link in `docs/` or either README — I checked all 108 of them, and the other 107 resolve.
- `docs/README.md`'s feature table lists all ten specs; all ten exist. The domain-design table lists all six; all six exist (they are the six untracked files from this delivery). The ADR table lists five; all five exist. No document referenced by the doc map was never written.

### 4.5 Unbacked "this is tested" claims

Named in the docs as test obligations, with no test and, in each case, no code.

| Claim | Site | Reality |
|---|---|---|
| A pass expires at 30 days (A7) | `preferences-and-discovery.md:427-434` | No window code (C-20). |
| `discovery.page_served` `poolBucket` thresholds `<10` / `1-9` against a page size of 10 | `preferences-and-discovery.md:296-303,365` | Neither the constant nor the bucketing nor the page size exists. `discovery.test.ts:189-194` asserts a **1-card** page. |
| The 200-examination cap and `budget_exhausted` (A14) | `preferences-and-discovery.md:348-352,470-477` | `grep budget_exhausted` repo-wide: zero. |
| M2 — "a match never silently vanishes" | `likes-and-matching.md:273-275`, A9/A14 | No standing data structure (C-18). |
| 2 of 4 M1 test obligations | `likes-and-matching.md:178-181` | *"a like, pass, like sequence producing exactly one match"* is unimplementable (C-16); *"a match attempt against a pair with an open match producing a no-op"* — `deriveMatchId` (`interaction.ts:112-115`) has no episode component and `resolveMatch` never inspects an existing match, so calling it twice returns `match_created` twice with the same `matchId`. The invariant holds by the accident of a deterministic id, which is the opposite of the spec's *"the guarantee must be visible in the storage design rather than hoped for in application code."* |
| *"No test fixture that asserts a page size of 10 without also asserting that every card passed the full rule list"* | `preferences-and-discovery.md:339-341` | No test asserts a page size of 10. The prohibition is trivially satisfied. |
| §8.2 cross-device capability equivalence | `account-restrictions-and-reverification.md:363` | The doc *offers* this test. It does not exist. `capabilityGrantFor` is a pure rebuild; freshness is the caller's problem and is specified nowhere. |
| D4 *"push tokens are bound to the account, not the device"*; D5 *"revoking a device logs the user out everywhere"* | `account-restrictions-and-reverification.md:368-369` | No token model, no device identity, no such capability anywhere in `platform/src`. |
| §9.3 `appeal_request` as *"a real and recorded intake — not a stub"* | `account-restrictions-and-reverification.md:~405-423` | `appeal_request` appears in exactly two places repo-wide: the capability table and one test assertion that it is granted. `case.ts:88-89` says the entry point *"is the entry point a future appeal flow will use; today only a moderator may take it."* |
| §8.5 *"a suspended or banned user's profile must not be reachable through any surface… the test is enumerating the surfaces"* | `account-restrictions-and-reverification.md:373-379` | Exactly one surface exists: discovery. `isVisibleInProduct` has **zero call sites** outside `core/src` and one test. The spec's own meta-test is missing. |

### 4.6 Smaller drifts, recorded so they are not re-found

- **M-2.** Three distance-band vocabularies: the spec's "1, 5, 15, 50, 100" (matches nothing), `dating/src/location.ts:21` (`lt_5_km`…`gt_100_km`, edges 5/25/50/100), `platform/src/location.ts:14` (`same_area`…`distant`, edges 8/40/160). The two **code** vocabularies are the real hazard: nothing converts between them, and `isWithinDistanceLimit` does `DISTANCE_BAND_BOUNDS[band].minKm` on a `Record` keyed by dating's names — a platform band reaching it is `undefined.minKm`, a **runtime `TypeError`**, not a compile error, because the unions are structurally unrelated. `packages/dating/test/location.test.ts` exercises only the dating module. The two architecture docs are each self-consistent about their own module; the feature spec is the third voice.
- **M-3.** `isWithinDistanceLimit` admits a band when its **lower** bound fits, so a `maxDistanceKm: 50` serves the `50_100_km` band — a candidate up to 100 km away under a "within 50 km" preference. This is the privacy-preserving direction and `dating-core.md:285-288` documents it deliberately; `preferences-and-discovery.md:169` (P3) describes the opposite, and its own §6 widen action is *"Include everyone within 50 km"* — the exact case that over-serves. No test pins the boundary (`discovery.test.ts:162-166` tests `25` against `50_100_km`, where both readings agree).
- **M-4.** 27 committed build artefacts (`*.js`, `*.d.ts`, `*.map`) live inside `packages/core/src/` and `packages/core/test/`, duplicating `dist/`. They are currently in sync (`diff packages/core/src/states/account.js packages/core/dist/states/account.js` → identical), and `package.json` points `main` at `dist/`, so nothing resolves to the wrong copy today. But `tsc --build` will not regenerate them (they are outside the project reference graph in the way that matters), so they will silently rot. Remove and gitignore.
- **M-5.** The two packages that share a concern share nothing else. `packages/core/src/states/account.ts:4` says in prose that moderation owns account standing, and `moderation-enforcement.md` §2 and `00-overview.md` §3 agree — but nothing enforces it. `moderation/src/decision.ts` is the only writer of `AccountState` in the repo, and that is convention, not structure: any future package can call `accountMachine.next` with a valid case id and a moderator id, exactly as `applyDecision` does. A type-level or lint-level assertion that `accountMachine` has exactly one consumer would make commitment 2's *single-sourcing* half structural rather than agreed. Related: `discovery.ts:111-115` catches `suspended` only because a moderation table it does not own omits `browse_discovery` (see §4.3).
- **M-6.** `platform.md:229` says the coordinate-free projection is "checked at compile time in `test/location.test.ts`." The test exists; the `NotAKey<>` assertion the sibling `read-model.test.ts` uses is not present there. The property holds; the stated mechanism is overstated.
- **M-7.** `trust-safety.md:143-146`'s safety argument about `threshold_crossed` is written against a table that does not exist. See **B-4** — this is the one that is not cosmetic.
- **M-8.** `moderation-enforcement.md:317` says `AuditLog` has *"append and four read projections"*; `moderation/src/audit.ts:8` (the module comment) says *"append and three read projections"* in its own module comment while declaring four (`byActor`, `bySubject`, `byEntity`, `forCase`). The doc is right, the code comment is wrong.
- **M-9.** `account-restrictions-and-reverification.md:~478` (§12) says the account model is a strict ladder. `suspend` is `from: ['active','limited']` (`account.ts:40`), so `active → suspended` is a legal single step. The open question is written against a model the table does not have.
- **M-10.** `dating-core.md:296-300` §8 ("Interaction with identity and account restrictions") describes a handler that raises `hide` on a standing change. No such handler exists in `packages/dating`. This is a genuine unimplemented section, not a contradiction — but it is the section the two feature specs' action-time re-check obligations (§4.2 C-25) depend on.
- **M-11.** `likes-and-matching.md:22` gives the pass window's *definition* to `#11 §5.2`, and `preferences-and-discovery.md:332-335` gives the pass's *lifetime* to #12. Neither document resolves whether a pass is a viewer's-own fact or a pair-level fact. `preferences-and-discovery.md:164` R6 is strictly viewer-own; `dating/src/interaction.ts:186-192` treats a pass as pair-level. Two tests in the suite assert opposite halves, and nothing composes them.

---

## 5. What must not be lost

These are load-bearing. A refactor that removes any of them re-opens a commitment.

1. **`evaluateEligibility`'s post-loop identity re-check** (`dating/src/discovery.ts:195-197`) and the injectable `rules` parameter that makes it testable. Without it, commitment 1 is a table row that a well-meaning edit to the rule list can delete. The empty-table test at `discovery.test.ts:76-88` is the thing that keeps the guarantee honest — do not let it be "simplified" into a loop-count assertion.
2. **`defineStateMachine`'s first-match resolution, and the fact that it has no shadow detection.** `transition.ts:60-64` silently drops every later matching row. B-4 is what that costs. The fix is to make shadowing *fail* — `assertMachineIsTotal` is the right home for that check and is the one thing in the kernel that should get stronger rather than be left alone.
3. **`isDiscoverableIdentity` as the single definition of discoverability**, and `IdentityStatusProjection.discoverable` being *derived* from it (`identity/src/read-model.ts:63`) rather than computed a second time.
4. **`IdentityStatusProjection`'s omissions, enforced at the type level.** `read-model.test.ts`'s `NotAKey<…, 'evidence'>` family is a compile error, not a review comment. Same for `trust-safety/test/type-guarantees.test.ts`'s `Equals<keyof DetectorContext, 'now'|'observations'|'priorSignals'>` and the `EnforcementVocabulary` `Forbidden<>` checks. These three files are the only mechanism that makes commitments 1, 2, and 7 structural rather than aspirational, and they are the first thing a "simplify the tests" pass would delete.
5. **`containsUserContent: false` as a literal type** in `communication/src/signals.ts:104-110`. A boolean field would compile; a literal makes the claim inexpressible-if-false.
6. **`ReversibleFriction.reversible: true` and `FrictionProposedPayload.reversible: true` as literals**, and `FRICTION_KINDS` as a closed three-element record with per-kind `minRiskState` and `ttlHours`. That record is the *entire* authority surface of automation and is answerable by reading one block.
7. **`TrustSafetyEventSensitivity = 'internal'`** (`trust-safety/src/events.ts:24`). Narrowing it to include `'public'` is a compile error at every builder, which is the point.
8. **`MatchEndedPayload.conversationRetained: true`** (`dating/src/events.ts:67`) and the conversation machine's *absence* of a delete-transition. Commitment 4 is enforced by a shape, and both are easy to break by adding a field.
9. **`reportMachine` having no `action`/`dismiss` edge from `submitted`.** A report is triaged before it is worth a moderator's time, and the table is the only thing saying so.
10. **`toIdentityRecord`'s `latestVerificationId: null`** — noted in the brief as intended, and it is load-bearing in a second way: it keeps `toIdentityRecord` a total function of the projection, so a consumer can call `isDiscoverableIdentity` without a second round trip *and* without the leak.
11. **`RawCoordinate` being unexported.** Verified genuine in the emitted `.d.ts`. It is a two-word design decision doing the work of a whole access-control layer, and any "let's just export that" convenience edit removes commitment 5's structural half silently — the compiler will not complain, because nothing in the package fails to compile when it is exported.
12. **`UNRESTRICTABLE_CAPABILITIES` existing at all** — while being moved (B-1) from `platform` to wherever removals are actually accepted. The invariant is right; it currently lives in the wrong package, and `account-restrictions-and-reverification.md:36`'s "read, never restated in code" makes the second-home problem a documented violation rather than an accident.

---

## 6. Recommended order

1. **B-1** — move the unrestrictable filter to where `applyDecision` validates, and apply it to the published payload. One file, one array, one test.
2. **B-2** — compare `requester.actorId` to `subjectId` for `kind: 'subject'`, and record who asked. The type already carries the field; it is simply unchecked.
3. **B-4** — delete or reorder `risk.ts:44`, then fix `trust-safety.md:143-146` to describe what the table actually does.
4. **B-3** — add `moderatorId` to `lift_restriction`'s guard and to `PROTECTED_ACTIONS`.
5. **C-1/C-2** — pick one spelling for the identity status event, fix the catalogue and the `AUDIT_REQUIRED_TYPES` duplicate in the same commit. Six specs and one codebase currently disagree on a string that gates discovery.
6. **C-11** — `CONTENT_BEARING_TYPES` currently protects nothing because none of its four strings is ever emitted. One-line rename per entry, one test.
7. **C-13/C-14** — decide whether a like supersedes a pass. The machine and the resolver already disagree, which is the real bug; the doc disagreement is downstream of it.
8. **C-20** — decide whether a pass is permanent or 30 days. Both specs say 30; the code says permanent; the difference is a user's dating life.
9. **M-2** — reconcile the two `DistanceBand` unions or add a converter. As written, a platform band reaching `isWithinDistanceLimit` is a runtime `TypeError`.
10. **C-19** — either publish `removedCapabilities` or drop the `{capability_line}` promise. Right now the spec's user-facing explanation cannot be generated from the event the spec also designed.
11. **§4.2a** — reconcile the measurement spec's 55 event names with the 20 that are registered. The spec is the more detailed document and the code is the more enforced one, and on this axis the code is right: an unregistered name is refused at the sink. Registering the missing names is a diff in `ANALYTICS_EVENTS`, which is exactly what the spec says it should be.
12. **C-25(b)** — move the block check into `recordLike`. Today the guarantee that you cannot like across a block is a `interactionMachine.can` assertion that the writer is not required to pass through.
13. **B-7** — declare `@been-there/core` in `identity`, `communication`, and `platform`, and add `packages/integration` to the root `tsconfig.json` references. Both are one-line changes that remove a class of machine-dependent failure.
14. **B-9** — give moderation's sixteen audit actions a policy entry each, or make `AuditAction` a single shared vocabulary in the kernel. Nine of them throw today, and TypeScript cannot see the gap.
15. **B-10** — add `moderation.` to `AUDIT_REQUIRED_PREFIXES`, or rename the moderation events to the `case.` scheme the prefix list assumes. The router is currently discarding the entire moderation domain's safety record.
16. **C-44** — reconcile the verification retry copy with the five-per-day cap. This is the only finding on this list where a real user reads both halves of the contradiction.
