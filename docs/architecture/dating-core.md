# Dating Core — profiles, discovery, matching

> Issue [#4](https://github.com/katzimoto/been_there/issues/4). Parent:
> [#1](https://github.com/katzimoto/been_there/issues/1).
> Read [`00-overview.md`](./00-overview.md) first: it is the authority, and this
> document is written to be consistent with it.
> Executable contract: `packages/dating`.

The basic dating flow — profile → discovery → like → match → unmatch, with
blocks — is described here **independently of safety, moderation and
infrastructure**. Nothing in this domain can suspend an account, flag a
harasser, or know why an account was restricted. It reads other domains'
published standings and applies product rules to them. That separation is the
point: the product can be built, argued about and tested without a single
moderation concept.

## 1. Owns / never owns

| Owns | Never owns |
|------|-------------|
| Profile content, its lifecycle, and what "complete" means | Identity evidence, verification decisions, likeness artefacts |
| The visibility projection of identity and account standing — *which* projection is read, never what it means | Writing `AccountState` or calling an enforcement command |
| Dating preferences and the mutual compatibility rule | Messaging transport, conversations, message retention policy |
| Discovery eligibility: the ordered deny-list that decides who a viewer may see | Ranking strategy beyond basic filtering, recommendation models |
| Likes, passes, matches, unmatching, the match identity rule | Detectors, risk scoring, report intake, case records |
| Blocks as a first-class relationship and their precedence over everything else | Deciding whether a block is justified; that is moderation's, and a block is always allowed |
| Coarse distance bands and the rules that consume them | Acquiring, storing or resolving an exact coordinate |
| Versioned read models (`DatingReadModel`) for discovery and messaging | Consuming another domain's internals; only its published projections |

## 2. Profile lifecycle

```
	  ┌──────────┐
	  │  draft   │
	  └────┬─────┘
	       │ mark_complete / mark_incomplete
	       ▼
	  ┌──────────┐        pause          ┌──────────┐
	  │incomplete│◄─────────────────────►│  paused  │
	  └────┬─────┘   mark_complete /      └────┬─────┘
	       │          mark_incomplete          │ hide
	       │ mark_complete                    ▼
	       ▼                            ┌──────────┐
	  ┌──────────┐       hide            │  hidden  │
	  │ complete │────────────────────►└────┬─────┘
	  └────┬─────┘                          │
	       │                        mark_complete / mark_incomplete
	       │ delete                          │
	       └──────────────┬───────────────────┘
	                      ▼
	               ┌──────────┐
	               │ deleted  │  terminal, reachable from every other state
	               └──────────┘
```

`complete` is the only state a profile can be shown from, and it is **not** the
same as *filled in*. `evaluateProfileCompleteness` requires, and reports every
missing field rather than the first:

| Requirement | Why it is required |
|-------------|--------------------|
| Display name, 1–50 chars | The only label a card has |
| Bio, 20–500 chars | A blank card is a wasted impression |
| 3 **approved** photos | A photo still in media review must not put a face in front of another user |
| 1 answered prompt | — |
| ≥ 1 gender identity | Compatibility cannot be evaluated without it |
| Age 18–120 derived from a birthdate | An unknown or unparseable age fails; it never passes |
| A resolvable coarse location | Distance filtering is impossible without it |

Two structural consequences, both enforced in `profileMachine`:

- **An incomplete profile never enters discovery.** The `complete` gate is a
  transition guard, not a filter someone can forget: a command that claims
  `mark_complete` without meeting the requirements is rejected with
  `validation_failed`.
- **`hide` is unreachable from the client.** It requires a
  `ProfileHiddenReason`, which only the `account_state.changed` handler and
  moderation-driven enforcement supply. A user who does not want to be seen
  uses `pause`.

Resuming and restoring are deliberately the same domain action: content decides
how far a profile comes back (`mark_complete` / `mark_incomplete` from any
non-deleted state). The *actor* and the *reason* travel on the command and on
the published event, not as extra edges in the table.

## 3. Like, pass, match and unmatch lifecycle

```
	  ┌──────┐  like   ┌───────┐  mutual_like (no pass, no block)  ┌────────┐
	  │ none │────────►│ liked │─────────────────────────────────►│ matched │
	  └──┬───┘         └───┬───┘                                   └───┬────┘
	     │ pass            │ withdraw_like                           │ unmatch
	     ▼                 ▼                                         ▼
	  ┌────────┐       ┌──────┐                                  ┌───────────┐
	  │ passed │       │ none │                                  │ unmatched │
	  └────┬───┘       └──────┘                                  └─────┬─────┘
	       │ like                                                 like │
	       └──────────────► liked                                    └───┘
```

- A **pass is a soft hide, not a veto**: it removes the candidate from the
  passer's discovery for a **30-day window** (`PASS_SUPPRESSION_DAYS`), and a
  later like by the same person supersedes it immediately — the like names the
  pass it overrode in `supersededPassId`, and `recordLike` returns that pass
  moved to `superseded`. Only a block is permanent.
- **A pass is a window, not a tombstone, and the clock is an argument.**
  `isPassInEffect(pass, at)` is the single definition of "suppresses right now",
  and `DiscoverySnapshot` carries `now` for exactly that reason: a pass that has
  expired suppresses nobody, so a decision the user cannot review cannot become
  a permanent exclusion.
- **A like after a pass, and a match across a pass, are one rule read twice.**
  `interactionMachine` lets a passer like; `recordLike` supersedes that pass in
  the pass list it returns, so `resolveMatch` — given the list the like
  produced — finds no pass in effect in either direction and matches, and
  discovery no longer reports `already_passed` to the party who liked. The
  counterpart's own pass is untouched and still refuses, because one person's
  like cannot speak for the other party's pass. Both writers return
  `InteractionOutcome` (ledger *and* passes) for that reason: a caller cannot
  keep one list and discard the other, which is how a live pass and a like
  claiming to have overridden it used to sit in the same data set.
- **Nothing is deleted.** A retracted like, a superseded pass, an ended match
  and a released block are all states on retained records, so a pair that once
  existed can always be reported — see §3.2.
- **Idempotence.** A like is a fact about the ordered pair `(from, to)`, not
  about a request. `recordLike` replays the same like id as success with an
  unchanged ledger, and rejects a *different* like id for the same pair as
  `conflict`. A retried request can never inflate a like count or a match.
- **A match needs two distinct reciprocal likes, no pass in effect in either
  direction, and no active block.** Anything else is a refusal with a reason
  (`match_refused: blocked | passed`), not an error. A pass that has expired or
  been superseded does not refuse.
- **Unmatch** is available to either participant. The match record is retained,
  the likes between them are **withdrawn rather than deleted**, and the
  conversation is closed but kept (`retainedForEvidence: true`). The command
  carries an `idempotencyKey`, and a retry with the same key replays the same
  outcome rather than failing as an invalid transition.
- **Standing is per party.** `MatchRecord.standings` holds one entry per
  participant, in `participants` order, and the two are equal only while both
  are `active`. See §3.3.

### 3.1 The mutual-match concurrency rule

> Exactly one match exists per unordered pair of users, no matter how many
> concurrent like requests race to create it.

The rule is a pure function over two like records — `resolveMatch` — and it does
not depend on who commits second:

1. Reject a self-pair, and a triggering like that is not the actor's like of the
   counterpart (`validation_failed`).
2. An active block in either direction → `match_refused: blocked`.
3. A pass **in effect** in either direction → `match_refused: passed`.
4. No reciprocal like in the ledger → `awaiting_counterpart`. This is a normal
   outcome, not an error.
5. Otherwise derive the match: `matchId = deriveMatchId(a, b)`, where
   `deriveMatchId` is a function of the **canonical (sorted) pair**.

Because the match identity is derived from the pair and not from the writer, two
racing writers compute the *same* `MatchId` and the same ordered pair of like
ids. The second committer recognises an existing match instead of creating a
rival one; if the storage layer adds a unique constraint on `matchId` (or a
compare-and-set on the pair key), the race is a no-op instead of an error. The
domain property is stated here so the storage choice stays an implementation
detail rather than a correctness requirement.

### 3.2 Standing is per party, and never removed

`MatchRecord.standings` is a two-entry tuple in `participants` order, and
`MatchEnd` carries the **cause** (`unmatched` | `ended_by_block`) separately.
The cause is the same for both parties; the standing is not, and that asymmetry
is the whole reason it is modelled as two entries:

| Event | `participants[0]` | `participants[1]` |
|-------|--------------------|--------------------|
| created, both usable | `active` | `active` |
| `unmatch` by either party | `closed_by_actor` | `closed_by_actor` |
| `applyBlockToMatch`, blocker first | `closed_by_actor` | `closed_by_target` |
| counterpart's identity lapses | `dormant_target_unverified` | `active` |
| counterpart lost `send_message` | `restricted_by_target` | `active` |
| counterpart cannot appear in the product | `closed_by_target` | `active` |

The four degraded rows are **not written**. They are computed on read:
`relationshipView` calls `deriveMatchStandings(match, standingOf)` with the two
current `SubjectStandingProjection`s and puts the result in the match it hands
the reader, so the rule runs on every read rather than only when a match
happens to be written — a moderated removal that writes nothing to the match
still degrades the row it degrades. It reads **only** a capability or a
visibility bit — never a reason — so a `restricted_by_target` line can name the
missing capability without ever naming the case that removed it. It never
reopens an ended match: a `closed_*` standing outranks a degradation, because
`dormant_*` and `restricted_*` are degradations that clear themselves and
`closed_*` are ends.

The blocked party seeing `closed_by_target` rather than `closed_by_actor` is
deliberate and is the anti-disclosure property: they are told they can no longer
reach this person, never that the other person closed anything.

### 3.3 Unmatch does not destroy the right to report

The right to report is a property of the *recorded relationship*, not of its
current state. `evidenceForReport` returns the like ids, pass ids, match id and
conversation id for any subject with a recorded interaction, in any state:

| Relationship state | Reportable | Evidence attached |
|--------------------|------------|-------------------|
| live match | yes | both likes, match, conversation |
| unmatched | yes | both likes, retained match, retained conversation |
| match ended by a block | yes | retained match, retained conversation |
| released block, retracted like, or a pass | yes | the block / like / pass record |
| like retracted before it matched | yes | the like record, in state `withdrawn` |
| never interacted | no — `not_found` | — |

`ReportEvidence` carries each record with its **state**, not just its handle:
"they liked me and then withdrew it" and "they matched me and then unmatched"
are different stories, and a state is the only thing that tells them apart. A
withdrawal is a state change on a retained row, which is why
`withdrawLike` cannot leave the pair unreportable — the same reason `unmatch`
retains.

`like.recorded` and `block.created` are the two most sensitive facts this domain
holds; they are published at `internal` sensitivity and are never rendered to
anyone but the two parties involved.

## 4. Blocks

A block is stored in one direction and applied in both:

```
	 A blocks B  ──►  blocks[]: { blocker: A, blocked: B, active: true }
	                 │
	                 ├── A does not see B in discovery
	                 ├── B does not see A in discovery
	                 ├── B cannot send A a message (contactPermission: blocked)
	                 ├── no match can be created from their likes
	                 └── an open match ends: both parties' likes are withdrawn and
	                     the two standings are written (blocker: closed_by_actor)
```

**Precedence is data, not prose.** The same order is encoded in three places, so
a block cannot lose:

| Layer | Where |
|-------|-------|
| Discovery | `blocked` is R4, ahead of every relational and preference rule, and behind only the identity, profile and account-standing rules |
| Messaging | `contactPermission` checks the block before it looks at match state |
| Matching | `resolveMatch` refuses on a block before reciprocity |

Releasing a block is idempotent and retains the record for audit. A released
block stops applying immediately: the pair becomes discoverable again, and a
match can be created again if the two like each other.

## 5. Discovery eligibility — the central gate

`evaluateEligibility(snapshot)` is a pure function over a read-model snapshot.
Its shape is a **deny-list evaluated in a fixed priority order, first match
wins**, so "why was this person not shown?" has exactly one answer per request
instead of one per code path.

Order rationale: safety and legality first (may this viewer browse at all, is
the candidate a verified person, may the product show them), then the
relationship layer (block, self, prior decisions), then preference filters last
— a preference change is a product decision; a standing change is not.

| # | Reason code | Disqualifies when |
|---|-------------|-------------------|
| 1 | `viewer_identity_not_verified` | The viewer's identity state is not `verified` |
| 2 | `viewer_lacks_discovery_capability` | The viewer's standing does not grant `browse_discovery` |
| 3 | `viewer_profile_not_complete` | The viewer's profile state is not `complete` |
| 4 | `candidate_identity_not_verified` | The candidate's identity state is not `verified` — **unconditional, and the first candidate-side rule** |
| 5 | `candidate_profile_not_complete` | The candidate's profile state is not `complete` (covers `paused`, `hidden`, `deleted`) |
| 6 | `candidate_account_not_visible` | The candidate is not product-visible, or their standing does not grant `browse_discovery` |
| 7 | `candidate_cannot_reciprocate` | The candidate's standing does not grant `like`. A separate rule from visibility, because the two are separate facts: a card the candidate may not act on is a page slot spent for nothing. R3 of the feature spec covers both, and R3 precedes the block rule |
| 8 | `blocked` | An active block exists in **either** direction |
| 9 | `self_view` | Viewer and candidate are the same user |
| 10 | `already_passed` | The viewer has a pass on the candidate **still in effect** — inside its 30-day window and not superseded by a like |
| 11 | `already_liked` | The viewer has a like on the candidate that still stands: `live` or `matched`. A `withdrawn` like is history and suppresses nothing |
| 12 | `already_matched` | A match is live (`ended === null`) |
| 13 | `age_out_of_range` | The viewer expressed an age range and the candidate's age is outside it |
| 14 | `gender_out_of_scope` | The viewer's `seekingGenders` does not cover the candidate. Gender precedes distance, in this document and in the feature spec |
| 15 | `beyond_distance_limit` | The candidate's coarse band cannot be within the viewer's limit |
| 16 | `not_mutually_compatible` | The mutual compatibility test fails (rules 13–15 plus the candidate's own `openTo`) |
Reason codes are `internal`. They are diagnostic and are never rendered: a user
is told "no new people right now", never which rule fired, because the reason set
would otherwise become a side channel for inferring another person's identity
state, account standing or block.

Two asymmetries are deliberate and tested:

- **A candidate who has already liked the viewer is still shown.** A pending
  like is a decision the *viewer* has not made; hiding the person would strand
  it. Liking them completes the match instead.
- **An unmatched or block-ended match does not block rediscovery.** Only a live
  match does — those two people are already in each other's inbox.

### 5.1 The verified-candidate guarantee

Commitment 1 says unverified means undiscoverable. It is enforced twice: by
rule 4, and by an explicit re-check of the candidate's identity state after the
rule loop, before the eligible branch is reachable. Deleting or reordering the
table entry cannot make a non-verified candidate eligible — a property the test
suite proves by evaluating an *empty* rule table against an unverified candidate.
`evaluateEligibility` accepts an explicit `rules` array solely so that property
is testable; every production caller uses `ELIGIBILITY_RULES`.

## 6. Coarse location

`coarseDistanceBand(origin, subject)` is the only function in this package that
accepts a raw coordinate, and `RawCoordinate` is deliberately **not exported**:
it is declared in the module and appears in the emitted `.d.ts` without `export`,
so no consumer can name it, store it, or pass one into anything except the
bucketing rule. No exported type in this package can carry a coordinate.

Bands: `lt_5_km`, `5_25_km`, `25_50_km`, `50_100_km`, `gt_100_km`, `unknown`.

**Precision decision and rationale**

- **The first band is 5 km, not 1 km.** A "nearby" that meant 500 m would let a
  determined observer accumulate impressions and triangulate a neighbourhood.
  5 km is the coarsest band that still carries product meaning.
- **25 km steps above that.** 25 km is roughly the radius inside which two
  people can meet for a date in one metro area. Finer buckets change no product
  decision and add inference risk with every additional observation.
- **Nothing above 100 km is distinguished.** 100 km already means "would you
  travel this far for a first date"; further resolution is noise.
- **Distance is computed on a mean-radius sphere** (haversine, ~0.3% error) —
  two orders of magnitude finer than the bucket width, and not worth a geodesic
  library.
- **Bucketing can only widen a result set, never narrow it.**
  `isWithinDistanceLimit` admits a band when its *lower* bound fits the limit, so
  a person who is genuinely within range is never hidden by rounding. An
  unresolvable location (`unknown`) is never treated as too far: the platform
  could not prove distance, and an unproven fact is not evidence of ineligibility.

Location resolution itself belongs to Platform. This domain consumes bands and
owns the rule that turns separation into a band.

## 7. Preferences and mutual compatibility

`DatingPreferences` has five nullable axes — `ageRange`, `maxDistanceKm`,
`seekingGenders`, `openTo`, `locationPrecision` — and `null` means **not
expressed**, never "no one" — a half-configured filter would silently exclude the
entire population and strand the cold start.

**The two gender axes are different questions and are not interchangeable.**
`seekingGenders` is one-sided: it filters the viewer's own page and is rule 14
above. `openTo` is pair-wise: it is half of the mutual test and the only gender
dimension that can end a match. A viewer who seeks only men but is open to being
matched with anyone can now say so; with one conflated field the openness was
silently narrowed to the page filter, and the two settings in the empty state
("Include any gender" and "Include all orientations") were inexpressible.
`OrientationGroup` is the label model over `GenderIdentity`, named separately
because it is read in a different role; modelling attraction as anything else is
open (§11).

`locationPrecision` names the **coarsest** bucket the viewer permits their own
location to be shown at, and may only be coarser than
`PLATFORM_DEFAULT_LOCATION_PRECISION` (`5_25_km`) — a request to refine is
`validation_failed`. The finest band exists for computing *separation*;
publishing someone's own location at that resolution is the triangulation risk
the banding exists to prevent.

**Pause being discoverable is the profile's `paused` state, not a preference
axis.** `profileMachine.pause` is the owner's reversible switch and eligibility
rule 5 denies a `paused` profile. A `hidden` boolean on the preference record
would be a second switch for one concept, and `hidden` in the profile machine
means something else: system-driven, carrying a reason, and not owner-callable.

`areMutuallyCompatible(viewer, candidate, distance)` is pure and **symmetric**:
the verdict for (A, B) is identical to the verdict for (B, A), including which
dimensions are named, evaluated in the fixed order `age, distance, gender`. A
dimension excludes only when *both* sides expressed a constraint and the pair
fails it:

| Dimension | Excludes when |
|-----------|---------------|
| `age` | Both expressed a range, and either party's age falls outside the other's range |
| `distance` | Both expressed a limit, and the coarse band fails either limit |
| `gender` | Both expressed an `openTo` list, and either list fails to cover the other's gender identities. `seekingGenders` is never read here |

An unknown age or an unresolvable distance never excludes: a missing field is
not evidence of ineligibility. The viewer's *own* preferences are applied
separately, as rules 12–14, because a viewer filtering their own page is not up
for negotiation with the mutual rule.

Validation (`validatePreferences`) rejects what could never be satisfied: an
inverted or out-of-bounds age range, a fractional bound, an age window narrower
than `PREFERENCE_LIMITS.minAgeRangeWidth` (5 years), a distance limit that is not
one of `DISTANCE_LIMIT_KM`, an empty or duplicated gender list on either axis, an
unknown gender identity, and a location precision finer than the platform
default.

`DISTANCE_LIMIT_KM` is **derived** from `DISTANCE_BAND_BOUNDS` — `[5, 25, 50,
100]`, the bands' own upper edges — rather than restated beside them. A limit
that is not a band edge cannot be compared against a band, so accepting one
would store a number no query can honour. This is also the third distance
vocabulary the review counted: dating's bands and platform's coarser
presentation bucket are now the only two, and this document is the one that
names both.

## 8. Interaction with identity and account restrictions

**By reading projections, never by calling them.**

| This domain needs | It reads | It never does |
|-------------------|----------|---------------|
| Is this user discoverable? | `identity.status_changed` → `IdentityStandingProjection { state, generation }` | Read `latestVerificationId` or any evidence |
| What may this account do? | `account_state.changed` → `AccountStandingProjection { state, capabilities, visibleInProduct }` | Write `AccountState`, call an enforcement command, or learn a reason |
| Where is this user? | A `DistanceBand` on the candidate card | Request, store or log a coordinate |
| Is this pair blocked? | Its own `BlockListProjection` | Ask Trust & Safety to decide |

The account standing publishes a **capability set**, not a reason. A dating
client must not be able to infer that someone was reported, reviewed or
restricted, so the reason is not in the projection and never will be. A
`limited` account that still holds `browse_discovery` stays discoverable; a
`suspended` account does not; a `banned` account is not product-visible at all.
Risk state is not consulted here at all: **risk never blocks a legitimate flow by
itself** — only an account standing does.

A reaction to a standing change is still a reaction, not a call: when
`account_state.changed` removes `browse_discovery`, the `account_state.changed`
handler raises `hide` on the affected profile with a `hiddenReason`. Dating
never initiates the change.

## 9. Read models

`DatingReadModel` (version `1`) is the projection discovery and messaging read:

| Member | Answers |
|--------|---------|
| `standingFor(userId)` | Profile snapshot, identity standing, account standing, preferences |
| `cardFor(viewerId, candidateId)` | Viewer-scoped card: name, age, gender identities, bio, photo ids, coarse `distance` |
| `relationshipFor(a, b)` | Blocks, likes, passes, and the current match record for the pair |

Every standing and card projection carries `projectionVersion`, and the model
carries `version` (`DATING_READ_MODEL_VERSION`). `selectEligibleCards` refuses a
model whose version it does not publish rather than guessing at its shape, so a
consumer that has not been rebuilt against a new version fails closed. The
relationship projection is derived from the block, ledger and match projections
by `relationshipView`, which is also handed the standing lookup: it re-derives
the match's two standings there, so the match a reader holds is the match as of
that read and not as of the last write (§3.2). Cards are viewer-scoped:
`distance` is the separation from the viewer the page was rendered for.

`selectEligibleCards` is the only function that turns a model into a page. It
applies the gate in candidate-store order and performs **no ranking** — see open
questions.

## 10. Event catalogue

Published by this domain (`DATING_EVENT_CATALOGUE`, all version 1):

| Event | Sensitivity | Meaning |
|-------|-------------|---------|
| `profile.completed` | `public` | A profile reached `complete` and may be discovered |
| `profile.state_changed` | `public` | A profile entered or left any state (`draft`, `incomplete`, `complete`, `paused`, `hidden`, `deleted`). `profile.completed` remains the one transition worth alerting on; this is the invalidation signal a consumer needs for the rest |
| `profile.deleted` | `user` | Content removed; history and evidence retained |
| `preferences.updated` | `user` | Full preference values changed; owner only |
| `like.recorded` | `internal` | A directed like exists; rendered to the recipient only |
| `like.withdrawn` | `internal` | A one-sided like was retracted before a match |
| `pass.recorded` | `internal` | The passer asked not to see the candidate |
| `match.created` | `internal` | Two reciprocal likes produced exactly one match |
| `unmatch.performed` | `internal` | A participant ended the match; conversation closed, retained |
| `match.ended` | `internal` | Fact that a match stopped being usable, with the cause (`unmatched`, `ended_by_block`) |
| `block.created` | `internal` | A block exists; the blocked user is never told |
| `block.released` | `internal` | A block was released; the record is retained |

Consumed by this domain (`CONSUMED_EVENT_CATALOGUE`, both `public`):
`identity.status_changed`, `account_state.changed`. Their payload types are
declared locally so the contract is reviewable in one block; the events are
published by Identity and Moderation respectively.

**Deliberately not ours.** `discovery.entered`, `discovery.page_served`,
`discovery.exhausted` and `discovery.viewer_ineligible` are delivery-layer
signals, not dating facts: they belong to the discovery service, and a dating
client must never be able to infer a standing from them. Likewise
`like.received` is a projection of `like.recorded` onto the recipient's inbox,
not a second source of truth.

## 11. Open questions

Recorded rather than guessed, because guessing is worse than writing down the
gap.

- **Ranking beyond basic filtering.** `selectEligibleCards` is unranked and
  returns candidates in store order. Any ordering — recency, activity,
  preference affinity, mutual-likelihood — is a product decision with a
  cold-start problem and a fairness problem, and needs its own issue. It also
  needs an answer on whether a ranked page may surface a *pending* like.
- **Preference semantics for non-binary users.** The model is label matching:
  a profile carries one or more gender identities and a preference is a list of
  identities. It is known-lossy — it cannot express attraction that is not a
  function of gender, it forces a `self_described` catch-all, and a binary-only
  preference list combined with a label model can systematically hide non-binary
  users from binary-seeking viewers. Whether to model attraction separately, to
  treat an unlisted identity as "not excluded", or to require an explicit
  `open_to_all` flag is unresolved and needs user research, not a schema guess.
- **Are `paused` and `hidden` the same concept?** They are modelled as
  distinct — `paused` is the owner's choice, `hidden` is system-driven and
  carries a reason — because only the second may be applied by an account
  standing, and a user who can un-pause must not be able to un-hide. The risk is
  two similar states with near-identical product copy. If the product needs only
  one, the honest merge is to drop `hidden` and let the account standing
  govern visibility directly.
