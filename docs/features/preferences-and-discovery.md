# Preferences & Discovery

> Issue [#11 — MVP Feature: Preferences & Discovery](https://github.com/katzimoto/been_there/issues/11). Parent: [#1](https://github.com/katzimoto/been_there/issues/1).
> Depends on [`docs/architecture/00-overview.md`](../architecture/00-overview.md). If this
> document contradicts it, the overview wins and this document is wrong.
> Related: #3 (identity), #4 (Dating Core domain design), #6 (Trust & Safety), #8 (Platform/privacy),
> #10 (Profile), #18 (measurement).

## 1. Goal and done-when

Users browse an appropriate set of eligible profiles without exposing anyone who
should not be discoverable.

Concretely, when this issue is done:

- A verified user can open discovery and receive a page of eligible candidates.
- Every candidate on that page is `verified`, in good account standing, not
  blocked with the viewer in either direction, and not someone the viewer has
  already decided on.
- No unverified, hidden, suspended, banned, or blocked person appears on any
  page, in any ordering, at any page depth, including as "filler".
- When the eligible pool is genuinely empty, the product says so.

## 2. Boundaries

### 2.1 What this feature owns

| Owned | Notes |
|-------|-------|
| The discovery preference record and its validation | Per-user, `user` sensitivity |
| The candidate eligibility rule set and its evaluation order | Pure function of read-model inputs |
| Eligibility reason codes | `internal`; never rendered to a user |
| The browse session: page assembly, page size, ordering, the end-of-page state | |
| The viewer's suppression set (what they have already seen and decided on) | Owned here; the underlying like/pass records are owned by Likes & Matching, same domain |
| Discovery funnel events for #18 | |

### 2.2 What this feature never owns

| Never owns | Owner instead |
|-----------|---------------|
| Identity state, verification evidence, `IdentityRecord` fields | Identity & Verification (#3). This feature may only read `isDiscoverableIdentity` over a projection, or the `identity.status_changed` event |
| `AccountState` and capability decisions | Moderation & Enforcement (#7). This feature reacts to `account_state.changed` |
| Writing a `banned`/`suspended`/`limited` state | Never. Product domains have no enforcement write path at all |
| Blocks as an action | User Safety Controls (#14). This feature only reads the block edges |
| Like/pass/match *semantics* | Likes & Matching (#12) |
| Exact coordinates | Platform (#8). Only a coarse distance bucket is ever read or emitted |
| Risk state | Trust & Safety (#6). Risk never hides a user from discovery; only identity and account state do |
| Copy for a restriction the viewer did not cause | The owning feature. A viewer is told a capability is unavailable, never "you were reported" |

### 2.3 Which domain owns each piece of state

| State | Owner | How this feature learns about it |
|-------|-------|----------------------------------|
| `IdentityState` | Identity & Verification | `identity.status_changed` → `IdentityStandingProjection` |
| `AccountState` + removed capabilities | Moderation & Enforcement | `account_state.changed` → `AccountStandingProjection` |
| Block edges (both directions) | User Safety Controls | block events → `BlockListProjection` |
| Profile content and publish state | Profile (#10) | `profile.completed` / `profile.state_changed` / `profile.deleted` (`draft\|incomplete\|complete\|paused\|hidden\|deleted`) consumed as a projection. The state set is Dating Core's own `ProfileState`: there is no `live` state, and `profile.deleted` is `user` sensitivity because a deletion is not a fact about discoverability |
| `InteractionLedger` (likes/passes/matches) | Dating Core | `InteractionLedgerProjection` |
| Preferences | Dating Core, this feature | local record |
| Coarse location bucket | Platform (#8) | Platform read-model; the raw coordinate is `sensitive` and is never requested |

## 3. Discovery preferences

### 3.1 Contract sketch

> Sketch only. Field semantics are normative; the type is illustrative and the
> shape may differ once `packages/dating` lands.

```ts
/** Every axis is three-valued. `null` means unbounded, never "match nobody". */
interface DatingPreferences {
	readonly ageRange: { readonly min: number; readonly max: number } | null;
	readonly maxDistanceKm: number | null;                       // one of DISTANCE_LIMIT_KM
	readonly seekingGenders: readonly GenderIdentity[] | null;   // one-sided page filter
	readonly openTo: readonly OrientationGroup[] | null;         // pair-wise match test
	readonly locationPrecision: DistanceBand | null;             // coarsening only
	// Pause being discoverable is NOT here: it is the profile's `paused` state.
}
```

### 3.2 The axes

| Preference | Meaning | Validation | Default | Unset behaviour |
|-----------|---------|-----------|---------|------------------|
| `ageRange` | Inclusive age window | Both ends integers 18–120 (the 18+ gate is the floor, at every end). `minAge <= maxAge`. Width at least 5 years. | `null` | Unbounded: every eligible age in 18–120. The platform never narrows on the user's behalf |
| `maxDistanceKm` | Maximum coarse-distance bucket | One of `DISTANCE_LIMIT_KM`, **derived** from the bands rather than restated beside them: 5, 25, 50, 100 km. Not a free number — a limit that is not a band edge cannot be compared against a band | `null` | Unbounded |
| `seekingGenders` | Genders the viewer wants to see | Non-empty subset of the enum. Saving a set that currently matches nobody is allowed, but the user is warned before saving and is never auto-reset | `null` (any) | Any gender, including the viewer's own |
| `openTo` | Gender/orientation groups the viewer is open to being matched with | Non-empty subset of the enum; no unknown value, no duplicate. **Independent of `seekingGenders`**: a viewer may seek only men and still be open to being matched with anyone, which one conflated field made inexpressible | `null` = unexpressed, and an unexpressed side imposes no requirement on anyone | See §3.4 |
| — pause being discoverable | Not a preference axis. It is `profileMachine.pause`, an owner-initiated reversible profile state, and rule R2 denies a `paused` profile. A `hidden` boolean on the record would be a second switch for one concept, and `hidden` in the profile machine means something else: system-driven, reason-carrying, not owner-callable | `false` (a `complete` profile) | — |
| `locationPrecision` | The **coarsest** bucket the viewer's own location may be presented at | Bucket ids only. May only be *coarser* than `PLATFORM_DEFAULT_LOCATION_PRECISION` (`5_25_km`); a request to refine — or the pseudo-bucket `unknown` — is rejected with `validation_failed` | `null` = the platform default | `null` |
| `hidden` | Pause being discoverable | Boolean | `false` | `false` |
| `verifiedOnly` | Show only verified users | Fixed `true`, and not a field at all: it is `DISCOVERABLE_IDENTITY_STATE` in R1, a domain constant rather than a stored preference. Not present as a user-facing toggle; changing it is not a supported operation | — | Never unset |

### 3.3 The unset rule

> **No preference axis is ever interpreted as an empty set. `null` means
> unbounded on that axis and nothing else.**

An unset axis is stored as `null`, renders in the UI as "Everyone", and widens
rather than narrows. There is no "cleared" state that produces zero candidates,
because the only way to produce zero candidates by configuration would be a
filter the user cannot see the effect of.

The symmetric rule, which matters as much: **the system never silently widens
either.** Widening is always an explicit user action with a visible one-tap
"widen this filter" affordance in the empty state (§6). There is no automatic
relaxation, no "we loosened your filters to keep you browsing", no adaptive
re-query. If a filter yields nothing, the user is told it yields nothing.

### 3.4 Gender and orientation compatibility

Compatibility is **symmetric and evaluated from both sides**, and it is the only
pair-wise filter. `age_out_of_range`, `gender_out_of_scope` and
`beyond_distance_limit` are evaluated from the **viewer's own preferences
alone** — they are one-sided questions about what this viewer asked for.
`not_mutually_compatible` is the extra constraint that requires **both** sides
to have expressed the same dimension.

**An unexpressed dimension never excludes anyone.** A user who has declared no
openness imposes no compatibility requirement, and a candidate who has declared
none is excluded by no one's declaration. The system never infers orientation,
never infers gender, and never widens a declaration to make a pool look
healthier. A user who has declared nothing is told so in settings as a
sentence, not shown an empty preference that silently excludes them.

The same rule means a like can never lead to a pair that discovery would have
refused: the pair-wise test is evaluated identically at browse time and at
match time.

## 4. Candidate eligibility

### 4.1 The rule

Eligibility is a **deny-list**: a candidate is admitted only if it survives
every deny rule below. There is no allow-list, no score, and no per-rule
weighting. The evaluation order is fixed and normative.

Two stages, in this order:

**Stage 0 — viewer gate (page level, before any candidate is considered).**

- G1. The viewer is discoverable (`isDiscoverableIdentity` over
  `IdentityStandingProjection`). If not, discovery is closed entirely.
- G2. The viewer holds the `browse_discovery` capability
  (`AccountStandingProjection`). If not, discovery is closed entirely.
- G3. The viewer's own profile is complete (`profile.completed`). A viewer who
  has not finished a profile has nothing to browse against, and sending them a
  feed anyway is a way to lose them during onboarding.

The gate is first because evaluating candidates for a viewer who is not
themselves eligible is work over data that viewer has no right to see, and
because the honest answer to "you cannot browse" is a specific state (§6), not
an empty page.

**Stage 1 — candidate rules, in strict priority order.**

| # | Rule | Denies when | Why it sits here |
|---|------|-----------|------------------|
| R1 | **Identity** | The candidate's identity is not `verified` | Unconditional and first. This is commitment 1: the only discoverable identity state is `verified`. No preference, no rank, no experimental flag can precede it, and no other rule may be evaluated on behalf of a candidate that failed R1 |
| R2 | **Profile presentable** | The candidate's profile is not complete and `live` | After identity, because a profile is only a thing that can be shown once there is a verified person behind it. Consumes a *boolean* — never a completeness score, never a rank |
| R3 | **Account standing** | The candidate's account is not visible in product (`banned`, or `suspended`), or lacks `browse_discovery` (may appear) or `like` (may reciprocate) | Before everything relational, because a candidate who cannot appear or cannot reciprocate is not a useful page slot. Implemented as **two** rules with two reason codes — `candidate_account_not_visible` and `candidate_cannot_reciprocate` — because they are two separate facts and one code would hide which of them denied a candidate. Risk state is **not** consulted: `high`/`critical` risk does not remove a candidate from discovery |
| R4 | **Block, either direction** | A block edge exists between viewer and candidate in *either* direction | Early, because a block is absolute and undiscussable. It outranks every preference and every earlier decision by both parties, including a like the other party already gave |
| R5 | **Self** | Candidate is the viewer | Absolute, cheap, and independent of any data drift |
| R6 | **Already passed** | The viewer has a pass on the candidate that is still **in effect**: inside its 30-day window and not superseded by a like (§5.2). The snapshot carries `now`, because a snapshot with no clock cannot answer this | The viewer's own prior decision, and never overridden by a later page |
| R7 | **Already liked** | The viewer has a live like on the candidate | Same principle, one step later. A candidate who already liked the *viewer* is **not** excluded by this rule — liking them is how the match completes, so hiding them would strand a mutual |
| R8 | **Already matched** | An **active** match exists between viewer and candidate | A match is a resolved relationship. Only an active match denies; an ended one does not, so an unmatched or block-ended pair is discoverable again |
| P1 | **Age** | The candidate's age band falls outside the viewer's `ageRange` | Viewer's preferences only |
| P2 | **Gender** | The candidate's gender is not in the viewer's `seekingGenders` | Viewer's preferences only, and the one-sided axis. Evaluated before P3, in this document and in the architecture doc |
| P3 | **Distance** | The candidate's coarse bucket exceeds the viewer's `maxDistanceKm` | Viewer's preferences only |
| P4 | **Mutual compatibility** | The pair fails the both-sides test of §3.4 | The only pair-wise filter; an unexpressed dimension never excludes |

**Why denies precede filters.** Every deny rule is an absolute platform or user
protection rule. Every filter is a preference. Running denies first means a
candidate who is blocked can never be *counted* into a pool estimate, a
diagnostic, or an "end of results" message that would otherwise leak the
existence of people the viewer is not allowed to know about. It also means the
exhaustion signal in §5.3 is computed over the set the viewer may actually see,
which is the only set whose emptiness is safe to report.

Filters P1–P4 are evaluated in that order purely for cost; among themselves they
are commutative and the product makes no claim about which one is "responsible"
for an empty page. The UI says which axes are active, never which one was
applied first.

### 4.2 Reason codes

Each exclusion produces exactly one reason code, the **first** one that
matched. Codes are `internal` and are never shown to a user, never included in
any user-visible message, and never inferable from timing or page size.

```ts
type ExclusionReason =
	| 'viewer_identity_not_verified'      // G1
	| 'viewer_lacks_discovery_capability' // G2
	| 'viewer_profile_not_complete'       // G3
	| 'candidate_identity_not_verified'  // R1
	| 'candidate_profile_not_complete'    // R2
	| 'candidate_account_not_visible'     // R3, may not appear
	| 'candidate_cannot_reciprocate'    // R3, may not act
	| 'blocked'                           // R4
	| 'self_view'                         // R5
	| 'already_passed'                    // R6
	| 'already_liked'                     // R7
	| 'already_matched'                   // R8
	| 'age_out_of_range'                   // P1, viewer's preferences
	| 'gender_out_of_scope'                // P2, viewer's preferences
	| 'beyond_distance_limit'              // P3, viewer's preferences
	| 'not_mutually_compatible';           // P4, requires both sides
```

### 4.3 Freshness

Eligibility is evaluated against the current projections at page-assembly time.
There is no positive cache of "this candidate is eligible". Invalidation is by
event: `identity.status_changed`, `account_state.changed`, a block edge, a like,
a pass, or a match all invalidate the affected rows. A page already served to a
client is not rewritten; a profile that loses eligibility after it was served
simply stops appearing on subsequent pages, and any action taken against it is
re-checked at action time (#12).

## 5. The browse experience

### 5.1 What a page is

- **Page size: 10 candidates.** A fixed, reviewable constant, not a tuning knob.
- A page is assembled server-side per request. The client requests `cursor`,
  receives up to 10 cards, and requests the next page only when it asks.
- **Ordering is deterministic and non-adaptive.** Default order is by
  `verifiedAt` descending (most recently verified first), tie-broken by
  `subjectId` ascending so that pagination is stable across identical requests.
  There is no scoring model, no recommendation, no personalisation: those are
  explicitly out of scope in issue #1. A/B-ordering is a v0.2 question, not a
  v0.1 behaviour.
- **Card contents only** (the `CandidateCardProjection`): display name, age
  band, coarse distance bucket, bio, photo references. No exact location, no
  identity artefacts, no risk or moderation signal, no "liked by" count, no
  verification *reason*.

### 5.2 What the user can do, and what counts as a decision

| Action | Recorded | Effect on the candidate's next appearance |
|--------|----------|-----------------------------------------|
| **Like** | Yes, a live like is written | Suppressed until the like is withdrawn or a match exists. Never shown again as a browse candidate |
| **Pass** | Yes | Suppressed for the **pass suppression window: 30 days** from the pass, measured from the moment the pass was recorded, not from the browse session |
| **Undecided** — the user closed the page, backgrounded the app, or the session expired before reaching the card | **No** | Not suppressed. The card remains eligible and may be re-presented |

**Undecided is not a decision.** This is the important half of the rule. A card
is consumed only by an explicit like or an explicit pass. A user who opens
discovery, looks at three cards and closes the app has made no decision about
anyone, and inventing one would silently and permanently remove real people
from their pool.

To prevent an undecided card from dominating a later page, undecided cards are
ranked **after** every never-seen eligible candidate on the next page, and the
suppression window does not apply to them. This re-presentation is a queue
property, not a decision record.

### 5.3 Repeat-profile avoidance and pool exhaustion

> This section exists because it is where the safety thesis is easiest to break.
> Every mainstream failure mode of "we ran out of people" is a decision to show
> the user someone they should not see.

Three mechanisms, in order of strength:

1. **Persistent suppression.** Every like and every unexpired pass removes the
   candidate from the viewer's eligible pool permanently or for 30 days. This is
   the viewer's decision and is never revisited by the system.
2. **Session de-duplication.** Within a single browse session a candidate
   appears at most once, including across page boundaries. A re-presented
   undecided card is therefore the *only* way a profile can recur inside one
   session, and it appears exactly once.
3. **Pool exhaustion is reported, never padded.**

**The exhaustion rule.** When the eligible pool for a viewer is smaller than the
requested page, the remaining slots are **not** filled with ineligible
candidates. There is no "people you may have missed", no "outside your
distance", no "widen your search" auto-relax, no sponsored or boosted filler,
and no fallback ordering that relaxes R1–R8. Every commitment in the overview is
a hard filter, and a hard filter that is relaxed under growth pressure is not a
hard filter.

The response to a short or empty pool is a **state**, not a substitution:

| Pool | Response |
|------|----------|
| ≥ 10 eligible | Full page |
| 1–9 eligible | Short page plus an end-of-page state reading "That's everyone available right now" |
| 0 eligible | Empty state (§6) with the active filter axes named and a one-tap widen action |

**The honesty rule.** A user who reaches the end of the eligible pool is told
so, explicitly, in plain language, and is never handed a profile as filler to
avoid that message. Concretely this forbids, at the code level: any query path
that drops or reorders R1–R8; any "expand" flag on the page request; any
secondary ranking that runs on a relaxed filter set; and any test fixture that
asserts a page size of 10 without also asserting that every card on it passed
the full rule list.

## 6. Empty and closed states

Five states. Each is a real state a user will hit, each is a distinct screen,
and each says what happened and what the user can do next. None of them
discloses the existence, count, or standing of anyone else.

| State | Trigger | Copy (verbatim) | Actions offered |
|-------|---------|-----------------|-----------------|
| **Filters too narrow** | Pool is empty, viewer passes the page gate, and ≥ 1 preference axis is active | "Your filters are set so there are no people to show right now. Widening them doesn't change who can see you — only who you see." | One tap per active axis: "Include all ages", "Include everyone within 50 km", "Include any gender", "Include all orientations". Never a silent apply |
| **No eligible people nearby** | Pool is empty, viewer passes the page gate, and no preference axis is active | "There are no verified people available in your area right now. We'll let you know when that changes." | "Notify me" (opt-in), "Adjust my location bucket" |
| **Verification not current** | Viewer gate G1 fails: `unverified`, `pending`, `review_required`, `verification_failed`, or `expired` | "Verify your identity to start discovering people." / for `expired`: "Your verification has expired. Re-verify to keep discovering." | Resume or start verification. The copy names the *state the user is in* and never mentions a report, a case, or a review outcome |
| **Account restricted** | Viewer gate G2 fails: `suspended` (no `browse_discovery`), or `limited` with `browse_discovery` removed | "You can't browse right now. You can still report a problem or block someone." | Report, block, contact support, view what is restricted. The removed capabilities are named — a restriction is always explainable |
| **Banned** | Viewer is `banned` | "This account has been permanently closed. You can still submit a report or appeal." | Report, `appeal_request`, `delete_account` — exactly the `banned` capability set. No browse, no matches list, no messages |

A page that is merely **short** is not an empty state: it renders the cards it
has plus the end-of-page line, and the "end of list" line is only shown when
the pool is genuinely exhausted (§5.3).

**Copy rule.** Every state names the user's own condition and the action
available to them. No state says or implies that another user was blocked,
reported, restricted, or is at fault, because the product read-model does not
contain that information in the first place (overview §4).

## 7. Evaluation budget

Eligibility is a multi-source check: four projection lookups, one block-graph
membership test, one ledger index, and an indexed candidate query. That has a
cost, and the product has to make a promise about it, because a discovery page
that takes four seconds is indistinguishable from a broken app.

| Guarantee | Value | Scope |
|-----------|-------|-------|
| Page assembly, server-side, warm cache | p50 ≤ 150 ms | 10 candidates |
| Page assembly, server-side | **p95 ≤ 400 ms** | The promise. p99 ≤ 800 ms, measured, and exceeding it is an alert, not an accepted outcome |
| Candidate examinations per page request | **≤ 200** hard cap | See below |
| Gate rejection (G1/G2 fail) | ≤ 50 ms | No candidate work at all |

How the budget is met:

- R1, R2 and R3 are answered from O(1) in-memory projections
  (`IdentityStandingProjection`, `AccountStandingProjection`, and the profile
  completeness boolean). No identity record, no evidence, no cross-domain call.
- R4 is a membership test against the viewer's own block projection, whose size
  is bounded by that user's block count, not by the platform.
- R6, R7 and R8 are index lookups on the viewer's `InteractionLedgerProjection`.
- Only P1–P4 touch the candidate index, and the index is filtered by the
  primary deny predicates (identity = verified, standing in the eligible set)
  **before** preference predicates, so the expensive predicate is never
  evaluated on a candidate that is going to be denied anyway.

**The 200-examination cap.** If a page request examines 200 candidates without
filling 10 slots, the service returns the partial page it has, with an
`internal` flag `budget_exhausted`. The user sees the short page and the normal
end-of-page line. The cap bounds worst-case latency; it never causes an
ineligible candidate to be substituted, and it never silently converts a full
page into an empty one. Under a systematically too-narrow filter the cap will
be hit repeatedly, and the fix is the honest empty state, not a filter bypass.

## 8. Discovery funnel events

Named per the overview's catalogue convention (`identity.status_changed`,
`account_state.changed`, `risk.changed`). Sensitivity is per the overview's
five-class model. These are the discovery half of the funnel measured in #18.

| Event | Sensitivity | Emitted when | Payload fields |
|-------|-------------|--------------|----------------|
| `discovery.entered` | `public` | Viewer passes the page gate and opens discovery | `subjectId` (viewer), `preferenceAxesActive: string[]` (axis names only, never values) |
| `discovery.page_served` | `internal` | A page is returned, full or short | `subjectId`, `pageSize`, `short: boolean`, `budgetExhausted: boolean`, `poolBucket: 'empty'\|'small'\|'healthy'` |
| `discovery.exhausted` | `internal` | The eligible pool is confirmed exhausted for the viewer | `subjectId`, `exhaustedAt` |
| `discovery.viewer_ineligible` | `internal` | G1 or G2 rejects the viewer | `subjectId`, `gate: 'identity'\|'capability'` — the *class* of gate, never the underlying state, never a reason a moderator would recognise |
| `preferences.updated` | `user` | A preference record is written | `userId`, `ageRange`, `maxDistanceKm`, `seekingGenders`, `openTo`, `locationPrecision` |

Design constraints on these events:

- **Only one of these is a domain fact.** `preferences.updated` is the Dating
  Core domain event. The four `discovery.*` signals are delivery and analytics
  signals emitted by the discovery serving layer: they describe a request that
  was served, not a state that changed. They are named here because #18 needs
  them, and they are kept in the `noun.verb_past` convention so the funnel reads
  as one catalogue. Nothing in `packages/dating` depends on them, and nothing
  may consume them to make a product decision.
- **Preference values are published, and the event is `user` for that reason.**
  This section previously promised `changedAxes` on the stated ground that
  "analytics is a `public`-clearance consumer" — but a `public` consumer can
  never see a `user` event, so that justification was void whichever way the
  question was decided. What settles it is the schema: `changedAxes` cannot
  answer a funnel question about *which axis* narrowed a pool, only *that
  something* did, so it would have been both less useful and still invisible to
  the analytics sink. The two gender axes are published separately because they
  are separately meaningful: an analytics consumer that cannot tell "wants to
  see" from "open to being matched with" cannot read a pool-size funnel at all.
- `poolBucket` is bucketed rather than exact, so that measuring pool health does
  not become a way to count how many eligible people exist in a small
  geography.
- Like, pass, match, and unmatch events are specified in
  [`./likes-and-matching.md`](./likes-and-matching.md) and are the continuation
  of this funnel.

## 9. Acceptance scenarios

**A1 — A verified user sees eligible profiles.**
*Given* Ada is `verified` and her account is `active`,
*when* she opens discovery,
*then* she receives up to 10 cards, every one of which is `verified`, `active`,
not blocked with her, and not Ada.

**A2 — An unverified user is undiscoverable by construction.**
*Given* Bo has an account but his identity is `pending`,
*when* the system evaluates Bo as a candidate for any viewer,
*then* Bo is denied at R1, before any account, block, or preference rule is
evaluated, and no viewer is ever served a card for Bo.

**A3 — Risk alone does not hide anyone.**
*Given* Cleo's risk state is `critical` and her identity is `verified` and her
account is `active`,
*when* a viewer with no block edge to Cleo opens discovery,
*then* Cleo is eligible. Risk feeds moderation; it does not remove a user from
the pool.

**A4 — A block hides the candidate in both directions.**
*Given* Dana blocked Eli,
*when* Eli opens discovery, and separately when any other viewer opens discovery
and Dana would otherwise be eligible,
*then* Dana is denied at R4 in both cases, and the card is counted in neither the
pool size nor the exhaustion message.

**A5 — A restricted account cannot browse, and is told so honestly.**
*Given* Frank's account is `limited` with `browse_discovery` removed by a case,
*when* Frank opens discovery,
*then* the page gate rejects him, he sees the restricted state naming the
removed capability, and he can still report and block.

**A6 — A candidate who cannot reciprocate does not consume a page slot.**
*Given* Greta is `verified` but `suspended`,
*when* a viewer assembles a page,
*then* Greta is denied at R3 and does not appear.

**A7 — A pass suppresses for 30 days and then expires.**
*Given* Hana passes a candidate on day 0,
*when* she browses on day 29, the candidate is not shown,
*and when* she browses on day 31, the candidate is eligible again if no other
rule denies them.

**A8 — An undecided card is not a decision.**
*Given* Ivo opens discovery, views three cards, and closes the app without
acting,
*when* he returns,
*then* no like, pass, or suppression exists for those three, and they are
eligible again, ranked after never-seen candidates.

**A9 — Already-matched and already-liked profiles never reappear.**
*Given* Jun likes Kim, and Kim has liked Jun back so a match exists,
*when* Jun opens discovery,
*then* Kim is denied at R7 for the live like and R8 for the active match, and
does not appear.

**A10 — The pool is reported honestly, never padded.**
*Given* Leah's eligible pool contains 3 candidates,
*when* she opens discovery,
*then* she receives 3 cards and an end-of-list line saying there is no one else
available, she receives no fourth card of any kind, and no ineligible candidate
is substituted to fill the page.

**A11 — Too-narrow filters produce a named, widenable empty state.**
*Given* Mo sets an age range of 30–34 and no one eligible is in it,
*when* he opens discovery,
*then* he sees the filters-too-narrow state naming the age axis, with a one-tap
"Include all ages", and the system does not silently widen anything for him.

**A12 — Verification lost mid-session closes discovery immediately.**
*Given* Noor is browsing with a served page,
*when* her identity transitions to `expired`,
*then* every subsequent page request fails the page gate and she is shown the
re-verify state.

**A13 — An unset preference does not exclude everyone.**
*Given* Pat has never opened preferences,
*when* he opens discovery,
*then* every axis resolves to unbounded, and he is not excluded from any
eligible candidate for the reason that he never configured anything.

**A14 — The page budget is met without weakening eligibility.**
*Given* a viewer with a narrow filter set,
*when* a page request exceeds 200 candidate examinations,
*then* the service returns the partial page it has with the internal
`budget_exhausted` flag, within the p95 budget, and no ineligible candidate is
substituted.

**A15 — Eligibility reasons never leak.**
*Given* any exclusion,
*when* the page, the response metadata, the client logs, and the analytics sink
are inspected,
*then* no user-visible surface contains a reason code, and every emitted event's
sensitivity is consistent with the overview's classification table.

## 10. Open questions

- Whether a limited-time re-discovery signal (a match expiring after N days of
  silence) is a v0.2 feature. It implies a match-lifecycle decision, so it
  belongs with #12's open questions too.
- Whether an age range narrower than 5 years should be rejected or merely
  warned about. **Settled and implemented** (C-22): `validatePreferences`
  rejects it, on the grounds that a validation failure at save time is cheaper
  to understand than an empty page later. What remains open is only whether the
  floor should be 5 or wider, and whether a UI hint is owed before the
  rejection.
- Whether the 200-examination cap should be raised, lowered, or made adaptive.
  The number is a guess made without production data.
- Whether location-precision coarsening belongs in the preference record at all,
  or in Privacy & User Settings (#17) with Dating Core merely reading the
  result. The value is owned here and validated here, which may be wrong; the
  one-way ratchet (coarser only) is settled, the *ownership* is not.
- Whether the pass window should be extendable or shortened per user. Thirty days
  is implemented and asserted; nothing in the product asks for another number
  yet.
- Whether A/B-testing the ordering is acceptable at all. It is a v0.2 question,
  and the answer constrains how much the deterministic ordering in §5.1 can
  rely on being a stable contract.
