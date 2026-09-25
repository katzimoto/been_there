# Privacy & User Settings

> Issue [#17](https://github.com/katzimoto/been_there/issues/17). Parent:
> [#1](https://github.com/katzimoto/been_there/issues/1).
> Authority: [System domains & boundaries](../architecture/00-overview.md). If this
> document contradicts the overview's eight commitments, the overview wins.
>
> Vocabulary used here — account state, identity state, risk state, `caseId`,
> `DataSensitivity` — is the overview's, not a local synonym set.

Settings are the user's control surface. Two rules make this document more than a
preferences screen:

1. **The safe state is the default state.** Every privacy-relevant setting
   defaults to the value that exposes less, and settings that cannot safely be
   changed by the user are not settings at all.
2. **A setting is a projection, not a capability.** Settings narrow what the user
   sees. They never grant anything: the account state machine owns capabilities,
   and a setting cannot re-enable what `limited`, `suspended`, or `banned` removed.
   This is the overview's commitment 2 seen from the settings screen — the
   Settings page must not display a control that would lie about what the account
   can do.

## 1. Boundary

| This spec owns | This spec never owns |
|----------------|---------------------|
| The settings inventory: what exists, its type, default, and scope | Any `AccountState` or capability — capabilities come from `capabilitiesFor(state, ctx)` |
| Location privacy: storage class, the coarse band shown to others, and the anti-triangulation rules | Whether exact location is retained for safety purposes — that is the Identity domain's `sensitive` store |
| Per-field visibility defaults for profile data | The profile field schema — that is [Profile & Personalization](./profile-and-personalization.md) |
| Blocked-user separation: every surface a block must remove a user from | The block's effect on moderation evidence retention — that is [User Safety Controls](./user-safety-controls.md) and the overview's commitment 4 |
| The settings required to exercise the rights in issue #1 | The deletion/recovery mechanics — see [Account & Onboarding](./account-and-onboarding.md) §Deletion and recovery |
| Read/write of the user's own settings, all class `user` | Reading anyone else's settings; there is no cross-account settings read, ever |

## 2. Settings inventory

`Scope` is who the setting affects: `self` (this account only) or
`session` (this device only). "Who can see the result" is the answer to "who
observes any change in behaviour caused by this".

| # | Setting | Type | Default | Scope | Who can see the result |
|---|---------|------|---------|-------|-------------------------|
| **Dating preferences** | | | | | |
| 1 | `age_range` | `{ min, max }` integer years, 18–99 | 18–99 | self | Only the user. Coarsened to 5-year bands for candidate filtering; never surfaced to a candidate. |
| 2 | `max_distance` | enum band: `near` ≤8 km, `city` ≤40 km, `region` ≤150 km, `anywhere` | `region` | self | Only the user. Sets a ceiling; a candidate is shown at a band never wider than the ceiling. |
| 3 | `gender_preference` | enum set | unset (no filter until set) | self | Only the user. Filters candidates; never exposed to a candidate. |
| 4 | `compatibility_mode` | `friends` \| `dating` \| `open` | `open` | self | Only the user. |
| 5 | `show_me_distance` | boolean | `true` | self | A matched counterpart sees the distance band instead of "Nearby", and can tell the difference. |
| 6 | `hide_me_from_search` | boolean | `false` | self | A matched counterpart cannot be found by name in search. |
| **Privacy** | | | | | |
| 7 | `display_name_visibility` | `public` \| `matches_only` | `public` | self | A non-matched candidate sees a display name unless narrowed. Never a full legal name. |
| 8 | `bio_visibility` | `card_truncated` \| `matches_only` | `card_truncated` | self | A non-matched candidate sees a truncated bio; a match sees the full text. |
| 9 | `interests_visibility` | `public` \| `matches_only` | `public` | self | A non-matched candidate sees interests unless narrowed. |
| 10 | `exact_location_sharing` | enum: `off` \| `band_only` \| `band_and_city` | `band_only` | self | A matched counterpart may see the coarse band; only `band_and_city` adds a coarse area name. Exact coordinates are never an option. |
| 11 | `read_receipts` | boolean | `true` | self | A matched counterpart sees "read" or does not. |
| 12 | `last_active_visibility` | `nobody` \| `matches` \| `everyone` | `matches` | self | A matched counterpart sees last active. `nobody` hides it; `everyone` is not offered in v0.1 (see open questions). |
| 13 | `photo_visibility` | `all` \| `matches_only` | `all` | self | A non-matched candidate sees a subset of photos. |
| **Safety** | | | | | |
| 14 | `block_list` | derived view over `block.changed` events | empty | self | Nobody. Not the blocked user, not any product surface. |
| 15 | `report_history` | derived view over `report.submitted` events | empty | self | Only the user. Never the reported user. |
| 16 | `auto_hide_reported_profiles` | boolean, not user-toggleable | always `true` | — | A user reported for a confirmed violation is not shown in discovery to anyone until lifted. |
| 17 | `block_removes_everywhere` | invariant, not user-toggleable | always `true` | — | The blocking user is not shown the blocked user's profile, match, or messages on any surface. |
| **Notifications** | | | | | |
| 18 | `push_likes` | boolean | `false` | self | The counterpart learns nothing. |
| 19 | `push_messages` | boolean | `true` | self | The counterpart learns nothing. |
| 20 | `push_matches` | boolean | `true` | self | The counterpart learns nothing. |
| 21 | `email_digest` | boolean | `true` | self | The counterpart learns nothing. |
| 22 | `email_discovery_digest` | boolean | `true` | self | The counterpart learns nothing. |
| 23 | `quiet_hours` | `{ from, to }` local time, or `off` | `22:00`–`08:00` | self | Nobody. Critical notifications ignore it — see [Notifications](./notifications.md) §5. |
| **Account** | | | | | |
| 24 | `date_of_birth` / age gate | date, attested at signup | attested | self | Age band only is public. The exact date is `user` and appears in no product surface. |
| 25 | `account_deletion` | action, not a stored setting | — | self | Nobody. The account leaves discovery. |
| 26 | `data_export` | action | — | self | Nobody. Delivers a class-`user` archive to the owner. |
| 27 | `contact_email` | email address | from signup | self | Nobody. Used for critical notifications; never rendered in a profile. |
| 28 | `marketing_email` | boolean | `false` | self | Nobody. Kept separate from all transactional mail precisely because transactional mail is not suppressible. |

Nothing in this table is a Map or a free-form bag: every setting is a named,
versioned field in a read-model projection, so adding one is a reviewable diff.

## 3. Location privacy

### 3.1 What is stored

| Field | Class | Retention | Read by |
|-------|-------|-----------|---------|
| `location.latitude`, `location.longitude` (exact, from device) | `sensitive` | Until account deletion | Identity anomaly detection and Trust & Safety only; every read is access-logged |
| `location.cell` (coarse cell derived at write time) | `internal` | Rolling 30 days | Platform coarse-location service only |
| `location.distance_band` (what a counterpart sees) | `public` | Current | Discovery and profile cards |
| `location.city` | `public`, only when `exact_location_sharing = band_and_city` | Current | Profile card, matches only |

The exact coordinate is stored because safety needs it — a credible block is
harder if you can prove proximity, and a safety investigation needs to know
whether two accounts were in the same place. It is stored **because** it is
sensitive, and the reason it is stored is not a reason to expose it. It never
leaves the Platform coarse-location service in raw form.

### 3.2 What is shown to others

Coarse distance only, in bands. Band edges are chosen so that the *width* of the
band grows with distance, matching the intuition that precision matters close by
and matters less far away, while never getting narrow enough to be a locator:

| Band | Presented as | Band width |
|------|--------------|-----------|
| `very_close` | `< 1 km` | 1 km |
| `close` | `1–5 km` | 4 km |
| `nearby` | `5–15 km` | 10 km |
| `in_area` | `15–40 km` | 25 km |
| `in_region` | `40–100 km` | 60 km |
| `far` | `100+ km` | open-ended |

The core rule, and the one that must not be relaxed: **the band is a step
function of distance, not the distance.** No API, screen, export, or
notification may return a numeric distance to a counterpart in v0.1. A band
with N km of width leaks roughly an annulus of area A = π((d+b)² − d²); at
`close` that is under 160 km², which is already too precise at city scale, and
the bands above it widen precisely so the annulus grows.

### 3.3 Triangulation: the rural case

The prompt's scenario is the one to design against: **a user who is the only
eligible person in a rural area can be located by triangulation** if every
observation exposes a band, because the intersection of a handful of annuli
around known points collapses to a point. Repeated observation is the attack, not
a single observation.

The platform's answer is five mechanisms, all of which are load-bearing:

1. **The band is recomputed on a fixed schedule, not on movement.** A distance
   band is recalculated at most once per 12 hours per viewer, from the target's
   last known cell at the *start* of the window. A user who moves 200 m is
   indistinguishable from one who does not. This converts a continuous location
   signal into a 12-hour-stepped one and is why "she suddenly appears closer"
   is not a thing a stalker can watch happen.
2. **The viewer's own precision is irrelevant.** The band is computed from the
   target's cell, and the viewer's location only selects the cell. A viewer with
   a precise fix gains nothing over one with a coarse fix, which removes the
   "get exact distance by using an unmasked tool" escalation.
3. **Cell-size suppression.** If a cell contains fewer than 10 other eligible
   users, the band is widened to `in_region` (or `far`). Being the only person in
   a village is therefore not observable, because everyone in that village looks
   the same distance away. This is the k-anonymity floor and it is the direct
   answer to the rural triangulation case.
4. **No viewer gets a second, sharper band.** Once a viewer has received
   `distance_band` for a target, subsequent reads return the same band for the
   remainder of the 12-hour window. There is no "refresh" that narrows.
5. **Distance is not available to non-matches at full width.** A non-matched
   candidate's card shows at most `in_area`; a matched counterpart can see the
   full ladder. This bounds the population that can build an intersection at all.

### 3.4 Residual risk, stated honestly

These mechanisms raise the cost of triangulation; they do not make a distance
band safe against a motivated adversary who controls several accounts in a known
sparse area, over weeks, in a market where the 12-hour window and the k=10 floor
are the only constraints. The platform accepts this residual risk for v0.1
because the alternative — showing a real distance — is strictly worse and because
the 12-hour window and k-anonymity floor make a single-account attacker
ineffective. Revisit before any market with a public location-sharing feature.

## 4. Profile-field visibility

Defaults, by class. `public` means visible to any authenticated user who is
eligible to see the profile at all — which, per the overview's commitment 1,
means only to users whose own identity state is `verified`. An unverified viewer
sees nothing; this table is only about the `verified`-viewer case.

**Ownership split.** [Profile & Personalization](./profile-and-personalization.md)
§3 owns the field inventory and each field's **maximum** visibility — what the
product is ever willing to render. This section owns the **per-account default
and the override**: what a user sees before they change anything, and how far
they may narrow it. A default here can never exceed the maximum there, and
adding a field to #10 without a row here means it has no default and no
privacy override, which is a gap to close rather than a licence to render it.

| Field | Default visibility | Overridable to | Notes |
|-------|--------------------|----------------|-------|
| `display_name` | `public` | `matches_only` | Never a full legal name. A name on a curated public-figure list is held at `matches_only` — see §4.1. |
| `age_band` | `public` | — | Five-year bands only, floored at 18. Never an exact age; the 18+ gate is satisfied by attestation, not by disclosure. |
| `photos` | `public` (all) | `matches_only` | Photo count capped. Metadata is stripped **at ingest**, not at serve (#10 §6.1): no EXIF, GPS, capture timestamp, or device identifier on the stored derivative. A retained original is a retained location history, so a serve-time-only rule would leave the coordinates in our own storage where the opt-in city choice in §3 means nothing. |
| `bio` | `public` (card-truncated, full text matches-only) | `matches_only` | Free text; the only free-text field in the product. The card shows a truncated excerpt, the conversation shows the full text. A bio hidden from the card leaves a like decision with no information, which is how a product teaches people to like on photos alone. |
| `interests` | `public` | `matches_only` | — |
| `coarse_distance_band` | `public` | (off, via `show_me_distance`) | §3 |
| `city` | `matches_only` | `public` (via `exact_location_sharing`) | Not a profile field in #10 — the coarse distance bucket is the only location on a card. This row covers the derived area name Platform attaches for a match. Opt-in, and the choice is the control. Never a neighbourhood, postcode, or venue. |
| `last_active_at` | `matches_only` | `nobody` | Granularity is hours, not seconds. |
| `read_receipts` | `matches_only` | `off` | Per conversation, not global. |
| `verification_badge` | `public` | — | Owned by the discovery surface, not the profile record. Public data: it tells others this account is verified and reveals no method, date, or evidence. |
| `date_of_birth` (exact) | `owner_only` | — | Never leaves the owner's account. |
| `contact_email` | `owner_only` | — | Never in a profile. |
| `like_history` (who liked whom) | `owner_only` | — | Counterparties are not told. |
| `block_list` | `owner_only` | — | Never, under any circumstance, to a blocked user. |
| `report_history` | `owner_only` | — | A reporter is not told the outcome. |
| `occupation`, `education` | **not in v0.1** | — | Deliberately excluded by #10 as the highest-value doxxing target for someone who already has a name. Listed here so the exclusion is a decision on the record and not an omission. Reserved for a later issue, and if introduced they would start `matches_only`. |
| `identity_evidence`, `liveness_artifacts` | `sensitive` | — | Identity domain only. No product surface, no export, no analytics. |
| `verification_provider_response` | `sensitive` | — | Same. |
| `risk_state`, `risk_scores`, `detector_names` | `internal` | — | Trust & Safety and Moderation only. Never rendered to any user, including the subject of the risk. |
| `eligibility_reasons` | `internal` | — | Never rendered. A user is told they are eligible, not why someone else is not. |
| `account_state` (of a third party) | `owner_only` | — | A user is told their own standing. A user's card never shows that another account is `limited` or `suspended`. |
| `moderation_case`, `case_notes`, `moderator_decision` | `restricted` | — | Moderation role only, every read access-logged. Never in a product surface, never in a notification. |
| `report_evidence` | `restricted` | — | Moderation role only. |

The default posture is **narrow-where-it-identifies, open-where-it-helps**.
`display_name`, `age_band`, `photos`, and `bio` are public because a like is a
decision and hiding the decision inputs produces a photo-only product.
`occupation` and `education` are not in v0.1 at all (#10), and `city` is
opt-in rather than public, because a location identifies a person *outside* the
dating context to someone who is not a counterparty. Note the asymmetry: the
four public fields identify a user **to another member of the app**, which is
the context they were written for; a city is identifying outside it. That is
also why `city` needs no compensating rule for `display_name` being public —
the user chose it, once, explicitly, and the choice is the control.

The user can narrow anything in the first group, and nothing in either group
can be widened past #10's maximum.

### 4.1 Names that collide with a public figure

`display_name` defaults to public, so a name a stranger can search is a
default, not an edge case. The handling is set by
[Profile & Personalization](./profile-and-personalization.md) §3 (rule R1) and
restated here because it changes a *default* and that is this document's job:

| Step | Effect | Class |
|------|--------|-------|
| The name matches a curated public-figure list | The name is **accepted** — plenty of real people share a famous name, and refusing them is its own harm | — |
| …and the field's effective visibility | Held at `matches_only` until the user does something about it | `public` field, narrowed |
| The user is invited to change the name or keep it private | Nothing else about the profile changes. If they do nothing the name stays match-only indefinitely | — |
| The account is flagged as a possible impersonation subject | A **signal** to Trust & Safety, which decides whether a case opens. A human judges impersonation; the string match never does | `internal` |

Three properties make this consistent with the overview, and they are the
reason this is a default rather than an enforcement:

- **It is not a rejection.** No account is refused a name, and no account state
  moves. The overview's commitment 2 is that automation never enforces, and a
  name match moving an account to any state would break it.
- **It is a per-field content outcome, exactly like photo screening.** A field
  gets a narrower visibility; the account is unaffected.
- **Nothing is shown to the user as a fact about themselves.** The prompt reads
  as an ordinary choice ("add something that makes it yours, or keep it
  private"), not as an accusation. A user told "your name resembles a public
  figure's" learns something they did not need and cannot act on.

The failure mode is deliberately mild: a false positive costs a private name,
not a blocked account. The list's size and maintenance are the real exposure
here — a list that is too small misses impersonators, and one that is too large
silently privatises ordinary people's names. Both are recorded in §9.

## 5. Blocked-user separation

Blocking is immediate, total, and silent. Three properties, all of which are
separately testable:

### 5.1 The blocker does not see the blocked user, anywhere

A `block.changed` event removes the blocked user from every surface for the
blocking user, immediately and permanently, on the same write path as the block
itself — not as an eventual projection:

| Surface | Result after block |
|---------|--------------------|
| Discovery feed | Blocked user excluded from the feed, from the "more like this" list, and from every logged-out preview |
| Like | Blocked user's existing likes are not shown; a new like is impossible |
| Match | Match is closed for the blocker; the blocker sees it as ended |
| Messaging | Conversation is hidden from the blocker's inbox, unread badge, and search; sending is impossible |
| Profile | Direct profile view returns not-found, not forbidden — the blocker must not learn the user still exists |
| Search | Name search returns no result |
| Unread counts and match counters | Excluded from every count |
| Analytics denominators | The blocker's conversation and match counts exclude blocked pairs, so blocking does not distort the funnel metrics in [Product Quality & Measurement](./product-quality-and-measurement.md) §3 |

Report availability is **not** a surface a block removes. Per the overview's
commitment 4 and issue #1, the blocker keeps `report` capability, and the
moderation evidence already retained is unaffected.

### 5.2 The blocked user is not told who blocked them

- No event of kind `match.ended_by_other` is emitted to the blocked user that
  distinguishes a block from an unmatch.
- The notification the blocked user receives (kind #16 in
  [Notifications](./notifications.md) §3) is the generic end-of-contact copy. It
  contains no reference to blocking, no case, no policy citation, and no
  timestamp that would let them correlate against a block they performed.
- A profile view by the blocked user returns not-found, exactly as for a
  deleted account, so a block is not distinguishable from absence.
- **The blocked user is told contact ended.** Silence would leave them
  messaging into a void with no explanation, which is worse for them and worse
  for platform safety: an unexplained dead end is a strong driver of the "why
  does nobody reply" harassment the product is trying to prevent. The copy is
  deliberately neutral and points at reporting, because reporting after a match
  ends is a supported flow.

```ts
// CONTRACT SKETCH — not an implemented API.
// What the product surfaces need to ask about a counterparty.
interface BlockSeparation {
	// true → the viewer must render "not found" for this counterparty, not "blocked".
	readonly appearsToExistTo(viewerUserId: string, subjectUserId: string): boolean;
	// true → the subject was blocked by the viewer, or has blocked the viewer.
	readonly isSeparatedByBlock(viewerUserId: string, subjectUserId: string): boolean;
	// The copy discriminator: identical output for block and unmatch.
	readonly endOfContactReason(subjectUserId: string): 'match_ended';
}
```

### 5.3 Reconciliation with the unmatch rule

An unmatch is not a block. After an unmatch, both users lose the match and the
conversation surface, neither is told why, and **both retain the right to
report** with the conversation's evidence intact. Blocking is a one-directional
safety action that also ends contact. Both are silent to the other party. The
difference is directional and the evidence consequence, not the copy.

## 6. Settings required to exercise issue #1's rights

Issue #1 lists, among its P0 items, sign-up/login/recovery, an 18+ age gate, and
account deletion. Each of those is a right the user can only exercise if a
setting or action exists:

| Right in issue #1 | Where it lives in the settings surface |
|-------------------|----------------------------------------|
| Account recovery | `contact_email` (#27) is the recovery address; the action is initiated from Settings → Account. Recovery mail is critical and unsuppressible. |
| 18+ age gate | `date_of_birth` (#24), attested at sign-up and immutable by the user. Self-attestation is a false-attestation risk, not a settings problem; the 18+ claim is confirmed at verification, not here. |
| Account deletion | `account_deletion` (#25). Cross-references the deletion and recovery flow in [Account & Onboarding](./account-and-onboarding.md) §8 — this spec owns only that the affordance exists, the irreversible confirmation, and that deletion is never deferred by an unsuppressed-mail setting. |
| Data portability / access | `data_export` (#26) — a class-`user` archive. Evidence and moderation records are excluded, and the export says so. |
| Stopping contact | `block_list` (#14), the reverse of which is exercised via block. |
| Reporting | No setting; the affordance is a capability, and it exists even on a `limited`, `suspended`, or `banned` account. |
| Contacting support for a moderation outcome | `contact_email` (#27) plus the `caseRef` printed in the enforcement notification. |

## 7. Settings a user may NOT turn off

Stated plainly, with the reason, because each of these will be requested.

| Not a setting | Why |
|---------------|-----|
| **Verification before discovery** (commitment 1) | Discoverability is a pure function of the identity state machine. If it were a setting, `verified` would no longer be the only discoverable state, and the entire safety claim collapses. |
| **The 18+ gate** | A product whose users are adults cannot carry an opt-out. |
| **Coarse distance instead of exact location** (commitment 5) | There is no `exact` option in `exact_location_sharing`. The setting chooses how much *coarse* data to show. |
| **k-anonymity cell suppression** (§3.3) | It only ever applies to users who are alone in a cell, i.e. users who would be located by it. A user in a dense area never triggers it. Making it toggleable would mean the rural user has to opt into being locatable, which is a bad trade for anyone. |
| **The 12-hour band refresh interval** | A per-user toggle would be an opt-in to being trackable. |
| **Enforcement and verification notifications** (§2.1 of Notifications) | No `false` exists to set; see the reasoning there. |
| **Report and block capability on a restricted account** | `limited` removes named capabilities (`like`, `send_message`) and keeps `report` and `block`. A restricted user must be able to report the thing that got them restricted. |
| **Evidence retention for reports the user filed** (commitment 4) | Retained independent of the dating relationship; the user may file a report but may not withdraw the evidence afterwards, because withdrawing it would let a pattern be erased. |
| **Capability restoration via settings** | A setting cannot lift a restriction. Only a moderator on a case can. |
| **Visibility of a third party's account state** | Never a user setting in either direction. |
| **Suppression of the audit log of moderation and trust-state changes** (issue #1) | Audit is a moderation guarantee, not a user preference. |

## 8. Cross-references

- [Notifications](./notifications.md) — the settings in §2 rows 18–23 are
  `NotificationPreferences`, and the non-suppressible kinds are defined there.
- [Account & Onboarding](./account-and-onboarding.md) §7–§8 — deletion and
  recovery mechanics referenced in §6.
- [Profile & Personalization](./profile-and-personalization.md) §3 — the field
  inventory and each field's maximum visibility; §4 here holds only the default
  and the per-account narrowing.
- [User Safety Controls](./user-safety-controls.md) — block and report
  affordances, evidence retention.
- [Preferences & Discovery](./preferences-and-discovery.md) — how rows 1–4
  become a candidate feed and why they are never surfaced to a candidate.
- [Product Quality & Measurement](./product-quality-and-measurement.md) — the
  funnel and health metrics, and the event index for every setting write
  (`settings.updated`).

## 9. Open questions

- Whether `last_active_visibility = everyone` is safe to offer. Current default
  is `matches`; `everyone` is deferred because last-active is a location proxy
  at a coarse time granularity.
- **Photo + opt-in coarse area is a triangulation path.** A photo is a face, a
  landmark, and a room at once, and it is an artefact the other person did not
  choose to see, so the "the choice is the control" reasoning that answers
  `city` on its own does not transfer to it. Stripping metadata at ingest
  (#10 §6.1) removes the explicit signal but not a recognisable building or
  landscape, which no list enumerates. Whether this warrants a rule — a
  location-plausibility screen, or a stricter environment list — or stays a
  design review is undecided, and the same question is now open on the #10
  side so it is visible from both documents rather than living only here.
  Needs a design review, not a default flip.
- Whether `data_export` may include the coarse band history (a `public` class
  field) or only the current value. Current draft: current value only, because the
  history is a location track.
- Whether a blocked user who is, separately, suspected of platform abuse
  receives enforcement notifications normally. Drafted as yes — a block is not an
  enforcement action and must not become a covert enforcement channel — but this
  needs moderation sign-off.
- The exact k-anonymity floor. `k = 10` is drafted; the right value depends on
  market density and is a launch-time decision informed by the
  `discovery.exhausted` rate.
- The public-figure list's **size and maintenance** (§4.1). How large it
  should be, who curates it, and how stale it may get. This is the only
  residual from the `display_name` default, and both directions of error are
  non-punishing — a miss costs a private name, not a blocked account — so it is
  a tuning question rather than a safety one.
