# Feature: Account Restrictions & Re-verification

> Issue [#15](https://github.com/katzimoto/been_there/issues/15) — MVP Feature: Account Restrictions & Re-verification.
> Parent: [#1](https://github.com/katzimoto/been_there/issues/1). Related architecture: [#3](https://github.com/katzimoto/been_there/issues/3), [#6](https://github.com/katzimoto/been_there/issues/6), [#7](https://github.com/katzimoto/been_there/issues/7).
> Authority: [`docs/architecture/00-overview.md`](../architecture/00-overview.md). Where this document and the overview disagree, the overview is right.
> Companions: [`messaging-experience.md`](./messaging-experience.md) (#13), [`user-safety-controls.md`](./user-safety-controls.md) (#14).

## 1. Goal and done-when

**Goal.** Provide clear product behaviour for accounts that become risky,
restricted, suspended, banned, or that need renewed verification.

**Done when (issue #15).** Every important trust/enforcement state has a
consistent product experience **and restricted users cannot bypass it**.

The second clause is half of this specification and the half that is easy to
leave as a paragraph. It is specified properly in §8.

## 2. Scope

In scope: the `limited` / `suspended` / `banned` product experience; the
capability surface of each state; copy and next steps; re-verification triggers
and flow; appeal readiness.

Out of scope for v0.1: the structured appeals flow (issue #1 lists "Appeals flow"
as a **P1 candidate** — see §9); reputation scores; risk-based product
personalisation; any automated irreversible action.

## 3. Boundaries

### 3.1 Ownership

| State / fact | Owner | This feature's relationship to it |
|---|---|---|
| `AccountState` (`active`/`limited`/`suspended`/`banned`) | Moderation & Enforcement | reads only, via `account_state.changed` + capability projection |
| The capability surface per state | Moderation & Enforcement (`packages/core/src/states/account.ts`) | **read, never restated in code** — see §4 |
| The capabilities no restriction may remove | Moderation & Enforcement, same file: `UNRESTRICTABLE_CAPABILITIES`, declared next to `CAPABILITIES_BY_ACCOUNT_STATE` | **read, never restated in code** — see §4. One file for both, deliberately: two homes for one capability vocabulary is how a capability gets added to the base table and forgotten in the list that protects it |
| `IdentityState` and the re-verification decision | Identity & Verification | reads `identity.status_changed`; may *request* re-verification, never enforce |
| `RiskState` | Trust & Safety | **not read by any product surface.** A product client must not be able to infer a risk state, so no `risk.*` event reaches a product projection |
| Which capabilities a specific restriction removes | Moderation & Enforcement (the `caseId`-bearing `restrict` event) | read from the capability projection, which is the state plus the removed set |
| Re-verification flow UI | Identity & Verification, surfaced here | — |

### 3.2 What this feature never owns

| Never owned | Owner |
|---|---|
| Writing `AccountState` | Moderation & Enforcement, exclusively |
| Deciding that a subject is risky enough to act on | Trust & Safety raises a signal; a human decides |
| Any automated irreversible action | Nobody. `accountMachine` rejects every enforcement event without a `caseId`; `suspend` and `ban` also require a `moderatorId` |
| Verification artefacts and provider responses | Identity & Verification (`sensitive`) |
| Whether a report is justified | Moderation & Enforcement |

**The product side of an enforcement is a capability set, not a story.** A client
renders what capabilities it has; it does not know why, and cannot find out.

## 4. The capability surface — read from code, not from this document

`packages/core/src/states/account.ts` is the **source of truth**, and it holds
three things: `CAPABILITIES_BY_ACCOUNT_STATE`, `UNRESTRICTABLE_CAPABILITIES`
(`report`, `block`, `delete_account`), and `capabilitiesFor(state, context)`.
The tables below are a transcription for the product's benefit; if they ever
disagree with the code, the code is right and this document is a bug.

`UNRESTRICTABLE_CAPABILITIES` is the answer to "who decides that this capability
may never be taken", and it lives beside the base table rather than in the
moderation package because the moderation package is not the only place that
needs the answer: `applyDecision` refuses a restriction naming one of them, and
`capabilitiesFor` will not subtract one. Moderation refuses loudly — a moderator
who types `report` is told no, because a decision that records fewer removals
than the one taken is a decision nobody made — and the kernel is the backstop
behind it. Platform re-exports the same constant rather than keeping its own
list, so a fourth copy cannot appear.

`capabilitiesFor(state, ctx)` starts from the state's base list and subtracts
`ctx.removedCapabilities`. Two consequences the product must internalise:

1. **A restriction always names what it removed.** The `restrict` transition's
   guard requires `caseId !== undefined` **and**
   `removedCapabilities.length > 0`. There is no such thing as a restriction
   that removes nothing: `limited` is always explainable, both to the user and
   to a moderator. This is the overview's "capability-based, not a blanket mute".
2. **A named removed capability can only ever be a subset of the base set**,
   so restriction can never *add* a capability, and it can never remove
   anything in `UNRESTRICTABLE_CAPABILITIES` — `report`, `block`,
   `delete_account`. The account's ability to reach safety controls survives
   every enforcement, and so does its ability to leave.

### 4.1 Base capability surface

| State | Capabilities | Removed by the state |
|---|---|---|
| `active` | `browse_discovery`, `like`, `send_message`, `report`, `block`, `edit_profile` | — |
| `limited` | `browse_discovery`, `report`, `block`, `edit_profile` | `like`, `send_message` (before any per-case subtraction) |
| `suspended` | `report`, `block`, `edit_profile` | `browse_discovery`, `like`, `send_message` |
| `banned` | `report`, `block`, `appeal_request`, `delete_account` | `browse_discovery`, `like`, `send_message`, `edit_profile` |

A `limited` account's effective surface is its base set minus
`removedCapabilities`, so the most restrictive legal `limited` account has
`report`, `block`, `edit_profile` — the same as `suspended` in practice, but
reached by a different, named, case-linked decision.

### 4.2 The invariant that makes the product safe to write

```ts
// contract sketch — the one rule every product surface obeys
// (canPerform/capabilitiesFor live in packages/core; the client never re-derives them)
type Gate = (capability: string) => boolean; // false ⇒ the surface is not offered
```

- A surface that maps to a capability is **hidden or disabled** when
  `canPerform(user, capability, ctx)` is false. Never shown-then-failing, except
  where §5 specifies a disabled-with-reason treatment.
- The client is not the enforcement point. Every write path re-checks the
  capability server-side; the client gate exists to make the product honest, not
  to make the system safe.
- A capability is **never** scoped to a device, a session, a client version, or a
  network. See §8.2.

## 5. What a user can and cannot do, per state

### 5.1 `active`

Everything the base list allows. This is the only state in which a conversation is
`active` and the only state in which the composer is ever enabled.

### 5.2 `limited`

| Surface | Behaviour | Gate |
|---|---|---|
| Discovery feed | **available** — the base surface keeps `browse_discovery`, unless the case's `removedCapabilities` names it | `browse_discovery` |
| Likes | **not offered**; already-made likes are retained, not reverted | `like` |
| Messaging | composer disabled for this user and for every counterpart (§8.4); existing threads readable | `send_message` |
| Report | **always available** | `report` |
| Block | **always available** | `block` |
| Profile editing | available; edits to photos trigger likeness re-check via Identity, not a restriction | `edit_profile` |
| Matches list | available, read-only | — |
| Notifications | received, but messaging notifications are suppressed (nothing to notify about) | — |

`limited` is the most commonly reached enforcement and the one most likely to be
wrong (issue #1, scenario 6). Its product treatment is therefore the mildest of
the three: nothing is hidden, nothing is deleted, and the copy names the exact
capabilities removed and what remains.

### 5.3 `suspended`

| Surface | Behaviour | Gate |
|---|---|---|
| Discovery feed | **not offered**; the user's card is removed from every other user's feed | `browse_discovery` |
| Likes | not offered | `like` |
| Messaging | composer disabled both ways; threads readable; **not** deleted | `send_message` |
| Report | **always available** | `report` |
| Block | **always available** | `block` |
| Profile editing | available | `edit_profile` |
| Profile visibility to others | `isVisibleInProduct('suspended')` is `true`, but a suspended user is filtered out of discovery by the same projection that gates their own feed, so they are effectively not encountered | — |
| Notifications | read-only; nothing new is generated for them | — |

`suspended` is a **pause with a defined end**: the data is intact, the state
moves, and `reinstate` returns everything. The product must present it as a
pause, never as a deletion.

### 5.4 `banned`

| Surface | Behaviour | Gate |
|---|---|---|
| Everything product-facing | not offered; `isVisibleInProduct('banned')` is `false` | all |
| Report | **still available** — a banned user can still report abuse they experienced | `report` |
| Appeal request | available as the v0.1 intake in §9.3 | `appeal_request` |
| Delete account | available, and is the *recommended* action on this screen | `delete_account` |
| Their data | retained per the retention rules; deleting the account is the user's own act, distinct from the ban | — |

`banned` is the only terminal-by-default state, and it is reversible only by a
named moderator with a `caseId` (`lift_ban`).

### 5.5 The three states are different products

| | `limited` | `suspended` | `banned` |
|---|---|---|---|
| Can message | no | no | no |
| Can be discovered | usually yes | no | no |
| Can report / block | yes | yes | yes (report and block) |
| Data intact | yes | yes | yes, until the user deletes |
| Reversible by | moderator (`lift_restriction`) | moderator (`reinstate`) | moderator (`lift_ban`) |
| Framing in copy | "here is what is switched off" | "paused, and here is how it ends" | "closed, and here is what you can still do" |

## 6. Copy and next steps per state

Full rules are in
[`user-safety-controls.md` §10.2](./user-safety-controls.md); the state screens
add the next step, because a state screen without a next step is a dead end.

### 6.1 `limited`

**Title:** "Your account is limited"
**Body:** "A member of our safety team has limited your account. {capability_line}
Everything else works as normal: {retained_line} Your matches and your messages
are kept exactly as they are."
**Next step:** none required — a "what you can still do" list plus `Read
community rules`. No forced flow, no cooldown timer, no nagging.
**Explicitly not in this copy:** the case, the reporter, the evidence, the risk
state, the moderation note, the duration (there is no fixed duration — a
restriction is lifted by a moderator, so promising a date would be a lie).

`{capability_line}` is generated from `removedCapabilities` on the published
`account_state.changed` payload — e.g. "sending messages and liking new people
are switched off." Generating it from the removed set — not from a hand-written
string per case, and not by diffing the effective set against a local copy of
`CAPABILITIES_BY_ACCOUNT_STATE` — is what makes `limited` always explainable to
the user, which is the whole point of the capability-based model. The payload
carries `{ accountState, capabilities, removedCapabilities }`: the state, what
is left, and what was taken.

### 6.2 `suspended`

**Title:** "Your account is paused"
**Body:** "Your account is paused. You cannot appear in discovery, like, or
message. Your profile, your matches and your messages are all kept, and they
come back in full if your account is reinstated."
**Next steps:** `Delete your account` (with its own data confirmation, never
bundled silently with the pause), `Report a problem`, `Read community rules`.
**Explicitly not in this copy:** any date, any "after X days", any implication
that a review is scheduled automatically. There is no automated path to
`reinstate`; it is a human decision.

### 6.3 `banned`

**Title:** "Your account has been closed"
**Body:** "A member of our safety team closed your account because of
{behaviour_summary}. You cannot use Been There any more. You can still report a
problem you have experienced, you can still ask us to look at this decision, and
you can still delete your account and its data."
**Next steps:** `Ask us to look at this` (§9.3), `Report a problem`,
`Delete my account and data`.
**Explicitly not in this copy:** the case, the evidence, the reports, the
reporter, the number of reports, or a statement that the decision is final. It is
not final — it is reversible by a named moderator — and saying "final" would be a
lie the P1 appeals work would have to retract.

### 6.4 The state-change notification

When an enforcement lands, the affected user gets one in-app notice, once, at
the next app open (and never a push that reveals a state change to someone
holding the device — device lock is not a security model here). The notice
repeats the state copy verbatim, links to the state screen, and **names the case
reference and the appeal route**. Notices are not sent for
`lift_restriction`/`reinstate` state *changes* beyond the positive
`SAFETY_ACCOUNT_REINSTATED` confirmation, and never for any risk signal.

Those two fields come from a second event, and the split is deliberate.
`account_state.changed` is `public`: any surface enforcing the capability set
reads it, and it carries no case, no decision, no moderator and no reason —
publishing a case id there would tell anyone holding the bus that an open case
exists about an identifiable person, which is the first fact a `restricted`
clearance exists to withhold. `moderation.restriction_applied` (and
`moderation.restriction_lifted` for a reversal) is `user`: the same decision,
addressed to the account it was taken against, carrying
`{ caseId, decisionId, accountState, removedCapabilities }`. The date is the
envelope's `occurredAt`; the appeal route is the `appeal_request` capability the
state grants, which no event needs to restate.

The user is the only audience for the case reference, and that is the point: a
restriction nobody can name the case for is a restriction nobody can contest.
Whether the appeal *intake* exists is §9.3's question; being able to point at
the case is not an appeal flow and does not wait for one.

## 7. Re-verification

### 7.1 What re-verification is, and is not

Re-verification is a **trust-change response in the identity domain**: the
`reverify_requested` event on `identityMachine` moves
`verified | expired → pending`. It is friction that is automated and
reversible, which is exactly the class ADR 0004 permits. It is **not** an
enforcement, it does not write `AccountState`, and it never appears in a
product read-model as a restriction.

`review_required` is deliberately **not** on that list. A person whose
verification is already with a human cannot be re-verified by an automated
caller, because the attempt would move them to `pending` and take them back out
of the review they were put in — automation undoing a human's involvement, which
is the shape commitment 2 exists to forbid. `requestReVerification` refuses it as
a `conflict` before the open-attempt and cap checks, so the refusal also tells
the caller nothing about the account, and the kernel refuses it independently.
A flagged account leaves review only through `review_cleared` or
`review_confirmed_fraud`, both of which need a named reviewer.

`IdentityContext.reVerification` marks the attempt as trust-triggered so Identity
can apply its own re-verification rules (e.g. a stricter likelihood floor, a
different sampling policy) without any other domain knowing why.

### 7.2 Triggers

| Trigger | Automated? | Path | Ends in |
|---|---|---|---|
| Verification expires | yes | Identity's own `expire`, then `submit_verification` | user re-verifies |
| A moderation decision requires it (`caseId` + `moderatorId`) | no — human | Identity `reverify_requested` | user re-verifies; the case is closed either way |
| Risk is `high` or `critical` and Identity's rules are satisfied | yes | Trust & Safety raises a **signal** → Identity decides → `reverify_requested` | user re-verifies, or the attempt fails and Identity's own state machine takes over |
| A moderation result is ambiguous and Identity has flagged it | no — human | `flag_for_review` → `review_required` | `review_cleared` (named reviewer) or `review_confirmed_fraud` (named reviewer) |
| The user changes profile photos in a way that triggers a likeness re-check | yes | Identity | user re-verifies; existing matches and messages are **not** interrupted |
| Age-band or verification `generation` change | yes | Identity | user re-verifies |

The non-negotiable property: **no re-verification request ever appears on a
`banned` or `suspended` account's surface as a route back in.** Re-verification
is not an appeal and not a reinstatement path; it changes identity state, and
only `lift_ban` / `reinstate` changes account state.

### 7.3 The flow

1. A trigger fires; Identity moves the subject to `pending` and publishes
   `identity.status_changed` at `public` clearance.
2. Every product surface that requires `verified` — discovery, messaging
   composer, likes — re-evaluates. A non-`verified` identity is undiscoverable
   *by construction* (`isDiscoverableIdentity`), so this is not a product rule;
   it is the identity machine.
3. The user sees `SAFETY_VERIFICATION_REVIEW` or
   `SAFETY_REVERIFICATION_REQUESTED` (copy in
   [`user-safety-controls.md` §10.3](./user-safety-controls.md)), with one
   action: verify now.
4. On success the state returns to `verified` and every surface restores without
   any user action. On failure, `verification_failed` and the user may
   `submit_verification` again.

### 7.4 What a re-verification must never do

- Never name its trigger. A user who can infer "I was asked because of what I
  did" has just read their own risk state.
- Never interrupt existing matches or conversations on a mere expiry or a
  photo-change re-check. Disrupting a conversation because of a photo upload is
  a self-inflicted safety regression: it teaches users not to update their
  profile.
- Never be the mechanism by which a restricted user regains a capability. A
  re-verified user with `send_message` removed still cannot send; the account
  state and the identity state are independent facts with independent remedies
  (the overview §5, "three independent state machines" — keeping them
  independent is the point).

## 8. Bypass prevention

This is the "and restricted users cannot bypass it" half of the done-when. It
has four surfaces, and the general rule is: **every restriction is a property of
the account, evaluated fresh on every request from any device, any session, any
client.**

### 8.1 Creating a new account to evade a restriction

New-account creation is **never blocked**. Blocking signups would be a product
rule about suspected wrongdoing, which is moderation's judgement, not a form
field's — and the overview's rule is that only a human on a case may restrict
access. So the answer is not to prevent the account; it is to make evasion
worthless and detectable.

| # | Rule | Justification |
|---|---|---|
| B1 | A new account is `unverified` on creation and must complete verification before it is discoverable or may message. This is commitment 1 and it is already true by construction. | The only discoverable identity state is `verified`; a new account that skips verification gets nothing. |
| B2 | A new account linked by a strong identifier (a verified phone/email, or device evidence at `sensitive` classification) to a subject with an open enforcement case does **not** auto-enforce. Identity raises it, and a human decides. | Automation never enforces. Linkage is a signal, not a verdict. |
| B3 | Every enforcement records the subject id, and every identity record carries a `generation` counter. A new account is a new subject, so the *account* is clean — which is why B1/B2 exist rather than a hard account block. | Honest about what an account-scoped restriction can and cannot see. |
| B4 | Re-verification of the new account runs Identity's normal rules. If Identity cannot establish that the person is real, the state stays short of `verified` — which is a **verification** outcome, not an enforcement. | The fake-profile attempt fails at verification (issue #1 scenario 2), not at a policy block. |
| B5 | Enforcement is *reviewable and reversible*, so evasion is visible to moderators as a pattern (a device/identifier appearing against many subjects with open cases) and is a case a human can act on. | Scenario 6: not an irreversible automated black box. |

What we explicitly do **not** do: share account state across a suspected
duplicate at the product layer, auto-ban duplicates, or require government ID
(issue #1 explicitly excludes mandatory government ID).

### 8.2 Using a second device

| # | Rule | Justification |
|---|---|---|
| D1 | No capability is ever device-scoped. A capability is a function of `AccountState` plus the case's `removedCapabilities`, both of which live on the account. | The single rule that defeats the entire second-device class. |
| D2 | Signing in on a new device is allowed and gets the *identical* restriction. There is no "fresh device" path to a fuller capability set. | Restrictions are not session state. |
| D3 | The restriction is re-evaluated on every request, including message sends, likes, and profile reads that expose discovery surfaces. No cached capability decision survives a state change. | Prevents a client from continuing on a stale grant. |
| D4 | Push tokens are bound to the account, not the device, so notifications cannot be used as a side channel to a state change. | §6.4. |
| D5 | Revoking a device (a Platform capability) logs the user out everywhere. This is a security feature, not an enforcement, and is independent of `AccountState`. | Keeps Platform concerns out of moderation state. |

A test that would catch a regression here: for every `AccountState` and every
state of the removal context, the effective capability set is identical across
sessions and devices, because the input contains no device dimension at all.

### 8.3 Re-verification as a harassment vector

The threat: a subject uses re-verification requests as a channel to keep
pestering a victim, or the platform's own re-verification prompts are gamed by
the subject to re-enter a product surface.

| # | Rule | Justification |
|---|---|---|
| R1 | A subject may only *ask* for their own re-verification, and only while `expired` — never while already `verified`, never from `verification_failed`, and never for anyone else. `REVERIFICATION_POLICY.subjectMayRequestOnlyWhen` enforces the request; the identity transition table enforces the event. The policy list is always a **subset** of the machine's `reverify_requested.from`, never a superset: a state the policy admits but the machine rejects is a call that pays for the open-attempt, cap and cooldown checks and then returns `invalid_transition`. | See R2 for who else may ask, R3 for the cross-subject refusal, and the retry route below. |
| R2 | Automated re-verification requests are rate-capped per subject per rolling 30 days, with a 24-hour minimum gap. Past either limit the request is refused **and a `ReverificationLimitSignal` is written to the caller's signal sink**, naming the limit, the count, and the moment the block lifts. | ADR 0004: automation is allowed to apply reversible friction, and the *rate* is the revisitable part. A `rate_limited` error with no side effect is the failure this replaces: the moderation queue never learns that the system pulled one person out of discovery three times in a month. |
| R3 | **No user can request another user's re-verification.** There is no "report as unverified", no "flag this person's age", and no product action that writes `reverify_requested` on a subject's behalf. | A user-triggered verification request is a harassment and an escalation-abuse vector, and it would be automation acting on a user's accusation. |
| R4 | A re-verification request never changes `AccountState` and never restores a removed capability. | Independence of the three state machines. |
| R5 | A re-verification prompt is rendered with the same copy whether it is routine, trust-triggered, or moderation-driven. | If the copy varied, the subject could infer their risk state, and the harassment vector would work at the psychological level instead. |
| R6 | A subject with an open enforcement case receives re-verification prompts only at Identity's normal cadence; the case does not create a prompt storm, and a moderator's restriction replaces the prompt rather than adding to it. | One friction, not two. |
| R7 | Failed or repeated attempts are capped by the identity machine, not by an account-level throttle, and **three consecutive failed attempts escalate to `review_required`** (`REVIEW_ESCALATION_POLICY.consecutiveFailuresBeforeReview`), never to any enforcement. | Escalation to enforcement stays human, and so does escalation out of a loop. Before the kernel had the `flag_for_review` edge out of `verification_failed`, "repeated failure leads to `review_required`" was not buildable: the implementer got `invalid_transition`, and looping back to `pending` forever was the only thing the table allowed. |

**A failed attempt is retried, not re-verified.** A subject in
`verification_failed` starts a fresh attempt through `submit_verification`,
which the identity machine allows from that state and which lands in the same
`pending` the re-verification command would have produced. Naming
`verification_failed` in `subjectMayRequestOnlyWhen` would have been a second
route to one outcome, and the one the machine does not have.

**A subject hitting a limit raises no signal.** The refusal row records it,
which is all a person tapping "verify again" twice needs. Only `trust_safety`
and `moderation` can reach a cap at all, and them doing so repeatedly on one
account is the pattern a human should see. Identity cannot open a moderation
case — it has no case vocabulary and the dependency runs the other way — so the
record is handed to the caller, which is Trust & Safety's to turn into a case.

### 8.4 Bypassing a messaging freeze

Covered in detail in [`messaging-experience.md`](./messaging-experience.md) §5.3,
and repeated here because it is an enforcement surface: a restricted sender's
messages are not delivered, and the refusal is symmetric and silent to the
counterpart, so a restriction cannot be probed, cannot be used to make a
counterpart look unreliable, and cannot be evaded by the counterpart's continued
sending. Outstanding messages are refused at write time, not held.

### 8.5 Bypassing a discovery removal

A `suspended` or `banned` user's profile must not be reachable through any
surface — cards, search, a retained match, a conversation header, a notification,
a shared link. The product contract is a single eligibility projection consumed
by every surface, and the test is enumerating the surfaces rather than trusting
the one that was implemented. `isVisibleInProduct()` is `false` for `banned`;
for `suspended` the removal comes from the account-state projection that also
gates the user's own feed, so the two can never disagree.

### 8.6 What "cannot bypass it" does not mean

It does not mean the platform builds a surveillance system around one user's
account. It means: **the enforcement is a property of the account, the
identity gate is a property of the identity, and a human decides every
irreversible move.** Anything that would require the platform to guess that a
new person is the same person is handled by verification and human review, not
by an automated ban. That boundary is a feature: it is the same line that keeps
a false positive from becoming a permanent unjust consequence.

## 9. Appeals: P1, and appeal readiness in v0.1

### 9.1 Status

**The structured appeals flow is a P1 candidate and is out of scope for v0.1**,
as stated in issue #1's "P1 candidates after core MVP" list.

What ships in v0.1 is the `appeal_request` capability that the `banned` state
already grants, as a real and recorded intake — not a stub and not a promise:

### 9.2 What v0.1 must guarantee instead

Every enforcement is **recorded and reversible**, so an appeal is answerable
later without reconstructing history:

1. Every enforcement event carries a `caseId`; `suspend` and `ban` also carry a
   `moderatorId`. The transition guards refuse otherwise, so an unattributable
   enforcement is not representable.
2. Every enforcement is written to the audit log with: subject, actor, prior
   state, new state, `caseId`, `moderatorId`, removed capabilities, timestamp,
   and the reason/evidence pointer of the case.
3. Every enforcement has a defined inverse event and the context it requires —
   `lift_restriction` (`caseId`), `reinstate` (`caseId`, `moderatorId`),
   `lift_ban` (`caseId`, `moderatorId`). Reversibility is a property of the
   transition table, not a favour.
4. The evidence bundle that justified the decision is retained with the case
   (see [`user-safety-controls.md` §6.2](./user-safety-controls.md)), so a
   later appeal can be answered against the same record the decision was made on.
5. Risk decays and a human may always lower it, so a subject's context at the
   time of the decision is a snapshot, not a permanent verdict.

### 9.3 The `appeal_request` capability in v0.1

`appeal_request` is present in the `banned` capability surface, so it must do
something real:

- It opens a one-screen request from the banned-account screen (§6.3).
- The user's free text is attached to the **existing case** as a new actor
  statement, timestamped, immutable, and visible to the moderation role at
  `restricted` clearance with the read logged.
- It does **not** change any state, does not queue an automatic review, and does
  not carry a deadline. A moderator picks it up like any other case statement.
- The user is told honestly what it is: `SAFETY_APPEAL_REQUESTED` — "We have
  recorded your message and a member of our safety team will read it. We cannot
  promise a particular time. If you delete your account in the meantime, the
  request stays with us."

That last sentence is the point: deleting the account does not erase the
request, and the record outlives the relationship, exactly as a report does.

### 9.4 Appeal readiness — the checklist

"Appeal-ready" means: an appeal arriving in v0.2 could be answered **without
reconstructing anything**. The v0.1 build is appeal-ready when all of these hold.

| # | Condition | Where it is satisfied |
|---|---|---|
| A1 | The enforcement is attributable to a human and a case | `accountMachine` guards |
| A2 | The prior state and the exact capabilities removed are recorded | `AccountContext` + audit log |
| A3 | The decision's evidence is retained and readable by the moderation role | report/case evidence bundle |
| A4 | The subject's full decision history is available in one view (warns, restrictions, suspensions, prior cases) | case history |
| A5 | The state is reversible by a named moderator, with a defined inverse event | `lift_*` / `reinstate` |
| A6 | The subject was told what happened and what they can do next, without being told the evidence or the reporter | §6 |
| A7 | The subject can add a statement to the case even in v0.1 | §9.3 |
| A8 | No enforcement decision rests on a risk state alone | ADR 0004; §2 |

## 10. Contract sketches

Descriptive only; the implemented types live in `packages/core` and
`packages/moderation`.

```ts
// contract sketch — the projection a product client is allowed to hold.
// Built from one `account_state.changed` payload; no second crossing point,
// no local copy of the base capability table.
interface AccountCapabilityProjection {
	readonly accountState: AccountState;
	readonly removedCapabilities: readonly string[]; // the case's named set
	readonly effectiveCapabilities: readonly string[]; // capabilitiesFor(state, ctx)
}

// contract sketch — what a product projection is NOT given. The subject's own
// case reference is not on this list because it does not arrive on a projection
// at all: it is a `user`-clearance event addressed to them (§6.4), and no
// product domain may hold it on a stranger's account.
type NeverInAProductProjection =
	| { readonly moderatorId: ActorId }
	| { readonly riskState: RiskState }
	| { readonly reportCount: number }
	| { readonly reason: string };
```

If a product screen needs a value from `NeverInAProductProjection` to render, the
screen is wrong: the copy in §6 is written to be sufficient without any of them.

## 11. Acceptance scenarios

| #1 scenario | Given | When | Then |
|---|---|---|---|
| **6. False positive** (primary) | an account that was `limited` on a case | the moderator lifts the restriction with a `caseId` | the account returns to `active`; messaging returns to `active` for both parties; the product read-model retains no trace; the user sees `SAFETY_ACCOUNT_REINSTATED`; the audit log retains the full history for a later appeal |
| 6. False positive | an enforcement with no `caseId` | the transition is attempted | the transition is refused with `validation_failed` and a message naming the missing case. The case is a precondition, not a convention — but the refusal is *incomplete context*, not *impossible transition*, and a client can act on that difference: `invalid_transition` means retrying will never help, `validation_failed` means the caller did not supply what the guard asks for. `applyDecision` returns the same code before the machine is consulted at all |
| 6. False positive | a `limited` account | the client renders the restricted screen | the removed set and the case reference both arrive: `removedCapabilities` on the `public` `account_state.changed`, and `caseId`/`decisionId` on the `user` `moderation.restriction_applied`. The screen is built from those two events, never from a local copy of the base capability table (§10) |
| 7. Re-verification abuse | Trust & Safety has already had three re-verifications from one subject in 30 days | it requests a fourth | the request is refused `rate_limited` **and** a `ReverificationLimitSignal` is written naming the limit, the count, and `blockedUntil`. Trust & Safety stops requesting and a human can see why |
| 7. Re-verification abuse | an account already in `review_required` | Trust & Safety requests a re-verification | refused `conflict`. `reverify_requested` has no edge out of `review_required`, so automation cannot walk an escalated case back into `pending` and out of the human's queue |
| 6. False positive | three consecutive failed verification attempts | the third failure is recorded | `escalateAfterRepeatedFailure` resolves `flag_for_review` → `review_required`. No account standing changes, no capability is removed, and a person picks it up |
| 5. Malicious account | a subject whose risk reaches `high`/`critical` with corroboration | Trust & Safety signals | an automated, reversible response (re-verification request, rate limit) is applied; **no** account state changes; a case enters the moderator queue; the subject sees only the neutral re-verification copy and cannot infer their risk state |
| 4. Harassment | a `limited` or `suspended` victim | they open the block and report controls | both are present and functional, because `report` and `block` are in every state including `banned`; evidence is captured and the case exists |
| 3. Normal dating flow | an `active` user | nothing happens | `limited` never arises from a dating action; unmatch and block do not change `AccountState` |
| 2. Fake-profile attempt | someone evading a restriction by making a new account | they attempt to use it | the new account is undiscoverable until `verified`; no automatic ban is possible; linkage is a signal for a human, never an automated enforcement |
| 1. Legitimate onboarding | a genuine adult | they complete verification and profile | nothing in the enforcement model touches them; `active` with the full base capability set |

## 12. Open questions

- Whether `limited` states compose (a restricted-then-suspended account) or are
  strictly a ladder. The overview records this as a v0.2 question and the
  transition table currently models a strict ladder; the product copy for a
  composed state would need a priority rule.
- ~~The re-verification rate cap in §8.3 R2.~~ **Decided, not open.** Three
  re-verifications per subject per rolling 30 days, minimum 24 hours apart
  (`REVERIFICATION_POLICY.maxPerSubjectPer30Days`, `cooldownHours`). Both
  numbers are exported, pinned by tests in
  `packages/identity/test/reverification.test.ts`, and revisit-able by editing
  the constant — the mechanism degrading to a signal is the part that has to
  survive a change of number, and it does, because the signal records the limit
  it tripped and when the block lifts rather than hard-coding either.
- Whether a `suspended` account should keep receiving non-messaging
  notifications (matches, likes). Keeping them helps the user return; there is a
  real argument either way, and it is a judgement call, not a technical one.
- The exact `{behaviour_summary}` catalogue used on restriction, suspension and
  ban screens, and who authors it. It is the closest thing v0.1 has to an
  accusatory sentence, so it needs a named review owner.
- Whether a banned user's `appeal_request` intake should carry a
  self-imposed acknowledgement deadline. Deferred on purpose: a deadline the
  platform cannot meet is worse than none.
- Long-term retention and its interaction with the appeal record — the same
  regulatory question the overview already flags.
