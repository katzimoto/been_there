# Feature: Messaging Experience

> Issue [#13](https://github.com/katzimoto/been_there/issues/13) — MVP Feature: Messaging Experience.
> Parent: [#1](https://github.com/katzimoto/been_there/issues/1). Related architecture: [#5](https://github.com/katzimoto/been_there/issues/5), [#6](https://github.com/katzimoto/been_there/issues/6).
> Authority: [`docs/architecture/00-overview.md`](../architecture/00-overview.md). Where this document and the overview disagree, the overview is right.
> Companions: [`user-safety-controls.md`](./user-safety-controls.md) (#14), [`account-restrictions-and-reverification.md`](./account-restrictions-and-reverification.md) (#15).

## 1. Goal and done-when

**Goal.** Give active matches a reliable private text conversation, and make the
conversation's availability a truthful, non-leaking function of match state, block
state, and account capabilities.

**Done when (issue #13).** Matched users can communicate reliably, and messaging
respects account, block and match state.

Concretely, this document specifies:

1. the conversation list and its per-row states,
2. the message list and delivery/read states,
3. the difference between a conversation *frozen by a restriction* and one *ended
   by an unmatch*, in both product behaviour and copy,
4. the empty states,
5. the exact conditions under which the composer is disabled, and the string
   shown to the user in each case,
6. the metadata (never content) exposed to the safety layer, at which clearance.

## 2. Scope

In scope: one-to-one text conversations between valid matches; history; composer
permission; the conversation's terminal states; communication metadata published
to Trust & Safety and Moderation.

Out of scope for v0.1 (issue #1 explicitly): image messages with safety checks,
video calls, read receipts beyond a single `read` watermark, group chats,
message search, message editing/deletion by the sender.

Non-negotiable inherited from the overview:

- Communication **never** decides a message is abusive. It publishes a signal.
- Messaging permission is a pure function of *match state* ∧ *block state* ∧
  *account capability* (`canPerform(user, 'send_message', ctx)`). There is no
  fourth input, and in particular **no risk state** in that function.

## 3. Boundaries

### 3.1 What Communication owns

| Owned by Communication | Notes |
|---|---|
| Conversation record and its lifecycle | states in §4.1 |
| Message records, ordering, and delivery/read status | states in §4.3 |
| Who may send and who may receive, given the three inputs | §4.2 |
| Conversation history and its retention lifecycle | §6 |
| Communication metadata events | §7, metadata only |

### 3.2 What Communication never owns

| Never owned | Owner instead |
|---|---|
| Match existence | Dating Core (projection `match.status`) |
| Block record and its effect on discovery | Moderation & Enforcement (see [`user-safety-controls.md`](./user-safety-controls.md)) |
| Account standing and the capability set | Moderation & Enforcement (`packages/core/src/states/account.ts`) |
| Whether a message is abusive | Trust & Safety (detectors) + Moderation (decisions) |
| Report intake and evidence bundles | Moderation & Enforcement |
| Identity state and verification evidence | Identity & Verification |
| Notification delivery and push | Platform |

### 3.3 Cross-domain state used by messaging, and who owns it

| State consumed | Owner | How it reaches Communication |
|---|---|---|
| `match.status` (`active` / `ended_unmatched`) | Dating Core | versioned read-model projection + `match.changed` event |
| block state (none / blocked-by / blocking) | Moderation & Enforcement | `block.changed` event at `user` clearance + read-model |
| `AccountState` + capability set | Moderation & Enforcement | `account_state.changed` event at `public` clearance, read-model |
| `IdentityState` | Identity & Verification | `identity.status_changed` at `public` clearance |
| Risk state | Trust & Safety | **not consumed.** Communication must not branch on risk. |

`account_state.changed` carries the state and the *capability surface*, never the
case, the moderator, or the reason. A dating client holding this projection must
be unable to infer that a report, case or review exists.

## 4. Conversation model

### 4.1 Conversation states

Owned by Communication. Derived, not authored: a conversation has no
independently-written state field that a moderator can set.

| State | Meaning | Composer (both sides) | History |
|---|---|---|---|
| `active` | A live match, neither party blocked, both capable of sending | enabled | appendable |
| `frozen_restricted` | At least one party is missing the `send_message` capability, or a block is in force | disabled for **both** parties | read-only |
| `ended_unmatched` | Either party unmatched | disabled | read-only, retained, reportable |

Precedence, evaluated in this order, first match wins:

```ts
// contract sketch — Communication's derivation, not an implemented API
type ConversationState = 'active' | 'frozen_restricted' | 'ended_unmatched';

interface ConversationAvailabilityInput {
	readonly matchStatus: 'active' | 'ended_unmatched' | 'none';
	readonly block: 'none' | 'i_blocked_them' | 'they_blocked_me';
	readonly myCapabilities: readonly string[];
	readonly theirCapabilities: readonly string[];
	readonly theirAccountVisible: boolean; // isVisibleInProduct()
}

function deriveConversationState(input: ConversationAvailabilityInput): ConversationState {
	if (input.matchStatus !== 'active') return 'ended_unmatched';
	if (input.block !== 'none') return 'frozen_restricted';
	if (
		!input.myCapabilities.includes('send_message') ||
		!input.theirCapabilities.includes('send_message') ||
		!input.theirAccountVisible
	) {
		return 'frozen_restricted';
	}
	return 'active';
}
```

Two rules fall out of the ordering and are load-bearing:

- **An unmatch outranks a restriction or block.** Once a user has unmatched, the
  conversation reads as ended, never as frozen. A block or restriction must not
  be inferable from the post-unmatch screen.
- **A restriction is symmetric in effect.** If I cannot send, the conversation is
  frozen for *them* too — see §5.2 for why that is the correct privacy choice.

### 4.2 Match validity

A message may be sent only if all hold:

1. the conversation state is `active`;
2. the sender's account capability set includes `send_message` at the time of
   the write (the check happens on the server write path, not in the client);
3. the sender's identity state is `verified` — commitment 1, unverified is
   undiscoverable, and messaging an undiscoverable identity is the same class of
   leak;
4. neither party's account is `banned` (`isVisibleInProduct()` is `false`).

A failed check is a rejected write, not a queued message. Messages are never
accepted-then-withheld: a withheld message is indistinguishable from a delivered
one for the receiver, so a sender must be told at write time, not later.

### 4.3 Message and delivery states

```ts
// contract sketch
type MessageDeliveryState = 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'refused';
```

| State | Meaning | Client-local? | Retried? |
|---|---|---|---|
| `sending` | optimistic echo, not yet acknowledged by the server | yes | n/a |
| `sent` | persisted, ordered, fanned out to the recipient's inbox | no | n/a |
| `delivered` | recipient's client has the message | no | n/a |
| `read` | recipient opened the conversation; a single per-conversation watermark, not per-message ticks | no | n/a |
| `failed` | transient (network, timeout) | no | yes, exponential backoff, same idempotency key |
| `refused` | server rejected the write under §4.2 | no | never |

- `read` is a **conversation-level watermark** (`readThroughMessageId` +
  `readAt`), not per-message receipts. Per-message read receipts leak presence
  and create a covert channel; one watermark is enough to drive the unread badge.
- Idempotence: a client-generated `clientMessageId` is unique per (sender,
  conversation). A retried write returns the original row; a duplicate never
  produces two bubbles.
- Ordering: per-conversation, assigned server-side by a monotonic sequence, not
  by client clock. `sentAt` is server time; client clocks only affect the
  optimistic `sending` echo.

## 5. Frozen vs ended — different states, different copy

The two states are genuinely different: `ended_unmatched` is a **mutual,
voluntary** end of the relationship, initiated by one party, and is *permanently
reversible in the reporting sense* (the right to report survives — see §6.3 and
[`user-safety-controls.md`](./user-safety-controls.md) §5). `frozen_restricted`
is an **involuntary, unilateral, temporary-or-not** constraint caused by a
block, a removed capability, or a non-visible account.

Telling a user "this conversation ended" when the truth is "an enforcement
action applies to you" would be a lie; telling them the truth to the other
party would be a disclosure. The resolution is viewer-relative.

### 5.1 Copy shown to the party whose own state changed

| Situation | Screen state | Copy id |
|---|---|---|
| I unmatched them | `ended_unmatched` | `MSG_CONV_ENDED_BY_ME` |
| They unmatched me | `ended_unmatched` | `MSG_CONV_ENDED_BY_THEM` |
| I blocked them | `frozen_restricted` | `MSG_CONV_FROZEN_BLOCKED_BY_ME` |
| They blocked me | `frozen_restricted` | `MSG_CONV_FROZEN_BLOCKED_BY_THEM` |
| My `send_message` capability is removed | `frozen_restricted` | `MSG_CONV_FROZEN_RESTRICTED_ME` |
| Their `send_message` capability is removed, or they are `banned` | `frozen_restricted` | `MSG_CONV_CLOSED` |

The strings themselves (`{name}` = counterpart's display name):

| Copy id | Copy |
|---|---|
| `MSG_CONV_ENDED_BY_ME` | "You ended this match, so the conversation is closed. Your messages are kept and you can still read them. If something in it concerned you, you can still report it." + action `Report this conversation` |
| `MSG_CONV_ENDED_BY_THEM` | "{name} ended this match, so the conversation is closed. Your messages are kept and you can still read them. If something in it concerned you, you can still report it." + action `Report this conversation` |
| `MSG_CONV_FROZEN_BLOCKED_BY_ME` | "You blocked {name}. You can no longer message them, they cannot message you, and neither of you will see the other in discovery. Your past messages are kept." + actions `Unblock`, `Report` |
| `MSG_CONV_FROZEN_BLOCKED_BY_THEM` | "{name} ended contact with you. You can no longer send them messages and they can no longer reach you. Your past messages are kept. If they said or did something that concerned you, you can still report it." + action `Report this conversation` |
| `MSG_CONV_FROZEN_RESTRICTED_ME` | "Messaging is switched off for your account, so this conversation is paused for both of you. Your messages are kept, and they are still here if your account becomes active again. You can still report a problem, and you can see what is available on your account status." + action `View account status` |
| `MSG_CONV_CLOSED` | "This conversation is no longer active, so neither of you can send messages. Your past messages are kept. If something in this conversation concerned you, you can still report it." + action `Report this conversation` |

`MSG_CONV_CLOSED` is the counterpart's view and is **deliberately identical**
whichever non-match cause applies. A person must not be able to run a probe —
"unmatch them, do they still see my message?" — and thereby discover that
someone was restricted or blocked. This is the same rule as the overview's:
the product read-model contains no report, case or restriction signal, and
copy is a read-model surface. The cost is that the counterpart is sometimes told
less than the truth; that cost is accepted, and it is the whole point.

### 5.2 The counterpart's view of a freeze

The counterpart sees `MSG_CONV_CLOSED` and a disabled composer. They are **not**
told whether the cause was a block, a restriction, a ban, or an unmatch. Their
outstanding messages are not bounced with an error code; the send is refused
with the same copy, and the pre-existing thread stays readable so nobody loses
their record of what was said.

### 5.3 Why restriction freezes both sides

A restriction is issued against one subject, but its communication effect is
applied at the conversation level for both participants. Alternatives and why
they lose:

| Alternative | Why rejected |
|---|---|
| Only the restricted party sees a frozen composer | The other side sees messages accepted and never delivered — indistinguishable from a bug, and it invites "why is he not replying" pressure that is itself a harassment surface. |
| Show the other side "this person is restricted" | Prohibited by the overview §4 and §6.2: the client must not be able to infer enforcement. |
| Show the other side "messages are undeliverable" | Same inference, one step removed. |
| Freeze both, neutral copy | Chosen. Symmetric, truthful to the affected party, silent to everyone else. |

## 6. Conversation list

### 6.1 List composition

Two sections, always in this order:

1. **Active** — conversations in `active` state, sorted by last activity
   descending. Unread badge from the `read` watermark. Row shows the other
   party's display name, age band, coarse distance bucket, last-message preview,
   relative time. Previews are truncated to one line and never contain a
   verification artefact, a link's full target beyond the host, or any
   `internal`/`sensitive` field.
2. **Past conversations** — `frozen_restricted` and `ended_unmatched`
   conversations, sorted by when they left the active section. Collapsed behind a
   single "Past conversations (n)" header. Not interleaved with active rows:
   mixing them makes a frozen conversation look like ordinary activity.

A conversation that transitions out of `active` moves to Past immediately, in
the same write that ended it. There is no grace period during which a frozen
conversation keeps sending or badges.

### 6.2 Row actions

| Action | Availability | Notes |
|---|---|---|
| Open | always | read-only outside `active` |
| Unmatch | `active` only | moves to Past; irreversible as a product action; see §6.3 |
| Report | always, including Past | the right to report is never withdrawn by a state change |
| Block / Unblock | always | see [`user-safety-controls.md`](./user-safety-controls.md) |

### 6.3 History and retention

- History is retained after the conversation leaves `active`. Unmatch ends the
  *relationship*, not the record of it — the overview's commitment 4.
- A user's ability to file a report from a Past conversation row persists for as
  long as the evidence bundle is retained, independent of whether the other party
  unmatched, blocked, was restricted, or deleted their account.
- The retention period itself is an open question (the overview flags it as
  needing a regulatory answer). Until it is answered, the product rule is: the
  Past-conversations section is retained for the account's lifetime, and the
  moderation evidence bundle is retained on its own schedule, which is never
  shorter than the account's lifetime for an open or closed case.

## 7. Empty states

| Situation | Copy id | Content | Action |
|---|---|---|---|
| No matches yet, `active` account | `MSG_EMPTY_NO_MATCHES` | "No conversations yet. When you and someone else both like each other, the chat appears here." | "Browse people" → discovery. Hidden entirely when the user lacks `browse_discovery` (a `limited`/`suspended` account must not be sent to a surface it cannot use — see [`account-restrictions-and-reverification.md`](./account-restrictions-and-reverification.md) §3). |
| No matches yet, no discovery capability | `MSG_EMPTY_NO_MATCHES_RESTRICTED` | "Messaging is paused while your account is limited. Your matches are kept and will be here when it ends." | none beyond the account-state screen |
| Matched, no messages yet | `MSG_EMPTY_NO_MESSAGES` | "You matched. Say hello." | composer focused |
| Active section empty, Past not | `MSG_EMPTY_NO_PAST` | "Conversations you end or that pause will be kept here." | none |
| No conversations at all | `MSG_EMPTY_ALL` | combines the above two | discovery CTA when permitted |
| Search/filter yields nothing | n/a | v0.1 has no conversation search | n/a |

Empty states never say "blocked", "restricted", "reported", or anything derived
from risk. Where the cause is the user's own account state, the copy points at
the account-state screen, which is owned by #15.

## 8. Composer gate — exact conditions

The composer is disabled if **any** row below matches. Rows are evaluated in
order; the first match determines the copy. This is the whole rule.

| # | Condition | Copy id shown in place of the composer |
|---|---|---|
| 1 | Identity state is not `verified` | `MSG_COMPOSER_VERIFICATION_REQUIRED` |
| 2 | Account is `banned` | `MSG_COMPOSER_BANNED` |
| 3 | `send_message` not in the sender's capability set | `MSG_COMPOSER_RESTRICTED` |
| 4 | A block exists in either direction | `MSG_COMPOSER_BLOCKED` (blocker) / `MSG_COMPOSER_CLOSED` (blocked) |
| 5 | Match ended by unmatch | `MSG_COMPOSER_ENDED` |
| 6 | Recipient account is not `isVisibleInProduct()` | `MSG_COMPOSER_CLOSED` |
| 7 | Sender is `suspended` | `MSG_COMPOSER_SUSPENDED` |

Notes:

- Row 1 precedes everything because an unverified identity has no legitimate
  reason to message anyone (commitment 1).
- Rows 4–6 are one wire-level fact ("this conversation is not writable") and
  must produce exactly one string on the wire, chosen server-side, so the client
  cannot render a different, more informative string than the server decided.
- A disabled composer is never a dead end: every `MSG_COMPOSER_*` string except
  `MSG_COMPOSER_CLOSED` names a next step (complete verification, view account
  status, review the report you can still file, or end the conversation
  yourself).
- Rate limiting is a separate, automated, reversible friction (ADR 0004) and is
  reported as `MSG_COMPOSER_RATE_LIMITED` with a retry time — it is not an
  account state and must not be described to the user as one.

### 8.1 The strings

Same rules as the copy catalogue in
[`user-safety-controls.md` §10](./user-safety-controls.md): no dead end, no
accusation, no internal state. `{name}` is the counterpart's display name.

| Id | Copy |
|---|---|
| `MSG_COMPOSER_VERIFICATION_REQUIRED` | "Messaging is for verified people only. Check one selfie to unlock your messages — it takes about two minutes, and it does not affect anyone you have already matched." + action `Verify now` |
| `MSG_COMPOSER_BANNED` | "This account is closed, so you cannot send messages. You can still report a problem you have experienced." + action `Report a problem` |
| `MSG_COMPOSER_RESTRICTED` | "Messaging is switched off for your account right now. Your matches and your past messages are kept, and you can still report a problem. See your account status for what is available." + action `View account status` |
| `MSG_COMPOSER_BLOCKED` | "You blocked {name}. You can no longer message them, they cannot message you, and neither of you will see the other in discovery. If they did something you did not like, you can still report it." + actions `Unblock`, `Report` |
| `MSG_COMPOSER_CLOSED` | "This conversation is no longer active, so neither of you can send messages. Your past messages are kept. If something in this conversation concerned you, you can still report it." + action `Report this conversation` |
| `MSG_COMPOSER_ENDED` | "One of you ended this match, so the conversation is closed. Your messages are kept and you can still read them. If something in the conversation concerned you, you can still report it." + action `Report this conversation` |
| `MSG_COMPOSER_SUSPENDED` | "Messaging is switched off while your account is paused. Your matches and your past messages are kept, and they come back in full if your account is reinstated. You can still report a problem." + action `View account status` |
| `MSG_COMPOSER_RATE_LIMITED` | "You are sending messages very quickly. You can send again in {time}. This is a limit on sending, not on your account." |

`MSG_COMPOSER_CLOSED` is the counterpart's string for every cause the counterpart
is not entitled to know about (§5.2), and it is deliberately different in tone
from `MSG_COMPOSER_RESTRICTED`, which is shown only to the person whose own
account state is the cause and which therefore can — and must — explain itself.

## 9. What the safety layer may see

The overview's spine is *information flows toward safety, authority flows back
as one state change*. Communication therefore publishes **metadata**, and the
content of a message never crosses into Trust & Safety.

### 9.1 Published to Trust & Safety (metadata only, no content)

| Event | Payload | Sensitivity | Consumer clearance |
|---|---|---|---|
| `conversation.activity` | conversationId, actorId, occurredAt, messageCount in window, distinct-content hash count, link count, duplicate-content hash count, median inter-message gap, conversation age, match age, whether the actor is the initiator | `user` | `{ upTo: 'sensitive' }` |
| `conversation.flagged_pattern` | conversationId, actorId, pattern name (e.g. `high_rate`, `repeated_content`, `link_density`), detector's own confidence | `user` | `{ upTo: 'sensitive' }` |
| `message.withheld_by_system` | conversationId, messageId, rule name, occurredAt — **no body, no excerpt** | `internal` | `{ upTo: 'internal' }` |

Message content is `user` sensitivity and is delivered to **no** cross-domain
subscriber. Trust & Safety's detectors operate on counts, hashes, timing, and
structure. A detector that needs text operates inside Communication on hashed or
derived features and publishes the resulting signal, not the text — this is the
concrete form of the overview's rule that Communication never decides a message
is abusive.

### 9.2 Published to Moderation (evidence, case-scoped)

| Data | Sensitivity | Path | Rule |
|---|---|---|---|
| message excerpt within a window around the reported message | `restricted` | read-model query with a `CaseId`, via Moderation | every read logged; never on the event bus |
| full message history for an open case | `restricted` | same | same |
| profile snapshot at match time | `restricted` | same | snapshot, not the live profile |
| conversation timings, counts | `restricted` | same | same |

The bus never carries `restricted` payloads to a general subscriber. Evidence is
fetched by case, which is why opening a case is a human act and why a report
carries the context a moderator needs.

### 9.3 Never leaves Communication

Message bodies, exact coordinates, verification artefacts, report free text, and
anything classified `internal` or `sensitive` by another domain.

## 10. Contract sketches

Descriptive only; the implemented types live in `packages/communication`.

```ts
// contract sketch — what a product client reads. No reason, no case, no risk.
interface ConversationListItem {
	readonly conversationId: ConversationId;
	readonly section: 'active' | 'past';
	readonly state: ConversationState;
	readonly counterpart: {
		readonly displayName: string;
		readonly ageBand: string;
		readonly distanceBucket: string; // coarse only; never a coordinate
	};
	readonly lastMessagePreview: string | null; // absent when the state is past
	readonly unreadCount: number;
	readonly lastActivityAt: Date;
	readonly composerEnabled: boolean;
	readonly composerDisabledReason: ComposerDisabledReason;
}
```

`composerDisabledReason` is the closed set from §8. There is no variant such as
`recipient_restricted` — a client could not render it without leaking.

## 11. Acceptance scenarios

Mapped to issue #1's six acceptance scenarios.

| #1 scenario | Given | When | Then |
|---|---|---|---|
| 3. Normal dating flow | two `verified`, `active` users who matched | A sends text, B opens the conversation | the message persists, reaches `delivered`, then `read`; the composer is enabled for both; a retry never duplicates a message |
| 3. Normal dating flow | an `active` conversation | either user unmatch | the conversation moves to Past in the same write, the composer is disabled with `MSG_COMPOSER_ENDED`, history is readable, the **Report** action is still present |
| 4. Harassment | a recipient who has blocked or reported | the other party attempts to send | the write is refused with `MSG_COMPOSER_BLOCKED`/`MSG_COMPOSER_CLOSED`; no notification, no read receipt, no error revealing the block to a third party |
| 4. Harassment | a conversation frozen by the restricted party's account state | the counterpart opens it | the counterpart sees `MSG_CONV_CLOSED`, identical to an unmatch; the restricted party sees `MSG_CONV_FROZEN_RESTRICTED_ME`, which is a different string and names the next step |
| 5. Malicious account | a spam-patterned conversation | the detector fires | only `conversation.activity` / `conversation.flagged_pattern` metadata is published; no body crosses to Trust & Safety; no account state changes as a result |
| 6. False positive | a user whose restriction was lifted | `account_state.changed` arrives | the conversation returns to `active` for both sides and the composer re-enables, with no residual flag in the product read-model |
| 2. Fake-profile attempt | an account that is not `verified` | it attempts to send | refused with `MSG_COMPOSER_VERIFICATION_REQUIRED`; the identity gate precedes the account gate |

## 12. Open questions

- Retention window for message history and for case evidence bundles. Blocked on
  a regulatory answer per market (the overview already records this gap).
- Whether `delivered` is worth its cost at MVP scale, or whether the list should
  jump `sent` → `read` and drop per-recipient delivery state. It is an
  infrastructure/UX tradeoff, not a safety one.
- Push notification copy for a message in a conversation that froze between
  delivery and display — belongs to #16, needs the `closed` projection to carry a
  suppression flag.
- Whether a very long inactive conversation should be archived out of the
  Active section. Not a safety decision; deferred.
- Maximum messages per conversation before a human-readable nudge. Deliberately
  not a hard cap: issue #1 forbids artificial match caps, and an automated
  message cap would be an unenforced (automation enforcing) rule.
