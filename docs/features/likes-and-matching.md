# Likes & Matching

> Issue [#12 — MVP Feature: Likes & Matching](https://github.com/katzimoto/been_there/issues/12). Parent: [#1](https://github.com/katzimoto/been_there/issues/1).
> Depends on [`docs/architecture/00-overview.md`](../architecture/00-overview.md). If this
> document contradicts it, the overview wins and this document is wrong.
> Related: #4 (Dating Core domain design), #11 (Preferences & Discovery),
> #14 (User Safety Controls), #15 (Restrictions & re-verification), #18 (measurement).

## 1. Goal and done-when

Two eligible users can express mutual interest, become matched, see that match,
and later end it — with no artificial ceiling on how many matches anyone may
have, and with the ability to report surviving every way a relationship ends.

## 2. Boundaries

### 2.1 What this feature owns

| Owned | Notes |
|-------|-------|
| The like record and its lifecycle (live / withdrawn / matched) | Idempotent per ordered pair; never deleted |
| The pass record and the 30-day suppression window it creates | The window itself is specified in #11 §5.2 |
| Match creation, the match's standing, and the one-per-episode invariant | |
| The match list: membership, ordering, unread state; unmatch and its consequence chain; like/match funnel events for #18 | |

### 2.2 What this feature never owns

| Never owns | Owner instead |
|-----------|---------------|
| Whether a candidate was eligible | #11. This feature re-evaluates the same rule set at action time; it does not re-derive it |
| Block edges and the block action | User Safety Controls (#14). A block only ever *removes* things here |
| Reports, cases, evidence, retention | Moderation & Enforcement (#7). This feature never deletes evidence |
| `AccountState`, capabilities, and identity state | Moderation & Enforcement (#7) and Identity & Verification (#3); consumed via `account_state.changed` and `identity.status_changed` |
| Conversation and message state | Communication (#5). Unmatch *requests* a conversation transition; it does not perform one |
| Whether an unmatch "should" feel good | Product copy, owned here, must stay neutral — see §8.4 |

### 2.3 Which domain owns each piece of state

| State | Owner | How this feature learns about it |
|-------|-------|----------------------------------|
| Like, pass, and match records, including match standing | Dating Core, this feature | local |
| `IdentityState` | Identity & Verification | `identity.status_changed` → `IdentityStandingProjection` |
| `AccountState` + capabilities | Moderation & Enforcement | `account_state.changed` → `AccountStandingProjection` |
| Block edges | User Safety Controls | `BlockListProjection` |
| Conversation state | Communication | `ConversationProjection`; unmatch publishes a request |
| Report availability and evidence | Moderation & Enforcement | never written or read here; only the *entry point* is kept alive |

## 3. The like action

### 3.1 Contract sketch

> Sketch only. Field semantics are normative; the shape is illustrative and may
> differ once `packages/dating` lands.

```ts
type LikeState = 'live' | 'withdrawn' | 'matched';

interface Like {
	readonly likeId: LikeId;
	readonly fromUserId: UserId;
	readonly toUserId: UserId;
	readonly state: LikeState;
	readonly createdAt: string;
	readonly supersededPassId: PassId | null;  // set when a like overrode an earlier pass
}
```

### 3.2 Preconditions

A like is accepted only if, at the moment the command is applied:

- The actor holds the `like` capability and is discoverable (identity
  `verified`). A user whose verification lapsed mid-session cannot like, and
  saying so is honest rather than letting them act on a platform state that no
  longer represents them.
- Target and actor are both discoverable, both have a presentable profile, and
  neither is `banned` or `suspended` (#11 rules R1, R2, R3).
- No block edge exists in **either** direction (#11 rule R4).
- Target is not the actor (R5), and no *active* match already exists between
  them (R8). Liking someone you are already matched with is a no-op, not an
  error — the transition is a self-transition to `matched` and the ledger returns
  the like already on record, so a double tap is not a `conflict`. An ended match
  is not a match and does not block a fresh one: unmatch withdraws the likes
  rather than deleting them, so the pair is free to be decided on again.

Every one of these is re-evaluated at action time against current projections,
and this domain has no other place to enforce them: `recordLike` takes both
`ActionStanding`s, the block edges and the clock, so "you cannot like after your
verification lapsed" is a guard rather than a comment. A card served five minutes
ago is not a licence to act on. A card the user was never served is not a
licence either: `InteractionContext` carries no standing, and none is needed,
because the precondition gate is the write path, not the transition table.

Failures are split by side, and the split is a privacy property. A failure about
the **actor** is reported honestly (`permission_denied`, with the state that
caused it) because the actor is being told about their own situation. A failure
about the **target** is one indistinguishable `not_eligible` with no details — a
block, a lapsed verification, a hidden profile and a removed capability all
produce the same error, because a liker who can tell a block from an absence by
probing with likes has learned something they must not learn.

### 3.3 Idempotence

> **A like is identified by the ordered pair `(fromUserId, toUserId)`. Liking
> twice produces one like, not two.**

- The second like of the same target is a no-op that returns the existing like,
  and no second `like.recorded` is published. The dedup is on the write, not on
  the event, so a retried request cannot inflate the funnel either.
- Match creation is a **function of the like pair**, not a side effect counted
  per request, so a duplicate like cannot create a second match even if two
  requests race (§4).
- The client sends an idempotency key with the command; the server dedups on
  the pair key, and the request key collapses transport retries so a flaky
  network never produces a visible double-tap. The unmatch command carries the
  same key (§9), because a double tap is not specific to the like button. A double-tap on the like button
  is the expected case, not an edge case, and is handled as a server retry.

### 3.4 The target unliked (or passed) in the meantime

**A like always supersedes an earlier pass by the same user.** A pass is a
dismissal; a like is an affirmative.

- The like is written as `live` and records the `supersededPassId`; the pass
  transitions to `superseded` and leaves the suppression set.
- If the target had already liked the actor, **a match is created now** (§4). A
  mutual one tap short is not lost because of ordering, and this is the only
  case where a *second* like rather than the second party's like creates one.
- The counterpart's own pass is untouched and still refuses. One person's like
  cannot speak for the other party's pass, so "a like after a pass matches" is
  true of the *passer's* pass and false of the counterpart's. This is the
  asymmetry A5 depends on, and it is why the machine, `recordLike` and
  `resolveMatch` have to agree on one definition of a pass in effect
  (`isPassInEffect`) rather than each having a say.

The reverse order is unremarkable: a like followed by a pass by the same user
withdraws the like and re-applies suppression. `pass` is therefore legal from
`liked`, so the machine can express the sequence rather than rejecting it as
impossible, and `recordPass` moves the like to `withdrawn` so the ledger and the
transition table cannot disagree about which decision stands. Withdrawal exists
because the state machine must be total, not because the UI offers a
like-then-pass button.

### 3.5 The target blocked in the meantime

**A block beats a like, unconditionally, in both orders.**

- Block already in place: the like is rejected with `not_eligible`, deliberately
  indistinguishable from "this person is not available", so the actor cannot
  learn that a block exists, or that the target's account does at all, by
  probing with likes. No like surface is generated and no record the liker can
  observe is written.
- Block arrives after the like: the like transitions to `withdrawn`, the match,
  if any, transitions to `closed_by_target` (§7.2), and the conversation is
  closed by Communication. The block is immediate and unilateral; the blocked
  party is told only that they can no longer reach this person, never who
  blocked them or that a block happened.

## 4. The mutual match rule

### 4.1 The rule

> A match exists between A and B **iff** both A and B hold a `live` like on
> each other, subject to the block rule in §3.5.

There is no score, threshold, or timing window. Two likes and one match.

### 4.2 The concurrency invariant

> **Invariant M1: for an unordered pair {A, B}, at most one match exists per
> match episode, and if a reciprocal pair of live likes exists, exactly one
> match exists. Never zero, never two.**

Guaranteed as follows, and the guarantee must be visible in the storage design
rather than hoped for in application code:

1. **One arbiter.** All match creation happens in a single serialisable unit
   against a single store. A client never decides "this is a match" from its own
   state; it renders a match when, and only when, `match.created` arrives on its
   own subscription.
2. **A canonical pair key.** `pairKey = (min(a, b), max(a, b))`, so
   A-likeing-B and B-likeing-A address the same row and there is no "A liked B"
   versus "B liked A" split to reconcile.
3. **Compare-and-set on the match row.** Create if and only if no open match
   exists for that key. The winning write publishes `match.created`; the loser
   observes the existing match and is a no-op.
4. **Both interleavings converge.**

   | Interleaving | Result |
   |---|---|
   | A's like commits, sees no reciprocal like, returns "pending" | One live like, no match. B's like commits, sees A's, wins the compare-and-set, one `match.created` |
   | A's and B's like commit simultaneously | Each write is serialised; the first sees no reciprocal, the second sees one. Exactly one `match.created` |
   | Both see a reciprocal like | The compare-and-set admits exactly one. The other observes the open match and is a no-op |
   | A's like is retried after a timeout | Idempotent on `(from, to)` (§3.3), so the retry is the same write |

5. **Nothing claims a match speculatively.** `like.recorded` carries only the
   like itself; it never carries an outcome, and no consumer infers one. The
   only thing that tells a client a match exists is `match.created`. Both
   parties' `like.recorded` events are published regardless of which write
   won, so the #18 funnel measures both sides of the mutual, not just the
   winning one.

### 4.3 Test obligations

M1 is not a property the code "probably" satisfies. Tests are expected for:
concurrent likes producing exactly one match; a retried like producing exactly
one match; a like, pass, like sequence producing exactly one match; and a
match-creation attempt against a pair that already has an open match producing
a no-op.

## 5. No artificial match cap

> **Hard product constraint from issue #1: there is no daily, weekly, or global
> limit on the number of matches a user may hold or accumulate. None. This is
> a decision, not an omission, and any implementation that introduces one is
> wrong until this document changes.**

Why, in the terms of the platform's thesis:

- **A cap is a scarcity mechanic, and scarcity is the business model of the
  category we are deliberately not copying.** A match limit protects nobody; it
  manufactures anxiety and makes the product worse precisely when it works
  best — for a popular user.
- **It contradicts the design commitments.** Commitment 1 makes `verified` the
  only discoverable identity state; a cap adds a second, hidden gate on
  discoverability, enforced by a number instead of a transition table.
- **It punishes exactly the users the safety work is for.** Verification
  re-runs, appeals, and enforcement churn all cost a user days of
  discoverability; a cap compounds that with an unrelated second loss.
- **It creates pressure against reporting.** A user near a cap has an incentive
  to be careless about whom they match with, so a capped product quietly
  discourages the block/report behaviour the whole design is built around.

### 5.1 The line: rate limits are not caps

Abuse prevention still requires limits, and the distinction is precise:

| Permitted | Forbidden |
|-----------|----------|
| A **rate limit on an action**: at most N like/pass/message *writes* per user per window | Any limit on the **number of matches** a user holds, acquires, or keeps |
| A per-pair duplicate guard: one like per `(from, to)` per lifetime, which is idempotence (§3.3), not a cap | A "you have used all your likes for today" state |
| A burst/spam circuit breaker keyed to behavioural risk signals, which may cool down a session | A fixed daily allowance that resets on a timer regardless of behaviour |
| Message rate limiting, which bounds a cost and an abuse vector | Any rule that must be described to a user as "you have N matches left" |

**The test that separates them:** a permitted limit constrains *how fast a user
acts* and always expires; a forbidden cap constrains *how much a user achieves*
and never expires. Any control that cannot be removed without changing what a
user is able to reach is a cap, and caps are forbidden here. A user who is
rate-limited is told the limit is temporary and given a time. A user is never
told they have run out of matches, because that state does not exist.

## 6. What a like reveals

### 6.1 The privacy rule

> **A like is private to the liker until it is mutual. No third party ever
> learns that a specific person liked a specific person.**

- `like.recorded` is `internal` sensitivity and reaches only the domains that
  need it — never a social graph, a public feed, or another user.
- There is no "liked by N people" counter, no "people who liked X" list, and no
  candidate ordering that reveals who liked whom — which is one more reason
  #11's ordering is a deterministic function of `verifiedAt` and never a
  function of inbound likes.
- The only disclosure is `match.created`, to both parties, and it discloses
  mutual interest and nothing else: not the date, not the content, not the
  order of the two likes. The liker is told the like was sent and nothing more;
  there is no "pending" or "mutual" state the liker can poll, because a state a
  user watches without progress is worse than silence. That is a real product
  cost — a silent like is frustrating — and it is the cost of a product where
  being liked cannot be used against you.

### 6.2 Exceptions

| Exception | What is disclosed, to whom |
|-----------|---------------------------|
| **Block** | Immediate, unilateral, takes effect without waiting for the other party. The blocked party is told "You can no longer message this person" — which is the absence of a capability, not a disclosure. They are **not** told who blocked them, and a block is never surfaced as a two-sided state to either side |
| **Report** | A report carries the evidence to Moderation under `restricted` sensitivity. It is not disclosed to the reported user in any form, ever, at any time. Enforcement authority is single-sourced and its reasons are never a product surface (overview §4) |
| **Match** | Mutual interest, to the two parties only |

There is no third exception: a moderation decision, a risk state, or an
enforcement outcome is never disclosed through any surface in this document.

## 7. The match list

### 7.1 Membership, ordering, and unread

A match appears in exactly one list, the matcher's own. A user cannot see who
else matched with someone, there is no aggregate, and a match row is visible to
its two parties and to no one else.

| Property | Rule |
|----------|------|
| **Ordering** | By most recent activity first: `lastMessageAt` when the conversation has messages, otherwise `matchedAt`. Ties break on `matchId` so the order is stable. No algorithmic reordering |
| **Unread** | Unread is **per party**: an inbound message the viewer has not read. A match the other party has read is not unread for the viewer, and vice versa. There is no shared read state |
| **Unread when unmatchable** | A match that cannot be messaged (because a capability is missing) still shows its unread badge until read, then shows its standing. The nav badge caps at "99+" for display only; the underlying count is exact |

### 7.2 Standing: a match never silently vanishes

> **Invariant M2: a match is never removed from a party's list as a side effect
> of identity, account, or moderation state. It transitions to a named standing
> that the UI renders, and the transition is recorded.**

| Trigger | Standing | What the other party sees | Messaging |
|---------|----------|--------------------------|-----------|
| Either party's identity becomes `expired` or `review_required` | `dormant_target_unverified` | The match stays in the list, in place, with "This person needs to re-verify to chat." It does not grey out to nothing, does not move to a separate archive, and does not disappear | Re-enabled automatically when the target returns to `verified` |
| Either party's account is `limited` with `send_message` removed | `restricted_by_target` | Stays in the list with "Messaging is unavailable right now." The removed capability is named, because a restriction is always explainable (overview §5) | Blocked by `canPerform`, and the block is the capability set, not a special case in the messaging path |
| Either party's account is `suspended` | `closed_by_target` | Stays in the list, not messageable, with a standing line and a report affordance | Not available (`suspended` has no `send_message`) |
| Either party's account is `banned` | `closed_by_target` | Stays in the list, not messageable. The other party is told the person is no longer available, and is not told the standing, the reason, or that an enforcement action occurred | Not available |
| Either party unmatches | `closed_by_actor` for **both** parties | Removed from the active list, retained in match history for the retention window (§8.3) | Closed by Communication |
| Either party blocks the other | `closed_by_actor` for the blocker, `closed_by_target` for the blocked party | The blocked party is told only that they can no longer reach this person | Closed |
| Either party deletes their account | `closed_by_actor` | Same as unmatch, from the surviving party's point of view | Closed |

Standing is not the same thing as the end of a match, and the two are kept apart
on purpose. `dormant_target_unverified` and `restricted_by_target` are **not**
ends: no `match.ended` is published, the match is still a match, and it becomes
fully usable again by itself when the cause clears. Only the `closed_*` standings
publish `match.ended`, and its `reason` is simply the match's new non-active
status: `'ended_by_block'` when a block ended it, `'unmatched'` otherwise. There
is no `declined` status and no declined state — a match is created `active` and
leaves only by one of those two. `unmatch.performed` is published only for the
actor-initiated case, so an end a block or a deletion caused is never
miscounted as a mutual decision.

**Why this matters.** The obvious implementation — filter the match list by the
target's current standing — makes a moderated user's removal look identical to a
mutual unmatch, and makes verification expiry look like the product losing
people. Both are false, and a list that silently loses rows is
indistinguishable from a service that is deleting people. The survivor of an
enforcement action may always report from the retained match row; that is not a
special case, it is the general rule in §8.3.

## 8. Unmatch

### 8.1 The action

Either party may unmatch, at any time, for any reason, with no reason required
and no confirmation beyond a single reversible-by-navigation "Are you sure?" on
the destructive direction. Unmatching is not moderated, and it is not
permanent-by-design (see open questions).

### 8.2 The consequence chain

| # | Consequence | Owner | Notes |
|---|-------------|-------|-------|
| 1 | Match → `closed_by_actor` | This feature | One `match.ended`, one `unmatch.performed`, both `user` sensitivity, each party receiving its own |
| 2 | Likes between the two parties are withdrawn, not deleted | This feature | They are historical facts and may be evidence |
| 3 | Conversation transitions to closed: no new messages accepted | Communication | This feature publishes the request; it does not perform it |
| 4 | Existing message history is retained | Communication | Retention window, not deletion |
| 5 | The match moves from the active list to match history | This feature | Both parties |
| 6 | **Report and block remain available** | Moderation / Safety | §8.3 |
| 7 | The other party is notified | Platform (notification) | §8.4 |
| 8 | Funnel events published | This feature | For #18 |

**Unmatch ends the match, not the pool entry.** The ledger keeps the record:
`already_matched` fires only for an *active* match, so once a match is ended —
by an unmatch, a block, or a deletion — the pair stops being excluded on that
ground, and the pair becomes discoverable again. Re-deciding is still a new
act, and the passes that either party made while the match was live remain
suppressed on their own 30-day window. This is stated explicitly because the
two failure modes here are both silent: an implementation that leaves an ended
match excluding the pair, and one that clears the ledger on unmatch. Neither is
intended, and the second is worse, because it would erase evidence.

### 8.3 The rule that matters most

> **Unmatch never removes the ability to report. Evidence produced inside the
> relationship is preserved independently of the relationship's end.**

This is commitment 4, and it is acceptance scenario 4 in issue #1. It is
specified here in full because unmatch is the single place in the product
where it is most natural to get wrong:

- **Report entry points that survive an unmatch**, for both parties, for the
  full retention window, from: the retained match history row, the closed
  conversation, the profile if it is still reachable, and the report surface in
  settings. Removing a match never removes any of them.
- **Evidence is retained on its own clock.** Messages, photos, timestamps,
  reports, and blocks generated inside the relationship are held under
  `restricted` sensitivity with a retention policy owned by Moderation &
  Enforcement. The end of the relationship is not a deletion event for
  evidence, and no part of the unmatch path may cascade-delete into the
  evidence store.
- **The unmatch path must not be an erasure path.** A reviewer should be able
  to check the unmatch implementation for exactly one thing: does any delete
  cascade from `unmatch` reach evidence? It must not.
- **A report filed after an unmatch is a first-class case** — not downgraded
  because the relationship ended, and not made harder to file because the
  reporter can no longer see the other party's profile.
- **The reported party learns nothing.** Filing a report about an unmatched
  person changes nothing observable in their product experience. The only
  outward effect of enforcement remains `account_state.changed`, and the
  product renders a capability, never a reason (overview §4).

### 8.4 Notification to the other party

Both parties are notified. The notification is neutral, states the fact, offers
report and block, and gives no reason:

> **"{Name} unmatched you."** — "You matched with {Name} on {date}. You can no longer message each other. You can still report or block."

Notifying only the initiator would make the recipient learn of the change by
finding a conversation that no longer accepts messages — a worse experience,
and one that reads as a silent punishment. A shared, neutral notification is
the honest one.

## 9. Like and match funnel events

Named per the overview's catalogue convention (`identity.status_changed`,
`account_state.changed`, `risk.changed`). Sensitivity per the five-class model.
This is the like/match half of the funnel measured in #18; the discovery half
is in [`./preferences-and-discovery.md`](./preferences-and-discovery.md) §8.

| Event | Sensitivity | Emitted when | Payload fields |
|-------|-------------|--------------|----------------|
| `like.recorded` | `internal` | A directed like exists. Private intent: rendered to the recipient, never to anyone else. **Not** on a duplicate or retry | `likeId`, `from`, `to` |
| `like.withdrawn` | `internal` | A **one-sided** like was retracted before it became a match — superseded by a pass, or killed by a block or an unmatch while still one-sided | `likeId`, `from`, `to` |
| `pass.recorded` | `internal` | The passer asked not to see the candidate. The most private interaction fact this domain holds | `passId`, `from`, `to` |
| `match.created` | `internal` | Exactly once per match episode (M1): two reciprocal likes produced exactly one match for the pair | `matchId`, `participants: [a, b]`, `likeIds: [a, b]`, `conversationId` |
| `match.ended` | `internal` | A match left the `active` status. The cause is the new status itself, not a separate narrative | `matchId`, `reason: 'unmatched'\|'ended_by_block'`, `actorId: UserId\|'system'`, `endedAt`, `conversationRetained: true` |
| `unmatch.performed` | `internal` | An **actor-initiated** unmatch command is accepted. Emitted only when a person did it, so an end a block or a deletion caused stays distinguishable from one a person chose | `matchId`, `actorId`, `idempotencyKey` |

The idempotency key travels on the event because it travels on the command:
`MatchEnd.idempotencyKey` is what makes a retried unmatch replay its own outcome
instead of failing as an invalid transition, and a declared field that nothing
reads is a promise the bus will not keep. This is the same discipline as the
like's pair-key dedup in §3.3, one layer up.

The envelope sensitivity of every Dating Core event is `internal`, because each
one carries a decision that a user would consider private. The *fields* inside
stay classified per field: a card's display name is `public`, a like record is
user data, and nothing here is ever promoted to a lower class to make an
analytics query easier.

The recipient's "you were liked" surface is **not** a second event of this
domain. It is an inbox projection derived from `like.recorded` for the target by
the notification serving layer, carrying a display reference rather than a copy
and resolved through the recipient's own read-model; a user who has hidden or is
no longer discoverable has no liker to reference, so no like surface is
generated for them. There is exactly one source of truth for a like, and a
notification signal must never become a competing one.

Constraints:

- Match rate is computed by joining `like.recorded` to `match.created` through
  the two `likeIds` the match carries. No outcome field is duplicated onto the
  like, because a second place to record "this became a match" is a second
  place to get it wrong.
- `like.recorded` is emitted once per like. A duplicate like emits nothing, so
  a bot cannot inflate the funnel by double-tapping.
- No event in this table carries identity evidence, an exact location, a
  moderation reason, or another user's private data.

## 10. Acceptance scenarios

**A1 — The normal dating flow (issue #1, scenario 3).**
*Given* Priya and Quinn are both `verified` and `active` and mutually
orientation-compatible, *when* Priya likes Quinn and Quinn likes Priya, *then*
exactly one match exists, both are notified of it, both see it in their match
list, they can message each other, and either may later unmatch.

**A2 — A one-sided like discloses nothing.**
*Given* Rosa likes Sam and Sam has not liked Rosa, *when* Sam views any surface
of the product, *then* Sam learns nothing about the like — no counter, no list,
no ordering change, no notification — and Rosa is told only that her like was
sent.

**A3 — Liking twice creates one like and one match.**
*Given* Tina likes Uma, *when* Tina likes Uma again, including via a retried
request, *then* one like exists, no second `like.recorded` is published, and the
result is identical to a single like.

**A4 — Simultaneous likes produce exactly one match.**
*Given* Vic and Wendy are eligible and like each other at the same moment from
two clients, *when* both writes are applied, *then* exactly one match exists and
exactly one `match.created` is published — never zero (the mutual is lost) and
never two (a duplicate match row).

**A5 — A like after a pass creates the match.**
*Given* Xavier passed Yao earlier today and Yao had already liked Xavier, *when*
Xavier likes Yao, *then* the pass is `superseded`, suppression is lifted, and
exactly one match exists.

**A6 — A block beats a like in both orders.**
*Given* Zara likes Bo, *when* Bo blocks Zara, the like is withdrawn and the
match, if any, closes; *and separately, given* Bo blocked Zara first, *when*
Zara likes Bo, the request is rejected indistinguishably from unavailability and
no like surface is generated for the liker.

**A7 — There is no match cap.**
*Given* a user has formed fifty matches, *when* the fifty-first mutual interest
occurs, *then* it is created normally, no cap state is entered, no message about
a limit is shown, and the user is never told they have run out of matches.

**A8 — Rate limiting is a throttle, not a cap.**
*Given* a user is acting at an abusive rate, *when* a rate limit engages, *then*
the action is refused temporarily with a stated duration, the limit expires on
its own, and the user is not prevented from forming any number of matches.

**A9 — A match does not vanish when a party is moderated or expires.**
*Given* Amy and Dan are matched, and Dan's identity expires and is then
restricted by a case, *when* Amy opens her match list, *then* the match is
still there, in place, in a named standing, with a stated reason and a report
affordance, and messaging is unavailable because the capability is unavailable.

**A10 — Unmatch ends the relationship and nothing else.**
*Given* Eli and Fay are matched and messaging, *when* Eli unmatches, *then* the
match closes, the conversation accepts no new messages, the existing history is
retained, both parties are notified neutrally, the match moves to history, and
neither profile returns to the other's browse pool.

**A11 — Reporting survives an unmatch (issue #1, scenario 4).**
*Given* Gus and Hal are matched, *when* Gus unmatches Hal, *then* Hal can still
file a report from the retained match history and from the closed conversation,
the evidence Gus produced is still held and still accessible to moderation, the
report is a first-class case, and Gus observes no change whatsoever.

**A12 — A report filed after an unmatch reaches moderation intact.**
*Given* Ines and Jan are unmatched and the retention window is open, *when*
Ines files a report about Jan with the conversation as evidence, *then* the
report, the conversation, and the timestamps reach Moderation under `restricted`
sensitivity, and the unmatch path has deleted none of it.

**A13 — Automation never enforces through this feature.**
*Given* a match is open and one party's behavioural risk is `critical`, *when*
nothing else happens, *then* the match is not closed, no capability is removed,
and the only outward signal remains the risk state feeding moderation.

**A14 — M2 holds under a bulk restriction.**
*Given* a moderator restricts many accounts at once, *when* a matched party is
among them, *then* the match transitions to a named standing and appears in
exactly one list for the other party, with no row lost and no state invented
that the capability set does not describe.

## 11. Open questions

- Whether unmatch should be reversible in v0.1. Currently it is not. Reversal
  needs a defined window and a decision on whether it restores messages, which
  makes it a moderation-evidence question as much as a product one.
- The retention window for match history, closed conversations, and the evidence
  they hold. A regulatory answer per market, not a technical one.
- Whether a match should decay on its own after long silence. Currently matches
  are stable indefinitely; an expiry would interact with #11's suppression set
  and with the standing states in §7.2.
- Whether a user may withdraw a like (un-like) at all, given that it is a
  unilateral removal of a signal the recipient's client may already have acted
  on. The state machine allows it; the UI exposure is undecided.
- Whether a per-pair like rate limit is worth having for spam defence, and
  whether it starts to look like a cap in aggregate. The test in §5.1 should
  catch that, but the edge is real.
- Whether the neutral unmatch notification wording reads as hostile to some
  users. Usability research, not a design decision.
