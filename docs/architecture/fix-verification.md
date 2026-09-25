# Fix verification — is the fix pass real?

> Adversarial pass over the Resolution section of
> [`review-findings.md`](./review-findings.md), which claims that the six
> Blocker findings closed in #19, the remaining Major and Minor findings closed
> in #25, and the identity spine event spelling closed in #29.
>
> Authority for the eight commitments remains
> [`00-overview.md`](./00-overview.md). This document records findings and
> fixes nothing.
>
> **Method.** `npx tsc --build` (clean, exit 0) before every conclusion, then
> `make check` end to end: typecheck, per-package test typecheck,
> **717 tests in 47 files, all passing**, doc links, research tool, stale
> artefacts, lockfile, CI parity. `make seed-verify` also passes
> ("8 users, 3 risk assessments, 2 cases, 18 audit records"). Every behaviour
> claim below was produced by a probe script in `/tmp` importing the built
> `dist/` artefacts, not by reading prose. Probes are quoted inline so they can
> be re-run.
>
> One caveat inherited from the baseline: cross-package imports resolve to
> `dist`, not `src`. Every probe here was run after a fresh `tsc --build`.

---

## 1. The claimed fixes

| # | Claimed fix | Verdict | Probe and result |
|---|-------------|---------|------------------|
| 1 | A restriction cannot strip `report`, `block` or `delete_account` — enforced at the intake valve **and** where the grant is computed | **holds** | `capabilitiesFor(s,{removedCapabilities:['report','block','delete_account','send_message']})` for all four states returns every one of the three floor entries. `applyDecision` refuses each by name. Two independent layers, as claimed. One cosmetic defect in the order — see Minor 11. |
| 2 | `lift_restriction` requires a moderator | **holds** | `accountMachine.next('limited','lift_restriction',{caseId:'c1'})` → `validation_failed`; with `moderatorId` → `active`. `applyReversal` with `moderatorId:null` → *"automation never enforces: a decision requires a named moderator"*. |
| 3 | A shadowed transition row (B-4) | **holds** | `riskMachine.next('high','threshold_crossed',{})` → `{ok:true,value:'critical'}` (was `high`). `legalEvents('high')` returns `'threshold_crossed'` **once**. The reordering plus the duplicate-event test both landed. |
| 4 | A user cannot demand another user's re-verification; the check is ordered first and leaks nothing | **holds** | `requestReVerification({subjectId:'VICTIM',reason:'user_requested',requester:{kind:'subject',actorId:'ATTACKER'}})` → `permission_denied`, `details` = `{requester:'subject', reason:'user_requested'}` — no subject id, no state, no history. The refusal precedes the eligibility, open-attempt, cap and cooldown checks. The refusal log records the attempt. |
| 5 | The identity machine cannot be walked out of human review | **partially holds** | `reverify_requested` is no longer reachable from `review_required` (all eight events probed: every one `invalid_transition`). But `withdraw` is an unguarded, `from`-less transition and `review_required --withdraw--> unverified`. See **Blocker-adjacent Major 5**. |
| 6 | Passes expire after 30 days; a like supersedes the liker's own pass; a counterpart's live pass still refuses | **partially holds** | Expiry: `critical` — pass, day 29 `already_passed`, day 30 and 31 eligible; `resolveMatch` at day 30 → `match_created`. Counterpart asymmetry: correct. **Supersession is not wired** — see **Blocker 1**. |
| 7 | `account_state.changed` publishes `removedCapabilities` and carries no case reference | **holds** | Payload: `{"accountState":"limited","capabilities":["browse_discovery","report","block","edit_profile"],"removedCapabilities":["send_message"]}`. No key matching `/case\|decision\|moderator\|reason/i`. Sensitivity `public`; the case id leaves only on `moderation.restriction_applied` at `user`. |
| 8 | The moderation audit sink accepts all sixteen actions and returns a `Result` | **holds, with a caveat** | `AUDIT_ACTIONS` has 37 entries; all 16 moderation actions classified `restricted`; `InMemoryAuditLog.append` returns `Result` and refuses an unclassified name with `validation_failed`. Caveat: this sink has **no production caller** — see **Minor 12**. |
| 9 | Every consumed event has a producer, checked by `event-contracts.test.ts` | **holds** | The test passes and is not vacuous: instrumenting `PUBLISHED` shows the real identity event *values* (not the record keys) are in the set, and `orphans = []`. I checked a stronger property the test does not: **all 36 published names appear literally in some `src/` file** — no declared-but-unemitted event. |
| 10 | Automation cannot enforce or reverse | **does not hold** | `applyDecision` is exported from `packages/moderation/src/index.ts` and accepts `moderatorId:'system'`. `escalateCase` and `reopenCase` never call `canWorkCase`. See **Blocker 2** and **Blocker 3**. |
| 11 | The event router no longer drops moderation events; an unroutable event is reported | **holds** | `routeEvent` returns `{audit,analytics,rejection}` with `'content'`, `'audited_only'` or `'unroutable'`; `'moderation.'` is in `AUDIT_REQUIRED_PREFIXES`. All 14 moderation event types route `{audit:true,analytics:false,rejection:'audited_only'}` except the content-bearing ones. |
| 12 | Three packages declared `@been-there/core` (B-7) | **holds** | `scripts/dev/check-workspace-lockfile.mjs` runs in `make check` and passes on 8 workspace packages. |
| 13 | `UNRESTRICTABLE_CAPABILITIES` is one list, in `core` (B-11) | **holds** | Defined once at `packages/core/src/states/account.ts`; `platform/src/authz.ts` re-exports it rather than restating it. `rg` finds exactly one `= [` definition. |
| 14 | `MatchRecord` carries per-party `standings` instead of a single `status` | **partially holds** | The type, the derivations and two end-transitions are right. But **nothing computes the degraded rows** — `deriveMatchStandings` has zero callers and zero tests. See **Major 4**. |
| 15 | A 21-row notification registry exists; `verification` is a non-suppressible category; blocked-pair suppression is representable | **partially holds** | 21 kinds, `NotificationCategory` derives from them, block suppression and the missing-edge refusal both work, and the "every channel is a subset of the in-app record" invariant is genuinely enforced by an exhaustive test. But see **Major 8** and **Major 9**. |
| 16 | The §4.2a analytics catalogue holds only events with a producer | **holds** | `CONTENT_BEARING_TYPES` is one name, `communication.message_sent`, which is the name communication actually publishes. Sample rates live in the catalogue. |
| 17 | B-5 — no producer for the trust-safety `Observation` vocabulary | **still open** | `OBSERVATION_KINDS` has ten entries; nothing in any `src/` constructs an `Observation`. The baseline review's own verdict is accurate. |
| 18 | B-6 — no counterpart-side messaging check | **still open** | `CommunicationDependencies` is `{match, blocking, senderStanding}`. `SEND_CHECKS` rule 6 reads `dependencies.senderStanding.capabilities` only. A `limited` counterpart can still send. The baseline review's verdict is accurate. |

### Probe transcripts for the rows that are not clean

```
$ node /tmp/btprobe/p1.mjs          # like after pass
recordPass:          [ [ 'pass-a-b', 'live' ] ]
recordLike A->B ok?  true [ { likeId:'like-a-b', …, state:'live', supersededPassId:'pass-a-b' } ]
resolveMatch with passes as recordLike saw them:  {"outcome":"match_refused","reason":"passed"}
resolveMatch after manual supersedePasses:        {"outcome":"match_created"}
```

```
$ node /tmp/btprobe/p3.mjs          # automation
assignCase by bot:            permission_denied: automation may not work a case
startCaseReview by bot:       permission_denied: automation may not work a case
escalateCase by bot:          OK                     <-- no canWorkCase
reopenCase (ctx fn) by bot:   OK                     <-- no canWorkCase
decide by bot:                permission_denied
reverseDecision by bot:       permission_denied
```

```
$ node /tmp/btprobe/p4.mjs
applyDecision with moderatorId="system":  {"action":"ban","mod":"system","state":"banned"}
```

```
$ node /tmp/btprobe/p6.mjs          # identity machine from review_required
review_required  ["review_cleared","review_confirmed_fraud","withdraw"]
reverify_requested  plain/conf/reviewer: invalid_transition
provider_result_received / expire / submit_verification / flag_for_review / fail
                      plain/conf/reviewer: invalid_transition
withdraw            plain/conf/reviewer: unverified
```

---

## 2. New problems introduced by the fixes

Ranked Blocker / Major / Minor. Every one has a reproduction I ran.

### Blocker 1 — a like still does not supersede the liker's own pass; the fix exists only in a helper nothing calls

**Where.** `packages/dating/src/passes.ts:62` (`supersedePasses`),
`packages/dating/src/likes.ts:166` (`recordLike`),
`packages/dating/src/interaction.ts:224` (`resolveMatch`).

The Resolution claims: *"The liker's own pass is now superseded by their
like."* It is not. `recordLike` finds the pass it overrode and writes the pass
id onto the like — `supersededPassId: 'pass-a-b'` — and then returns. It never
touches the pass record, which is still `state: 'live'`. `supersedePasses`, the
function that *does* change the state, has **no caller anywhere in `src/`**:

```
$ rg -n supersedePasses --glob '!dist' --glob '!node_modules' .
packages/dating/test/interaction.test.ts:19
packages/dating/test/interaction.test.ts:263
packages/dating/test/interaction.test.ts:315
packages/dating/src/passes.ts:62
```

**Reproduce** (`/tmp/btprobe/p1.mjs`): A passes B, A likes B, B likes A, then
`resolveMatch` with exactly the pass array `recordLike` was given:

```
resolveMatch … {"outcome":"match_refused","reason":"passed"}
```

The like record claims it superseded a pass that is still live, in the same
data set. Two things break:

1. `resolveMatch` refuses, so a mutual like after one side passed never
   produces a match — the behaviour the Resolution names as the reason the
   review was wrong.
2. Discovery rule `already_passed` (`packages/dating/src/discovery.ts:144`) uses
   the same `isPassInEffect`, so the passer is not shown the candidate for 30
   days either. In the product, they never get to like at all.

**The test asserts the helper, not the property.**
`packages/dating/test/interaction.test.ts:294` — *"matches once the passer
likes, because the like supersedes their own pass"* — composes the two steps
itself:

```ts
const afterLike = supersedePasses([passerPass], A, B);
expect(afterLike[0]?.state).toBe('superseded');
const result = resolution({ …, passes: afterLike, at: LATER });
expect(result.outcome).toBe('match_created');
```

Deleting `supersedePasses` fails the suite, so the suite "protects" a function
the product does not call. The composition belongs in `recordLike` (which
already computes the same `isPassInEffect` predicate) or in the command that
pairs the like with the pass list.

The development dataset does not cover it either: `scripts/seed/dataset-steps.mjs`
passes `passes: []` at lines 291, 301 and 328, so `make seed-verify` never walks
this path.

### Blocker 2 — `applyDecision` is a public export with no human check; automation can ban

**Where.** `packages/moderation/src/decision.ts:133`, re-exported by
`packages/moderation/src/index.ts:8`.

`canWorkCase` refuses `actor.automated`, and `decide`/`reverseDecision` both
call it. `applyDecision` and `applyReversal` are exported too and call only
`validateAuthority`, which requires a **non-null** `moderatorId` and nothing
else. `DecisionCommand` has no `automated` field at all.

```
$ node /tmp/btprobe/p4.mjs
applyDecision with moderatorId="system":  {"action":"ban","mod":"system","state":"banned"}
applyDecision restrict by "svc-pipeline": "limited"
```

This is the exact shape of B-1, which the fix pass correctly diagnosed as "a
floor enforced only where a removal is *accepted* is one package too
downstream". The same argument applies to the human check and it was not made:
the guard is in the orchestrator, and the function that produces the
`Decision` value — the thing an appeal is answered from — is callable without
it. A service that already holds a `caseId` (every intake path mints one, and
`openCase` is callable with `openedBy: 'system'`) can produce a ban.

**Compounding it:** `ModeratorActor` (`packages/moderation/src/evidence.ts:251`)
is an unbranded interface whose `automated: boolean` is set by the caller. Its
own comment concedes this — *"A non-null actor id is not evidence of a human:
any service can mint an id. Only this flag distinguishes them"* — but the flag
is a self-declaration, so commitment 2 is currently **advisory at both
entrances**, not enforced at either.

### Blocker 3 — `escalateCase` and `reopenCase` bypass `canWorkCase`

**Where.** `packages/moderation/src/case.ts:491` and `:531`. `assignCase`
(`:404`) and `startCaseReview` (`:452`) call it; these two do not.

```
$ node /tmp/btprobe/p3.mjs
escalateCase by bot:            OK
reopenCase (ctx fn) by bot:     OK
```

An `automated` actor — the exact actor `canWorkCase` refuses everywhere else —
can escalate a case and can reopen a resolved one. `reopenCase` also nulls
`resolutionDecisionId` on the case, so the pointer from a case to the decision
that resolved it is erased by a caller the code elsewhere calls a machine.

Neither changes an account standing, so this is not "automation enforcing" in
the narrow sense. It is the same class as B-3 (which was rated Blocker for a
one-line missing `moderatorId`): a case-state transition reachable by
automation that the code elsewhere declares impossible. `reopenCase` also emits
**no event at all** (see Major 6) while writing a `case.reopened` audit row.

### Major 4 — the per-party `standings` redesign is unwired; a banned counterpart leaves the record reading `active`

**Where.** `packages/dating/src/read-models.ts:144`.

`MatchRecord.standings` is a well-designed replacement for a single `status`,
and `deriveMatchStandings` is the function that makes it mean anything: it
recomputes both entries from live standing projections, so a counterpart whose
verification lapsed or who lost `browse_discovery` degrades *their* party's row
only. It has **no caller and no test**:

```
$ rg -n deriveMatchStandings --glob '!dist' --glob '!node_modules' .
docs/architecture/dating-core.md:179   "deriveMatchStandings(match, standingOf) computes the four degraded rows from …"
packages/dating/src/read-models.ts:144
packages/dating/src/read-models.ts:157  (its own throw)
```

The only writers of `standings` are `resolveMatch` (both `active`),
`applyBlockToMatch` and `unmatch`. Nothing recomputes them. So the four degraded
states (`dormant_target_unverified`, `restricted_by_target`, `closed_by_target`
by moderation) are unreachable in the data, and the asymmetry the redesign was
made for — "an implementation that filtered a match list by the target's
current standing would make a moderated removal look identical to a mutual
unmatch" — is exactly what still happens.

`docs/architecture/dating-core.md:179` documents the function as if it were
live, so the doc and the code disagree in the direction that reads as coverage.

### Major 5 — `withdraw` walks an account out of `review_required`

**Where.** `packages/core/src/states/identity.ts:73`.

```ts
{ event: 'withdraw', to: 'unverified' },
```

No `from`, no `guard`. The fix pass closed `reverify_requested` and left this
one open. The kernel's own note on `reverify_requested` says *"A flagged case
leaves review only through `review_cleared` or `review_confirmed_fraud`"* — that
is false:

```
$ node /tmp/btprobe/p6.mjs
review_required + withdraw (no context) => unverified
```

`requestReVerification` adds a `review_required` refusal at
`packages/identity/src/reverification.ts:328`, but the kernel edge it is
described as backing up is not what is needed here: the machine itself is
reachable. Nothing calls `withdraw` on this machine in any `src/` file, so it
is currently a declared capability with no owner and no guard. The correct
shape is `from: ['unverified', 'pending', 'expired', 'verification_failed']`
with the two `review_required` edges left as the only way out.

### Major 6 — one moderation event, two payload shapes, and a reopen nobody can see

**Where.** `packages/moderation/src/case.ts:471` versus `:428`.

`EmitSpec<P>` is generic and `MODERATION_EVENT_TYPES` types names only, so no
payload shape is checked. Probe over a full report → triage → case → assign →
review walk:

```
$ node /tmp/btprobe/p8.mjs
 1 moderation.case_assigned :: assignedModeratorId,caseId
 1 moderation.case_assigned :: caseId,state
types with >1 payload shape:  moderation.case_assigned -> [ 'assignedModeratorId,caseId', 'caseId,state' ]
```

`startCaseReview` reuses `moderation.case_assigned` and swaps the payload for
`{caseId, state}`. A consumer that reads `payload.assignedModeratorId` gets
`undefined` on a review-start and cannot tell an assignment from a review
beginning. There is no `moderation.case_review_started`, and no test pins the
payload of any moderation event.

Separately, in the same probe: `reopenCase` returns `ok` and publishes **zero
events** — there is no `moderation.case_reopened` in
`MODERATION_EVENT_TYPES`, so a reopen is invisible on the bus while writing a
`case.reopened` audit row and clearing `resolutionDecisionId`. `escalateCase`
does publish `moderation.case_escalated`; the asymmetry looks accidental.

### Major 7 — `NotificationContentToken` constrains the catalogue and nothing else

**Where.** `packages/platform/src/notification-catalogue.ts:45`.

The claim is: *"There is no message-text token, and that absence is the
guarantee: a template cannot render a message body because the vocabulary it
binds against has no word for one."* Half of that is real — the catalogue is
`as const satisfies Record<string, NotificationKindSpec>`, so a channel can
only list tokens from the union, and
`packages/platform/test/notifications.test.ts:122` proves no listed token
matches `/text|body|excerpt|message/i`.

But nothing consumes `content`. `planNotification` never reads
`spec.channels[channel].content`; `NotificationPlan` carries no body and no
token list; there is no renderer, template type, or `render*` function anywhere
in the repository (`rg -n "NotificationContentToken"` matches only the
catalogue and its own type). So the *second* half — that a body may only bind
these facts — has no enforcing artefact. The first half (the catalogue cannot
name a message body) does.

Related: the catalogue is the only thing that exists. `rg` over `packages/*/src`
finds no emitter for **any** of the 21 kinds; `planNotification` takes `kind`
as a caller parameter. A 21-row registry with 0 producers is a vocabulary, not
a registry. That is defensible for a contracts-only repository, but it should
be said in the document rather than implied by the row count.

### Major 8 — "a verification notice is non-suppressible" is enforced per kind, and the test hard-codes the kinds

**Where.** `packages/platform/test/notifications.test.ts:236`.

```ts
const verificationKinds = [
  'verification.passed', 'verification.failed', 'verification.rate_limited',
  'verification.review_required', 'verification.expired',
] as const;
for (const kind of verificationKinds) {
  expect(NOTIFICATION_KINDS[kind].category, kind).toBe('verification');
  expect(NOTIFICATION_KINDS[kind].critical, kind).toBe(true);
}
```

The list is written out on both sides. Add `verification.locked` to the
catalogue with `critical: false` and this test still passes, and the new kind is
muteable through `channelOptIn`. The mechanism that actually protects the five
is per-kind `critical`, checked in `planNotification` before the opt-in lookup
(`packages/platform/src/notifications.ts`, the `if (!spec.critical)` guard). The
category-wide property the Resolution claims needs an exhaustive loop over
`EVERY_KIND.filter(k => NOTIFICATION_KINDS[k].category === 'verification')` —
which is exactly the shape the neighbouring in-app-subset test already uses
correctly.

### Minor 9 — the intake valve's check order contradicts its own comment, and reports the wrong reason

**Where.** `packages/moderation/src/decision.ts:148` and `:163`.

The comment at `:159-162` says: *"Checked before the not-held check so a
capability the account does not hold **and** may never lose is reported for the
reason that actually matters."* The code does the opposite — the not-held check
is at `:148`, the unrestrictable check at `:163`. Probe:

```
$ node /tmp/btprobe/p2.mjs
report          validation_failed: a restriction may never remove report: …
block           validation_failed: a restriction may never remove block: …
delete_account  validation_failed: a restriction may only name capabilities the account actually holds: delete_account
```

No safety hole: `delete_account` cannot be removed either way, and the grant
floor holds in all four states. But `delete_account` is only in the `banned`
grant, so a moderator restricting a `limited` account gets *"the account does
not hold it"* for a capability that is **never** removable, and the one message
that explains the floor never fires for it. Swap the two blocks, or fold the
unrestrictable test into the same pass.

### Minor 10 — a stale comment states the opposite of the kernel

**Where.** `packages/identity/src/reverification.ts:330`.

```ts
// A human is already looking at this account. `reverify_requested` is
// legal from `review_required`, so without this an automated caller could …
```

`core/src/states/identity.ts:68-71` removed that edge deliberately and says so
in its own `note`. The refusal at `reverification.ts:328` is still correct and
still worth having as belt-and-braces, but the comment now justifies it with a
false premise, and the "belt-and-braces" reading is what a future reader will
take from it.

### Minor 11 — the classified audit sink is not the sink moderation writes to

`packages/moderation/src/audit.ts` defines its own 16-action `AuditAction`
union and an `AuditLog` whose `append` returns `AuditEntry` (not a `Result`).
That is the object every production call site writes through
(`ctx.audit.append` at 15 sites across `report.ts`, `evidence.ts`, `case.ts`,
`decision.ts`), and it carries **no sensitivity classification at all** — the
`restricted` classification of all sixteen actions exists only in
`packages/platform/src/audit.ts`, whose `InMemoryAuditLog` has no caller in any
`src/`.

So the fix for B-9 is real against the platform sink — all sixteen names are
classified, `append` returns a `Result`, an unknown name is a
`validation_failed` domain error rather than a `TypeError`, and
`packages/platform/test/moderation-audit-contract.test.ts` derives its list from
moderation's source so a seventeenth action fails there. But the appeal chain
that is actually written at runtime goes to the unclassified log. Whether that
is a defect depends on an unstated decision about which log ships; the document
should say which one is the system of record.

### Minor 12 — a weak floor on the critical-notice test

`packages/platform/test/notifications.test.ts:214`:
`expect(delivered).toBeGreaterThan(20)`. There are 36 critical kind/channel
pairs today, so the assertion would still pass with 16 of them reclassified as
non-critical. The per-pair assertions above it are the real check; the count is
a smoke test that has been given slack it does not need.

### Behaviour that is now stricter than intended

Checked, and the answer is: **nothing legitimate became impossible.** The three
new refusals are exactly the three the spec forbids, the floor cannot be
bypassed from any state, and naming removals on a non-`restrict` action
(`action:'suspend', removedCapabilities:['report']`) is refused by the same
valve — arguably over-strict, since a suspend takes no removals, but the
`Decision` it produces sets `removedCapabilities: []` anyway
(`packages/moderation/src/decision.ts:193`), so the refusal costs nothing.
`REVERIFICATION_POLICY.subjectMayRequestOnlyWhen: ['expired']` is a strict subset
of the machine's `reverify_requested.from` (`['verified','expired']`), as its
comment claims, and `verification_failed` is correctly absent because
`submit_verification` covers it.

---

## 3. The eight commitments, one enforcing artefact each

"Regression caught" means: a change that breaks the commitment, with no other
change, fails the named artefact.

| # | Commitment | Enforcing artefact | Regression caught? |
|---|-----------|--------------------|-------------------|
| 1 | Unverified means undiscoverable | `isDiscoverableIdentity` (`packages/core/src/states/identity.ts:85`), the single definition; `DISCOVERABLE_IDENTITY_STATE` in `packages/dating/src/read-models.ts:31`; **and the post-loop re-check** at `packages/dating/src/discovery.ts:214`, after the rule table, which is why an empty rule table still refuses | **Yes.** `packages/dating/test/discovery.test.ts:76-88` proves the property survives the rule table, which is the strongest form of this commitment. |
| 2 | Automation never enforces | Three layers: `accountMachine` guards on `caseId` + `moderatorId` (`packages/core/src/states/account.ts`, all six rows), `canWorkCase` (`packages/moderation/src/case.ts:373`), and `UNRESTRICTABLE_CAPABILITIES` at the intake valve + the grant | **No — and this is the one the product is selling.** `applyDecision`/`applyReversal` are exported and check neither `canWorkCase` nor `automated` (Blocker 2). `escalateCase`/`reopenCase` skip `canWorkCase` (Blocker 3). `withdraw` on the identity machine is unguarded (Major 5). The floor itself *is* enforced twice and would be caught. |
| 3 | Risk decays, one step | `riskMachine` decay rows, one per state, ordered so `threshold_crossed` from `high` is not shadowed; `applyDecay` (`packages/trust-safety/src/assessment.ts:220`) withdraws the friction and closes the queue entry | **Yes.** Probed at 29/30/31, 13/14/15 and 6/7/8 days: one step, no skip, one day early at the boundary. `legalEvents('high')` returns `threshold_crossed` once. Clean. |
| 4 | Unmatch does not destroy the right to report | Four mechanisms: the conversation machine has no delete transition; `submitReport` freezes a `RelationshipSnapshot`; `evidenceForReport` reads recorded interaction only; `MatchEndedPayload.conversationRetained: true` pinned as a literal | **Yes.** Probed end to end: after `unmatch`, `evidenceForReport` returns both withdrawn likes and the match id; a pair with no interaction returns `not_found`. |
| 5 | Exact location is never exposed | `interface RawCoordinate` is declared without `export` in `packages/dating/src/location.ts:28` and appears so in `packages/dating/dist/location.d.ts:26`; `CoarseLocation` has no coordinate field; `StoredAnchor.sensitivity` pinned to `'sensitive'`; `ANALYTICS_FORBIDDEN_PROPERTIES` | **Partly.** Dating is genuinely sealed by the type. Platform's `Coordinate` **is** exported (`packages/platform/src/location.ts:72`) and `quantiseAnchor` returns one, so the platform half rests on `sensitivity: 'sensitive'` plus the caller not passing it on — the same "enforced at the sink" caveat the baseline recorded, still open. |
| 6 | Domains never call each other's internals | Zero non-core cross-package imports in `src/` and `test/`; `scripts/dev/check-workspace-lockfile.mjs` in `make check` | **Yes.** Re-verified by `rg`: the only non-core imports are in `packages/integration/test/`, which exists precisely to hold cross-domain assertions. |
| 7 | Sensitive data classified per field | `ClassifiedField` demands a `sensitivity` and no constructor omits one; `redact` recurses and filters against the **destination's** clearance; `requestLogEntry` fixes an `internal` ceiling; `InMemoryAuditLog.read(clearance)` decides visibility from the reader | **Only at the sink.** A producer that forgets to classify produces a record that passes through whatever clearance the sink holds. Unchanged from the baseline. |
| 8 | Every state is a reviewable table | `defineStateMachine` for all machines; `assertMachineIsTotal`; the no-duplicate-event test added for B-4 | **Yes, with one gap.** The duplicate-row test is the right artefact and it holds. `withdraw` has no `from` and no guard — a table row that declares an edge from every state including the ones a reviewer is looking at (Major 5). |

### The two the product is actually selling

**Commitment 2** is enforced in its *sanctions* and not in its *entrances*.
Every one of the six `accountMachine` enforcement rows now requires both a case
and a named moderator, `lift_restriction` no longer differs from `lift_ban`, and
`system` holds no decision permission in `PERMISSIONS_BY_ROLE` and is refused
`account.enforce.ban` by `authorize` (probed). The floor is enforced twice, as
claimed. But the three paths that produce a state change without going through
`canWorkCase` are open, and `ModeratorActor.automated` is a self-declared
boolean, so an enforcing service is one refactor away. The commitments that
*are* caught by a test are: the capability floor, the machine guards, the role
permissions. The ones that are not: "only a human" as a property of the code
rather than of the caller's honesty.

**Commitment 4** is the cleanest of the eight. Four independent mechanisms, all
present, all probed, and the one that is easiest to break — a delete
transition on the conversation machine — is a structural absence rather than a
guard somebody can reorder.

---

## 4. Coverage gaps worth filling

Concrete test names, in the file each belongs in. Each one fails against the
code as it stands.

**`packages/dating/test/interaction.test.ts`**

1. `records the superseding of the liker's own pass, without the test calling supersedePasses` — record a pass, then `recordLike` with that pass list, then assert `passes[0].state === 'superseded'` **from the value `recordLike` returned**. Fails today; this is the test that turns Blocker 1 into a red.
2. `refuses a match while the counterpart's pass is still in effect, and creates one when only the liker's was superseded` — two cases through `recordLike` → `resolveMatch` with no manual `supersedePasses` in between. Replaces `interaction.test.ts:263` and `:315`.
3. `deriveMatchStandings: a banned counterpart closes only the other party's row` — belongs in `packages/dating/test/interaction.test.ts` or a new `read-models.test.ts`. Fails today because the function is never called from a match flow.

**`packages/moderation/test/decision.test.ts`**

4. `refuses a decision whose moderator id is a service, not a person` — this is only writable once `DecisionCommand` carries provenance, which is the point: today the test cannot be written because there is nothing to assert.
5. `reports delete_account as unrestrictable, not as not-held` — pins Minor 9 so the order cannot drift silently.

**`packages/moderation/test/case.test.ts`**

6. `refuses to escalate or reopen a case for an automated actor, exactly as it refuses to assign or review one` — one table over `{escalateCase, reopenCase} × {bot, human}`. Fails today on both.
7. `reopening a case republishes the case state on the bus` — asserts a `moderation.case_reopened`-shaped event with a `resolutionDecisionId` transition. Fails today (zero events).
8. `moderation.case_assigned carries assignedModeratorId on every emission` — or, better, a new `moderation.case_review_started` with its own typed payload.

**`packages/core/test/states.test.ts`**

9. `no identity event is legal from review_required without a reviewerId` — the exhaustive form of the `withdraw` hole. Fails today.
10. `legalEvents returns no event from no state twice, across every machine` — the B-4 test generalised from `riskMachine` to all eleven, so the next shadowed row is caught where it is introduced.

**`packages/platform/test/notifications.test.ts`**

11. `every kind in the verification category is critical` — `EVERY_KIND.filter(k => NOTIFICATION_KINDS[k].category === 'verification')`, mirroring the exhaustive shape the in-app-subset test already uses.
12. `no channel lists a content token that no renderer could bind` — currently unassertable, because nothing consumes `content`. Write it when a renderer exists; until then the token union is a catalogue constraint and the document should say so.
13. `every notification kind is planned at least once by a call site` — turns the "21 rows, 0 producers" observation into a failing test or an explicit exemption list.

**`packages/integration/test/event-contracts.test.ts`**

14. `every published event name appears as an emit site in its owning package` — the stronger property I checked by hand (all 36 do). Today's test is one-directional (consumed ⊆ published) and would not notice a new `MODERATION_EVENT_TYPES` row nobody emits.
15. `every published event has a payload shape, and one name has one shape` — the cross-domain half of Major 6.

---

## 5. What I could and could not execute

- Executed: `npx tsc --build` (clean), `make check` in full (717 tests / 47
  files, all green, plus the doc, research, stale-artefact, lockfile and CI
  parity gates), `make seed-verify`, and eleven probe scripts against the built
  `dist/` artefacts covering capabilities, decisions, reversals, case
  transitions, automation actors, the identity and risk machines, re-verification
  ordering and limits, like/pass/match resolution, unmatch evidence, session
  caps, authz roles, event publication shapes, and notification planning.
- Not executed: no database, broker, HTTP service or push/email adapter was
  started. The repository has no runtime to start — `make migrate` and
  `make seed` both refuse by design, and `seed-print`/`seed-verify` load the
  dataset in process. Every finding above is therefore about the pure domain
  layer and the CLI, which is where the fixes were made.
- Not attempted: an independent re-derivation of the analytics catalogue's 55-row
  provenance, and a line-by-line re-read of the ~80 KB of the baseline review
  beyond the Resolution table. Findings B-5 and B-6 are reported as still open
  because a direct probe of the code shows the described absence, not because
  the Resolution was taken at its word.
- One file outside my ownership was touched:
  `docs/README.md` gained a single row linking this document, because
  `scripts/check-doc-links.mjs` fails any `docs/architecture/*.md` that the map
  does not list. Without it `make check` would be red for a reason unrelated to
  the code.
