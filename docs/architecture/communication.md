# Communication

> Issue [#5](https://github.com/katzimoto/been_there/issues/5). Parent: [#1](https://github.com/katzimoto/been_there/issues/1).
> Read [`00-overview.md`](./00-overview.md) first. It is the contract; this
> document implements it and loses any conflict.

Matched users talk. That is the whole product surface of this domain, and the
entire design problem is keeping it *dumb in the right ways*: messaging decides
who may speak, and nothing else. It does not decide whether a message is
acceptable, because the moment a transport grows a judgement, every
safety guarantee in the overview becomes a suggestion.

Package: `packages/communication`.

## 1. Owns / never owns

| Owns | Never owns |
|------|-----------|
| The conversation aggregate and its lifecycle | Whether a message is abusive, spam, or a threat — no classifier, no keyword list, no score |
| The message value object and its delivery/read lifecycle | Account standing. `AccountState` is written by moderation and only read here |
| Who may send and who may read, as an ordered permission table | Why an account is `limited`. A restriction is a capability set, never a reason shown to a user |
| Rate friction at the transport layer | Enforcement. Friction answers `rate_limited`; it never closes a conversation or touches a standing |
| Behavioural metadata published for risk detection | Report validity, case creation, or moderator decisions |
| A scoped, redacted evidence view for an already-recorded case | Opening a case, judging a report, or deciding retention beyond the policy |
| Retention classification of a conversation's history | The report/case record itself, which moderation owns |

Every cross-domain fact arrives as a projection defined in
`packages/communication/src/read-models.ts`: the match projection (Dating Core),
the block ledger view and the capability projection (Moderation & Enforcement).
This package imports no other domain.

## 2. Conversation lifecycle

`packages/communication/src/conversation.ts`. Five states, declared as one
transition table.

```
                    block_applied          block_lifted
             ┌─────────────────────►  ┌─────────┐  ─────────────►  (active)
  (match)    │                        │ blocked │
 ──────────► ┌─────────┐  freeze_for_ └─────────┘
             │ active  │  restriction
             └─────────┘  (requires a caseId)
                 ▲   │           │
                 │   │           ▼
                 │   │   ┌──────────────────────────┐
                 │   │   │ frozen_by_restriction    │
                 │   │   └────────────┬─────────────┘
                 │   │                │ block_applied
                 │   └────────────────┘
                 │   unfreeze_on_restriction_lift
                 │   (requires a caseId)
                 │
   active │ blocked │ frozen_by_restriction
        ├── unmatch ──► ended_by_unmatch   (terminal)
        └── end    ──► ended              (terminal)
```

Read it as three different questions:

| State | Question it answers | Reversible | Sends | History |
|-------|--------------------|-----------|-------|---------|
| `active` | Is this conversation live? | — | yes | readable by both |
| `blocked` | Did one party invoke a safety control? | yes, by that party | no | blocker keeps it; blocked party loses it immediately |
| `frozen_by_restriction` | Did enforcement remove a capability? | yes, by a new case | no | readable by both |
| `ended_by_unmatch` | Did the relationship end? | no | no | retained, reportable |
| `ended` | Closed for any other reason, including a case | no | no | retained, reportable |

**`ended` versus `frozen` is the distinction the issue asks for.** `frozen_by_restriction`
is a *pause imposed by safety*: it exists only alongside a recorded `caseId`,
it is lifted by a second recorded case, and the conversation returns to exactly
where it was. `ended` is a *conclusion*: there is no path out, in this
conversation, ever. A new match opens a new conversation; nothing is resurrected.

`blocked` is a third thing again, and it is deliberately not an enforcement
state. A block is a user acting on their own behalf: unilateral, immediate, and
requiring no case. What makes it dominant is that the table gives it priority
over everything:

- `freeze_for_restriction` is **not** legal from `blocked`. A lifted restriction
  cannot reopen a blocked conversation (`legalEvents('blocked')` has no
  `unfreeze_on_restriction_lift`), because a block the blocker never lifted must
  not evaporate because of an account-level decision about the other side.
- `block_lifted` is guarded on `matchState === 'active'`, so an unblock can never
  resurrect a conversation whose match is gone.
- The conversation state is **not** the authority on a capability. If a block is
  lifted while a restriction is still live, the state returns to `active` and
  the send gate still refuses, because the moderation-owned capability
  projection says so. One source of truth per fact.

The table also contains no delete-transition, at all. There is no way to make a
conversation's record disappear from inside this domain, which is how
commitment #4 of the overview ("unmatch does not destroy the right to report")
is enforced rather than merely stated.

## 3. Message lifecycle

`packages/communication/src/message.ts`.

```
  createMessage
       │
       ▼
    ┌───────┐  deliver   ┌───────────┐  mark_read   ┌──────┐
    │ sent  │───────────►│ delivered │─────────────►│ read │
    └───┬───┘            └───────────┘              └──┬───┘
        │ fail                                       │ delete
        ▼                                            ▼
    ┌────────┐  retry   ┌──────┐                  ┌──────────┐
    │ failed │─────────►│ sent │                  │ deleted  │ (terminal)
    └────────┘          └──────┘                  └──────────┘

    delete: legal from sent | delivered | read | failed, never from deleted
```

`read` is what the transport knows, not a reaction and not a signal about the
person. Deletion by `sender` or `recipient` is a user action; deletion by
`moderation` requires a `caseId`, exactly like every other enforcement-driven
move. Bodies are capped at 4000 characters and may not be blank — the only two
validations in the domain, and neither of them looks at what the text says.

The current acknowledgement state travels with the send signal as
`messageState`, so a consumer can tell an accepted message from a failed one
without ever seeing what it said.

## 4. The permission model

`packages/communication/src/permissions.ts`. `canSend(conversation, sender,
dependencies)` is pure: it reads projections, mutates nothing, publishes
nothing, and returns the first denial. The rules are **data**, in this order:

| # | Rule | Denies when | Code |
|---|------|-------------|------|
| 1 | `blocked` | an un-lifted block exists in either direction between the participants | `permission_denied` |
| 2 | `not_a_participant` | the sender is not one of the two | `permission_denied` |
| 3 | `match_not_for_conversation` | the match projection describes a different conversation | `conflict` |
| 4 | `match_not_active` | the match is `unmatched` | `not_eligible` |
| 5 | `conversation_not_open` | the conversation is blocked, frozen, un-matched, or ended | `not_eligible` |
| 6 | `missing_send_message_capability` | the sender's capability projection omits `send_message` | `permission_denied` |

**Block dominates, and it dominates by being first.** If the block were rule
four, a restricted user who had blocked someone would be told their
conversation was unavailable "because of your restriction" — which leaks the
existence of an enforcement action into a product surface, and makes the
strongest fact the weakest one. Rule 1 also covers a block whose conversation
has already ended, so the answer to "why can I not message here" never depends
on which condition happened to be checked first.

Every denial carries `details.rule`, so a client renders a correct, uniform
explanation and never guesses at a reason.

Reading is separate, and deliberately asymmetric (`canView`):

- the **blocked party** loses read access immediately, even while the
  conversation is still formally `active` on this side of the projection;
- the **blocker keeps their history** — they may need it to report later;
- a **stranger** is refused;
- an **ended or frozen** conversation keeps both parties' read access, because
  the history is evidence, not a chat window.

### Order of the send path

`sendMessage` (`src/send.ts`) is the only place the pieces meet, and its order
is the safety argument:

1. **participant** — structural; also what makes `peerId` non-null in the signal.
2. **`canSend`** — authorisation first. A rate limit is a cost the sender pays;
   it must not become an oracle revealing *why* a conversation is unavailable.
3. **body validation** — an empty or oversized body is rejected before it can
   consume rate budget.
4. **friction** — last, and only ever as friction.

On success it returns the message *and* the signal payload the caller must
publish; nothing is written or sent from here.

## 5. Friction is not enforcement

`packages/communication/src/friction.ts`. Two sliding-window rules, both pure
predicates returning a `Result`:

| Rule | Window | Limit | Applies to |
|------|--------|-------|-----------|
| `per_conversation_burst` | 60 s | 20 | sends in one conversation |
| `new_conversation_burst` | 60 min | 10 | conversations one user opens |

A denial is `rate_limited`, which the kernel marks `retryable`, and carries
`retryAfterMs` so the client can say when to try again.

The difference between friction and enforcement is structural, not tonal:

- a rate limit has **no case id** and cannot obtain one;
- it **cannot move a conversation out of `active`**: every event that does so is
  an explicit `end`/`unmatch`, a `block_applied`, or a case-guarded freeze, and
  nothing in this file produces any of them;
- it **never touches an account standing**;
- it **expires on its own** — a sender who waits out the window is simply
  allowed again.

The test suite proves the second point the blunt way: fifty consecutive
rate-limited sends leave the conversation `active`, with its `stateChangedAt`
untouched, and the same sender succeeds as soon as the window clears. If rate
friction could ever end a conversation, an automated rule would be removing a
person's ability to talk — the exact outcome the overview's "automation never
enforces" commitment forbids.

Pressure is still *observable*: each denial publishes
`communication.friction_applied`, so a detector can see a user hammering the
transport without this domain ever forming an opinion about why.

## 6. What safety sees — and what it never sees

`packages/communication/src/signals.ts`. **Messaging never judges content.**
There is no classifier, no keyword list, and no score anywhere in this package,
and a signal payload has no field capable of holding a sentence. The
`COMMUNICATION_SIGNALS` catalogue carries `containsUserContent: false` as a
*literal type*, so an entry claiming otherwise would not compile.

| Event | Sensitivity | Consumed at | Payload |
|-------|-------------|-------------|---------|
| `communication.message_sent` | `internal` | Trust & Safety | conversation id, match id, sender id, peer id, message id, message state, sent-at, seconds since previous message, seconds since conversation opened, messages in conversation, messages in the last hour, **body length** |
| `communication.conversation_state_changed` | `internal` | Trust & Safety | conversation id, match id, from-state, to-state, changed-at, case id (pointer only, or `null`) |
| `communication.friction_applied` | `internal` | Trust & Safety | rule id, subject id, conversation id (nullable), used, limit, window, at |
| `communication.evidence_captured` | `restricted` | Moderation | case id, conversation id, subject id, requesting user, captured-at, scoped message count, redacted message count, redaction reasons |

Clearances are declared in code: `SAFETY_CLEARANCE` is `{ upTo: 'internal' }`
and `MODERATION_CLEARANCE` is `{ upTo: 'restricted' }`. A subscriber cleared
only to `public` receives **none** of these events, because the bus filters
before delivery rather than after.

What is deliberately **not** shared:

- **message content, in any form** — not the text, not a preview, not a hash,
  not a keyword hit. Only a character count leaves the transport;
- **who reported whom** — that is moderation's record, not a safety signal;
- **the reason for a restriction** — safety gets a capability consequence, not
  a narrative;
- **read receipts as a behavioural signal** — see open questions.

The privacy direction runs the same way as the safety direction: enough to raise
risk and to justify opening a case, never enough to read what anyone said. A
case id in a state-change signal is a correlation pointer, not case content;
reading the case itself still requires `restricted` clearance.

## 7. After unmatch, block, and restriction

| | Messaging | Reading | Retention | Reportable |
|---|---|---|---|---|
| **Unmatch** | permanently closed for this conversation; a new match creates a new one | both keep the history | full, on the same clock as any conversation | yes, with the whole transcript |
| **Block** | closed both ways, immediately | blocker keeps it; blocked party loses it | full | yes — the blocker is the most likely reporter, so their copy is the one that must survive |
| **Restriction (`limited` without `send_message`)** | frozen until the restriction is lifted | unchanged for both | full | yes; a conversation frozen by enforcement is exactly the one a case will want |

The unmatch row is commitment #4 in practice. The record outlives the
relationship, the conversation stays addressable by a conversation id that a
report can cite, and `captureEvidence` answers identically in all five states —
the test suite runs it across every state the machine can reach.

## 8. Evidence for a case

`captureEvidence(conversation, messages, request)` in `src/evidence.ts`. It
answers one question — *given a recorded case, what does this conversation
hold?* — and decides nothing about the report.

- **Scoped.** Bound to a `caseId` (mandatory in the type: there is no unscoped
  read of message history), one conversation, and one subject. A subject who is
  not a participant gets `not_found` rather than an empty or borrowed view.
  Scope narrows further by explicit message ids, or by a start instant.
- **Chronological.** Output is sorted by send time regardless of the order the
  projection returns, so a moderator reads an exchange, not a shuffle.
- **Redacted, never silently.** Email addresses, links, and `+`-prefixed phone
  numbers are replaced with `[redacted:<reason>]` and the reason is recorded
  per message, with a count of affected messages. The unredacted length is kept
  so a moderator can see that something was removed. A redaction must never be
  mistakable for the absence of evidence.
- **Attributed, not judged.** Each message is marked as authored by the subject.
  The view makes no statement about whether it is offensive.

## 9. Retention and deletion

`src/retention.ts`, `DEFAULT_RETENTION_POLICY`:

| Age of the conversation | Outcome |
|---|---|
| ≤ 180 days | `live_history` — readable in the product |
| ≤ 365 days | `reportable_only` — withdrawn from the product, still available to a case |
| > 365 days | `purged` |

Two rules hold across the whole range. A conversation **never regains** history
as it ages — the outcome is monotonic, so a bug cannot make old content
readable again. And evidence retention is independent of the relationship: the
record survives the unmatch, the block, and the freeze, and stops surviving only
when a case opened after that point would have nothing to look at.

The numbers are placeholders pending a regulatory answer per market, which is
why they are a policy object rather than constants sprinkled through the
transitions. Deletion of a single message is the `delete` event above: a user
may delete their own, and moderation may delete only against a case.

## 10. Open questions

Recorded rather than guessed, because a wrong answer here is a user's
consequence.

- **Delivery infrastructure.** WebSocket vs. SSE vs. polling, presence, and
  whether the sliding-window counters live in the transport, a cache, or the
  write model. The rate rules are pure functions over a timestamp list, so the
  storage choice does not change this domain — but the *window semantics*
  (fixed vs. sliding, per-instance vs. cluster-wide) do change their
  correctness under horizontal scale, and that is unresolved.
- **Image messages in v0.1.** The message value object is text-only and the
  signal payload reports `bodyLength` alone. Photos raise a media pipeline
  (moderation, storage, EXIF stripping), a different sensitivity class for the
  bytes themselves, and a detector question about whether image *metadata* may
  cross to safety. Not decided, and deliberately not half-built: v0.1 sends text.
- **Read receipts and their privacy cost.** The transport needs `delivered` and
  `read` to be honest about delivery, but "they saw it and did not reply" is a
  behaviour detector and a source of anxiety. Three live options: track
  delivery but not reads, track both but publish neither as a signal, or make
  read receipts an opt-in setting. Until this is decided, no acknowledgement
  state is published to safety beyond what `message_sent` already carries.
- **Evidence retention period.** Inherits the overview's open question; the
  policy object is ready for the real numbers.
- **A generic `publish<P>` on the kernel's event bus.** `EventPublisher.publish`
  is typed to the envelope's default payload, so publishing a typed signal needs
  one widening step in the caller. Not this package's change to make, but it
  should be raised against `packages/core`.
