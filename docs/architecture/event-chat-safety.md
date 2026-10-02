# Event chat safety model

> Decides the two open questions in [#52](https://github.com/katzimoto/been_there/issues/52)
> and [#53](https://github.com/katzimoto/been_there/issues/53), and the one in
> [#51](https://github.com/katzimoto/been_there/issues/51), before implementation
> rather than during it.

## What these issues change about the product

Every conversation in this system so far is **match-derived**: two people could
message because they liked each other and both liked back. That gate is the
product's core safety property — a stranger cannot reach you at all.

[#52](https://github.com/katzimoto/been_there/issues/52) and [#53](https://github.com/katzimoto/been_there/issues/53) replace it for events. A host can open a private conversation with every participant in a live event, and in an Open Chat Event any two participants can message each other **without a prior mutual match.** Both issues say so explicitly.

That is the right product call — events where you cannot talk to anyone are not events — and it is also the single largest change to the threat model this repository has, so it gets decided explicitly rather than inherited by accident.

## What does not change

Event participation does not weaken any existing commitment. A participant is
subject to exactly the same rules as anyone else:

- **`verified` only.** An unverified account cannot join an event, and
  therefore cannot chat in one. Commitment 1 is unchanged.
- **Account standing still governs messaging.** A `limited`, `suspended` or
  `banned` account cannot send, regardless of how it got the conversation.
- **A block still dominates.** If either party has blocked the other, no
  conversation exists, no conversation reopens, and an event is not a way around
  it — including for a host, who may not message a participant who blocked them.
- **`report` and `block` stay unrestrictable.** A restriction can never remove
  the ability to report or to protect yourself, so an event cannot be used to
  trap someone.
- **Every event conversation is reportable and case-able**, with the same
  evidence retention as any other conversation. Evidence is captured at the time
  and survives the event.
- **Exact location is still never exposed.** Showing a user is "at this event"
  is not showing where they are; an event has a place, not a position in it.

## The new risks, and the three rules that answer them

### 1. Scale. A host can now reach N people who never chose to be reached.

This is the real one. A match-derived conversation has exactly two people who
both wanted it. An event conversation has a creator who chose to address a room,
and participants who chose to be in a room — not to be addressed individually by
its host. That asymmetry is the same shape as the mass-reporting campaign
`trust-safety` already quarantines, pointed the other way.

**Rule: host-initiated conversations are rate-capped per event, per
participant, and are visibly initiated.** A participant can see that a
conversation began with the host rather than with them, and can block or report
the host without leaving the event. The cap is per-host-per-event, not global, so
a popular host is not silently muted across every event they run.

### 2. The participant directory is a discovery surface.

Finding "other available participants in the same live event" is a listing of
eligible people. It must not become a way to browse users who are not in your
event, and it must not carry anything a discovery card does not.

**Rule: the participant list is exactly the event's joined participants, filtered
by the same eligibility the discovery feed applies, and exposes nothing beyond
what a match-eligible card shows.** No location, no last-seen, no contact
details. The list is not paginated into something enumerable, and it is empty for
an event you have not joined.

### 3. Conversations that outlive their event will look like matches.

An event conversation and a match conversation are both "two people talking".
If they share a representation, then an event conversation that persists after
the event becomes indistinguishable from one two people chose — including in the
moderation queue, and including in anything that later counts matches.

**Rule: an event conversation is bound to its event, permanently and visibly.**
It is not a match, it does not appear in the match list, it does not count
toward the completed-date counter (#49), and it is labelled as event-sourced
everywhere it is rendered or reviewed. A reviewer must be able to see that a
conversation began at an event without reconstructing it.

## The two open questions, decided

**Does an existing event conversation stay writable after the event ends?**

**No — new conversations stop; existing ones become read-only.**

The event is the authorisation. Once it ends, the reason two people were
allowed to talk no longer holds, so the ability to *start* goes with it. History
is retained and remains reportable, because a report filed later must still have
evidence, and because a conversation that vanished would hide the conduct it
recorded.

Read-only rather than deleted, for the same reason the audit log is append-only:
a deletion is indistinguishable from a cover-up to anyone reviewing it later.

This is the same rule in [#52](https://github.com/katzimoto/been_there/issues/52)
and [#53](https://github.com/katzimoto/been_there/issues/53); they disagreed only
because neither had decided.

**Does an event end automatically, or only when the creator says so?**

**Creator-controlled, with a hard default.** [#51](https://github.com/katzimoto/been_there/issues/51) flags this as undecided. Automatic ending is implemented for the *messaging* window only: messaging closes at the scheduled start plus a stated duration, because "stays live forever if the host forgets" is the worse failure for a safety property. The event's own `live → ended` transition stays creator-controlled, so the record reflects what actually happened rather than what a timer inferred.

Both questions therefore have a written answer, and the same answer applies to both event types.

## What is deliberately not built

- **No event chat with a `limited` account**, even if the restriction names a
  different capability. The unrestrictable floor covers `report`, `block` and
  `delete_account`; messaging itself is restricted by the account's standing,
  which is a separate and stricter gate.
- **No group conversation.** Every event conversation is one-to-one. A host
  addressing a room uses the event itself; a group thread is a different product
  with a different safety surface and is out of scope.
- **No cross-event messaging.** An event conversation does not survive into
  another event, and participation in one grants nothing in another.

## Done when

These rules are stated in the shared events design and enforced by tests, not
only by this document. In particular:

- A `limited`, `suspended` or `banned` participant cannot send in an event
  conversation, and a host cannot bypass this for a participant they blocked.
- An ended event's conversations refuse new messages and still return history
  and a report path.
- The participant list returns nothing for a non-member and carries no field a
  discovery card does not.
- A host cannot open more conversations than the cap, and the refusal is
  visible to the host rather than silent.
- An event conversation never appears in the match list and never increments the
  completed-date counter.