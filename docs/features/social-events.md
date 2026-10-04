# Feature — Social Events

> Issues [#50](https://github.com/katzimoto/been_there/issues/50) (shared model
> and drafts), [#51](https://github.com/katzimoto/been_there/issues/51)
> (publishing, discovery, lifecycle), [#52](https://github.com/katzimoto/been_there/issues/52)
> (Host Chat Event), [#53](https://github.com/katzimoto/been_there/issues/53)
> (Open Chat Event). Parent: [#32](https://github.com/katzimoto/been_there/issues/32).
> Safety model: [`../architecture/event-chat-safety.md`](../architecture/event-chat-safety.md) —
> which decides the questions [#51, #52 and #53 raise, and is the authority this
> document builds on.
> Authority: [`../architecture/00-overview.md`](../architecture/00-overview.md). If this
> document contradicts it, that document wins and this document is wrong.
>
> **Status: nothing in this track is built.**
> [`../delivery-state.md`](../delivery-state.md) records #48–#53 as deferred to a
> later version by decision. There is no event domain, no event migration and no
> route module for events under `packages/service/src/routes/`; the twenty-two
> modules there are accounts, conversations, discovery, moderation, reports and
> the rest, and none of them mentions an event. Every state and event name below is
> **this document's proposal**, to be registered rather than re-declared.

## 1. Goal and done-when

**Done when:** a creator can prepare, publish and run either an event type; an
eligible user can discover it, join it while it runs, and start the conversations
that type allows; the lifecycle follows the schedule and the creator's actions
reliably across retries, reconnects and restarts; and every conversation is
governed by exactly the same verification, restriction, block, report and evidence
rules as a match conversation.

The properties that make it true, in the order they matter:

1. **Event messaging is the one place the match gate does not apply, and it is
   bounded by the event.** The event is the authorisation. When it ends, the
   authorisation goes with it (§7.4).
2. **An event conversation is an event conversation forever.** It is not a match,
   it never appears in the match list, and it never increments the completed-date
   counter (§8).
3. **Every existing commitment still applies to a participant.** Nothing about
   joining an event weakens `verified`-only, account standing, block dominance or
   the unrestrictable floor of `report` and `block`.
4. **The two event types share one lifecycle.** Scheduling logic exists once.

## 2. Boundaries

### 2.1 What this feature owns

| Owned | Issue |
|-------|-------|
| Event type selection at draft time, and the common event record: creator, type, title, description, scheduled start, status | #50 |
| The creator's own drafts: create, save, reopen, edit, delete, resume across sessions | #50 |
| Publishing, browsing published events, and the lifecycle `draft → published/scheduled → live → ended` plus cancellation | #51 |
| Participation: joining, the participant set, and exposing the current lifecycle to each type | #51 |
| The two type-specific chat rules: host-to-participant (#52) and participant-to-participant (#53) | #52, #53 |
| The rate cap on host-initiated conversations, and its visibility to the host | #52, from `event-chat-safety.md` §1 |

### 2.2 What this feature never owns

| Never owns | Owner instead |
|-----------|---------------|
| Verification and identity evidence | Identity & Verification. A participant is `verified` or they are not eligible to join |
| `AccountState`, capabilities, restrictions | Moderation & Enforcement, read as a capability set. An event cannot make a restricted account able to send |
| Blocks | User Safety Controls. An event is never a way around a block, including for a host |
| Reports, cases, evidence, retention of evidence | Moderation & Enforcement. An event conversation is reportable with the same evidence rules as any other |
| Conversation and message state, the send gate, message retention | Communication, [`../architecture/communication.md`](../architecture/communication.md). §7 states the change this feature forces on it |
| Matches, likes, passes, the match list | Likes & Matching. §8 |
| The completed-date counter | [`./profile-and-personalization.md`](./profile-and-personalization.md) §9. #52 and #53 both forbid it |
| Discovery eligibility | Dating Core, [`./preferences-and-discovery.md`](./preferences-and-discovery.md). The event list applies the same eligibility, and re-derives none of it |
| Notification delivery and quiet hours | [`./notifications.md`](./notifications.md) |
| Coarse location and the distance band | Platform, [`../architecture/platform.md`](../architecture/platform.md) §7 |

### 2.3 Which piece of state is whose

| State | Owner | How this feature learns about it |
|-------|-------|----------------------------------|
| Event record, lifecycle, participation | **this feature** | local |
| `IdentityState` | Identity & Verification | `identity.status_changed` → the standing projection |
| `AccountState` + capabilities | Moderation & Enforcement | `account_state.changed` → the standing projection |
| Block edges | User Safety Controls | the block list projection |
| Conversation, messages, send authorisation | Communication | through the send path in §7 |
| Report and evidence availability | Moderation & Enforcement | never written here; only the entry point is kept alive |

## 3. What is shared and what belongs to each type

| Concern | Shared (#50, #51) | Host Chat (#52) | Open Chat (#53) |
|---------|-------------------|------------------|------------------|
| Draft, fields, ownership | the creator's own, private | — | — |
| Publishing, schedule, lifecycle | yes | reuses it | reuses it |
| Participation | yes | reuses it | reuses it |
| Who may message whom | — | host ↔ participant only | any two participants |
| Type-specific extra details | — | none beyond the common fields in v0.1 | none beyond the common fields in v0.1 |

**Adding a third event type must not duplicate drafts, scheduling or
participation.** #50 states this as an acceptance condition and it is the reason
the common record is separated from the type's chat rules. A new type adds a chat
rule and reuses everything above; anything else is a bug.

## 4. Drafts (#50)

| Rule | Statement |
|------|-----------|
| Type is chosen at draft time | `host_chat` or `open_chat`, and it is fixed once the event is published |
| Incomplete is allowed | A draft may be saved without a title, a description or a start time. Saving a draft is not publishing it |
| Private to the creator | Another user can neither read nor modify it, and a draft is never listed anywhere public |
| Durable across sessions | A draft reloads from the store, not from the client |
| No side effects | Saving a draft produces no publication, no invitation, no notification and no counter movement |
| No duplicates on retry | Draft creation takes a caller-supplied retry key, the same rule the completed-date counter uses ([`./profile-and-personalization.md`](./profile-and-personalization.md) §9.5) |

Deletion of a draft is an ordinary delete: it is the creator's own unsent work and
nothing has ever derived from it.

## 5. Lifecycle (#51)

```
draft ──publish──▶ published ──scheduled start──▶ live ──creator ends──▶ ended
  │                    │
  │                    └──creator cancels────────▶ cancelled
  └──delete──▶ (none)
```

| Rule | Statement |
|------|-----------|
| Publication is gated | A draft publishes only when the common requirements and the type's requirements are both satisfied |
| Live is scheduled | The event goes live at its scheduled start |
| End is the creator's | The creator ends the event; the `live → ended` transition is theirs, so the record reflects what happened rather than what a timer inferred |
| Cancellation is the creator's | From `published` or `live`, and it stops new conversations at once (§7.4) |
| The messaging window has a hard default | **Messaging closes at the scheduled start plus a stated duration, whether or not the creator ended the event.** This is the one automatic behaviour, and it is decided in `event-chat-safety.md` §"The two open questions, decided" |
| Correct across restarts | The lifecycle is derived from the schedule and the creator's actions on every read, so a process that dies mid-event resumes in the state the clock and the record say |

**The stated duration is a product parameter and has no value.** It is the one
number in this document that is deliberately absent; inventing one here would
settle a question #51 raised. Recorded in §14.

**The current lifecycle is exposed to each type.** #51 requires it, and each type
enforces its own participation rule from it. The shared layer decides *when*; the
type decides *what a participant may do then*.

## 6. Participation and the participant list

Joining requires what every other surface in the product requires: a `verified`
identity, an account in good standing, no block in either direction between the
joiner and the creator, and a published or live event. Any of these can fail
before the join and at the moment of the join.

**The participant list is a discovery surface and is bounded accordingly**
(`event-chat-safety.md` §2):

| Rule | Statement |
|------|-----------|
| Membership | Exactly the participants who have joined **this** event. Empty for an event you have not joined |
| Filtering | The same eligibility the discovery feed applies — re-evaluated, not copied |
| Fields | **Nothing beyond what a match-eligible discovery card shows.** No location, no last-seen, no contact details, no exact age |
| Enumeration | Not paginated into something enumerable. An event with a hundred participants is not a hundred-page directory |
| Event location | An event has a place. Being at an event is not a position inside it, so participation reveals no coordinate |

The event's own location is shown at the coarseness the platform already uses for
location ([`./privacy-and-user-settings.md`](./privacy-and-user-settings.md) §3).
Whether an event's place is a named venue, a coarse band or free text is a copy
question recorded in §14.

## 7. Event conversations

### 7.1 The structural change, stated plainly

Every conversation in this repository is match-derived. `Conversation` carries a
`matchId` and is constructed only by `startConversation(match, at)`
(`packages/communication/src/conversation.ts:113-133`), and the send gate checks
that the match projection describes *that* conversation and that the match is
active (`packages/communication/src/permissions.ts:111-130`, rules
`match_not_for_conversation` and `match_not_active`).

An event conversation has no match. **So this feature requires Communication to
grow a conversation that is bound to an event rather than to a match, and that is
the single largest change this track makes to an existing domain.** It is stated
here rather than discovered during implementation, because the alternative —
letting an event conversation borrow a match record it does not have — would put
an event conversation into the match list, which §8 forbids and which
`event-chat-safety.md` §3 calls out specifically.

### 7.2 The conversation record

Same shape as today's, with one addition and one rule:

- `conversationId`, `participants` as the ordered pair, `state`, `openedAt`,
  `stateChangedAt`, `lastMessageAt` — unchanged, and still the five states of
  `conversationMachine`: `active`, `blocked`, `frozen_by_restriction`,
  `ended_by_unmatch`, `ended`
  (`packages/communication/src/conversation.ts:41-46`). `ended_by_unmatch` is
  unreachable here — an event conversation has no match to unmatch — and its
  existence in the table is a reminder that this type is the one conversation
  kind that will never carry it
- **plus** the event it belongs to, permanently and visibly
  (`event-chat-safety.md` §3)
- and a **rule**: an event conversation never appears in the match list, in any
  match count, or in anything that counts matches

### 7.3 The send gate, in order

The existing gate is an ordered list and the order is the specification
(`packages/communication/src/permissions.ts:91-204`). For an event conversation the
order is the same, with the match-derived pair replaced:

1. **Block, either direction** — refused. A host may not message a participant who
   blocked them, and an event is not a way around it.
2. **Participation** — the sender must be a participant in this conversation.
3. **Binding** — the event-conversation projection must describe *this*
   conversation and *this* event. Replaces `match_not_for_conversation`.
4. **Event state** — the event must be `live`, and the messaging window (§5) must
   be open. Replaces `match_not_active`.
5. **Conversation state** — `isMessagingOpen(state)`, which is true only for
   `active` (`packages/communication/src/conversation.ts:151-154`).
6. **Standings identifiable** — a standing that could not be evaluated refuses, and
   fails closed.
7. **Capability** — the sender holds `send_message`
   (`packages/communication/src/permissions.ts:60`) and the counterpart is able to
   send. One rule, one code, one message over both participants, so neither can
   tell which of them it was about.

Rules 1, 2, 5, 6 and 7 are unchanged from today's gate. Rules 3 and 4 are the
substitution, and the substitution is the whole of the match-gate change: the
authorisation is *this live event, and these two people are in it*, instead of
*these two people matched*.

`report` and `block` are unrestrictable
(`packages/core/src/states/account.ts:87-89`), so nothing about an event can leave
a participant unable to protect themselves or to report.

### 7.4 After the event ends: read-only

**New conversations stop. Existing ones become read-only.** Decided in
`event-chat-safety.md` §"The two open questions, decided", for #52 and #53
alike, and the reasoning is in that document: the event was the authorisation, so
the ability to *start* goes when it ends, while history is retained and remains
reportable.

Concretely, on `live → ended` or on cancellation:

- no new event conversation may be created, by anybody;
- existing event conversations move to `ended` and refuse sends at rule 5 above,
  because `isMessagingOpen` is false for every state but `active`;
- history still reads for both participants, subject to the ordinary retention
  policy (`packages/communication/src/retention.ts:19-22`);
- a report still files, and the evidence still captures, because a report filed
  later must still have the conduct it is about;
- nothing is deleted. Read-only rather than deleted, for the same reason the audit
  log is append-only: a deletion is indistinguishable from a cover-up to whoever
  reviews it afterwards.

### 7.5 Host-initiated conversations are capped and visible

`event-chat-safety.md` §1: a host can now reach N people who never chose to be
reached individually. So:

| Rule | Statement |
|------|-----------|
| Cap | Host-initiated conversations are capped **per host, per event**. Not global: a popular host is not silently muted across every event they run |
| Shape of the rule | A sliding window, like `NEW_CONVERSATION_RATE_RULE` (10 attempts per hour, `packages/communication/src/friction.ts:42-46`) — a rate limit bounds how fast a user acts and expires; it is not a cap on what a user achieves, which #1 forbids |
| Visible to the host | The refusal is shown to the host, naming the rule. A silent cap is indistinguishable from a broken product |
| Not visible to the participant | A participant learns that a conversation began with the host — that is what makes it *visibly initiated* — but not that a cap was reached |
| Participant-initiated is uncapped by this rule | A participant messaging the host is not the scale risk; the host messaging the room is |

The participant can block or report the host without leaving the event.

### 7.6 What a participant may not do with the event

- **Host Chat (#52):** a participant cannot start a conversation with another
  participant. The event grants host-to-participant pairs and nothing else.
- **Open Chat (#53):** every conversation is one-to-one. The creator is a
  participant under the same rules as anyone else and gains no access to other
  people's conversations by being the creator.
- **Neither type:** no group conversation, and no cross-event messaging. An event
  conversation does not survive into another event, and participation in one grants
  nothing in another (`event-chat-safety.md` §"What is deliberately not built").
- **Neither type:** a `limited`, `suspended` or `banned` account cannot send,
  even if the restriction names a capability other than messaging. The
  unrestrictable floor covers `report`, `block` and `delete_account`; messaging
  itself is gated by the account's standing, which is separate and stricter.

## 8. What an event conversation never is

| It is not | Consequence |
|-----------|------------|
| A match | Absent from the match list, from match counts, and from anything that counts matches |
| A completed date | **Never** increments the counter ([`./profile-and-personalization.md`](./profile-and-personalization.md) §9). Both #52 and #53 say so explicitly, and §7.3 there states that no interaction of any kind is an input to it |
| A discovery surface | The participant list is bounded (§6), and an event never widens what anyone can see elsewhere |
| A location disclosure | The event has a place, not a position |
| An unreportable conversation | Reportable and case-able from the moment it exists, with the same evidence retention as any other conversation |

**Labelling is permanent.** `event-chat-safety.md` §3 requires that an event
conversation be *"labelled as event-sourced everywhere it is rendered or
reviewed"*, so a moderator sees that a conversation began at an event without
reconstructing it. That is the same labelling requirement the avatar track's
open question 1 turns on
([`../decisions/avatar-introductions.md`](../decisions/avatar-introductions.md) §3),
which is noted here because the two features will share one mechanism and it
should be built once.

## 9. Evidence, retention and friction

- **Evidence.** `captureEvidence` requires a `caseId` and there is no unscoped read
  of message history, ever
  (`packages/communication/src/evidence.ts:70-102`). An event conversation is
  captured under the same rule; nothing about an event changes what a case can
  reach.
- **Retention.** The existing policy applies unchanged: full history for a
  participant for 180 days, case-scoped evidence for 365
  (`packages/communication/src/retention.ts:19-22`). Whether an *event* should be
  shorter-lived than a match conversation is a product question, recorded in §14
  and not answered here.
- **Messaging never judges content.** There is no classifier in the communication
  package and none is added by an event. An event conversation publishes the same
  `communication.message_sent` signal that Trust & Safety consumes, so a
  participant's behaviour inside an event is visible to safety on the same terms
  as their behaviour in a match conversation.
- **Friction is not enforcement.** The two existing sliding-window rules
  (`per_conversation_burst`, `new_conversation_burst`) apply to event
  conversations unchanged, and the host cap in §7.5 is a third of the same kind.

## 10. The question that remains open

`event-chat-safety.md` settles three questions that #51, #52 and #53 raised:

| Question | Answer | Where |
|----------|--------|-------|
| Does an event end automatically, or only when the creator says so? | **Creator-controlled, with a hard default** — the `live → ended` transition is the creator's; the *messaging* window closes automatically at the scheduled start plus a stated duration | `event-chat-safety.md` §"The two open questions, decided" |
| Do existing conversations stay writable after the event ends? | **No — new conversations stop, existing ones become read-only** | same |
| Was the disagreement between #52 and #53 real? | No. They disagreed only because neither had decided; one answer applies to both | same |

**The question that is still open, and it is the one above all the others:**

> **Whether event messaging may bypass the match gate at all.**

It is recorded in
[`../delivery-state.md`](../delivery-state.md) §"Decisions a human still owns" as
a human-owned decision, with the reason given there: *"It changes who can reach
whom."* `event-chat-safety.md` argues the product call — *"events where you
cannot talk to anyone are not events"* — and sets out the rules that make it
survivable. That is a safety model for a decision, not the decision.

Everything in §7 is therefore **conditional on that question being answered
yes**. This document specifies what the feature is if it is, and does not assume
it is. If the answer is no, the whole of §7 is withdrawn and §4, §5, §6 and the
lifecycle stand on their own.

## 11. Acceptance scenarios

**E1 — the shared lifecycle, both types.**
*Given* a creator with a draft of either type,
*when* they publish it and it reaches its scheduled start,
*then* it is live, another eligible user discovers and joins it, the creator ends
it, and it is ended — with drafts still private and both types running on the same
lifecycle rather than separate scheduling.

**E2 — Host Chat, both directions.**
*Given* a host and two eligible participants in a live Host Chat Event,
*when* the host starts a conversation with one participant and that participant
starts one with the host,
*then* each has a separate private conversation with two-way messages, no prior
match was required, and the two participants cannot see or reach each other's
conversation.

**E3 — Open Chat, three participants.**
*Given* three eligible participants in a live Open Chat Event,
*when* each starts a conversation with the others,
*then* there are three separate one-to-one conversations, none readable by a
participant or the creator who is not in it, and a user outside the event cannot
use it to start one.

**E4 — verification, restrictions and blocks still govern.**
*Given* a `limited` participant, a `suspended` host and a pair with a block in
either direction,
*when* any of them tries to send, or a host tries to reach a participant who
blocked them,
*then* every attempt is refused, the refusals are the platform's own, and neither
`report` nor `block` was removed for anybody.

**E5 — read-only after the end.**
*Given* an event with existing conversations,
*when* it ends, or is cancelled, or its messaging window closes,
*then* no new conversation can be created, every existing conversation refuses new
messages, history still reads, and the report path still works.

**E6 — the host cap is visible and per event.**
*Given* a host who reaches the per-event cap,
*when* they try to open one more conversation,
*then* the refusal is shown to them and names the rule, and the same host in a
different event is unaffected.

**E7 — the participant list is bounded.**
*Given* a user who has not joined an event,
*when* they ask for its participants,
*then* the answer is empty. For a member, the list is exactly the joined
participants filtered by the same eligibility as discovery, carries no field a
discovery card does not, and is not an enumerable directory.

**E8 — an event conversation is never a match or a date.**
*Given* two participants who spent an evening messaging,
*when* the event ends,
*then* nothing appears in either party's match list, no match count moves, and the
completed-date counter is unchanged for both.

**E9 — retries and restarts.**
*Given* a publish, a join and a conversation open that are each retried, and a
process that restarts mid-event,
*when* each is retried,
*then* there is one draft, one participation, one conversation, and the lifecycle
is the one the clock and the creator's actions say.

**E10 — drafts are private and inert.**
*Given* a creator's saved draft,
*when* another user attempts to read or modify it, and when the creator saves it
again,
*then* the other user is refused, and the save produced no publication, no
invitation and no counter movement.

## 12. Copy

Copy is a safety surface here: every refusal below tells a user something about
whether they can reach somebody, and none of them may leak a block, a restriction
or a count.

| Moment | Says | Never says |
|--------|------|-------------|
| Join refused | Why joining is not available to you, in the terms the product already uses for eligibility | Anything about another participant, or a list of who is in the event |
| Event messaging closed | The messaging window for this event has closed | Whether the creator ended it early, or why |
| Host cap reached | You have opened as many conversations as this event allows. You can still reply to anyone who writes to you. | Whether anyone has replied |
| New conversation refused after the end | This event has ended, and new conversations cannot be started. Your existing conversation is still here. | — |

Every refusal is the platform's own answer, not an interpretation, and every one is
offering a next step: report, block, or a surface the user can still act on.

## 13. Events

Proposed names, **none registered**. `ANALYTICS_EVENTS` is an allowlist
(`packages/platform/src/analytics.ts:36`) and `DATING_EVENT_CATALOGUE` is
published by Dating Core (`packages/dating/src/events.ts:126`); an event name that
is in neither may not be published until it is in one. Publishing nothing is the
correct state until then.

| Proposed event | Class | Dimensions | Never carried |
|----------------|-------|-----------|----------------|
| `event.published` | `internal` | `type` | the description, the venue |
| `event.state_changed` | `internal` | `from`, `to` | — |
| `event.participation_changed` | `internal` | `action: joined \| left` | the participant list |
| `event.conversation_opened` | `internal` | `type`, `initiated_by: host \| participant` | the pair's identities as a list |
| `event.conversation_refused` | `internal` | `rule` | which participant was restricted |

No event may carry the participant list, a participant's identity, or the
existence of a conversation between two named people. Those are `user`-class facts
about two people, and the analytics sink is not a place that learns them.

## 14. Open questions

Recorded rather than guessed.

1. **Whether event messaging may bypass the match gate at all.** §10. Blocks §7.
   A human owns it.
2. **The stated messaging duration.** §5 closes messaging automatically at the
   scheduled start plus a duration, and no value is written here. #51 raised it
   and it needs a product number, not a plausible one.
3. **Whether an event's place is a named venue, a coarse band, or free text, and
   how precisely a participant list shows it.** §6 requires that participation
   reveal no position; the granularity of the event's own location is undecided.
4. **Whether event conversations are retained for less time than match
   conversations.** §9 applies the existing 180/365-day policy unchanged, and no
   document argues for a different number. If one is wanted it is a product
   decision with a retention answer behind it, not a constant.
5. **Whether an event can be re-published after it ends**, and whether the same
   creator may run the same event again as a new one. #50 makes a draft deletable
   and #51 makes lifecycle transitions one-way; neither says.
6. **Whether a host may message a participant who left the event before it
   ended.** The block rules and the read-only rule are clear; this is not, and it
   is the one case where "the event was the authorisation" and "the participant
   withdrew" point in different directions.
7. **Whether a saved event is visible to non-participants before it goes live.**
   #51 says eligible users browse *published* events, so this document reads
   published-and-not-live as browsable. Whether an event should be announceable
   before its start — by a link, or in a notification — is undecided.
8. **Whether Open Chat Event participants can be discovered to each other by name,
   or only in the live event.** #53 says participants "find other available
   participants in the same live event"; §6 implements that as the live list
   only. A searchable directory of event participants is a different discovery
   surface and is not in scope.