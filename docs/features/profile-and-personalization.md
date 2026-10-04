# Feature — Profile & Personalization

> Issue [#10](https://github.com/katzimoto/been_there/issues/10) · Parent: [#1](https://github.com/katzimoto/been_there/issues/1)
> Authority: [`docs/architecture/00-overview.md`](../architecture/00-overview.md). If this document contradicts it, that document wins.
> Related design: Dating Core ([#4](https://github.com/katzimoto/been_there/issues/4)); identity evidence belongs to Identity & Verification ([#3](https://github.com/katzimoto/been_there/issues/3)), media handling to Platform ([#8](https://github.com/katzimoto/been_there/issues/8)).
> Adjacent feature specs: [Account & Onboarding](./account-and-onboarding.md) ([#9](https://github.com/katzimoto/been_there/issues/9)), [Preferences & Discovery](./preferences-and-discovery.md) ([#11](https://github.com/katzimoto/been_there/issues/11)), [Likes & Matching](./likes-and-matching.md) ([#12](https://github.com/katzimoto/been_there/issues/12)), [User Safety Controls](./user-safety-controls.md) ([#14](https://github.com/katzimoto/been_there/issues/14)).
> Also specifies the dating goal and the completed-date counter:
> [#48](https://github.com/katzimoto/been_there/issues/48) and
> [#49](https://github.com/katzimoto/been_there/issues/49) (§9). The aggregates
> behind them are [Dating Core §12](../architecture/dating-core.md); where the
> two documents could be read as disagreeing, this one is the contract.

## 1. Goal and done-when

**Done when:** a user can create a profile from nothing, bring it to a state where
another user can act on it, keep it truthful over time, and take it out of
circulation — with every field's visibility, sensitivity and edit rule decided in
advance rather than per screen.

Design stance: **small and boring on purpose.** A profile is a card someone
glances at for four seconds. Every field added costs every user time at
onboarding, costs every card space, and creates one more thing to moderate. The
field list in §3 is the shortest list that still lets another user answer "is this
worth a like?" without messaging first.

Two owner-only numbers live here too, because a profile is where they are set
and where the person who set them sees them: the **dating goal** (§9.1, §9.2) and
the **completed-date counter** (§9.3–§9.7). Neither is on the card, neither is a
completeness rule, and reaching the goal changes no capability anywhere in the
product — the counter is a record of what somebody did, not a measure of them.

## 2. Boundary

| Piece of state | Owning domain | This feature reads | This feature never owns |
|---|---|---|---|
| Profile record, profile state, completeness boolean, photo set and order, prompt answers | **Dating Core** | writes through its command interface | — |
| Photo bytes, transcoding, storage, delivery | Platform (media) | media service | Storing a file path or a CDN key in a profile read-model |
| Photo content screening (nudity, text, face count, dedupe) | Moderation & Enforcement, via the screening pipeline | `profile.photo_rejected`, or a moderator case when the result is borderline | Declaring a photo "fine" from a product code path |
| Likeness of a profile photo to the verified selfie | Identity & Verification | `identity.status_changed` plus the per-photo likeness outcome Identity owns | Reading the selfie, or a likeness score |
| `IdentityState` | Identity & Verification | `identity.status_changed` → `DiscoveryStandingProjection` | Any local copy, any "trust the client" check |
| `AccountState` and capabilities | Moderation & Enforcement | `AccountStandingProjection` fed by `account_state.changed` | Any write, or any rendering of *why* a capability was removed |
| Date of birth, age band derivation | Platform ([#9](./account-and-onboarding.md)) | `ageBand` on the card projection | A birth date, an exact age, or an age field |
| Coarse location bucket | Platform | `location.resolved` + bucket band | A coordinate, an address, or a free-text location |
| Discovery preferences and candidate ordering | Dating Core ([#11](./preferences-and-discovery.md)) | — | Anything a viewer sees about another's preferences |
| Dating goal and completed-date counter | **Dating Core** ([#48](https://github.com/katzimoto/been_there/issues/48), [#49](https://github.com/katzimoto/been_there/issues/49)) | the owner's own goal, count and the progress derived from them | A target or a count on a card, a percentage, a completeness rule, or a gate on discovery, matching or messaging |
| Risk, detectors, cases, evidence | Trust & Safety / Moderation | never read by product surfaces | A risk level, a report count, a case reason |

Two structural rules this feature inherits and must not soften:

- **Sensitivity is per field.** The card projection is assembled from fields
  classified individually; adding a field means classifying it before it ships.
- **A profile is a publication.** A field marked `public` here is visible to any
  authenticated, eligible user — not to "users you match" — and that decision is
  made in the field table, not at the query site.

## 3. Every profile field

Visibility vocabulary: **discovery** = can be shown on the card in discovery;
**match-only** = shown after a mutual match, to the matched user, and not
earlier; **owner-only** = never rendered to anyone else, in any surface.

**Who owns which half.** This table fixes the field inventory and each field's
**maximum** visibility — what the product is capable of showing. The per-account
**default** and the owner's ability to narrow it are the privacy layer's
([Privacy & User Settings §4](./privacy-and-user-settings.md)): a field listed as
`discovery` here may still default to match-only for a given account, and the
card renders whatever the effective visibility is. Nothing in this document may
widen a visibility that the privacy layer has narrowed, and the privacy layer may
not invent a field that this document does not define. The two documents agree on
the defaults: `displayName` and `bio` are public by default, narrowable to
match-only per field, and `occupation`/`education` are not v0.1 fields.

| Field | Required | Limits | Validation | Sensitivity | Max visibility |
|---|---|---|---|---|---|
| `displayName` | yes | 2–40 graphemes | no URLs, no phone numbers, no handles, no "admin/support/mod" style reserved terms, no pure emoji, not identical to another account's name after casefold+strip | `public` | discovery |
| `ageBand` | derived | 5-year band, floor 18 | not user-editable; derived by Platform from `dateOfBirth` | `public` | discovery (as a phrase, never a number) |
| `gender` | yes | 1 value from the bounded vocabulary §5.1 | must be in vocabulary; may be `prefer_not_to_say` | `public` | discovery |
| `pronouns` | no | ≤ 24 chars | free text, same reserved-term screen as `displayName` | `public` | discovery |
| `bio` | yes | 30–500 chars | no URLs, no contact handles (phone/email/handles), no other social platform names, no "snap me" style solicitation, screen for slurs, no ALL-CAPS beyond 30% of the text | `public` | discovery, truncated at 240 — the full text is **match-only** |
| `datingIntent` | yes | 1 value from §4 | must be in vocabulary | `public` | discovery |
| `intentDetail` | no | ≤ 300 chars | same screen as `bio`; must not contradict `datingIntent` structurally (e.g. cannot say "no commitment" against `marriage` — see §4.3) | `public` | discovery (truncated at 160) |
| `area` | derived | 1 coarse area | chosen from the Platform-resolved area list; the user may hide it, never edit it to free text | `public` | discovery, as a distance bucket, never as a name the user typed (granted at step 5 of [Account & Onboarding §3](./account-and-onboarding.md)) |
| `interests` | yes | 3–8 from the §5.2 catalogue, no duplicates | catalogue values only | `public` | discovery |
| `promptAnswers` | yes | exactly 2 of the 6 §5.3 prompts, ≤ 140 chars each | prompt id must exist in the catalogue; the same screen as `bio` | `public` | discovery |
| `photos` | yes | 1–6, ordered | see §6 (photo rules) | `public` | discovery (primary + up to 5) |
| `isDiscoverablePref` | no | boolean | owner toggle only; defaults to `true` once complete | `user` | owner-only (the control), affects §7 visibility |
| `profileHiddenReason` | derived | internal code | set only by moderation-driven flows, never by the user | `internal` | never rendered to another user |
| `dateOfBirth` | — | — | **not a profile field.** Owned by [Account & Onboarding §4](./account-and-onboarding.md); no profile API exposes it | `user` | owner-only, never displayed |
| `datingGoal` | no | a whole number of dates, 1–100,000; **default 1,000** | must be a whole number in range; it is not a completeness rule and it gates nothing (§9.2) | `user` | **owner-only** — never on a card, never to a match |
| `completedDateCount` | derived | an integer ≥ 0 — a raw count, never a ratio or a percentage | not editable as a number: it is folded from the owner's records and their corrections (§9.4, §9.5) | `user` | **owner-only**, and keyed to the **user** rather than to the profile (§9.1) |

Two rows that are owner-only by construction, and the reason §4.2's no-score
rule needs no exception for them. Neither is in `ProfileContent`, neither is in
`CandidateCardProjection`, and neither is read by the completeness rules: the
goal is a setting the owner makes on their own profile, and the count is a fact
about their life that no other user is ever shown. §9 specifies both;
[Dating Core §12](../architecture/dating-core.md) is the aggregate behind them.

Deliberately **excluded**, with the reason each one is not here:

| Not in v0.1 | Why |
|---|---|
| Job title, employer, school | The most doxxing fields on any dating profile, and the highest-value target for a harasser who already has a name. |
| Height, weight, smoker/drinker, religion, politics, star sign | Low signal for the decision "like or pass", high moderation surface, and each one is a value someone will be harassed about. |
| Free-text "about me" *plus* free-text "what I'm looking for" | Two overlapping free-text fields produce the same sentence twice and double the moderation load. `bio` plus `intentDetail` plus the prompts already cover it. |
| Languages, "how I met you" | Nice-to-have, no bearing on the core flow, and every extra field is a card that no one reads. |
| Social links | Account-takeover and off-platform harassment vector, with no dating value that `bio` does not provide. |
| Last active / "online now" | Belongs to Messaging ([#13](https://github.com/katzimoto/been_there/issues/13)), and an activity signal on a card is a targeting aid. |
| "Profile boost" / weight slider | Boosts are explicitly out of scope in [#1](https://github.com/katzimoto/been_there/issues/1). |

Two moderation-flavoured rules apply to every free-text field, not just `bio`:
a field that trips the content screen is **rejected at save with the offending
field named** (never silently), and repeated rejections on the same field publish
a signal to Trust & Safety. A content rejection is not an account restriction and
creates no case on its own.

**`displayName` and impersonation.** `displayName` is public by default, which
makes it the one profile field a stranger can put into a search box. A curated
public-figure list is therefore part of R1, and the handling is deliberately not a
rejection:

| Situation | Behaviour |
|---|---|
| Name matches a public figure, plausibly impersonating them | The name is **accepted** — plenty of real people share a famous name, and refusing them is its own harm. The name's effective visibility is held at `matches_only` and the user is asked to either add something that makes it theirs or keep it private. |
| The user does not resolve it | The name stays match-only indefinitely. Nothing else about the profile is affected, and the account is not restricted. |
| The user resolves it, or the name is a common-name collision | The name becomes public as normal. |
| Any of the above | The account is flagged for a possible impersonation subject — `internal`, sent to Trust & Safety, which decides whether a case is opened. A human, not the string match, judges impersonation. |

This is a content gate, the same shape as photo screening: a per-field outcome,
never an account state, never an automatic enforcement, and never a verdict the
user is shown as a fact about themselves. A name-match does not block discovery
by itself; a name-match that a moderator confirms as impersonation is handled
under the ordinary case route ([#14](https://github.com/katzimoto/been_there/issues/14)),
with the usual `caseId` requirement.

<!-- contract sketch: illustrative shape, not an implemented API -->
```ts
/**
 * CONTRACT SKETCH — not an implemented API. The owner-side profile record. Every
 * field carries its own sensitivity; the card projection is assembled from the
 * public subset only, and the two are different types on purpose.
 */
interface Profile {
	readonly profileId: string;
	readonly accountId: string;
	readonly state: 'draft' | 'incomplete' | 'live' | 'paused' | 'hidden';
	readonly displayName: string; // public
	readonly ageBand: string; // public — derived, never an age
	readonly gender: Gender; // public
	readonly pronouns: string | null; // public
	readonly bio: string; // public
	readonly datingIntent: DatingIntent; // public
	readonly intentDetail: string | null; // public
	readonly areaBucket: string | null; // public — derived, coarse
	readonly interests: readonly InterestId[]; // public
	readonly promptAnswers: readonly { promptId: string; answer: string }[]; // public
	readonly photos: readonly Photo[]; // public; order is significant
	readonly isDiscoverablePref: boolean; // user — owner toggle
	readonly hiddenReason: string | null; // internal — never rendered
}

/** The only shape another user's client ever receives. */
interface CandidateCardProjection {
	readonly displayName: string;
	readonly ageBand: string; // phrase, e.g. "late 20s"
	readonly distanceBucket: string; // e.g. "3-6 km"; never a coordinate
	readonly gender: Gender;
	readonly pronouns: string | null;
	readonly bio: string; // truncated at 240 characters
	readonly datingIntent: DatingIntent;
	readonly intentDetail: string | null; // truncated at 160
	readonly interests: readonly InterestId[];
	readonly promptAnswers: readonly { promptId: string; answer: string }[];
	readonly primaryPhotoRef: string; // media service ref, not a path
	readonly photoCount: number;
}
```
<!-- contract sketch: illustrative shape, not an implemented API -->
```ts
/**
 * CONTRACT SKETCH — not an implemented API, and deliberately NOT inside
 * `Profile`: the goal is a setting on a publication and the count is a fact
 * about a person, so they are two records with two different keys. See §9.
 */
interface DatingGoal {
	readonly profileId: string;
	readonly target: number; // whole, 1–100,000; default 1,000
	readonly updatedAt: Date; // no count field, on purpose
}

interface CompletedDateLedger {
	readonly ownerId: string; // the user — not the profile
	readonly records: readonly CompletedDateRecord[];
}

interface CompletedDateRecord {
	/** The owner's retry key. Not an id of any person or date. */
	readonly entryId: string;
	/** `null` — someone met outside the product is still a date. */
	readonly counterpartId: string | null;
	readonly occurredOn: string; // ISO YYYY-MM-DD
	readonly recordedAt: Date;
	readonly corrections: readonly DateCorrection[]; // appended, never edited
}

type DateCorrection =
	| { readonly kind: 'withdrawn'; readonly key: string; readonly at: Date }
	| {
				readonly kind: 'restated';
				readonly key: string;
				readonly at: Date;
				readonly occurredOn: string;
			};

/** Owner-only. Two integers and a boolean — nothing that fits in a ring. */
interface GoalProgress {
	readonly completed: number;
	readonly target: number;
	readonly goalReached: boolean;
	readonly beyondGoal: number;
}
```

## 4. Dating intentions

### 4.1 The vocabulary

A closed set, single-select, versioned. Free-text intent is what turns a filter
into an unsearchable mess.

| Value | Label shown | Meaning |
|---|---|---|
| `long_term` | Looking for something serious | A committed relationship, not necessarily marriage |
| `marriage` | Looking to get married | |
| `dating_open` | Dating and open to see where it goes | |
| `short_term` | Looking for something casual | |
| `friends_first` | Want to meet and see | Open to friendship or romance, no rush |
| `figuring_it_out` | Figuring it out | Unsure or exploring; the intent filter treats this as "no intent constraint" |
| `prefer_not_to_say` | Prefer not to say | Never excluded by a hard filter, never shown as a gap |

Adding a value is a vocabulary-version bump. Existing profiles keep their stored
value; a client that receives an unknown value renders the label "Looking for
something" and never crashes and never blocks discovery on it. Values are never
removed, only retired into a label change.

### 4.2 The hard rule: no compatibility percentage

[#1](https://github.com/katzimoto/been_there/issues/1) puts "compatibility
percentages" explicitly out of scope, and this feature treats that as an
architectural constraint, not a UI preference:

- **No score is computed.** There is no compatibility scalar anywhere in the
  dating read-models, and no field capable of carrying one. The `MatchProjection`
  and `CandidateCardProjection` types above are closed: adding a numeric
  compatibility field is a type change that shows up in review.
- **No score is transmitted.** Because nothing computes it, hiding it in the UI
  is not sufficient and is not attempted. There is no endpoint to hide a number
  behind.
- **No score is implied.** A progress bar, a ring, a "fit" meter, an A–F grade, or
  a star rating is a score with different pixels. None of them ship.
- **A progress figure is not a score either.** The owner's dating goal shows
  two integers and a boolean, never a ratio (§9.7). A completion percentage is
  a compatibility number with a ring drawn around it, and the cheapest way to
  refuse one is never to publish a value that fits in a ring. It is also
  owner-only, so unlike the fields above it has no plausible route to becoming a
  comparison between two people.

### 4.3 How "we might work" is communicated instead

With **facts and differences**, attributed to the people who declared them, and
with the mismatch visible rather than smoothed over:

| Surface | What it shows | Example |
|---|---|---|
| Match confirmation | Declared facts in common, as chips | "Both looking for: something serious · 4 km apart · both into live music" |
| Match view | The same chips plus **declared differences**, phrased neutrally | "Different: you're looking for marriage, they're dating open" |
| Discovery card | Neither. A card shows the other person's declarations, not a comparison | intent chip on the card |
| Post-match, before first message | Three suggested openers built from declared facts | "You both list live music — what's the last show you saw?" |

Compatibility as a hard filter (intent vocabulary, distance band, age band) is
applied by [Preferences & Discovery](./preferences-and-discovery.md) as a
*predicate*, never as a ranking signal exposed to a user. A user who does not
match the predicate is not shown; a user who matches is not told they scored.

`intentDetail` is free text and cannot be machine-checked for contradiction with
`datingIntent` beyond a small blocklist of outright self-contradictions (e.g.
"no commitment / no relationship" against `marriage`). A softer mismatch is left
alone and handled by the reader.

## 5. Interests and prompts — the small cut

### 5.1 `gender` vocabulary

Closed set: `woman`, `man`, `non_binary`, `trans_woman`, `trans_man`,
`prefer_not_to_say`, plus a free-text `self_describe` up to 40 characters.
Orthography follows first-person self-identification; the option list may never
be shortened without a decision record, because a shrinking list is a shrinking
set of people. Preference-side compatibility logic lives in
[#11](https://github.com/katzimoto/been_there/issues/11) and is not decided here.

### 5.2 Interest catalogue

Forty values in eight groups, small enough that a person finds three quickly and
large enough that most people recognise themselves in at least one group:

| Group | Values |
|---|---|
| Outdoors | hiking, running, climbing, cycling, kayaking, gardening |
| Food & drink | cooking, baking, restaurants, coffee, wine, street food |
| Arts | live music, concerts, film, theatre, museums, books, art |
| Sport | climbing, running, cycling, swimming, football, yoga |
| Learning | languages, cooking classes, volunteering, courses, reading |
| Life | travel, pets, cats, dogs, gardening, home improvement |
| People | big groups, small groups, new friends, community, parties, board games |
| Slow | walks, coffee, museums, quiet nights in, live music |

Duplicates across groups are deduplicated at selection time (a value appears
once, in its primary group). Free-text interests are **not** available: they
cannot be filtered, they cannot be shown as a "you both like" chip without
free-text matching, and they are a harassment surface.

### 5.3 Prompts

Six fixed prompts; the user answers **exactly two**.

| Prompt id | Prompt |
|---|---|
| `a_good_weekend` | A good weekend for me looks like… |
| `currently_into` | Currently into… |
| `the_quick_question` | Would rather: early bird or night owl? |
| `non_negotiable` | One thing I won't compromise on… |
| `best_recommendation` | Send me to… |
| `two_truths` | The truth is… |

Answer format: a single line of plain text, ≤ 140 characters, no formatting, no
links, no mentions, no contact handles. Discovery shows both answered prompts;
the match view shows both. An unanswered prompt is never shown to anyone.

**Why the cut, specifically:**

- **Two answers, not six.** Every additional prompt lowers answer quality and
  completion; six optional prompts reliably produce six one-word answers, which
  is worse than two real ones because it looks like effort and is not.
- **Six offered, two answered.** Offering the choice means the two answers
  reflect the person rather than the form's ordering, and it keeps a
  deterministic rule (exactly 2) instead of a fuzzy "at least one".
- **140 characters, not a paragraph.** A card is scannable in seconds; a prompt
  answer longer than 140 characters is a `bio` that nobody reads.
- **Fixed prompts, not a free "tell me about yourself".** A fixed prompt is
  comparable across profiles, which is what makes "you both answered *best
  recommendation*" worth showing, and it avoids a second large free-text field
  to moderate.
- **No free-text interests.** See §5.2.

## 6. Photos

### 6.1 Count, order, and the primary photo

| Property | Rule |
|---|---|
| Count | 1–6. One is enough to enter discovery; six is the cap. |
| Order | Owner-settable by drag; order is explicit, not timestamp-derived. |
| Primary photo | **Index 0, always.** The card's image, the image used in a match, the image other people see first. There is no "auto-pick the best" heuristic and no separate "set as primary" flag that can disagree with the order. |
| Minimum resolution | Short edge ≥ 600 px, aspect ratio between 2:3 and 3:2. A face must occupy roughly 25–70% of the frame height — a distant shot and a cropped forehead both fail. |
| Maximum size | 10 MB; JPEG, PNG, or WebP. HEIC is converted on upload; the stored derivative is what everyone sees. |
| Derivatives | One full-width and one card-sized derivative, both served through the media service. No original upload is served to another user. Metadata is **stripped at ingest**, not at serve time: the stored derivative carries no EXIF, no GPS, no capture timestamp and no device identifier. Stripping at ingest is the requirement that matters, because a photo is the most identifying artefact on a profile and a retained original is a retained location history. |
| Accessibility | Every photo requires alt text (≤ 120 chars) for the owner's own audit trail; other users see the owner's description as an optional caption, never auto-generated identity claims. |

### 6.2 What a photo may not contain

| Prohibited | Why |
|---|---|
| Anyone who is not the account holder, other than as incidental background | A profile is a claim about one person. Extra faces are a route to a stalker's shortlist. |
| Anyone who appears to be under 18 | Routed to a moderator rather than auto-approved or auto-rejected; a photo that clearly contains a minor is never published, and the automated layer never makes that call on its own. |
| Nudity, explicit content, fetish content | Safety and legal exposure. |
| Weapons in use, gore, graphic violence | Same. |
| Text overlays, memes, slogans, dating-app screenshots | A dating-app screenshot is a fabricated-match scam, and text overlays defeat screening. |
| Contact details, handles, QR codes, watermarks of other apps | Off-platform extraction vector. OCR is part of screening. |
| Logos, alcohol brands, cigarette brands, sport-club crests | Advertising and trademark exposure; also a fast route to "which stadium does this person go to". |
| Filters that obscure the face, heavy beauty retouching, AI-generated faces | The likeness check in §6.3 needs a comparable face, and a filtered face undermines the product's core promise. |
| Identifiers in the environment: a house number, a school gate, a uniform with a visible badge | Geolocation and doxxing. |

### 6.3 Screening at upload

Screening is a **content gate, not enforcement**. It produces a per-photo state
and never an account state, never a case, and never a moderator decision on its
own. That distinction is what keeps commitment 2 intact: an automated screen
cannot suspend, restrict or ban anybody.

Pipeline, in order, per photo:

1. **Technical validation** — resolution, aspect, size, format, decode. Failure
   is a save-time error with a plain message and no upload stored.
2. **Hash and dedupe** — perceptual hash checked against (a) the owner's other
   photos, (b) photos belonging to any account that has been deleted, and (c)
   photos belonging to a subject under a `banned` or `suspended` standing. A match
   on (b)/(c) rejects the upload **and** publishes
   `identity.duplicate_photo_signal` (`sensitive`, audit) for Trust & Safety.
   This is the photo-side analogue of the deleted-account re-entry rule in
   [Account & Onboarding §8.3](./account-and-onboarding.md).
3. **Content screening** — nudity, explicit content, weapons, gore, text-in-image
   (OCR), face count, brand/logo detection. Produces `approved`,
   `rejected` (with a `reason_code`) or `needs_human` (borderline → routed to a
   moderator queue, photo held out of the live set until a human answers).
   The state machine is `mediaMachine` in `packages/platform`, and the rule is
   that **`needs_human` is reachable only from an `inconclusive` verdict** — a
   scanner that could not decide, as distinct from one that decided against the
   photo. A definite verdict may act on a definite rule; "this might break a
   rule" has no such warrant. Leaving `needs_human` in either direction requires
   a named reviewer, on the same rule as requeueing a rejection: a decision about
   a person is made by a person. Which verdicts count as inconclusive is an open
   question in §13 — today only an explicit `inconclusive` verdict reaches the
   state, and promoting, say, `sexual_content` into a human queue is a
   queue-cost decision with user-facing consequences, not a mechanical one.
4. **Likeness check** — the photo's face is compared with the face in the user's
   verified selfie, by Identity. A low likeness result does not reject the photo
   silently: the profile moves to `incomplete` and the user is told
   *"your photos need another look — one doesn't match the person in your
   verification photo"* and asked to replace it. This is the profile-photo
   likeness check required by [#1](https://github.com/katzimoto/been_there/issues/1),
   and it is a **profile** fact, never an identity verdict: the identity state is
   not changed by a profile photo.
5. **Publication** — an `approved` photo is added to the photo set at the
   requested position. A photo's own state is always visible to its owner
   ("approved", "being checked", "not approved — reason").

Per-photo state, which is the media machine's states under this document's
vocabulary: `initiated` (`uploading`) → `scanning` (`screening`) → `approved |
rejected | needs_human`, with `rejected → initiated` on a reviewer's requeue. The
set is valid for discovery only while **index 0 is `approved`**; a `needs_human`
photo at index 0 is held out exactly as a rejected one would be, and says
something different to its owner (§6.4).

### 6.4 A photo is rejected while the profile is already live

This is the common case and it must not be a cliff.

| Situation | Behaviour | What the user sees |
|---|---|---|
| A non-primary photo is rejected | It is removed from the live set immediately. Order closes up. The profile stays `live` if the rest of the completeness rules still hold. | A toast: "One photo wasn't approved and was removed." with the reason and a Replace action. |
| The primary photo is rejected and others are approved | The next approved photo is promoted to index 0 automatically; the profile stays `live`; `profile.photo_set_updated` is published with the new count. | "We changed your main photo — here's why the old one wasn't approved." |
| The primary photo is rejected and **no** approved photo remains | The profile moves `live` → `incomplete`, leaves discovery, and stays in existing matches with a placeholder card. The user is asked for one more photo. | "You're not appearing in discovery until you add a photo we can approve. Your matches are still there." |
| A photo goes to `needs_human` | It is held out of the live set as if rejected, and the user is told it is "being checked" — not that it failed. `profile.photo_rejected` is **not** counted: a hold is a queue, not a refusal, and sharing the counter would make a screening regression and a moderator backlog look like one number. | "One photo is being checked. It'll appear if it's approved." |
| A photo is removed by a moderator from an open case | The photo is withdrawn everywhere, including in existing matches and conversations already delivered. This is the one case of retroactive removal (see §10.1). | The photo disappears; the user is told it was removed without the case detail. |

Removal never cascades to a punishment: a rejected photo does not hide the
profile, does not count toward risk by itself, and does not require a human.

## 7. Profile state

Six states. `paused` and `hidden` are **owner** actions; `incomplete` is a
**deterministic consequence** of the completeness rules; `live` and `draft` are
the ordinary path. None of these is the account state — a `banned` user can have
a `live` profile, it is simply not eligible for discovery.

| State | Meaning | Triggered by | In discovery? | In existing matches? |
|---|---|---|---|---|
| `draft` | Created, never submitted | Account creation, or first edit after `hidden` | no | no |
| `incomplete` | Submitted, failing at least one completeness rule, or with no approved primary photo | Any edit that breaks a rule; photo rejection; likeness failure | no | yes, with a placeholder card |
| `live` | All completeness rules satisfied and the owner has not paused | Publishing; completing the last missing rule | **yes** — subject to identity and account standing | yes |
| `paused` | Owner chose a break | Owner toggle | no | yes — matches and conversations continue; only discovery stops |
| `hidden` | Removed from circulation at the owner's request, or by an enforcement-driven flow | Owner toggle; account deletion scheduling; moderation-driven unpublishing | no | no — the profile does not appear, and match surfaces show a "profile unavailable" placeholder |
| `deleted` | Terminal; not a state a user returns from without re-registering | Completed deletion job | no | no |

Transition rules:

```
draft ──publish──▶ incomplete ──all rules satisfied──▶ live
incomplete ◀──any rule broken── live
live ⇄ paused                      (owner toggle, both directions)
live|paused ──owner hide──▶ hidden ──unhide──▶ incomplete   (never straight to live)
```

`hidden → live` does not exist. A hidden profile that has drifted out of
completeness becomes `incomplete`, and the user sees exactly which rules are
unmet. This is a deliberate annoyance: a profile that was hidden for a year
should not silently reappear.

`paused` differs from `hidden` in one way that matters: **paused keeps your
matches.** Someone who takes a break does not lose the conversation they were
having. Someone who hides a profile has said "take me out", and continuing to
appear in a stranger's match list contradicts that.

## 8. Completeness — a rule set, not a score

### 8.1 The rules

Each rule is a boolean. The threshold is: **all rules true**.

| # | Rule | Fails when |
|---|---|---|
| R1 | `displayName` present and valid | empty, > 40 graphemes, fails the reserved-term, impersonation, or uniqueness screen |
| R2 | `gender` selected | null or outside the vocabulary |
| R3 | `bio` between 30 and 500 characters and passes the content screen | shorter, longer, or rejected by the screen |
| R4 | `datingIntent` selected from the vocabulary | null or an unknown value |
| R5 | 1–6 photos, **index 0 `approved`** | no photos, or the primary photo is not approved |
| R6 | 3–8 distinct interests | fewer than 3, more than 8, duplicates, or a value outside the catalogue |
| R7 | exactly 2 prompt answers, each ≤ 140 characters | 0, 1, or 3+ answers, or an over-length answer |
| R8 | age gate passed | the owner's `dateOfBirth` is absent or computes under 18 ([#9](./account-and-onboarding.md)) |

**This table is the decision; `PROFILE_REQUIREMENTS` in `packages/dating` is the
implementation, and the two currently disagree.** Recorded rather than quietly
reconciled, because the disagreement is in both directions and each side has a
reason:

| Rule | This table | `PROFILE_REQUIREMENTS` today | Which way the code errs |
|------|-----------|------------------------------|---------------------------|
| R1 `displayName` | ≤ 40 graphemes | `maxDisplayNameChars: 50` | Looser by 10. A 45-character name is a name nobody can read on a card, and the uniqueness and reserved-term screens already do the real work of the rule. |
| R3 `bio` | ≥ 30 characters | `minBioChars: 20` | Looser by 10. §5.1's argument for a floor is that a 12-character bio is an empty box with a cursor in it; 20 is the same box. |
| R5 photos | **1–6**, index 0 `approved` | `minPhotos: 3` | **Stricter by 3×, and this is the one that matters.** The code rejects every one- and two-photo profile this document says is valid, and §6.1's own argument is that *one* photo is enough to enter discovery. A user who uploads one good photo and is told the app wants three is a user who does not upload three. |
| R6 `interests` | 3–8 | not represented | Missing, not loosened. `ProfileContent` has no `interests` field at all, so the rule cannot fail and does not exist. |
| R7 `promptAnswers` | exactly 2 | `minAnsweredPrompts: 1` | Looser, and in the wrong direction: §5.3's reason for "exactly 2" is determinism — a fuzzy "at least one" is a rule with no testable boundary. |
| R4 `datingIntent`, and the required `pronouns` and `intentDetail` | required | not represented | Missing. `ProfileContent` has no such fields. |

The photo count and the four absent fields are the substantive half, and both are
changes to `packages/dating`, which this document does not own and which its
author does not edit. What is settled here and needs no code change: **one
approved photo is enough to enter discovery**, and the completeness gate must
either evaluate `interests`, `datingIntent`, `pronouns` and `intentDetail` or stop
listing them — a rule that is written down and not evaluated is a rule the product
believes it has.

Two things are **not** in the rule set, deliberately: identity verification and
account standing. They gate *discovery*, not *profile completeness*, and they are
owned by other domains. The full discovery predicate is R1–R8 **and**
`identity.state === 'verified'` **and** `account.state === 'active'` **and**
discovery preferences set ([#11](./preferences-and-discovery.md)). Keeping them
separate is what lets a verification failure produce "your photos need another
look" instead of "your profile is 80% complete".

### 8.2 The gate, not a leaderboard

- **Completeness is a boolean.** `profile.completed` is `true` or `false` and is
  the only form in which it crosses a domain boundary. There is no percentage, no
  0–100 counter, no per-field partial credit, and no `completenessScore` field in
  any projection. A partial-credit model needs a weighting decision, and every
  weighting is a product opinion about which fields matter more than a person's
  time — which is exactly the judgement this product is refusing to automate.
- **It is shown to the owner, as a checklist.** "Finish these to start appearing
  in discovery: add a photo · choose what you're looking for · answer 2 prompts".
  Never as a number, never as a bar, and never with a celebratory animation
  implying a score to beat.
- **It is invisible to every other user.** A "profile strength" badge would rank
  people by effort, and would be a target for anyone wanting to know which users
  are new. `CandidateCardProjection` has no such field, and neither does
  `MatchProjection`.
- **It is not in discovery ranking.** Ordering may use declared facts and
  freshness; it may not use completeness, and a complete profile is not a licence
  to be shown more often than anyone else. No global cap exists in either
  direction ([#1](https://github.com/katzimoto/been_there/issues/1): no
  artificial match limits).

## 9. The dating goal and the completed-date counter

> Issues [#48](https://github.com/katzimoto/been_there/issues/48) and
> [#49](https://github.com/katzimoto/been_there/issues/49). The aggregate shapes
> and the reason each one is shaped that way are
> [Dating Core §12](../architecture/dating-core.md); this section is the
> product decision and does not restate the implementation.

Two numbers the owner keeps about their own life: a **target** for how many
dates they want to go on, and a **count** of how many they have recorded. Both
are set on a profile and shown to the person who set them, and neither is
readable by anyone else. There is a temptation to read this section as a
scoreboard, and the whole of §4.2 applies to it: it is not one.

### 9.1 Two records, keyed differently, on purpose

The goal is **per profile**; the counter is **per user**. This is the only
place the two disagree about scope, and it is deliberate.

| | The goal | The counter |
|---|---|---|
| Keyed by | `ProfileId` | `UserId` |
| Holds | a target | the dates the owner recorded |
| Default | 1,000 dates | 0 |
| Set by | the profile owner | the profile owner |
| Survives profile deletion | no — a new profile starts at 1,000 | **yes** |

A `ProfileId` names a card, and a card has a lifecycle that ends in `deleted`.
Deleting a profile is an ordinary act of privacy — take yourself off the
marketplace for a while — and it must not take a life behind it. So the target,
which is a setting on the publication, goes with the publication; the count,
which is a fact about the person, does not. The consequence a product person
should hold onto: **deleting and recreating a profile does not reset the
count**, and the person sees the same number afterwards with a fresh target to
set.

The alternative — keying both to the profile — makes deletion the natural
moment to lose the count, and losing it is silent: the user comes back, sees
zero, and has no way to tell a reset from a mistake.

### 9.2 The target is a target, not a gate

| Rule | Value |
|---|---|
| Default | **1,000** dates until the owner names another |
| Accepted | a whole number, 1 to 100,000 |
| Refused | 0, negatives, fractions, and anything above the ceiling, with the reason named |
| Effect on discovery, matching, messaging | **none** |
| Effect on profile completeness | **none** — the goal is not a completeness rule (§8.1) |
| Past the target | recording continues; the count is allowed to exceed it |

**Reaching the goal changes nothing about what the person can do.** Liking,
matching, messaging and discovery eligibility do not read the goal or the count,
and a user at 1,000 of 1,000 dates is in exactly the position they were at 12.
This is [#48](https://github.com/katzimoto/been_there/issues/48)'s explicit
requirement and it is enforced by absence rather than by a check: nothing in
the discovery, matching or messaging paths takes a goal or a ledger as an
input, so there is no rule to forget and no future refactor that can quietly
add the gate back.

**The count may pass the target.** A progress figure that stops at 100% is a
grade, and a person who has been on more dates than they set out to go on has
not failed at anything. The owner is told how far past they are.

**Zero is refused rather than treated as "no goal".** The default already
covers a person who has not chosen, and a stored `0` would then be
indistinguishable from a person who deliberately chose to aim at nothing.

**The ceiling of 100,000 is not in the issue.** It exists because a target past
it is not a number any progress view can render, and storing one would record a
claim the product cannot show back to the person who made it.

### 9.3 Only a date the owner explicitly records counts

A like is not a date. A match is not a date. A message is not a date. None of
them is an input to the counter, and there is no path from an interaction to an
increment — recording a date reads nothing but what the owner supplied.

The reason is not fussiness. A counter that moved because two people had
exchanged messages would be a statement, published to nobody but the owner, that
those two people had met in person. It would be wrong often enough to be
worthless (a conversation that goes nowhere is still a conversation), and it
would make the owner's own record something the product inferred rather than
something they said.

### 9.4 Corrections are appended, never edited

The owner's right to correct a mistake is [#49](https://github.com/katzimoto/been_there/issues/49)'s
requirement, and it is the reason the counter is derived rather than stored.
"I typed the wrong day" and "I never went on that date" are two different
mistakes, and only one of them should cost the person a date:

| Correction | The owner means | Effect on the count |
|---|---|---|
| `withdrawn` | the date did not happen | decrements; the record is **retained** |
| `restated` | it happened on a different day | unchanged; the day moves to the corrected one |
| `restated` on a **withdrawn** date | — | **refused**; a withdrawal is not undone by redacting the day again |

**Corrections accumulate and never resurrect.** Once a date is withdrawn it
stays withdrawn, however many times its day is restated. There is no path back,
and that is the point: a correction that could resurrect would let a mistake in
the correction path restore a date the owner said did not happen.

The same rule the like ledger already follows: a retraction is a state change
on a retained row, never a deletion
([Dating Core §3.2](../architecture/dating-core.md)).

**A correction preserves what was there.** A withdrawal is never a deletion:
the record stays on the ledger with the withdrawal attached, so the owner can
always be shown what they recorded and why the count dropped from 13 to 12. An
editable counter row cannot answer that — after a single bad write the number
and the truth are the same value.

**A restatement does not preserve what was there, and that is a gap.** The
day a restatement replaces is overwritten, so the originally claimed day is
not recoverable afterwards: only *that* the day was restated, when, and to
what. The product promise this section is written to make — the owner can be
told what they claimed and what it was corrected to — is therefore only half
kept by the current shape. The correction log grows; it does not preserve the
prior value. Either the record keeps a `supersededOccurredOn` per restatement,
or this document stops promising it. Recorded in §13; **not** a decision this
section makes on the implementer's behalf, because the fix belongs in
`packages/dating`, which this document does not own.

### 9.5 The count is derived, and a retry counts once

**The count is never stored as a number.** It is the number of recorded dates
that carry no withdrawal, computed from the ledger on every read. A stored
counter has to be reconciled after a reload, and a reconciliation that runs
wrong is invisible; a derived one cannot drift, because there is nothing to
drift from. The same reasoning makes a negative count impossible rather than
merely unlikely: there is no integer anywhere in this feature that a decrement
acts on, so withdrawing the last entry yields 0 and withdrawing it again yields
0.

**Every write carries a caller-supplied retry key.** Recording a date and
applying a correction each take one, and a repeated write with the same key
changes nothing. This is the requirement behind "prevent accidental duplicate
increments from retries", and it is a property of the operation rather than of
the client: the caller that retries is precisely the caller that cannot be
trusted to remember not to. A double-tap, a retry after a timeout and two
workers racing on one key all leave the count where one of them put it.

The key is **not an id of anything**. It names a request, not a date, not a
person and not a profile, and nothing in the product may display it or reason
about it as though it did.

### 9.6 Recording requires nothing of the other person

[#49](https://github.com/katzimoto/been_there/issues/49) rules out mandatory
review and feedback about the other person, and nothing here reintroduces it:

- Recording reads no standing, no block list, no match and no verification
  state, so a review requirement has nowhere to attach.
- The other person is **optional**. A date with someone met outside the product
  is a real date and counts; requiring a `counterpartId` would have quietly made
  the product's own users the only ones who can keep a count.
- A recorded date is not an assertion about the other person that anyone else
  reads. Nothing derived from the ledger is rendered to another user, in any
  surface, so no counter can become a counter of somebody's behaviour.

The one entry refused is a date with yourself.

### 9.7 What the owner sees

| Surface | What is shown |
|---|---|
| The owner's own view | completed dates, the target, whether the goal is reached, and how far past it they are |
| The discovery card | nothing |
| The match view | nothing |
| Any API response to another user | nothing |
| A percentage, ratio, ring or grade | never, anywhere (§4.2) |

Two integers and a boolean, recomputed on each read, so the figure cannot be
stale against the ledger behind it. It is a count of what the owner did, shown
to the owner — not a measure of the person, and never a comparison between
people.

### 9.8 Where this document and the code have disagreed

The two halves of this feature were built at different times, and the history
is worth recording because it is the precedent that settles which one wins.

| Feature | Where the code was | Where this document said | Settled |
|---|---|---|---|
| R5 minimum photos | `minPhotos: 3` | 1–6, index 0 `approved` (§6.1, §8.1) | **the code was changed to match this document.** One approved photo is enough to enter discovery; three rejected every profile this document calls valid. |
| The dating goal and the completed-date counter | a tested domain module in `packages/dating`, with an HTTP surface | **absent** — no field row, no rules, no mention | **this document was changed to match the code.** The decisions were already made, tested and written down in [Dating Core §12](../architecture/dating-core.md); what was missing was the specification of them, which is the part a product decision is allowed to depend on. |
| Whether a restatement keeps the day it replaced | overwrites `occurredOn` and appends the correction, so the originally claimed day is unrecoverable (§9.4) | a correction preserves what was there, and the owner can be shown what they claimed | **open.** The promise is stated and the code does not keep it. Recorded in §13 rather than resolved here, because the fix is in `packages/dating`, and because promising less than "a correction is retained" would be the wrong trade. |

The first two rows resolve the same way, and the rule is the one the rest of
this document already uses: **this document is the contract.** When the code is
wrong about a product decision, the code moves — silently changing a documented
rule would leave two truths and no way to tell which one a reader is holding.
When the *document* is silent about a decision the code already makes, the
document is what is owed, and silence is the failure: an implementer following
this specification would not have built either feature, and a reviewer reading
only it could not tell that they exist.

The dating goal is the second row, which is why it is written down here at all.
It is also the argument for closing a gap rather than leaving it to the next
implementer: the code was right, the document was silent, and every decision in
§9 was one implementer could have reopened.

The third row is the harder case and worth stating plainly, because it is the
reason the first two needed a rule. Here the code is *right* about the
mechanism and this document is *right* about the promise, and they do not
agree: the correction log grows but does not preserve the value it replaced. A
specification written by transcribing the code would have recorded the
overwrite as the design and lost the promise without noticing, which is the
failure this section exists to prevent. It is written down as open rather than
decided, because deciding it means changing a tested domain module that this
document does not own — and a spec that guesses at the fix would be guessing at
someone else's schema.

### 9.9 The surface this is reachable at, and what it refuses

§9 specifies what the goal and the counter *are*. This subsection records where
they are reachable and what a client is told when they are not, because a rule
with no refusal has no observable behaviour.

All five routes are in `packages/service/src/routes/goal.ts`, and each one starts
from the session rather than from an id in the path (`:337-347`), so neither
aggregate is addressable by anybody but its owner.

| Route | Answers | Notes |
|---|---|---|
| `GET /v1/profiles/me/goal` (`:93`) | the target, the count, and the derived progress | Answers with the default when no row exists yet, including for a member with no profile at all (`:99-107`) — "what is my goal" has an answer before there is anything to set it on |
| `PUT /v1/profiles/me/goal` (`:112`) | the same body after the change | Refused with `not_found` when there is no profile, because a goal is a setting on a publication and there is no publication yet (`:126-128`, `:334-335`) |
| `GET /v1/profiles/me/completed-dates` (`:150`) | `completed`, `progress`, and **every** record including withdrawn ones | The fold's inputs are published with the fold, because a correction the owner cannot see is one they cannot explain (`:164-171`) |
| `POST /v1/profiles/me/completed-dates` (`:176`) | `entryId`, `created`, `completed` | `201` with `created: true` when the entry was created, `200` with `created: false` when the key was a replay — a retry is not a second creation (`:231-235`) |
| `POST /v1/profiles/me/completed-dates/:entryId/corrections` (`:240`) | `kind`, `applied`, the effective day, whether it still counts, `completed` | `kind` is resolved through a lookup, so an unknown value cannot be stored (`:87`, `:253-257`) |

**The counter works without a profile and the goal does not.** That asymmetry is
§9.1's two keys showing through the surface: the ledger is keyed by `UserId` and
exists whether or not there is a card, while `PUT` of a target has nothing to
attach to (`:159-163`). It is not an oversight to be tidied away.

The refusals a client can receive, with the values the domain produces
(`packages/dating/src/goal.ts`):

| Situation | Code | `reason` |
|-----------|------|----------|
| Target is not a whole number | `validation_failed` | `not_a_whole_number` (`:98-103`) |
| Target below 1 | `validation_failed` | `below_minimum` (`:105-111`) |
| Target above 100,000 | `validation_failed` | `above_maximum` (`:113-119`) |
| A day that is not a real calendar day, including `2026-02-31` and a malformed string | `validation_failed` | `not_a_calendar_day` (`:226-249`) |
| A day that has not happened yet | `validation_failed` | `in_the_future` (`:250-257`) |
| A date with yourself | `validation_failed` | `self_recorded` (`:295-302`) |
| A correction against an entry that does not exist | `not_found` | — (`:336-338`) |
| A restatement of a withdrawn date | `conflict` | `already_withdrawn` (`:345-351`) |

Two absences are load-bearing and are worth naming because they cannot be added
without a review:

- **Recording reads nothing about the other person.** The only validation on
  `counterpartId` is that the caller wrote a uuid — not that the account exists,
  is verified, is matched, or is in good standing
  (`packages/service/src/routes/goal.ts:189-193`). §9.6's promise is enforced by
  that absence. A handler that fetched a standing here would reintroduce the
  review requirement the domain was shaped to make unreachable.
- **Nothing here is stored as a count.** There is no `completed` column
  (`packages/database/migrations/005_dating_goal_and_completed_dates.sql:37-40`)
  and no `counterpart_id` foreign key, for the same reason (`:50-55`).

### 9.10 Where the superseded day actually survives

§9.4 promises that the owner can be told what they claimed, §9.8 records the
disagreement as open, and §13 carries the question. All three are written against
"the record overwrites the day". That is true of the domain aggregate and false
of the storage, and the difference matters because it changes what the open
question is about.

| Layer | What it keeps | Where |
|-------|---------------|-------|
| `CompletedDateRecord` | the **effective** day, plus one correction per correction — a `restated` carries the day it moved *to* | `packages/dating/src/goal.ts:146-158`, `:359-365` |
| The store | the chain of claims, in `completed_date_corrections.superseded_on` | `packages/database/migrations/005_dating_goal_and_completed_dates.sql:146`, `:168`, `:189` |
| `findLedger` | reads it back in `seq` order, the append order | `packages/database/src/store-goal.ts:248-252`, `:135-157` |
| The restatement's write | takes the replaced day from the row's current `occurred_on` in the same statement that appends the correction | `packages/database/src/store-goal.ts:357-374` |
| The route | **drops it**, because `DateCorrection` has no field for it | `packages/service/src/routes/goal.ts:307`, and why at `packages/database/src/store-goal.ts:29-31` |

The storage guarantee is real and is not an inference: a test walks
`supersededOn` back across a chain of three restatements and reaches the day the
owner originally claimed (`packages/database/test/store-goal.test.ts:321-341`),
and the schema's `CHECK` refuses a `restated` row that does not carry both days
(`005_dating_goal_and_completed_dates.sql:189`), so the chain cannot be quietly
nulled out by a writer.

**So the promise is kept in storage and unreachable in the product.** The owner
cannot be shown what they claimed, because the aggregate the route reloads has no
field to show it from, and §9.4's "the owner can always be shown what they
recorded and why the count dropped" is true of a withdrawal and false of a
restatement.

The open question in §13 is therefore narrower than it reads, and this document
does not answer it, because the answer is a change to `DateCorrection` in a tested
domain module this document does not own. It is either: the domain type carries
the superseded day and the promise is kept as written; or the document's promise
is reduced to what a withdrawal already keeps, and the chain stays an
auditability property of the table. The first keeps §9.4 as written. The second
costs one sentence of it, and buys an aggregate that stays exactly the log the
domain asked for.

## 10. Editing

### 10.1 What is editable once a match exists

| Field | Editable after a match? | Effect on existing matches |
|---|---|---|
| `displayName`, `bio`, `pronouns`, `interests`, `promptAnswers`, `intentDetail` | yes, freely (subject to §10.3) | The matched user sees the new value on next render. Existing messages are never rewritten. |
| `datingIntent` | yes | The match continues. The intent chip in the match view updates. |
| `gender` | yes, but a likeness re-check is required before the change appears in discovery (§10.2) | Card and match view update after the re-check. |
| `photos` (add, remove, reorder) | yes, subject to §10.2 and §10.3 | New photos appear. **Removed photos are not retroactively pulled from a matched user's view in v0.1** — except when a moderator removed the photo under a case (§6.4). This is a known gap, recorded in §13. |
| `ageBand` | never — it is derived | — |
| `area` | derived from a re-resolved coarse location; the owner may hide it | Distance bucket updates. |

Nothing about a profile edit affects a match's existence. A match is not a
contract; unmatch is available to both parties at any time
([#12](https://github.com/katzimoto/been_there/issues/12)).

### 10.2 What triggers re-discovery

| Change | Re-enters the discovery pool? | Re-check required first? |
|---|---|---|
| First publish (`incomplete` → `live`) | yes, immediately | photo screening + likeness already done |
| Any edit while `live` that leaves the profile `live` | no — the user stays in the pool; there is no re-queue penalty for editing | no |
| `live` → `incomplete` (a rule broke, or the primary photo was lost) | yes, on the next rule satisfied | primary photo approval |
| `displayName` changed | no | **likeness re-check** against the verified selfie, because the name is an identity claim; the profile stays `live` while the check runs and the card shows the previous name until it passes |
| `gender` changed | no | **likeness re-check**, same rule |
| Primary photo replaced | no | **likeness re-check** for the new photo (it must be `approved` before it becomes index 0 — a new photo enters the set as index 0 only if it is approved) |
| `datingIntent` changed | no | no |
| `area` changed by re-resolving location | no | no |
| Owner pauses | leaves the pool | no |
| Owner hides | leaves the pool; matches drop the card | no |

The rule behind the table: an edit changes **what the card says**, and the card is
re-derived from the current profile on every render. Nothing is cached as a
"discovery snapshot", so there is no path by which a stale profile is shown and
no re-queue step to get wrong.

### 10.3 Rate limiting edits — and the evasion it exists to stop

| Limit | Value | Rationale |
|---|---|---|
| Profile mutations (any field) | 20 / hour | Stops a script that rewrites the bio 10,000 times to churn the pool. |
| Identity-affecting changes (`displayName`, `gender`, primary photo) | 3 / 24 hours, **across all three combined** | The cheapest way to be "someone new" is a new name and a new face. A shared budget across all three fields means rotating them together does not buy extra attempts. |
| Photo uploads | 10 / 24 hours, 6 live at once | Bounds the screening load and the spam-photo surface. |
| Prompt/interest edits | 10 / 24 hours combined | The same churn argument. |

Evasion-specific rules, because "rate limit everything" does not stop a
determined evader:

- **Block evasion.** A photo whose perceptual hash is within the similarity
  threshold of a photo belonging to someone the uploader has **blocked**, or who
  has **blocked** the uploader, is rejected. The user is told the photo cannot be
  used; they are not told whose photo it resembled, because that would confirm the
  block exists and let an evader binary-search the threshold.
- **Report evasion.** Replacing a reported photo does not clear the report. A
  report already filed keeps its evidence snapshot at filing time, so a user
  cannot respond to a report by changing the photo afterwards. This is
  commitment 4 in practice: evidence for a case is retained independently of the
  content that produced it.
- **Identity churn.** Exceeding the 24-hour identity-affecting budget does not
  block the edit and does not queue it forever: the change is applied, the
  profile's card holds the previous identity-facing values until the likeness
  re-check passes, and the pattern publishes a signal to Trust & Safety. A
  detector proposing, a human deciding — the same shape as every other safety
  signal in the system.
- **Enforcement is not involved.** None of these limits sets an account state
  and none of them appears to the user as a restriction. A rate-limited edit is
  refused with a plain message and a time.

## 11. Acceptance scenarios

**P1 — Legitimate profile, end to end** (issue #1 scenario 1)

- *Given* a verified account, *when* the user sets a display name, uploads two
  photos that pass screening and the likeness check, writes a 200-character bio,
  selects `long_term` and a gender, picks five interests, answers exactly two
  prompts, and hits publish,
  *then* `profile.completed === true`, the state is `live`, `profile.published`
  is emitted, and the profile is eligible for discovery given identity and
  account standing.

**P2 — A profile cannot be published while incomplete**

- *Given* a profile missing R5 (no approved primary photo), *when* the user
  attempts to publish,
  *then* the profile is `incomplete`, the user sees the named unmet rules, and
  the profile is not in any discovery result. No partial state, no
  "published anyway".

**P3 — The primary photo is rejected while live**

- *Given* a `live` profile with three approved photos and index 0 rejected after
  the fact, *when* screening completes,
  *then* the next approved photo is promoted to index 0, `profile.photo_set_updated`
  is emitted, the profile stays `live`, and the user is told the main photo
  changed and why.
- *And* given the same rejection with **no** remaining approved photo, *when*
  screening completes, *then* the profile becomes `incomplete`, leaves discovery,
  keeps its existing matches, and the user is asked for one more photo.

**P4 — Evasion by photo replacement** (issue #1 scenario 4)

- *Given* user A has reported user B, *when* B replaces the reported photo,
  *then* A's report retains its evidence snapshot, the case is unaffected, and B
  gains no capability. B's account state does not change because of the edit; if
  a detector believes the edit is evasion, a signal reaches Trust & Safety and a
  human decides.

**P5 — Block evasion**

- *Given* user A blocked user B, *when* B uploads a photo perceptually similar to
  one of A's,
  *then* the upload is rejected with a neutral message, A is not told, and no
  product surface reveals that the rejection was caused by a block.

**P6 — No compatibility score exists**

- *Given* any two profiles and any API response in either direction,
  *when* the response is inspected,
  *then* no numeric compatibility value is present, no progress meter, ring,
  grade or star rating exists anywhere in the client, and the way compatibility
  is conveyed is declared-intent chips plus declared differences, as in §4.3.

**P7 — Completeness is a gate, not a score**

- *Given* any profile and any user,
  *when* completeness is read by another user or by a ranking function,
  *then* only the boolean is available, and no percentage, badge, or
  completeness-derived ranking term exists in the card projection or in discovery
  ordering.

**P8 — A fake profile cannot buy its way past the likeness check**

- *Given* an account whose identity is `verified`,
  *when* it uploads a photo that does not depict the verified person,
  *then* the likeness check holds that photo out, the profile becomes
  `incomplete` and leaves discovery, the user is told to replace the photo, and
  the **identity state is unchanged** — a fake-profile attempt is stopped by the
  profile gate, not by an automated punishment, and no account state changes
  without a case and a moderator.

**P9 — Pausing keeps matches; hiding does not**

- *Given* a user with an active match, *when* they pause their profile,
  *then* the conversation continues and the profile leaves discovery.
- *When* instead they hide it, *then* the profile leaves discovery **and**
  disappears from match surfaces with a "profile unavailable" placeholder, and
  unhiding returns it to `incomplete` rather than to `live`.

**P10 — A famous name is not a blocked account**

- *Given* a user who sets a `displayName` that matches a public figure,
  *when* the profile is published,
  *then* the name is accepted, the profile is not blocked, no account state
  changes, and the name's effective visibility is `matches_only` with an
  invitation to make it distinctive or keep it private.
- *And* the account is flagged for a possible impersonation subject, which reaches
  a human as a possible case and is never a decision the string match makes.

**P11 — Changing the goal does not touch the count**

- *Given* a user with 12 recorded dates and a goal of 1,000,
  *when* they change the goal to 20,
  *then* the count reads 12, the target reads 20, the progress figure reads
  12 / 20, and every recorded date and correction is still there — the two are
  separate records keyed differently (§9.1), so an edit to one cannot reach the
  other.

**P12 — Reaching the goal opens nothing and closes nothing**

- *Given* a user whose count has reached and then passed their goal,
  *when* they like, match, message or are shown in discovery,
  *then* every capability is unchanged, no eligibility rule reads the goal or the
  count, and recording another date past the target is accepted and reported as
  `beyondGoal` rather than refused (§9.2).

**P13 — A retried record counts once; a withdrawn date cannot come back**

- *Given* a user who submits the same record key twice,
  *when* both are accepted,
  *then* the count rises by one, not two, and the second submission changes
  nothing (§9.5).
- *And* given a user who withdraws a recorded date and then restates its day,
  *when* the restatement is attempted,
  *then* it is refused as a conflict, the count stays decremented, and the
  withdrawal and the attempted restatement are both retained on the record
  (§9.4).

**P14 — Deleting a profile does not delete the count**

- *Given* a user with recorded dates,
  *when* they delete their profile and create another,
  *then* the new profile carries the default goal of 1,000 and the count is
  unchanged, because the ledger is keyed by user and the goal by profile
  (§9.1). A count of zero here would be indistinguishable from a reset.

**P15 — Nothing about the goal or the count reaches another user**

- *Given* any user with a goal, a count and recorded dates,
  *when* every surface is inspected — cards, matches, search, any API response,
  and the analytics sink,
  *then* neither the target, the count, the counterpart of a recorded date, nor
  any percentage of the two appears anywhere outside the owner's own view
  (§9.7, §12).


## 12. Events

Names are registered in the Platform catalogue and imported, never re-declared.
Content never enters a sink: `profile.updated` carries field **names** and a
count bucket, never a value.

| Event | Sink | Dimensions / fields | Meaning |
|---|---|---|---|
| `profile.published` | analytics | `surface` | `incomplete` → `live` — the funnel terminal for [Account & Onboarding §11](./account-and-onboarding.md) |
| `profile.state_changed` | analytics | `from`, `to` ∈ `draft incomplete live paused hidden` | profile state only; never the account state |
| `profile.updated` | analytics | `changed_field_count_bucket`, `changed_field` (field **name** enum) | which field changed, not what it says |
| `profile.photo_uploaded` | analytics | `bytes_bucket` (the registered `reason_code` carries the upload source, not a verdict) | upload accepted for screening |
| `profile.photo_rejected` | analytics | `reason_code` (content screen) | content gate refused a photo |
| `profile.photo_set_updated` | analytics | `photo_count_bucket` | order/count changed, including automatic primary promotion |
| `identity.duplicate_photo_signal` | **audit** (`sensitive`) | `match_kind: 'deleted_subject' \| 'blocked_party'` | dedupe hit against a deleted, blocked, or banned subject — Trust & Safety only, never analytics |
| `identity.status_changed` | **audit** (Identity owns it) | — | drives the likeness/re-verification flow, not a metric |
| `account_state.changed` | **audit** (Moderation owns it) | — | a standing change may force `live` → `hidden`; the product reacts to the capability set, never to the reason |
| `dating_goal.updated` | analytics | `from_bucket`, `to_bucket` | the owner changed their target — **buckets only**, never the raw target and never the count |
| `dating.completed_date.recorded` | analytics | `with_counterpart: true \| false` | the owner recorded a date. The count, the day and who it was with never leave the owner's record |

A photo-level outcome that is borderline is not a `profile.photo_rejected` with a
probability attached: it is routed to a moderator, held as `needs_human`, and the
user is told it is being checked. The product never renders a confidence value
about a safety judgement.

**Neither event may carry the counter.** Both are `user`-sensitivity facts
about one person's life, and the analytics sink is not a place that learns how
many dates somebody has been on: `ANALYTICS_EVENTS` is the allowlist, and a
count that became a dimension would be exported to every dashboard holder the
moment someone added it for a chart. What may be published is **shape** — that
a target changed, that a date was recorded, whether a counterpart was involved —
which is what [Product Quality & Measurement](./product-quality-and-measurement.md)
needs to know the feature is used at all. If a metric ever needs the count
itself, it is asked for there, deliberately, as a named field with a retention
decision behind it, rather than smuggled out as a dimension.

Neither name is in `ANALYTICS_EVENTS` today, so neither may be published yet —
`recordAnalyticsEvent` refuses anything outside the catalogue. Recorded as a
doc/code disagreement in the same direction as `minPhotos` in §9.8: this table
is the decision, the catalogue is behind it, and closing the gap is a
registration, not a redesign. Until it is closed the feature is simply not
measured, which is a smaller problem than a counter leaking into a sink.

## 13. Open questions

- **Retroactive removal of a photo the owner later deletes.** §10.1 keeps a
  deleted photo visible to existing matches in v0.1. If a safety case shows
  that this is a real harm path — an abusive photo that the owner removes once
  they regret it — the fix is a tombstoned media ref, and it belongs in Platform's
  media design. Owner: Platform + Moderation. Unmeasured.
- **A photo plus an opt-in coarse city is a triangulation path.** §6.1 requires
  metadata stripped at ingest and §6.2 forbids identifiable surroundings, which
  removes the cheap cases, but a photo of a recognisable building or landscape
  plus a city name is still more identifying than either alone, and a display
  name is not a comparable artefact. Whether that warrants a rule here (a
  location-plausibility screen, or a stricter environment list) or belongs to
  [Privacy & User Settings §9](./privacy-and-user-settings.md) as a design
  review is undecided. This document does not add a `city` field; the card's only
  location is the coarse distance bucket.
- **Likeness threshold and its false-reject rate.** The number that separates
  "different person" from "bad lighting" is unmeasured, and
  [#1](https://github.com/katzimoto/been_there/issues/1) makes verification
  false-reject rate a primary success metric. A too-strict threshold removes real
  people from the product; a too-loose one admits the fake profile P8 exists to
  stop. Owner: Identity + Product. Blocks the threshold value.
- **Default visibility of `displayName` and `bio`.** Resolved: both are public by
  default and narrowable to match-only per field, per
  [Privacy & User Settings §4](./privacy-and-user-settings.md). Recorded here
  because the card spec in [Preferences & Discovery](./preferences-and-discovery.md)
  depends on it — a card that renders a name, a photo, an intent and a
  240-character bio only exists under this default.
- **`occupation` and `education` are not v0.1 fields** (§3), and the privacy
  spec carries the same exclusion with the same reasoning, so the decision is on
  the record in both places. If they are ever introduced they start match-only
  and need a column in §3 plus a completeness decision.
- **Size and maintenance of the public-figure list behind the §3 impersonation
  hold.** A stale list produces false holds on ordinary people and misses every
  new figure. Whether it is maintained by hand, seeded from a public dataset, or
  restricted to a few categories is undecided. The hold is reversible and
  non-punishing, so a miss costs a private name rather than a blocked account.
- **Whether `displayName` uniqueness should be enforced at all.** It is currently
  a casefolded match, which stops two identical names and inconveniences a person
  whose name is genuinely common. Needs a decision record either way.
- **Interest catalogue size.** Forty is chosen for card width and completion
  rate, both unmeasured. If a group is picked by fewer than 2% of users it should
  be cut; that threshold has not been agreed.
- **Whether the `gender` vocabulary needs a self-describe free text visible in
  discovery.** It is in the type and capped at 40 characters, but whether it is
  rendered on the card or only in the match view is undecided.
- **Whether `paused` should suppress new likes while keeping matches.** Current
  decision is that it does not; a user who pauses may still receive likes, which
  some will find surprising. Needs a product decision, not a technical one.
- **Which screening verdicts escalate to a human.** Only an explicit
  `inconclusive` verdict reaches `needs_human` today. The interesting case is
  `sexual_content`: a machine verdict of sexual content on a stranger's face is
  frequently wrong, and auto-rejecting a person's only photo on one is a decision
  with no case and no appeal behind it. Promoting it — or any other verdict —
  into the human queue trades moderator capacity for fewer wrong rejections, and
  the exchange rate is a staffing decision rather than an engineering one.
- **Per-photo moderation appeal.** A rejected photo can be re-uploaded, but a
  formal appeal path for content screening does not exist in v0.1. Whether one
  lands with the appeals work in [#15](https://github.com/katzimoto/been_there/issues/15) is undecided.
- **Retention of the completed-date ledger.** §9.1 settles the *scope* — the
  counter is per user and survives profile deletion — but nothing here sets how
  long the ledger is kept. It holds who the owner dated, and
  [Privacy & User Settings §5](./privacy-and-user-settings.md) owns deletion,
  so the retention period is that document's question. It is not settled here,
  and it is not settled by omission either: a ledger with no stated retention
  is a ledger that will be kept forever by default.
- **Whether the goal ever becomes a card field.** Resolved: **no**, not in
  v0.1. It is deliberately outside `ProfileContent`, so `evaluateProfileCompleteness`
  cannot see it and completeness is unaffected by it (§3, §8.1). If it is ever
  proposed for the card, it is a change to this document first — a goal on a
  card is a statement to strangers about how many dates you have been on, and
  it is not a small UI decision.
- **Whether the counter is ever shown to a match.** Resolved: **no** (§9.7).
  Recorded because it is the obvious next request and the answer has a reason
  rather than a preference: a count shown to one other person is a claim about
  that other person's own dating life, made by the owner, without their say.
- **Whether one account may hold two profiles at once.** Undecided, and it is
  the question that would reopen §9.1. The current split already accommodates
  it (a second profile means a second target, one shared count); what is not
  decided is whether the second profile gets its own target at all, and a
  per-profile history would be a schema change rather than a default.
- **Whether a restatement keeps the day it replaced.** Undecided, and it is the
  one place where the code and this section disagree today (§9.4, §9.8, §9.10).
  The domain aggregate cannot say what was claimed first — a record claimed on
  the 3rd and restated to the 2nd retains *that* it was restated, when, and to
  the 2nd, but not the 3rd. **The store does keep it**, in
  `completed_date_corrections.superseded_on`, so what is missing is not the data
  but the field on `DateCorrection` that would let the owner be shown it (§9.10).
  The choice is therefore narrower than "the record keeps it or it does not":
  either the domain type carries the superseded day and this document's promise
  is kept as written, or the promise is reduced to what a withdrawal already
  keeps and the chain stays a property of the table. Owner: Dating + Product.
  Blocks the correction API's shape, and blocks the owner-facing read that §9.4
  promises.
