# Feature: User Safety Controls

> Issue [#14](https://github.com/katzimoto/been_there/issues/14) — MVP Feature: User Safety Controls.
> Parent: [#1](https://github.com/katzimoto/been_there/issues/1). Related architecture: [#6](https://github.com/katzimoto/been_there/issues/6), [#7](https://github.com/katzimoto/been_there/issues/7).
> Authority: [`docs/architecture/00-overview.md`](../architecture/00-overview.md). Where this document and the overview disagree, the overview is right.
> Companions: [`messaging-experience.md`](./messaging-experience.md) (#13), [`account-restrictions-and-reverification.md`](./account-restrictions-and-reverification.md) (#15).

This is issue #1's **acceptance scenario 4** — "recipient can immediately stop
contact and report with evidence" — and is specified accordingly.

## 1. Goal and done-when

**Goal.** Give users immediate, understandable controls when an interaction
feels unsafe or unwanted, and hand moderators the context to act.

**Done when (issue #14).** A user can stop contact immediately and report
problematic behavior with enough context for moderation to act.

Three properties that make that true, and which the rest of this document
exists to protect:

- **Stop is one action, one tap, no case, no waiting.** Blocking is a user right,
  not a moderation outcome. It never requires a moderator and never waits for
  review.
- **Report is one decision, not a form.** A person in a bad situation should be
  able to report in under 30 seconds, and the resulting record should be
  readable by a moderator without asking a single follow-up question.
- **The right to report outlives the relationship.** It survives unmatch, it
  survives a block in either direction, and it survives the other party deleting
  their account.

## 2. Scope

In scope: block; report (profile, message, conversation); evidence capture;
post-unmatch reporting; the user-facing copy catalogue for safety and account
messages.

Out of scope for v0.1: appeals (#1 lists "Appeals flow" as P1 — see
[`account-restrictions-and-reverification.md`](./account-restrictions-and-reverification.md) §9);
scam-specific detectors; media-with-content review; moderator-facing tooling
beyond the case record (#7).

## 3. Boundaries

### 3.1 What this feature owns

| Owned here | Notes |
|---|---|
| The **block record** and its effect on messaging and discovery | it is a user-instant safety action with a retention obligation, so it lives with reports, not with dating or transport |
| The **report record**, its reason taxonomy, and the evidence bundle attached at creation | Moderation & Enforcement owns the case lifecycle; the intake contract is specified here |
| The user-facing copy catalogue in §10 | `user`-sensitivity product copy, never `internal` |
| The interaction budget in §5.4 | a product contract, not an implementation detail |

**Decision: the block record is owned by Moderation & Enforcement, not by
Communication or Dating Core.** Justification: (a) a block is evidence of a
safety action and needs the same retention guarantees as a report; (b) the
`block` capability is declared in `packages/core/src/states/account.ts`, which
is Moderation's machine, and is present even for a `banned` account — a user who
is banned must still be able to block the person harassing them; (c) Dating Core
and Communication both need it, and the overview forbids them from owning
shared state. Both consume it as a projection and apply their own half of the
effect.

### 3.2 What this feature never owns

| Never owned | Owner |
|---|---|
| Deciding whether a report is justified, and any enforcement | Moderation & Enforcement, on a `Case` with a `caseId` (+ `moderatorId` for suspend/ban) |
| Risk scoring, detectors, corroboration | Trust & Safety |
| Whether a message is abusive | Communication never decides; it publishes signals |
| Whether a user may send | Communication, from the capability set |
| Verification status and evidence | Identity & Verification |
| Match state | Dating Core |

**Automation never enforces, and neither does this feature.** A block is not an
enforcement: it removes capabilities between two accounts and cannot remove a
capability from the blocker. A report is not an enforcement: it opens a queue
item. Neither writes `AccountState`. Only a moderator does, through the
`accountMachine` transitions, which reject every enforcement event without a
`caseId`.

## 4. Block

### 4.1 What it takes effect on

- **Immediately and synchronously with the tap.** One write, one event. There is
  no pending state, no queue, no "processing" period during which a message can
  still be sent.
- **Requires no case, no moderator, no review, no reason.** Block is a right.
- **Unblocking is also immediate**, and is itself a recorded, auditable action.
- Blocking is available in **every** account state. Per
  `CAPABILITIES_BY_ACCOUNT_STATE`, `block` is present in `active`, `limited`,
  `suspended` and `banned`. The control must never be hidden from a restricted
  user: hiding "block" from someone being harassed is the exact failure this
  product exists to prevent.

### 4.2 What a block stops — the complete list

| # | Effect | Immediate? | Owner of the effect |
|---|---|---|---|
| 1 | The blocker can no longer send messages to the blocked | yes | Communication |
| 2 | The blocked can no longer send messages to the blocker | yes | Communication |
| 3 | Message delivery across the pair stops in both directions, including queued and in-flight | yes | Communication |
| 4 | The pair's conversation is `frozen_restricted`; history stays readable to both; the thread is never deleted | yes | Communication |
| 5 | The pair no longer appears in each other's discovery feed, in either direction | next read-model refresh (target: seconds) | Dating Core |
| 6 | The existing match is hidden from both parties' match surfaces; the match record is retained, not destroyed | yes | Dating Core |
| 7 | No push/in-app notification generated by the pair is delivered to either side (new likes, new messages, profile edits, new matches) | yes | Platform |
| 8 | Neither party's profile is reachable from the other's surfaces by any link | yes | Dating Core |
| 9 | The blocked is not told which capabilities or surfaces changed, only that contact ended | — | §4.4, §7.2 |
| 10 | Nothing outside the pair is affected: the block is pairwise, it does not restrict either party's other conversations, and the blocked stays visible in other users' discovery | — | — |

Effect 10 is a real constraint, and it is the reason a block is not a
complete safety tool: see §4.4 for what it is disclosed, and
§4.3 for what it deliberately leaves alone.

### 4.3 What a block does *not* do

| Not done | Why |
|---|---|
| Does not delete anything | Deleting a conversation is evidence destruction, and commitment 4 says the right to report survives. History is retained read-only. |
| Does not end the match as a dating fact | It hides it; `match.status` is unchanged, so a later unmatch or a moderator review still has a coherent record. |
| Does not notify the platform, open a case, or set risk | That is report's job, and risk is Trust & Safety's. Blocking is not evidence of wrongdoing in either direction. |
| Does not restrict the blocker's own capabilities | It removes no capability from the blocker. |
| Does not stop the blocked from reporting the blocker | Symmetry is required: a blocked user is exactly the person most likely to be in danger, and the block must not be a way to silence a complaint. |
| Does not block re-matching elsewhere later | Dating Core's mutual-like rules govern that. |
| Does not apply across accounts | A new account is not a block escape, and block is not the mechanism that prevents one — see [`account-restrictions-and-reverification.md` §8](./account-restrictions-and-reverification.md) |

### 4.4 Is a block anonymous? — No, and here is the decision

**Decision: the blocked user is told that contact has ended. The block is
disclosed as an outcome; it is not disclosed as a complaint.**

Concretely, on block the blocked user receives `SAFETY_BLOCK_RECEIVED`
(§10.1), which says: this person is no longer able to contact you or be
contacted by you; you can still report anything they did; you will not be told
why they ended contact.

The alternative — a silent block — is rejected, and the reason is the abuse it
creates. A block that is invisible is a **disappearance tool**: someone who
anticipates a report blocks first, vanishes from the reporter's view, and
removes the reporter's most obvious escalation path. Because the reporter can
always block right back, the escalation path is recoverable — but only if the
blocked side is told. Silence would also make the block invisible to the very
people building safety cases, and would make the product's own support channel
unusable ("he just disappeared" is not answerable).

What we deliberately **do not** disclose, to the blocked user or to anyone else:

- the reason for the block (there is no reason field at block time),
- that a report, case, review or risk state exists,
- who else blocked them, or how many people have,
- any count, timing, or aggregate that could be used to infer enforcement.

So the disclosure is one-directional and minimal: *contact ended, here is what
you can still do*. It is a usability and anti-abuse decision, not a disclosure
of moderation state, so it does not violate the overview's §4 rule (the product
read-model contains no report/case/restriction information).

### 4.5 Abuse of the block itself

Blocking is a powerful action and can be misused to silence a partner, so:

- a block is recorded in the audit log with actor, target, timestamp, and the
  pair's conversation id;
- block and unblock counts are visible to moderators on the case view as
  *context*, never as a verdict (a user who blocks a great deal is a
  moderator-relevant pattern, not a moderator-decided one);
- a block is reversible in one tap, and a pattern of block-then-report against
  many accounts raises a **signal** in Trust & Safety — a signal, not an
  enforcement, per ADR 0004.

## 5. Report

### 5.1 Reason taxonomy

Twelve reasons, in triage order, plus a free-text-only escape. The list is a
**closed vocabulary shared with moderation** — `ReportReason` in
`packages/moderation/src/report.ts` is the same twelve names, and the code
below is the wire format. There is no translation layer, because a translation
layer is where "I am being sexually harassed" quietly becomes a scam report.

The length is deliberate: a taxonomy is a classifier, and a person who is being
harassed is not going to scroll a menu of thirty categories. Every reason maps to
at least one moderator play, or it does not ship.

| Order | Code (`ReportReason`) | Shown to the user as | Play it maps to |
|---|---|---|---|
| 1 | `threats_or_violence` | "Threatening me or someone else" | **immediate**: 4-hour target; content + behaviour review; warn/restrict/ban ladder |
| 2 | `non_consensual_intimacy` | "Sending me sexual content I did not agree to" | **immediate**: 4-hour target; evidence preserved; restrict/ban ladder |
| 3 | `minor_safety` | "I think this person may be under 18" | **immediate**: 4-hour target; escalated queue, human triage, identity evidence pull |
| 4 | `hate_or_discrimination` | "Hate speech or targeting me because of who I am" | content preservation; 24-hour target; restrict/ban ladder |
| 5 | `unsafe_contact` | "Pressured me to move off Been There, or used my personal details" | contact-safety review; 24-hour target; restrict |
| 6 | `sexual_content` | "Sexual content that upset me" | content review; restrict |
| 7 | `harassment` | "Harassment or threats" | content + behaviour review; warn/restrict/ban ladder |
| 8 | `impersonation` | "Pretending to be someone else" | identity review; 24-hour target; ban ladder |
| 9 | `scam_or_solicitation` | "Scamming, or asking me for money" | identity + message review; ban ladder |
| 10 | `fake_or_misleading_profile` | "Their profile is fake or misleading" | profile review |
| 11 | `spam` | "Spam" | bulk review |
| 12 | `other` | "Something else" | free text required for this reason only |

**What changed, and why the earlier seven were wrong.** An earlier draft of this
section offered seven codes — `harassment`, `hate`, `sexual_content`, `scam`,
`minor`, `unsafe_contact`, `other` — while moderation triaged eleven. Four were
the same report under a shorter name, one (`unsafe_contact`) existed in no
vocabulary at all, and five that a member can plainly file — threats,
non-consensual intimacy, impersonation, a fake profile, spam — were not
offerable. A menu that cannot express a report does not prevent it; it routes it
into `other` or into the nearest wrong reason, and both mis-triage.

`unsafe_contact` is now in the taxonomy, at `high` priority and person-safety.
Folding it into `scam_or_solicitation` would have triaged a report about being
steered into an unmoderated channel at `normal` with no person-safety flag.

Design constraints on the taxonomy:

- No reason mentions an internal state, a detector, a score, or a likelihood.
- Reasons are phrased as **what happened to me**, never as an accusation
  ("you are a scammer"), because the subject sees nothing — but because the
  reporter must be able to say it out loud without a false accusation on record.
- The list is a closed set in v0.1. A new reason is a schema change in
  `packages/moderation`, reviewed like any other state change, and must ship
  with the moderator play it maps to. A reason that is not in `ReportReason`
  cannot be sent.

### 5.2 Optional free text

- Optional for every reason except `other`, where it is required.
- Maximum 500 characters, plain text, no formatting. It is treated as
  untrusted input: length-capped, escaped, and never rendered as HTML anywhere.
- Sensitivity `restricted`. It is **never** shown to the reported user, in whole
  or in part, in any state, ever. §8.
- It is attached to the case as author-supplied context and is clearly labelled
  as such in the moderator view, because "user said this" and "detector found
  this" must never be visually conflated.

### 5.3 Evidence captured automatically

Captured at report time by the system, without the reporter doing anything.

```ts
// contract sketch — the bundle Moderation receives when a report is opened.
interface ReportEvidenceBundle {
	readonly reportId: ReportId;
	readonly caseId: CaseId; // a case is opened by the report, atomically
	readonly reason: ReportReasonCode;
	readonly freeText: string | null;
	readonly createdAt: Date;
	readonly subject: { readonly subjectId: SubjectId; readonly accountState: AccountState; readonly identityState: IdentityState };
	readonly reporter: { readonly reporterId: ActorId; readonly anonymousToSubject: true }; // always true, not a user choice
	// Provenance — where the report came from.
	readonly origin:
		| { readonly kind: 'profile' }
		| { readonly kind: 'message'; readonly conversationId: ConversationId; readonly messageId: MessageId }
		| { readonly kind: 'conversation'; readonly conversationId: ConversationId };
	// Automatically captured evidence.
	readonly profileSnapshot: ProfileSnapshot; // see below
	readonly conversationExcerpt: MessageExcerpt[] | null;
	readonly timings: {
		readonly reportedAt: Date;
		readonly matchCreatedAt: Date | null;
		readonly conversationCreatedAt: Date | null;
		readonly lastMessageAt: Date | null;
	};
}
```

| Evidence | Contents | Why it is there | Sensitivity |
|---|---|---|---|
| **Profile snapshot** | display name, age band, bio, prompts, photo ids + content hashes as they were at report time, coarse distance bucket, join date, verification state at that time | the profile changes; a moderator must judge what the reporter actually saw | `restricted` |
| **Conversation excerpt** | the reported message, plus up to 5 messages of context on each side, both directions, with author ids and timestamps | an isolated message is not evidence of a pattern | `restricted` |
| **Whole-conversation bundle** | for a `conversation`-origin report: the full retained history of that conversation | "report this conversation" means the conversation | `restricted` |
| **Timestamps** | match time, first/last message time, reported time, prior reports by this reporter about this subject | cadence and repeat-offender are the two things a moderator needs first | `restricted` |
| **Subject's standing** | `AccountState`, `IdentityState` | so the moderator knows what they are deciding about | `internal` |
| **Prior moderation history** | prior cases about this subject, their outcomes, prior blocks by this reporter | a second case changes the decision | `restricted` |
| **Signal context, clearly separated** | risk state, contributing detector names | useful, but shown in a separate panel from the evidence so it cannot pre-frame it | `internal` |

What is **not** captured: exact coordinates, verification artefacts, the
reporter's identity evidence, or anything the reporter did not put in front of
the moderator. Snapshot semantics mean later profile edits do not rewrite the
record.

### 5.4 Reading it in 30 seconds — the interaction budget

The requirement is that a report be understandable **and submittable** in under
30 seconds. Budget, from any entry point:

| Step | Budget | Detail |
|---|---|---|
| Reach "Report" | ≤ 2 taps, 0 page loads beyond the current screen | message overflow menu, conversation header, profile overflow, or the Past-conversations row |
| Pick a reason | 1 tap, 1 screen | twelve rows, no submenus, no scrolling on a 5" screen — the first four are the urgent ones and are at the top |
| Add context | optional, skippable without penalty | 500 chars, no attachment picker in v0.1 — attachments would break the 30s budget and add a second upload path |
| Submit | 1 tap | single button, `Submit report` |
| Confirm | immediate, inline | `SAFETY_REPORT_SENT` plus a reference code, on the same screen |

Totals: **≤ 5 taps, 1 screen, ≤ 30 seconds**, and no required field beyond the
reason. Nothing in the flow asks the reporter to decide whether their report
"counts", to describe severity, or to answer follow-up questions. There is no
moderator-in-the-loop between submit and case creation: the case exists the
moment the report does.

The moderator side of the 30 seconds: the case view renders **evidence first**
— snapshot and excerpt at the top, in full, no scrolling past a wall of
metadata — with the signal context below it in a visually separate panel.

## 6. Reporting after unmatch — a first-class flow

This is the flow most often designed as an afterthought, and it is the one that
decides whether evidence is usable. It is specified here as a named flow with
its own entry points, its own empty state, and its own retention rules.

### 6.1 Entry points

A user who has unmatched can reach a report from **four** places, all of which
must exist in v0.1:

1. **Past conversations** (`messaging-experience.md` §6.1) — every ended
   conversation is a row with a Report action. This is the primary entry point
   and it is the reason history is retained (§6.3).
2. **The conversation screen itself**, after the unmatch, on the read-only
   thread — a persistent `Report this conversation` action in the header.
3. **The counterpart's profile snapshot reached from that history**, with
   `Report this profile` — so a user who never liked the message but disliked
   the profile can still report the profile.
4. **Notification history** (issue #16) — for a message that arrived after the
   unmatch and was suppressed, the notification deep-links to the same
   read-only thread rather than a dead end.

Empty-state copy when there is nothing to report from a row that was removed
from history: `SAFETY_REPORT_HISTORY_EXPIRED`, which says the conversation is no
longer available to attach and offers a profile-only report. The flow never
dead-ends and never silently disappears.

### 6.2 Retention rules

Stated as rules, because these are the ones that will be got wrong:

1. **Unmatch ends the relationship, not the record.** `match.status` becomes
   `ended_unmatched`; the message history and the profile snapshot are
   retained, read-only, and reportable.
2. **The evidence bundle is retained independently of the relationship.** It
   does not live on the match object, so tearing the match down cannot tear it
   down.
3. **The right to report survives unmatch.** There is no time limit measured
   from the unmatch; the limit, when it exists, is the evidence retention
   period, and it is a single number, stated once, in one place.
4. **The right to report survives a block in either direction.** Being blocked by
   someone does not remove your ability to report them. Blocking is not a
   shield.
5. **The right to report survives the other party's account deletion.** If the
   subject deletes their account after you unmatched, the retained bundle and
   your right to file a report against them persist. A subject cannot launder a
   complaint by closing their account; the case is opened against a subject id,
   not against a live profile.
6. **Report creation outlives the reporter's own account deletion** for the same
   reason: once a case exists, it belongs to moderation.
7. **A block is not an erasure.** Blocking does not delete messages, does not
   delete the snapshot, and does not shorten any retention clock.
8. **Nothing here extends to content that the platform never held.** v0.1 has no
   media messages, so there is no media to retain or lose.

The retention period itself is an open question in the overview (it needs a
regulatory answer, not a technical one). The product rule stands regardless of
its value: whatever it is, it is never shorter than the platform's own ability
to answer a safety complaint, and it is never shortened by an unmatch, a block,
or a deletion.

Operationally: the thread stays readable to both parties (see
[`messaging-experience.md` §6.3](./messaging-experience.md)), the snapshot is
immutable so a moderator months later judges what the reporter actually saw,
and a report filed against a conversation id resolves its subject from the
retained record even if the account is gone.

## 7. Who is told what

### 7.1 The reporter is told

| Situation | Copy id | Content |
|---|---|---|
| Report submitted | `SAFETY_REPORT_SENT` | Received; a person reviews reports; reference code; what happens next; that they can add information to the same case while it is open |
| Already reported, duplicate | `SAFETY_REPORT_DUPLICATE` | Already received; the existing case continues; reference code |
| Rate limited | `SAFETY_REPORT_RATE_LIMITED` | Too many reports in a short window; retry time; "if you are in danger, contact local emergency services" |
| History no longer available | `SAFETY_REPORT_HISTORY_EXPIRED` | The conversation can no longer be attached; the profile can still be reported |
| Enforced on the subject, subject still active | `SAFETY_SUBJECT_ACTIONED` | We reviewed it and took action. **No** description of the action, the level, or its timing |

Rules for reporter-facing copy:

- Never a count, never "your report was closed", never "we could not find a
  problem". A closed case is a moderator judgement about sufficiency; telling the
  reporter would be a dead end and would discourage future reports.
- A reference code is issued on every accepted report, including a report that
  is later closed, so the reporter has something to quote in support.
- The reporter can add information to an open case. They cannot reopen a closed
  one; that is a P1 appeals path.

### 7.2 The reported user is told: nothing identifying, ever

**Decision: the subject of a report is never told that a report exists.** Not
the fact, not the count, not the timing, not the reason, not the reporter, not
an aggregate.

This is absolute, and it is the reason the product read-model can be trusted:

- A "someone reported you" surface is an attack surface. It invites retaliatory
  reports against the reporter (whose identity the attacker does not know, but
  whose existence they can now infer), and it converts a safety tool into a
  harassment tool.
- Report counts are the most easily gamed number in the system. Exposing them
  makes them worth attacking.
- The overview's rule is the same rule: the only thing enforcement publishes
  outward is `account_state.changed`, and a dating client must not be able to
  infer that a user was reported, reviewed, or restricted. A report-received
  notification would break that at the transport layer.

What the reported user **may** be told, in exactly one circumstance: that an
enforcement decision was made about their account, with the enforcement copy from
§10 — because they have to know what happened to them and what to do next. That
copy describes the **decision**, not the report that prompted it. `warn` in
particular is a state change with no account-state change, and it is delivered
as a neutral `SAFETY_ACCOUNT_WARNING` that names the behaviour and the rule,
never the reporter, the case, the evidence, or the outcome for anyone else.

## 8. Anonymous reporting — decision and tradeoffs

**Decision: v0.1 has no user-selectable anonymous reporting. Reporter identity is
always available to the moderation role, always `restricted`, always
per-access-logged, and never disclosed to the subject.**

Tradeoffs, stated rather than hidden:

| In favour of an anonymous toggle | Against it |
|---|---|
| Lower perceived cost of reporting abuse by a person you still match with | A toggle is a promise about the *system*, not just about the subject, and we cannot keep it against compelled disclosure |
| Higher volume of reports from victims who fear consequences | Creates a privileged reporter class whose reports need heavier triage, and that class is unappealable |
| Deterrent against retaliation | The property that actually matters is that the subject can never learn who reported — which §7.2 guarantees unconditionally, with or without a toggle |

The decisive argument: the safety property we need is *the subject cannot learn
who reported me*. That is achieved by never disclosing, for every report, at
every stage. A user-facing "anonymous" toggle buys no additional protection
against the subject while adding a promise the platform cannot structurally keep
— and a promise that quietly fails is worse than no promise, because the
retaliation it was meant to prevent then happens.

Countermeasures that replace the toggle, and are in scope:

- **Subject can never learn reporter identity**, unconditionally (§7.2).
- **Per-reporter rate limits** on reports, with a hard cap, so the report queue
  cannot be flooded by one account.
- **Corroboration weighting** in the case view: a first report from an account
  with no history is presented as evidence, not as a verdict, and a report
  spree against many subjects is visible to moderators as a pattern.
- **Report immutability**: a report cannot be edited or withdrawn by the subject
  under any circumstance.

Revisit when appeals ship: a user appealing their own enforcement needs to be
able to face the evidence against them, and that changes what "anonymous" can
mean.

## 9. Reporting without a match, and reporting a whole conversation

Three distinct intakes, because they produce different evidence and different
triage.

### 9.1 A profile you never matched with

Available from the profile overflow menu on any profile card or profile screen —
`Report this profile` is one of the two overflow items, next to `Block`.

- Open to any authenticated user who can see the profile. It is **not** gated on
  a match, on `send_message`, or on discovery eligibility: the user who was
  catfished on a profile is exactly the user who is not matched to anyone.
- No conversation excerpt. The evidence is the profile snapshot (§5.3), the
  report time, and the reporter's position in discovery (which card, which
  surface), which tells the moderator whether this was a targeted encounter or
  a browse.
- Rate limited like any other report, but the rate limit is per-reporter and
  generous enough that a legitimate user reporting ten profiles is not stopped;
  the limit targets floods, not enumeration.
- A profile report does **not** notify or remove the profile. Visibility
  changes, if any, are a moderation decision with a `caseId`.

### 9.2 A single message

- Entry: the message overflow menu in the conversation, and the conversation
  header's `Report` (which defaults to the most recent message and lets the
  reporter pick a different one).
- Evidence: the reported message plus ±5 messages of context in both directions
  (§5.3). A single message reported without context is still actionable — the
  context exists so the moderator does not have to ask.

### 9.3 A whole conversation

- Entry: the conversation header's `Report conversation`, and the Past row's
  `Report`.
- Evidence: the full retained history of the conversation, both directions,
  plus timings and the profile snapshot as it was at match time.
- Semantics: "the pattern is the problem", not a specific line. The moderator
  sees the whole thread on one screen.
- Available after unmatch, after a block in either direction, and after the
  subject's account is deleted, exactly as §6.2 requires.

### 9.4 What is never reportable

- A block is not a report, and reporting is not a block. They are separate
  actions with separate records and separate effects.
- A user cannot report a *risk state*, a *detector*, or an *internal* reason.
  Those are not user-visible objects.
- A user cannot report "unmatch" as a violation. Unmatch is a right.

## 10. Copy catalogue

Rules applied to every string below:

- **No dead ends.** Every message says what happened and what to do next.
- **No accusatory language.** The user is told what the platform did, not what
  they did wrong.
- **No internal state.** No risk level, no detector, no case, no moderator, no
  report count, no score. A user cannot read their own risk state from a string.
- **No unverifiable promises.** "We will review this" is fine; "we will respond
  within 24 hours" is not, because nothing in the system makes it true.
- **No urgency theatre.** The one place urgency is warranted (immediate danger)
  is §10.1 `SAFETY_REPORT_RATE_LIMITED`, and it points at emergency services.

Placeholders: `{name}` display name, `{ref}` report/case reference code,
`{time}` a human-readable relative duration, `{date}` a calendar date.

### 10.1 Block and report

| Id | Trigger | Audience | Copy |
|---|---|---|---|
| `SAFETY_BLOCK_CONFIRMED` | I blocked someone | me | "You blocked {name}. You can no longer message them, they cannot message you, and you will not see each other in discovery. Your past messages are kept. You can still report anything they did before you blocked them." + action `Report` |
| `SAFETY_BLOCK_RECEIVED` | I was blocked | them | "{name} ended contact with you. You can no longer send them messages and they can no longer reach you. Your past messages are kept. If they said or did something that concerned you, you can still report it." + action `Report` |
| `SAFETY_UNBLOCK_CONFIRMED` | I unblocked | me | "You unblocked {name}. Your past messages are still here. They are not told that you unblocked them." |
| `SAFETY_REPORT_SENT` | Report submitted | me | "Report received. A person on our safety team reviews every report, and this one is now in the queue. Your reference is {ref}. We will not tell you what we decide, or who reported you, and we will never tell them who you are. If you remember something else, you can add it to this report while it is open." + actions `Add detail`, `Done` |
| `SAFETY_REPORT_DUPLICATE` | Second report on the same thing | me | "You have already reported this, and that report is still with our safety team. Your reference is {ref}. We have not lost it." |
| `SAFETY_REPORT_RATE_LIMITED` | Report rate limit hit | me | "You have sent a lot of reports in a short time, so we have paused the button for {time}. Your earlier reports are still with our safety team. If you are in immediate danger, contact your local emergency services now." + action `Try again` |
| `SAFETY_REPORT_HISTORY_EXPIRED` | Conversation no longer attachable | me | "We can no longer attach the messages from that conversation. You can still report this person's profile, and our safety team will see what we still have." + action `Report profile` |
| `SAFETY_SUBJECT_ACTIONED` | Enforcement taken on the subject | me | "We reviewed the report you sent and took action on that account. We are not able to share what the action was. Thank you — reports like yours are how problems on Been There get found." |
| `SAFETY_ACCOUNT_WARNING` | A `warn` was issued (state unchanged) | them | "A member of our safety team has reviewed your activity and asked you to change how you use Been There: {behaviour_summary}. Please read our community rules. If you keep going, your account will be limited and you will not be able to message. This is not a decision about your identity, and it is not permanent." + action `Read community rules` |

`{behaviour_summary}` is drawn from a fixed catalogue of moderator-authored
phrasings (e.g. "messages that pressure others to move off Been There", "repeated
messages after someone has asked you to stop"). It describes the **behaviour**,
never the evidence, never the reporter, never a count.

### 10.2 Account states (owned by #15, listed here for completeness)

Full copy, states and next steps: [`account-restrictions-and-reverification.md`](./account-restrictions-and-reverification.md) §6.

| Id | Trigger | Copy (abbreviated) |
|---|---|---|
| `SAFETY_ACCOUNT_RESTRICTED` | `limited` | "Your account is limited, so {removed_capabilities} is switched off. You can still {retained_capabilities}. Existing matches and messages are kept. A member of our safety team made this decision and it can be changed if the situation does. Your reference is {case_ref}." |
| `SAFETY_ACCOUNT_SUSPENDED` | `suspended` | "Your account is paused. You cannot message or appear in discovery. Your profile and messages are kept and return in full if your account is reinstated. You can still report a problem, and you can still delete your account. Your reference is {case_ref}." |
| `SAFETY_ACCOUNT_BANNED` | `banned` | "Your account has been closed by a member of our safety team because of {behaviour_summary}. You cannot use Been There. You can still delete your account and its data, and you can still report a problem you have experienced. Your reference is {case_ref}." |
| `SAFETY_ACCOUNT_REINSTATED` | `reinstate` / `lift_restriction` / `lift_ban` | "Your account is active again. Everything you had is where you left it. Your reference is {case_ref}." |

`{removed_capabilities}`, `{retained_capabilities}` and `{case_ref}` all come
from the enforcement events, none of them from a local capability table:
`moderation.restriction_applied` (or `moderation.restriction_lifted`) carries
`{ caseId, decisionId, accountState, removedCapabilities }` at `user`
clearance, and `account_state.changed` carries the effective set at `public`.
Naming the reference is what makes the notice contestable — see
[`account-restrictions-and-reverification.md`](./account-restrictions-and-reverification.md)
§6.4. It names the case; it never names the reporter, the evidence, the
moderator or the reason.

### 10.3 Verification states

| Id | Trigger | Copy |
|---|---|---|
| `SAFETY_VERIFICATION_REQUIRED` | Identity not `verified`, and something needs it | "Been Here is for verified people only, so we need to check one selfie before you can appear in discovery or message anyone. It takes about two minutes." + action `Verify now` |
| `SAFETY_VERIFICATION_FAILED` | `verification_failed` | "We could not verify that selfie. That usually means the lighting was poor or the photo did not match your profile photos. This is not a strike, and it does not affect anyone you have already matched." + action `Try again`, which becomes `Try again in {minutes}` when the attempt limit is reached |
| `SAFETY_VERIFICATION_RATE_LIMITED` | `rate_limited` on an attempt or a retake | "You have tried a few times in a row, and each try only gets as far as the same place. You can try again {retry_at} — we are not counting this against you." + action `Try again` once the time arrives |
| `SAFETY_VERIFICATION_REVIEW` | `review_required` | "We are checking your verification by hand. This usually takes under a day. You can keep using the app while we do, and nothing you have already done is affected." |
| `SAFETY_REVERIFICATION_REQUESTED` | `reverify_requested` (see #15 §7) | "We need to check your identity once more. It takes about two minutes and nothing else about your account changes." + action `Verify now` |

Two of these are the important ones. A re-verification is an **automated,
reversible** friction (ADR 0004), so its copy must not read as an accusation, and
must not say why it was triggered. A user must not be able to infer their own
risk state from the fact that they were asked to re-verify — that is why the
trigger is not named.

**The retry copy is not allowed to promise a retry the policy will refuse.**
`ATTEMPT_POLICY` allows five attempts in a rolling day and a 15-minute cooldown
on retaking one artefact, and both refusals carry a `retryAt`. A `Try again`
button that is greyed out three times out of five is a broken promise to a person
who has just been told their selfie did not work, so the button renders the time
the limit lifts rather than a flat invitation. Five a day is generous for a real
bad-photo problem and cheap to hold; it is there to stop an unattended endpoint,
not to ration a person's afternoon.

## 11. Contract sketches

Descriptive only; the implemented types live in `packages/moderation`.

```ts
// contract sketch — the same twelve names as `ReportReason`. There is no
// user-facing subset to map onto: the menu in §5.1 is a presentation of these.
type ReportReasonCode =
	| 'harassment'
	| 'hate_or_discrimination'
	| 'threats_or_violence'
	| 'sexual_content'
	| 'non_consensual_intimacy'
	| 'minor_safety'
	| 'unsafe_contact'
	| 'scam_or_solicitation'
	| 'impersonation'
	| 'fake_or_misleading_profile'
	| 'spam'
	| 'other';

interface BlockRecord {
	readonly blockerId: SubjectId;
	readonly blockedId: SubjectId;
	readonly blockedAt: Date;
	readonly conversationIdAtBlockTime: ConversationId | null;
	readonly caseId: CaseId | null; // a block may be linked to a case; usually not
}

interface ReportSummary {
	readonly reportId: ReportId;
	readonly caseId: CaseId;
	readonly reference: string; // {ref} shown to the reporter
	readonly reason: ReportReasonCode;
	readonly origin: 'profile' | 'message' | 'conversation';
	readonly evidenceAttached: boolean;
}
```

`BlockRecord.caseId` is null for the ordinary case: **a block is not a case.**
It is populated only when the same tap is part of a moderation action. The field
exists so that a block performed inside an enforcement flow is still traceable
to its case; it does not imply that blocking opens one.

## 12. Acceptance scenarios

| #1 scenario | Given | When | Then |
|---|---|---|---|
| **4. Harassment** (primary) | a matched user receiving unwanted messages | they tap `Block` in the message menu | the effect is immediate and pairwise: no message crosses in either direction, neither appears in discovery, no notification is delivered; history is retained; the blocked user receives `SAFETY_BLOCK_RECEIVED` and still has a working Report action |
| 4. Harassment | the same user, before or after blocking | they tap `Report` on the message and pick a reason | within ≤5 taps and one screen a case exists with a reference code, the reported message plus ±5 messages of context, and the profile snapshot as it was; the reporter is told only that it was received |
| 4. Harassment | the same user after unmatching | they report from the Past-conversations row | the report is accepted; the retained history and snapshot are attached; the right to report is unaffected by the unmatch, the block, or the subject deleting their account |
| 4. Harassment | a user who has been blocked by the subject | they report the subject | the report is accepted — a block is not a shield — and the subject is told nothing about it |
| 3. Normal dating flow | two matched users | either unmatch and later reports | the conversation is read-only and reportable; the unmatch is not itself reportable, and no one is reported for unmatching |
| 5. Malicious account | a subject who blocks many people in a pattern | the pattern is observed | a **signal** is raised for Trust & Safety; no account state changes; no automatic enforcement occurs |
| 6. False positive | a reported user who is found to have done nothing | the case is closed | the user sees nothing at any point; no notification, no counter, no timing change; the reporter sees only `SAFETY_SUBJECT_ACTIONED` if action was taken, and nothing if it was not |
| 2. Fake-profile attempt | a profile a user never matched with | they report the profile | the report is accepted, a snapshot-only evidence bundle is created, and no conversation evidence is fabricated for a conversation that does not exist |
| 4. Harassment | a member whose account has been restricted | the state screen renders | `{capability_line}` comes from the published `removedCapabilities` and `{case_ref}` from the `user`-clearance `moderation.restriction_applied` event. No local capability table, no hidden case id, and the appeal route is the `appeal_request` capability the state grants |
| 4. Harassment | a member who has used five verification attempts in a day | they tap `Try again` | the action is disabled with `Try again in {minutes}`, from the `retryAt` on the `rate_limited` refusal. The copy never offers a retry the policy has already refused |

## 13. Open questions

- Retention period for report evidence bundles and for the message excerpts
  inside them. Blocked on a regulatory answer per market; the overview already
  records this gap. The rules in §6.2 are stated so that the *answer* is one
  number, not a re-litigation.
- Whether a `minor_safety` report should be time-boxed to minutes rather than
  hours. Currently a human-triage-only queue at the 4-hour `urgent` target; a
  fast lane is a staffing decision, not a design one, but it is a real one.
- Whether the reporter should ever be able to add evidence to a **closed** case.
  §7.1 says no in v0.1; reopening is coupled to the appeals work in P1.
- Whether an explicit "this account is new" signal is useful to moderators for
  un-matched profile reports. The join date is already in the snapshot; whether
  to surface it is a moderator-tooling question (#7).
- What `behaviour_summary` phrasings belong in the warn catalogue, and who
  authors them. Needs a review step, because this string is the closest thing
  v0.1 has to an accusatory message and it must never become one.
