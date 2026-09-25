# Moderation & Enforcement

> Issue [#7](https://github.com/katzimoto/been_there/issues/7). Parent:
> [#1](https://github.com/katzimoto/been_there/issues/1). Contract:
> [`./00-overview.md`](./00-overview.md) — this document builds on it and loses
> to it.
>
> Executable contracts: `packages/moderation`. Every table and gate below is a
> transition table or a tested function, not a description of one.

## 1. What this domain is for

Issue #1 ends the spine with `moderation → enforcement`. This domain owns the
last two arrows, and the promise of issue #7 is a single sentence: **reported or
safety-flagged behaviour can follow a clear path from evidence to review to an
accountable decision.**

That path is four records and one gate:

```
report ──triage──▶ case ──assign──▶ review ──decide──▶ decision ──▶ account state
   │                  │                                                  │
 evidence            evidence ids                                 audit row
```

Nothing in the chain is skipped, and nothing is silent. There is no path from a
detector to an account state: a detector raises risk, a human opens or does not
open a case, and only a named moderator on a recorded case changes a standing.

## 2. Owns / never owns

| Owns | Never owns | Why the boundary is here |
|------|------------|--------------------------|
| User reports: intake, reason taxonomy, triage, status | Whether a message is abusive | Communication publishes a signal; it does not judge |
| Moderation cases: intake, priority, queue, assignment, escalation | Detection heuristics and thresholds | Trust & Safety owns what counts as suspicious |
| Evidence: capture, retention metadata, redaction, access levels | Identity evidence itself | Raw identity artefacts never enter a moderation surface |
| Moderator decisions and their rationale | Account state definitions and guards | The shared `accountMachine` in `packages/core` is the only enforcement mechanism |
| The audit log and its read projections | Detection heuristics, product eligibility | An audit log that can be edited is not an audit log |
| Reversal of a decision, as appeal support | The appeal flow (P1, v0.2) | The data model has to be right now; the flow comes later |

**Dependency direction.** This package imports `packages/core` and nothing else.
Trust & Safety, Identity, Communication and Dating Core reach moderation by
publishing events and reading projections, never by calling in. Moderation reads
their facts as a *frozen snapshot* (`RiskAssessmentId` + `RiskState` +
detector names, `VerificationId` + anomaly string) supplied at intake, and
freezes it into an evidence record — it never asks another domain what it thinks
today.

## 3. The report lifecycle

`packages/moderation/src/report.ts` — `reportMachine`.

```
                    ┌──────────┐
      triage        │ submitted│
  submitted ───────▶│          │
                    └────┬─────┘
                         │
                  ┌──────▼───────┐
                  │   triaged    │◀── the only state a moderator works in
                  └──┬───┬───┬───┘
        merge ┌───────┘   │   └────────┐ escalate
             ▼           │ action      ▼
        ┌────────┐       │ dismiss  ┌───────────┐
        │ merged │       ▼          │ escalated │
        └────────┘  ┌──────────┐   └─────┬─────┘
                    │ actioned │         │ action | dismiss
                    └──────────┘◀────────┘
```

| From | Event | To | Guard | Why |
|------|-------|----|-------|-----|
| `submitted` | `triage` | `triaged` | — | Triage is the gate a report passes before it is worth a moderator's time |
| `triaged` | `merge` | `merged` | case + moderator | A report joins an existing case under a named moderator |
| `triaged`, `escalated` | `action` | `actioned` | case + moderator + decision | A report is actioned only by a decision |
| `triaged`, `escalated` | `dismiss` | `dismissed` | case + moderator + decision | A dismissal is a decision too, and is accountable identically |
| `triaged` | `escalate` | `escalated` | moderator | Escalation is a human judgement and is recorded under a name |

`merged`, `actioned` and `dismissed` are terminal: once a report is attached to a
case, the case's decision closes it. A report is **never** actioned or dismissed
from `submitted` — the table has no such edge, and that is the point.

### Report fields

| Field | Notes |
|-------|-------|
| `reporterId` | `null` means anonymous. Anonymity never weakens the record |
| `subjectId` | Whose behaviour is reported |
| `reason` | The taxonomy below; the category alone is never the action |
| `statement` | Free text, ≤ 2000 chars; **mandatory** for `other` (≥ 20 chars) |
| `relationship` | A frozen `RelationshipSnapshot`: status, conversation, message range |
| `capturedEvidence` | Frozen at submission, never re-derived |
| `state`, `mergedCaseId` | Lifecycle |

| Reason | Priority on intake | Statement required | Person-safety |
|--------|--------------------|--------------------|---------------|
| `threats_or_violence` | urgent | no | yes |
| `non_consensual_intimacy` | urgent | no | yes |
| `minor_safety` | urgent | no | yes |
| `hate_or_discrimination` | high | no | yes |
| `unsafe_contact` | high | no | yes |
| `sexual_content` | normal | no | yes |
| `harassment` | normal | no | no |
| `scam_or_solicitation` | normal | no | no |
| `impersonation` | high | no | no |
| `fake_or_misleading_profile` | low | no | no |
| `spam` | low | no | no |
| `other` | normal | **yes** | no |

`ReportReason` is the **only** reason vocabulary: the wire format carries these
twelve names, the client renders a label beside each, and a report that arrives
with a name outside this union is not a report. There is no second, user-facing
code list — the intake menu in
[`user-safety-controls.md` §5.1](../features/user-safety-controls.md) is an
ordering and a set of labels over this table, and it offers every reason here.
That is a decision, not a convenience: a menu that omits a reason does not
remove it, it forces the member into `other` or into a near-miss reason that
triages somewhere else, and a report about unsolicited sexual content landing
in a `normal`-priority queue is worse than no menu at all.

`unsafe_contact` is the one this package gained to close that gap. "Pressured me
to move off Been There, or used my personal details" is a report about the
*channel* rather than the content, and folding it into `scam_or_solicitation`
triaged it at `normal` with no person-safety flag. It is `high` rather than
`urgent` because nothing in it is a threat, an image of a minor, or
non-consensual — the three the platform treats as immediately urgent.

### Reporting survives the relationship

`submitReport` takes a **snapshot**, not a live match id, and captures the
evidence at that moment. Once submitted, the record is self-contained. This is
commitment #4 of the overview, expressed as a parameter type: there is no code
path by which an unmatch, a conversation deletion, or an account deletion can
invalidate a report or a case built on it. Tested in
`test/report.test.ts` → *reporting after an unmatch*.

Reporting is also always available: every account state in the shared kernel
grants the `report` capability, including `banned`, because a banned user with a
genuine safety concern is exactly the person who must still reach a human.

## 4. The case lifecycle

`packages/moderation/src/case.ts` — `caseMachine`.

```
   ┌──────┐  assign   ┌──────────┐ start_review ┌───────────┐
   │ open │──────────▶│ assigned │─────────────▶│ in_review │
   └──┬───┘           └────┬─────┘              └─────┬─────┘
      │                    │                        │
      │  escalate (reason) ▼                        │
      │                ┌───────────┐ ◀──────────────┘
      └───────────────▶│ escalated │──▶ resolve
                       └─────┬─────┘
                             │
   ┌──────┐  reopen   ┌───────▼──┐
   │ open │◀──────────│ resolved │
   └──────┘  (reason) └──────────┘
```

| From | Event | To | Guard |
|------|-------|----|-------|
| `open`, `assigned`, `escalated` | `assign` | `assigned` | moderator id |
| `assigned` | `start_review` | `in_review` | moderator id |
| `open`, `assigned`, `in_review` | `escalate` | `escalated` | moderator id + a stated reason |
| `open`, `assigned`, `in_review`, `escalated` | `resolve` | `resolved` | moderator id + **decision id** |
| `resolved` | `reopen` | `open` | moderator id + a stated reason |

Each of these transitions publishes exactly one event under its own name — one
name, one payload: `moderation.case_assigned` `{caseId, assignedModeratorId}`,
`moderation.case_review_started` `{caseId, state}`,
`moderation.case_escalated` `{caseId, reason}`,
`moderation.case_reopened` `{caseId, state, clearedDecisionId}` and
`moderation.case_resolved` `{caseId, decisionId}`. A reopen used to write its
audit row and publish nothing, so a consumer watching cases could not see a
resolution pointer move; `clearedDecisionId` names the decision the reopen
detached, which is still in the record and still answerable on appeal.

Two rules carry the weight:

- **A case cannot close on a shrug.** `resolve` requires a decision id. Even a
  dismissal is a `Decision` with action `clear`, taken by a named moderator on
  the case. There is no "closed with no action" transition.
- **Every case operation is gated, not two of them.** `canWorkCase` refuses an
  automated actor, and refuses a non-lead on an `escalated` case, at
  assignment, review start, escalation, merge, reopen and decision time. There
  is no case transition reachable without passing through it. Intake is the
  deliberate exception: `openCase` accepts `openedBy: 'system'`, because opening
  a case is not a judgement about a person.

### The three intake paths

All three produce the same `Case` record. Only `origin` differs — which is
exactly why "we only act on user reports" and "we act on what we find" are one
auditable process rather than two that drift apart.

| Path | Intake | Triggering fact frozen as evidence | Queue | Priority |
|------|--------|------------------------------------|-------|----------|
| User report | `openCase({source:'user_report', report})` | The report's own captured evidence, captured at submission | `safety` | Strongest priority its reasons imply |
| Trust & safety | `openCase({source:'trust_safety_review', riskAssessmentId, riskState, detectors})` | A `risk_assessment` record: *"Risk critical raised by velocity, duplicate_device"* | `safety` | From the risk state: `elevated→normal`, `high→high`, `critical→urgent` |
| Identity anomaly | `openCase({source:'identity_anomaly', verificationId, anomaly})` | An `identity_anomaly` record — **redacted**, because a moderator may know an anomaly exists and must not see the result | `identity_integrity` | `high`, never lower |

Guards on intake:

- risk at `normal` opens no case (`not_eligible`) — a detector must raise it first;
- an anomaly with no description is a validation failure;
- a case with no evidence is a validation failure — there is nothing to review;
- a report must be `triaged` before it opens a case, and a report already merged
  into a case can never open a second one.

`test/case.test.ts` asserts that the three paths produce the same record and
that the case-operation audit chain — opened → assigned → review started →
decision recorded → resolved — is byte-identical across all three.

### Queue and priority

| Priority | Response target | Typical origin |
|----------|-----------------|----------------|
| `urgent` | 4 hours | threats, non-consensual intimacy, minor safety, critical risk |
| `high` | 24 hours | hate or discrimination, impersonation, any identity anomaly |
| `normal` | 48 hours | harassment, scam, sexual content |
| `low` | 72 hours | spam, misleading profile |

A queue is only real with a clock, so `dueAt` is derived from priority and is
pulled in when a merge raises it. Queues: `safety` (member behaviour),
`identity_integrity` (who is on the app), `appeals` (reserved for v0.2, listed so
the routing target exists before the flow does).

### Merge

Several reports describing one behaviour collapse into one case. No report is
lost:

- each report keeps its own id, reporter (anonymous or not), statement and
  captured evidence, and moves to `merged` pointing at the case;
- the case's evidence becomes the **union, deduplicated by id, order preserved**,
  so a moderator reads each artefact once and can still see which report brought
  it;
- the case priority rises to the strongest any merged report implies, and the
  deadline moves with it;
- merging a report about a different subject is a `conflict`;
- re-merging what the store already holds is a no-op; a report already merged
  into another case is a `conflict`, so one behaviour cannot be counted twice.

The merge publishes `moderation.case_reports_merged` (**restricted**), carrying
the case id, the reports this call folded in, and the new total. It is not a
resolution and it does not resolve anything: the case stays open for a decision,
and only `decide` moves it.

## 5. Evidence, retention and redaction

`packages/moderation/src/evidence.ts`.

An `EvidenceRecord` is minted once by `captureEvidence`, is `readonly` end to
end, and has no mutator. It records `capturedAt`, the `capture` context
(`report_submission` / `case_intake` / `review`), the source domain, a pointer
into restricted artefact storage, a content `digest`, and a `redactedSummary`.
The case points at evidence by id. Nothing is re-captured, re-summarised or
"reconstructed from what the conversation now says".

**Access is a property of the evidence type**, declared once in `EVIDENCE_POLICY`:

| Evidence kind | Sensitivity | Minimum clearance | Rationale |
|---------------|-------------|-------------------|-----------|
| `message_snapshot`, `conversation_snapshot` | restricted | reviewer | The behaviour under review, and the context that decides intent |
| `profile_snapshot`, `photo_snapshot` | restricted | reviewer | As the reporter saw it at report time, including since-deleted content |
| `report_statement` | restricted | reviewer | The reporter's words, retained even when the report is anonymous |
| `risk_assessment` | internal | reviewer | Rationale, never a verdict |
| `account_history` | restricted | reviewer | Repeat behaviour is context, not proof |
| `moderator_note` | restricted | reviewer | The next reviewer needs the last one's notes |
| `device_signal` | internal | escalated reviewer | Forensics invite over-reading; only escalated work justifies it |
| `ip_or_location` | sensitive | escalated reviewer | Exact coordinates never reach a plain reviewer |
| `identity_anomaly` | sensitive | identity privacy officer | A moderator may know it exists; only Identity may see the result |
| `identity_artefact` | sensitive | identity privacy officer | Raw selfie/liveness artefacts never appear in a moderation surface |

The clearance ladder is `reviewer < escalated_reviewer < lead`, plus
`identity_privacy_officer`, which sits **outside** the moderation hierarchy: it
is an appointment in the identity domain, not a promotion of a moderator.

`readEvidence` has three outcomes, not two, and this is the whole redaction
policy:

| Outcome | When |
|---------|------|
| `full` | The actor's clearance meets the evidence's access level |
| `redacted` | Identity evidence and a moderation actor. The `redactedSummary` only — never the artefact, never the digest. The case continues on the summary |
| `denied` | A moderator-level clearance below the evidence's access level |

Every call appends an audit row — `evidence.read` or `evidence.read_denied`,
with the actor, the clearance used and the level required — **and** publishes
`moderation.evidence_read` at `restricted`, carrying `{ evidenceId, kind,
visibility }` and nothing else. A denied read is published too, and is the more
interesting of the two. The payload never carries the summary, the digest or the
artefact reference: the event says that restricted evidence was touched, by
whom, and with what outcome, which is the fact a clearance-graded consumer needs
and nothing more.

**Retention.** `EvidenceRecord.retentionExpiresAt` is `null` until the per-market
retention policy is decided (open question below). The field exists so the answer
is a data change and not a schema migration; the value is set at capture and is
never recomputed.

## 6. Decisions and the account machine

`packages/moderation/src/decision.ts`.

`applyDecision` is a **thin adapter over the shared `accountMachine`**. The
kernel's guards decide whether a restriction, suspension or ban is legal at all.
Moderation's own preconditions are the ones the kernel does not hold — a case
id, a human moderator id, a rationale — plus the one the kernel deliberately
does not enforce: that a restriction names capabilities the account actually
has, and **none** in `UNRESTRICTABLE_CAPABILITIES` (`report`, `block`,
`delete_account`), which lives beside `CAPABILITIES_BY_ACCOUNT_STATE` in
`packages/core/src/states/account.ts`. A moderator who types `report` into a
restriction is refused rather than having the name silently dropped, because a
decision that records fewer removals than the one taken is a decision nobody
made. That refusal comes first, ahead of the "does the account hold it" check,
so a capability that may never be removed is always reported as such —
`delete_account` is granted only by `banned`, so from every other state the
other message would name a capability the moderator could never have removed
anyway. A missing `caseId` is a `validation_failed` refusal, not
`invalid_transition`: the guard failed for want of input, which is a different
thing from the transition being impossible, and a client can act on the
difference.

```ts
applyDecision({
  decisionId, caseId,      // null is a rejection, not a default
  moderatorId,             // a HumanActorId, not an ActorId — see below
  automated,               // must be stated false; a machine, or a caller
                           // that says nothing, is refused
  subjectId, action, rationale,
  currentAccountState, removedCapabilities,
  decidedAt,
}): Result<Decision, DomainError>
```

### Automation never enforces, at both doors

`applyDecision` and `applyReversal` are exported, so the human check cannot
live only in the orchestrators that call them. It is enforced twice, and both
halves are needed:

- **The brand, which is load-bearing.** `moderatorId` is a `HumanActorId`, an
  `ActorId` that only the package's own `asHumanActor` crossing point can mint
  — and that function is not re-exported. The id a service already holds is not
  assignable to it, so `applyDecision({moderatorId: 'system'})` does not compile
  at all. The lie becomes a cast somebody had to write, at a site a reviewer can
  find, instead of a value that flows silently.
- **The claim, which is the runtime half.** `DecisionCommand.automated` is
  required and is compared against `false` rather than tested for truth, so a
  command that says `true` — and one that says nothing at all, which an untyped
  caller can do — is refused with `permission_denied` inside the function that
  produces the `Decision` an appeal is answered from.

`decide` and `reverseDecision` pass both, after `canWorkCase` has already
refused an automated actor; the cast they perform is a narrowing the gate has
made true. What is left is irreducible in the type system: a caller can write
`asHumanActor`'s result by hand and state `automated: false`. That is two
deliberate acts in one expression, not a default.

### Decision matrix

| Action | Required preconditions | Account event | Resulting standing | Reversible by |
|--------|------------------------|---------------|--------------------|---------------|
| `warn` | case id, human moderator id, rationale ≥ 20 chars | — | unchanged (`active`/current) | Nothing to lift: a warning is a recorded conversation, not a sanction |
| `clear` | case id, human moderator id, rationale | — | unchanged | n/a — this *is* the absence of a sanction |
| `restrict` | the above **+ ≥ 1 named removed capability** the account actually holds, and none that may never be removed | `restrict` | `limited` | `lift_restriction` on a new decision, or case reopen |
| `suspend` | case id, human moderator id, rationale | `suspend` | `suspended` | `reinstate` on a new decision, or case reopen |
| `ban` | case id, human moderator id, rationale | `ban` | `banned` | `lift_ban` on a new decision, or case reopen |

A restriction may only name capabilities the account holds *now*: naming one it
has already lost is a validation failure, because a decision that mis-explains
itself to the user is a defect. The decision function refuses before the machine
is asked, and the machine still has the final word on the transition itself.

`decide` is the orchestration: it requires the case to be `in_review` or
`escalated`, applies the decision, resolves the case through `caseMachine`, and
emits

- `moderation.decision_recorded` — **restricted**;
- `moderation.case_resolved` — **restricted**;
- `account_state.changed` — **public**, and only when the standing actually
  changed. Its payload is exactly three fields, `{ accountState, capabilities,
  removedCapabilities }`: the state, what is left, and what the case took away.
  No case, no decision, no moderator, no reason;
- `moderation.restriction_applied` — **user**, the affected account and nobody
  else, carrying `{ caseId, decisionId, accountState, removedCapabilities }`.
  A reversal publishes `moderation.restriction_lifted` with the same shape, the
  removed set being what came back.

A product domain therefore learns that an account is `limited` and that it can no
longer send messages, and it learns **what** was taken without learning **why**.
It cannot learn that this happened because of a report, a review, a case or a
moderator: those events are `restricted` and are never delivered to a `public`
clearance. Tested in `test/decision.test.ts` with a `public`-clearance subscriber
on the bus.

### Why the case reference is a second event

The restricted user is owed a case reference: an action they cannot name is an
action they cannot contest, and contestability is one of the eight commitments.
It is not owed to anyone else. Putting `caseId` on `account_state.changed` would
publish, to every subscriber on the bus, the fact that an open case exists about
an identifiable person — which is the first thing a `restricted` clearance
exists to withhold, and would undo §6's guarantee for a notification.

So there are two events over one decision, split by audience rather than by
redaction: `public` carries the capability projection every enforcing surface
needs, and `user` carries the reference the affected person needs. A client
builds `{ accountState, removedCapabilities, effectiveCapabilities }` from the
first without a local copy of `CAPABILITIES_BY_ACCOUNT_STATE`, and builds the
restriction notice from both. Neither event carries the other audience's fields.

## 7. Audit log

`packages/moderation/src/audit.ts`. Append-only **by construction**: the
`AuditLog` type has `append` and four read projections and nothing else — no
update, no delete, no truncate. An action cannot be edited out of the record; it
can only be answered by a later row.

Every row answers *who did what, when, on what evidence, and can it be reversed?*
from one record:

| Field | Question it answers |
|-------|--------------------|
| `sequence` | Total order within the process; gap-free, monotonic |
| `occurredAt` | When |
| `actorId` | Who — a moderator id, or `system` for automated intake |
| `action`, `entityType`, `entityId` | What, to which record |
| `subjectId` | Whose account this concerns |
| `caseId` | Which case authorised it |
| `evidenceIds` | On what evidence |
| `decisionId` | Under which decision |
| `outcome` | `allowed` or `denied` — a refused read is a fact worth keeping |
| `reversal` | `account_state` + event, `new_decision` + id, `case_reopen` + id, or `null` for facts that are not actions |
| `detail` | Stable machine-readable specifics (reason, from/to standing, visibility, clearance) |

Actions recorded: `report.submitted` `report.triaged` `report.merged`
`report.status_changed` `case.opened` `case.assigned` `case.review_started`
`case.escalated` `case.reports_merged` `case.resolved` `case.reopened`
`evidence.captured` `evidence.read` `evidence.read_denied` `decision.recorded`
`decision.reversed`.

Read API: `byActor(actorId)`, `bySubject(userId)`, `byEntity(type, id)`,
`forCase(caseId)`, plus the ordered `entries`.

`test/audit.test.ts` walks a full case and asserts that the chain under one
`caseId` is exactly: `case.opened` → `case.assigned` → `case.review_started` →
`evidence.read` → `decision.recorded` → `case.resolved`, and that the decision
row names the evidence, the moderator, and the account event that would undo it.

## 8. Appeal readiness, without the appeal flow

Issue #7 asks for *future appeal support*. Issue #1 lists appeals as P1. **The
appeal flow is out of scope for v0.1**; what v0.1 owes is a data model that an
appeal can be added to without a migration or a rewrite. Three properties
deliver that, and each is tested:

1. **A decision is referenced, never overwritten.** `Decision` is immutable and
   the audit log has no update. The account's full sanction history stays
   readable through `bySubject`.
2. **A reversal is a new decision.** `reverseDecision` drives the kernel's lift
   transition (`lift_restriction` / `reinstate` / `lift_ban`) and returns a new
   `Decision` with `reverses` set to the original's id. The original is untouched
   and still says what was decided and when.
3. **A sanction still in force is appealable.** `isAppealable(decision, history)`
   is true for a sanction that no later decision has already reversed, and false
   for a `clear` — a user may appeal a sanction, not a clearance.

The case stays `resolved` across a reversal: that review really happened and
really produced that decision. The appeal reviewer reads two rows and a second
decision, which is the honest sequence. `reopenCase` is the entry point a future
appeal process will use; today only a human moderator may take it, with a
stated reason, and it publishes `moderation.case_reopened` naming the decision it
detached from the case.

## 9. Open questions

Recorded rather than guessed, because guessing is worse than writing down the
gap.

- **Retention period per market.** `retentionExpiresAt` is `null` until this is
  answered. Depends on the regulatory answer per market (GDPR erasure deadlines
  versus law-enforcement and child-safety preservation duties), and it collides
  with the right to be forgotten for non-sanctioning reports.
- **Moderator training and quality measurement.** The model names a
  `ModeratorActor` and a lead, but not what qualifies someone to be a lead or how
  their decisions are sampled. Needs a quality programme, not a type.
- **Whether `warn` requires user-visible copy.** A warning is currently recorded
  against the account with no user-facing message, which may be right and is
  certainly a policy question. If it needs copy, `warn` needs a template and the
  decision needs a delivery record.
- **Escalation to law enforcement.** There is no case type, no retention override
  and no disclosure path for a referral. A referral is also the one case where
  evidence retention outlives the account, so it needs its own answer.
- **Kernel id branding.** Moderation needs two id kinds the kernel does not name
  (`EvidenceId`, `DecisionId`). `castId` keeps `Brand` private, so a domain cannot
  declare a new branded id without duplicating the branding mechanism — and a
  second crossing point is worse than an unbranded one, because validation added
  later would have two homes. They are `string` aliases in `src/ids.ts` until
  the kernel re-exports `Brand`.
  `HumanActorId` is the one place the duplication is already paid, and it is
  deliberate rather than convenient: the alternative to a private brand was an
  `ActorId` parameter that any service could satisfy with the id it minted for
  itself, which is the commitment this exists to hold. It is a brand plus one
  named minting function in the same file, and it should collapse into
  `Brand<ActorId, 'HumanActorId'>` the moment the kernel exports `Brand`.
- **Composition of `limited`.** Per the overview, the account model is a strict
  ladder. A suspended-then-restricted account is a v0.2 question and moderation
  inherits whatever the kernel decides.
