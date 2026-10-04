# Feature — Avatar Introductions

> Issues [#54](https://github.com/katzimoto/been_there/issues/54) (parent),
> [#55](https://github.com/katzimoto/been_there/issues/55),
> [#56](https://github.com/katzimoto/been_there/issues/56),
> [#57](https://github.com/katzimoto/been_there/issues/57),
> [#58](https://github.com/katzimoto/been_there/issues/58),
> [#59](https://github.com/katzimoto/been_there/issues/59).
> Open decisions: [#62](https://github.com/katzimoto/been_there/issues/62),
> written up in [`../decisions/avatar-introductions.md`](../decisions/avatar-introductions.md).
> Authority: [`../architecture/00-overview.md`](../architecture/00-overview.md). If this
> document contradicts it, that document wins and this document is wrong.
>
> **Status: nothing in this track is built.** There is no `packages/` code for
> sources, knowledge, avatars, simulations or introductions, and no route under
> `packages/service/src/routes/`. Every state, event and reason value named below
> is **this document's proposal**, to be registered rather than re-declared, in the
> same way [`../features/profile-and-personalization.md`](./profile-and-personalization.md)
> §12 records names that the catalogue does not carry yet.

## 1. Goal and done-when

**Done when:** two eligible users can add information about themselves, review
and approve what the app knows, activate an avatar that represents them
faithfully, and receive an introduction immediately after a promising private
simulation — with mutual human interest opening exactly one real chat, neither
user able to reach the dialogue or any private disclosure, an unsuccessful
simulation leaving no lasting effect on anybody, and revocation, blocking, retries
and deletion all preserving those boundaries (#54's acceptance criterion,
verbatim in intent).

The properties that make it true, in the order they matter:

1. **Nothing is representable until it is permitted.** An item that is not
   permitted for a use does not reach that use's consumer — not as a field, not as
   a default, not "temporarily".
2. **The simulation's only product effect is an introduction candidate.** Every
   other surface a person can observe is out of the simulation's reach.
3. **A conversation is a conversation between people.** What the avatar said is
   not in it, and what the avatar concluded is not recoverable from it.
4. **Revocation is not a flag.** Pausing, blocking, changing knowledge or
   permissions, and deletion all invalidate dependent pending work before it is
   delivered.

## 2. Boundaries

### 2.1 What this feature owns

| Owned | Notes |
|-------|-------|
| Source connections: which source, what was selected from it, when it last refreshed, what failed, when access was revoked | #55 |
| Knowledge items, their provenance, their confirmed/inferred status, and their corrections | #56 |
| The four permission scopes, and the enforcement point for each consumer | #56. See §4.2 |
| Knowledge versions — which version an avatar was built from, which a simulation read, which an introduction writer was given | #56, #57 |
| The avatar: setup, activation, pause, update, delete | #57 |
| Simulation scheduling, pair selection, bounded conversations, and the introduction candidate they may produce | #58 |
| The introduction, the recipient's `interested` / pass / save-for-later actions, and the delivery of one real chat on mutual human interest | #59 |

### 2.2 What this feature never owns

| Never owns | Owner instead |
|-----------|---------------|
| Identity state, verification evidence, `verified` eligibility | Identity & Verification. This feature reads standing; it never reads evidence, and it has no path that grants eligibility |
| Profile content, profile state, completeness, profile visibility | Dating Core, [`./profile-and-personalization.md`](./profile-and-personalization.md). The avatar does not write a profile, and an introduction never appears on a card |
| Preferences, dealbreakers, discovery eligibility | Dating Core, [`./preferences-and-discovery.md`](./preferences-and-discovery.md). The avatar reads the owner's declared preferences and never writes them |
| Blocks | User Safety Controls, [`./user-safety-controls.md`](./user-safety-controls.md). A block only ever removes things here |
| `AccountState`, capabilities, restrictions | Moderation & Enforcement. Consumed as a capability set via `account_state.changed`; never written, never rendered as a reason |
| Matches and the match gate | Likes & Matching, [`./likes-and-matching.md`](./likes-and-matching.md). See §8.2 — the avatar does not create a match |
| Conversations and messages | Communication. The avatar delivers a *candidate*, and a candidate becomes a conversation only through the existing chat path |
| The completed-date counter | [`./profile-and-personalization.md`](./profile-and-personalization.md) §9. #59 requires this; §7.4 states it as an absence rather than a check |
| Risk, detectors, cases, evidence, enforcement | Trust & Safety and Moderation. §9.2 rule 6 is the load-bearing one |
| Notification delivery, push, quiet hours | Notifications, [`./notifications.md`](./notifications.md). This feature emits an event and reads the user's preference |
| Account deletion and its 30-day window | Account & Onboarding, [`./account-and-onboarding.md`](./account-and-onboarding.md) §8. §10 states what this feature must do when one is requested |

### 2.3 Which piece of state is whose

| State | Owner | How this feature learns about it |
|-------|-------|----------------------------------|
| `IdentityState` | Identity & Verification | `identity.status_changed` → the standing projection. Never a local copy |
| `AccountState` + capabilities | Moderation & Enforcement | `account_state.changed` → the standing projection |
| Block edges | User Safety Controls | the block list projection |
| Profile content and state | Dating Core | the profile projection; read-only here |
| Preferences and dealbreakers | Dating Core | the owner's own preferences; read-only here |
| Knowledge, provenance, permissions, versions | **this feature**, #56 | local |
| Avatar lifecycle | **this feature**, #57 | local |
| Introduction candidate | **this feature**, #58 | local, and it is not a product entity — §7.3 |
| The real chat | Communication | delivered through the existing conversation path, §8.2 |

## 3. What lands, and in what order

#62 settles the order and the reason is structural rather than a preference:
**#56 before #57 before #59**.

| Order | Issue | What exists when it lands |
|-------|-------|----------------------------|
| 1 | #55 | A user can add a supported source, see what was imported and why, refresh it and disconnect it |
| 2 | #56 | A user can review, correct, approve and remove knowledge and understand each item's permitted uses. Nothing can reach an unauthorised consumer |
| 3 | #57 | A user can build, read, correct, activate, pause and delete an avatar |
| 4 | #58 | Eligible activated avatars produce introduction candidates, and nothing else |
| 5 | #59 | Candidates become introductions, and mutual human interest opens one real chat |

**Why #56 cannot be later.** #59 requires the introduction writer to receive only
information approved for human-facing sharing. If introductions land first, that
approval has no home, and the shareable subset becomes whatever the writer needed
— which means every knowledge item is shareable by default. This is the one
ordering in this track that is not a preference.

## 4. Knowledge, provenance and permissions (#56)

### 4.1 A knowledge item

Four fields, and every one of them is load-bearing:

| Field | Why it is not optional |
|-------|------------------------|
| The statement, in readable words | The user approves *this sentence*. Anything else is a machine's paraphrase of their life |
| `origin` — `stated` or `imported` | Direct answers and declared preferences are `stated`; connector output and anything derived is `imported` |
| `confirmed` or `inferred` | #54 requires that confirmed facts be distinguished from inferences. An inference presented as a fact is the whole failure mode |
| `provenance` — the source, the source's own date, and the connector that fetched it | Without it the user cannot check the item, and "remove what came from this source" has nothing to select on |

**An inference never inherits approval.** #56: *"New inferences do not inherit
approval automatically."* Approval is granted by the user against a named
statement at a named version; a later inference is a new item with no approval,
whatever else about it is similar.

**An unsupplied field stays unknown.** #57 requires that an avatar
*"acknowledge missing information"*. A missing fact is not a blank to be filled
from the conversation, and an avatar that supplies one is unfaithful by
construction.

### 4.2 The four permission scopes

#56 names four. They are stated here with what each one *unlocks*, because the
useful form of this rule is a reader being able to check whether a given consumer
should have seen a given item.

| Scope | Unlocks | Never implies |
|-------|---------|---------------|
| **private storage** | The item is held at all, and shown to its owner | Any other scope |
| **matching-only use** | The item may inform what the owner's own avatar looks for | Sharing it with anybody |
| **private simulation** | The item may enter a private avatar-to-avatar simulation | Any statement about the other person |
| **human-facing sharing** | The item may appear in an introduction, or in a real conversation the owner wrote | Anything beyond the introduction text |

**The rule that makes these a boundary rather than four booleans.** #62: the
approval *"has to exist as an enforced, versioned boundary — not as a field on a
knowledge item"*. Concretely, three requirements:

1. **Default denial.** An item with no explicit grant for a scope is not permitted
   in that scope. There is no `shareable: true` default anywhere.
2. **Enforcement before the consumer, not inside it.** A permission is checked at
   the boundary where data would cross into a model or a writer, and the check
   reads the permission set for the **specific consumer**. "Permitted for
   simulation" is not "permitted for the introduction writer", and the code that
   assembles an introduction's input must be a different call site from the code
   that assembles a simulation's.
3. **Versioned.** A consumer is given a named knowledge version. The versions that
   a simulation ran against, and the version an introduction was written from, are
   recorded with the work, so "what did it know when it did that" is answerable
   without guessing.

**Sensitive preferences require explicit user control.** #54 lists them and this
document does not soften it: a preference the user marked sensitive is not
importable, not inferable, and not shareable, whatever the other scopes allow.

### 4.3 Corrections, removal and what depends on them

- A correction creates a new version. The old one is retained, because "what did
  the app believe last week" is answerable only if the previous belief is.
- **Removal invalidates dependent pending work.** #56: *"A permission change or
  deletion affects dependent data and work, including already queued work."* §10
  states the propagation.
- Derived summaries, embeddings and caches are removed with their support. A
  summary whose source item is gone is a conclusion about a person that the
  person can no longer correct.

## 5. Sources and connectors (#55)

A connector is a translation from one service's shape to one common contract, and
the common contract is what makes #55's "another connector can be added without
changing avatar or dating behaviour" true rather than aspirational:

| The contract carries | It does not carry |
|---------------------|-------------------|
| Which source, connected when, revoked when | Anything about what the avatar may say |
| The items the user selected, with provenance | An authorisation to simulate or disclose |
| Last refresh, and the outcome of the last one | A source-specific field any consumer might come to depend on |
| The failure, if it failed | A silent partial success |

**Connecting a source authorises nothing beyond storage.** #55: *"Import only
selected information into personal knowledge; connecting a source does not
authorize simulation or disclosure."* A connector that arrives pre-authorised for
the upper two scopes of §4.2 is a defect, not a shortcut.

**Source-specific behaviour stays inside the connector.** A new integration adds
one connector and changes nothing in knowledge, avatar, simulation or
introduction code. If a new source requires a field anywhere else, the contract is
wrong.

**Initial integrations are not chosen here.** #55 leaves this open pending real
service access and permissions, including Meta options, and states the constraint
that matters: do not assume full social-account access, and never import another
person's private information. Recorded in §13.

## 6. The avatar (#57)

An avatar is a **representation built from a named knowledge version**, not a
profile and not a persona. Three proposed states and an absence, to be registered
as one transition table like every other lifecycle in this repository:

```
draft ──activate──▶ active ──pause──▶ paused
  ▲                   │                 │
  └──────update───────┴─────update──────┘
                      │
                   delete ──▶ (none: the representation and its versions are removed)
```

| Rule | Statement |
|------|-----------|
| Faithfulness | Represents approved personality, communication style, values and boundaries, and nothing else |
| Fact discipline | Keeps confirmed facts distinct from inferences, and acknowledges what is missing |
| Invented content | **Never** invents experiences, feelings, intentions or commitments, and never makes arrangements on the owner's behalf |
| Fixed input | Each simulation's avatar is built from a fixed, permitted knowledge version (§4.2 rule 3) |
| Memory | Simulated dialogue is never written to permanent avatar memory and never enters training |
| Reversal | Activate, pause, update and delete are owner actions at any time; each invalidates the pending work named in §10 |

The third rule is the one an implementation gets wrong first, because "make the
avatar sound like them" and "make the avatar sound like them *even where that
means inventing*" are one sentence apart. The unfaithful case is not a quality
problem, it is the avatar claiming to be a person who said something.

## 7. Private background simulations (#58)

### 7.1 Pair selection

Selected using both users' explicit preferences, verification eligibility,
participation, blocks and account restrictions. Every one of those is a filter
applied *before* a conversation runs, and every one is re-read at the moment of
delivery rather than trusted from the moment of selection (§10).

A pair that either side would refuse in the product — an unverified participant, a
blocked pair, a `limited` account, a paused avatar, an owner who has not activated
— is not simulated. There is no "the simulation is private, so the eligibility
rules do not apply" reading of this rule, because a simulation that cannot be
reported can still shape what the owner believes about a real person.

### 7.2 Bounded, faithful conversations

- They run only on knowledge permitted for **private simulation** (§4.2), and only
  from a fixed version.
- They are inaccessible to both users while they run and afterwards. There is no
  endpoint, no export, and no support path that returns them.
- They are excluded from routine logs, analytics, permanent memory and training.
  "Routine" is the word that has to be defended: a log line that is not *routinely*
  read is still a retention decision, and this track owns none.
- They are temporary. What survives a run is the introduction candidate or nothing.

### 7.3 The introduction candidate is not a product entity

A candidate is a record that a pair may be worth surfacing, and it carries the
minimum needed to be delivered and then invalidated. It is **not**:

- a match, and it appears in no match list;
- a like, and it creates no `live` like in the dating ledger;
- a profile write, a preference write, or a knowledge write;
- a reputation, a risk input, a moderation input, or an account-state input (§9.2);
- anything the other person can see, and nothing either person can inspect.

**An unsuccessful simulation creates no lasting rejection label.** No record that a
particular pair was considered and set aside, no decay, no suppression, no
"already evaluated" mark that would keep the pair from being evaluated again on
better terms. The only scheduling record permitted is one that prevents repeated
work and duplicates, carrying no dialogue and no conclusion (§13 records the
retention question).

### 7.4 What a simulation must not be able to do

| Must not | Because |
|----------|---------|
| Write to any product state | #58: *"Simulation can propose an introduction; it cannot deliver one, create a match or contact a person."* |
| Increment the completed-date counter | #49 and #59. Nothing a simulation does is a date the owner went on; the counter's only input is what the owner supplied ([`./profile-and-personalization.md`](./profile-and-personalization.md) §9.3) |
| Change a preference, even to "improve" it | #59: *"Delivery does not increment the completed-date counter or rewrite user preferences."* A preference the owner did not set is a decision made for them |
| Reveal dialogue, quotations, private disclosures, scores or compatibility percentages | #59. #54 already excludes compatibility percentages from the product entirely ([`./profile-and-personalization.md`](./profile-and-personalization.md) §4.2) |
| Claim proven human chemistry | #59. A simulation is two representations talking; it is evidence of nothing about the people |

## 8. Introductions and mutual human interest (#59)

### 8.1 Before delivery

Every one of these is re-read at delivery, from current state, not from a
snapshot taken when the candidate was produced (#59: *"Recheck both users'
current participation, eligibility, blocks, knowledge permissions and candidate
validity before delivery"*):

1. Both owners still have an activated avatar.
2. Both are still participating in this track.
3. Both still satisfy the same eligibility the simulation's pair selection read.
4. Neither has blocked the other, in either direction.
5. Both still hold `send_message`, and neither account is `limited`, `suspended`
   or `banned`.
6. Every item the introduction would use is still permitted for
   **human-facing sharing**, at the current version.
7. The candidate is still valid — not invalidated by §10.

A failure at any step is a refusal the deliverer sees and the recipient is not
told about. Which users are told what is a product question this document does not
answer; it is recorded in §13.

### 8.2 The chat gate

An introduction **proposes**; it does not connect. On mutual human interest the
existing matching and communication rules apply unchanged, and one real chat opens
([#59](https://github.com/katzimoto/been_there/issues/59)).

**What "mutual human interest" means is an open decision**, not a rule this
document states: see
[`../decisions/avatar-introductions.md`](../decisions/avatar-introductions.md) §4.
Until that document's question 2 is answered, no conversation opens from an
introduction, and the reason is not a default — it is that opening one is the
thing #62 says is cheapest to decide before it ships.

Two things hold under every answer to that question, and are stated here because
they are true of the existing product rather than of this feature:

- **Blocks still dominate.** If either party has blocked the other, no conversation
  exists and none opens. An introduction is not a way around a block, in either
  direction, and the block is not disclosed to the other party.
- **Retries cannot duplicate anything.** One candidate produces at most one
  introduction per party, one notification per party, one match and one
  conversation. #59 requires this explicitly, and it is the same
  caller-supplied-retry-key rule the completed-date counter already uses
  ([`./profile-and-personalization.md`](./profile-and-personalization.md) §9.5).

### 8.3 What the introduction writer may read

The writer's input is **the separately approved shareable subset and nothing
else**. It does not receive, and must have no path to:

- the simulation dialogue, in whole or in part;
- quotations or paraphrases of it;
- the simulation's reasoning, its scoring, or its evaluation of either owner;
- any item whose permission does not include **human-facing sharing**, at any
  version.

This is the enforcement point named in §4.2 rule 2, and it is a different call
site from the simulation's. If the two share a function, the permission boundary
is a convention.

### 8.4 Delivery

Introductions appear immediately when ready, with no digest delay (#59). A push
notification is **optional, discreet, and obeys the user's notification
preferences** — including quiet hours
([`./notifications.md`](./notifications.md) §5) and the non-suppressible/non-
suppressible distinction in §2. "Discreet" is a content requirement as much as a
channel one: a notification about an introduction must not disclose the other
party's presence in a way the product's block separation forbids.

Passing stays private. A pass is not disclosed to the other party, is not a signal
about them, and leaves no label (§7.3).

## 9. Safety properties this feature must preserve

### 9.1 The eight commitments, one line each

| # | Commitment | What it means here |
|---|------------|--------------------|
| 1 | `verified` is the only discoverable identity state | An unverified account cannot activate an avatar, cannot be simulated with, and cannot be introduced to. There is no path in this track that grants discoverability, and none that needs to |
| 2 | Automation never enforces | §7.3 and §9.2 rule 6: nothing an avatar or a simulation concludes is an input to Trust & Safety or Moderation. No detector reads this track, and no enforcement transition can be reached from one |
| 3 | Risk decays | Follows from rule 2 — there is no risk input to decay from |
| 4 | Unmatch never destroys the right to report | An introduction and the conversation it may open are reportable on the same terms as any other; the evidence survives whatever happens to the introduction |
| 5 | Exact location is never exposed | No item carries a coordinate. "Similar area" is a coarse band at best, and the whole location vocabulary is the one in [`./privacy-and-user-settings.md`](./privacy-and-user-settings.md) §3 |
| 6 | Domains never import each other's internals | Connectors, the avatar, the simulation and the writer each receive projections, never another package's `src/` |
| 7 | Sensitive data is classified per field | §12 classifies every field this track proposes to publish, including the ones that exist only to say "something happened" |
| 8 | Every lifecycle is a transition table | §6's avatar states, and any lifecycle #55 or #59 add, are declared as transition tables like the other eleven |

### 9.2 The rules this track must not break, stated as rules

1. **Unverified means undiscoverable, and an avatar is not an exception.** The
   avatar is a representation of an account, not a way for an unaccounted-for
   entity to reach anybody.
2. **Automation never enforces — extended to this track's own output.** An
   avatar outcome is not a signal. It never becomes a detector's input, a risk
   state, a case, a restriction or a reputation. This matters for the reason
   [`../delivery-state.md`](../delivery-state.md) gives about
   `safety.detected_before_first_report`: a metric that can move from a non-report
   source is not measuring detection, and an avatar outcome is exactly such a
   source.
3. **A simulation cannot write product state.** §7.4.
4. **A block removes; it never informs.** A block prevents selection, prevents
   delivery, prevents a conversation, and is not disclosed to the other party.
5. **`report` and `block` remain unrestrictable**, so nothing in this track can be
   used to trap someone.
6. **Nothing unreported becomes a judgment.** No lasting rejection label (§7.3), no
   score rendered to anyone, no consequence the owner did not choose.
7. **Dialogue is not evidence and never becomes any.** It is not in the moderation
   queue, not in a case, not in an audit record, not in analytics. #54 says
   simulation conversations must not be revealed to either user; this document adds
   the stronger half — they are not revealed to the platform either.

## 10. Revocation, invalidation and deletion

### 10.1 The invalidation table

| Event | Invalidates | Not invalidated |
|-------|------------|------------------|
| Avatar paused or deactivated | Queued simulations for that owner; queued introductions for that owner | Completed introductions the recipient already acted on |
| Knowledge corrected | Queued work whose version is older than the correction; anything that read the superseded version | Work that named a newer version |
| Permission narrowed | Queued work that relied on the withdrawn permission | Work that did not use it |
| Owner blocked a counterpart | The candidate, the queued introduction, and the simulation for that pair | Nothing else about either account |
| Account restricted | Queued work for that account | Evidence, which moderation owns |
| Source disconnected, or its access revoked | Everything derived from that source (§4.3) | Items the user stated directly |
| Owner deletes their avatar | Queued work, the avatar, and the versions it was built from | — |

**Invalidation happens before delivery, not after.** §8.1's re-checks are the
enforcement point; the table above is what each of them reads.

### 10.2 Deletion

#56 requires that deletion propagate to *"summaries, embeddings, caches and
pending work that depend on it"*, and #54 adds that removal of a source must offer
removal of the knowledge derived from it. The feature-level statement:

- Deleting a knowledge item removes every derived summary, embedding and cache
  entry over it.
- Deleting the avatar removes the avatar and its versions.
- Deleting the account reaches this track through
  [`./account-and-onboarding.md`](./account-and-onboarding.md) §8, and this track
  holds nothing that must be retained against it — the introduction record is a
  fact about two people who both asked for it, and it goes with them.

## 11. Acceptance scenarios

**V1 — the whole journey, end to end.**
*Given* two eligible users who have connected a source or answered directly,
*when* each reviews and approves their knowledge and activates an avatar,
*then* a promising private simulation produces an introduction for both
immediately, built only from information permitted for human-facing sharing, and
mutual human interest opens exactly one real chat. Neither user can retrieve the
dialogue or any private disclosure, and the introduction does not claim proven
human chemistry.

**V2 — permissions are enforced before the consumer.**
*Given* an item permitted for private simulation but **not** for human-facing
sharing, *when* a simulation runs and an introduction is later written,
*then* the item reaches the simulation and does not reach the writer. The refusal
is structural: the writer's input never contained it.

**V3 — a new inference does not inherit approval.**
*Given* an approved knowledge item, *when* an inference is derived from it
afterwards, *then* the inference is a separate unapproved item and cannot enter
any consumer that the original could enter until the user approves it.

**V4 — an unsuccessful simulation leaves nothing.**
*Given* a pair whose simulation finds no mutual fit,
*when* every surface is inspected — profiles, preferences, knowledge, matches,
reputation, moderation, the completed-date counter — *then* nothing differs from
before the run, and a later run for the same pair is not suppressed by it.

**V5 — revocation invalidates queued work.**
*Given* an introduction queued for delivery,
*when* the recipient narrows a permission, pauses their avatar, or blocks the
introducer before it is delivered,
*then* it is not delivered, no notification is sent, and the queue does not retry
it into a later state where the re-checks pass.

**V6 — deletion reaches everything derived.**
*Given* knowledge derived from a connected source,
*when* the owner removes that knowledge or disconnects the source,
*then* the summaries, embeddings, caches and pending work over it are gone, and
the owner is told which derived items were removed.

**V7 — an unverified account cannot participate.**
*Given* an unverified account with knowledge, an avatar and an activated
simulation queue, *when* a pair is selected and when an introduction is delivered,
*then* neither step includes it, and no path in the track grants it
discoverability.

**V8 — a blocked pair cannot be introduced.**
*Given* two activated avatars and a block in either direction,
*when* selection runs and when delivery is attempted,
*then* no candidate, no introduction and no conversation exist, the blocked party
is not told who blocked them, and the block is not an input to any other pair.

## 12. Events

Proposed names, **none registered**. `ANALYTICS_EVENTS` is an allowlist and
`recordAnalyticsEvent` refuses anything outside it, so until these rows exist in
`packages/platform/src/analytics.ts` none of them may be published — the same
doc/code position
[`./profile-and-personalization.md`](./profile-and-personalization.md) §12 records
for `dating_goal.updated`. Publishing nothing is the correct state until then.

| Proposed event | Class | Dimensions | Never carried |
|----------------|-------|-----------|----------------|
| `avatar.knowledge_approved` | `user` | `scope` | the statement's content, the source, the counterpart |
| `avatar.knowledge_withdrawn` | `user` | `origin` | content; how many derived items were dropped |
| `avatar.activated` / `avatar.paused` | `user` | `to` | nothing about any other person |
| `avatar.simulation_completed` | `user` | `outcome: candidate \| none` | the dialogue, the reasoning, the score, the pair |
| `avatar.introduction_delivered` | `user` | `surface` | the introduction text, the reasons, the counterpart |
| `avatar.introduction_acted_on` | `user` | `action: interested \| passed \| saved` | the counterpart, unless the pair has since matched |

Two structural requirements on this table:

- **No event in it may carry a knowledge statement, an introduction text, a
  simulation conclusion or a counterpart.** The shape of a knowledge item is
  somebody's private life; the shape of an introduction is a judgement about two
  people that both of them have to be able to see and nobody else.
- **`avatar.simulation_completed` is an owner-visible record, not an analytics
  dimension.** Whether it is published at all is part of the open question about
  who bears a mistake ([`../decisions/avatar-introductions.md`](../decisions/avatar-introductions.md)
  §5).

## 13. Open questions

Recorded rather than guessed. The first three are the human-owned decisions from
[`../decisions/avatar-introductions.md`](../decisions/avatar-introductions.md);
this document does not answer them and does not assume any answer.

1. **When, and how, is a user told they are talking to an avatar** — the
   introduction, the conversation, or neither. Decision document §3. Blocking: no
   conversation may open from an introduction until it is answered.
2. **What "mutual human interest" means when one party's interest was produced by
   their own avatar.** Decision document §4.
3. **Who bears a mistake** when a user's avatar is unkind, badly written, or
   simply never produces a candidate. Decision document §5.
4. **Initial source integrations.** #55 leaves this to real service access and
   permissions, including Meta options. No integration is promised, and the
   constraint is that full social-account access may not be assumed and another
   person's private information may never be imported.
5. **AI provider and hosting**, named as a separate privacy boundary by #54:
   permitted inputs, retention and training use must be defined *before* a
   provider is selected, not after. Recorded here and not guessed, because it
   decides the retention question below.
6. **Evaluation criteria and thresholds for a promising mutual connection.**
   #58 requires both sides to be evaluated independently, refuses agreeable
   dialogue alone as evidence, and refuses unknown facts as supporting evidence.
   What satisfies "supported mutual fit" is undecided, and no threshold is written
   here because a threshold written before the criteria would be the wrong number.
7. **Retention periods.** Two of them, and neither has a value: how long raw
   imports are kept before derived material takes over, and how long a
   scheduling record is kept. #54 requires both to be stated rather than left to
   default.
8. **Bounded conversation limits for #58** — the cap on turns, and the behaviour
   at the cap. An operational processing limit, and explicitly not a product match
   cap (#54: no artificial global match cap).
9. **What an introduction says when there is nothing permitted to share.** #59
   forbids transcripts, reasoning, scores and percentages; an introduction with no
   shareable reason is possible under §4.2. Whether one is delivered or withheld
   is undecided.
10. **Whether a delivery refusal is told to its owner.** §8.1 lists seven re-checks
    that can fail after a candidate is produced. Whether the owner sees "no
    introduction this time", and in what words, is part of the open question about
    who bears a mistake and is not answered separately.
11. **Whether `save-for-later` holds an introduction indefinitely**, and for how
    long. #59 has the action; it has no retention.
12. **Whether the completed-date counter should ever be reachable from a real
    chat.** Not now — #59 and #49 forbid it and §7.4 states it as an absence.
    Recorded because it is the obvious next request and the answer has a reason
    rather than a preference.