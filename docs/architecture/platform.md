# Platform, Privacy & Shared Capabilities

> Issue [#8](https://github.com/katzimoto/been_there/issues/8). Parent: [#1](https://github.com/katzimoto/been_there/issues/1).
> Contract: [`./00-overview.md`](./00-overview.md). If this document contradicts
> the overview, the overview wins and this document is wrong.
> Executable form: `packages/platform`.

The platform is the part of Been There that is nobody's product feature. Every
domain needs a session, a permission check, a photo bucket, a push send, a log
line, and a vendor call. If each domain answers those for itself, the product
ends up with five notions of "restricted", three logging conventions, and a
verification provider SDK imported into a domain that also imports a risk
scoring library.

So the platform owns the answers, and the domains own the questions.

## 1. What this domain owns

| Owns | Never owns |
|------|-------------|
| Session issuance, validation, rotation, revocation, account recovery | Who may date whom; profile completeness; match eligibility |
| The role and permission matrix; capability grants; per-action authorisation | Which capabilities an account *should* have — moderation owns `AccountState` and the removals |
| Media upload policy, scan lifecycle, signed-URL issuance and verification | Whether a photo is a good photo; profile photo ordering; nudity policy thresholds (scanner vendor) |
| Notification channels, critical/suppressible classification, quiet hours, idempotency keys | What a notification says; the product event that caused it |
| Coarse location: anchor storage, quantisation, distance banding | The user's raw location lifecycle; city-level product rules |
| The append-only audit log and its action catalogue | Moderation cases, evidence semantics, enforcement decisions |
| The analytics event catalogue, the analytics sink discipline, sampling | What a funnel *means*; product experiment design |
| Redaction at the sink; the field-sensitivity vocabulary in use | The `DataSensitivity` type itself — that is the shared kernel's |
| The external integration port, failure taxonomy, retry policy | Which vendor; whether a verification is good enough (identity) |
| Correlation/causation propagation; request-log assembly | Trace storage, dashboards, alerting |

The distinction that keeps this honest: the platform knows *whether Robin may
send a message*, never *whether Robin should like Sam*. The moment a platform
decision needs a product fact, it belongs to a domain and arrives as an event.

## 2. Capability model

Two independent mechanisms, frequently confused:

- **Capabilities** (`send_message`, `browse_discovery`, …) answer "may this
  account do this product thing?" They are owned by the account machine in
  `@been-there/core` and published as `account_state.changed`. The platform
  resolves them into a `CapabilityGrant` and gates product commands with
  `requireCapability`.
- **Permissions** (`case.decide.ban`, `case.evidence.read`, …) answer "may this
  *role* perform this platform or moderation action?" They are owned here,
  because a role is a platform concept.

A `CapabilityGrant` is the account-state grant minus every removal a live
restriction names, resolved once into an immutable list:

```ts
interface CapabilityGrant {
	userId: UserId;
	accountId: AccountId;
	state: AccountState;              // published by moderation, never written here
	restrictions: ActiveRestriction[]; // each names the case that justifies it
	granted: string[];                // state grant minus all removals
}
```

The gate takes the grant, not the raw state:

```ts
requireCapability(grant, { capability: 'send_message' }, run);
```

This is deliberate and is the one bug class worth writing a test for.
`capabilitiesFor(state, {})` returns the **unrestricted** list, so a call site
that rebuilds the context itself silently ignores every restriction. The
platform's gate makes that shape inexpressible: the removals travel inside the
grant, and a caller-supplied `AccountContext` is merged *under* them — it can
only subtract. Tests: `packages/platform/test/authz.test.ts`.

Unknown capability names fail closed. `send_messages` is not a capability anyone
has, and an unrecognised name is treated as "not granted", never as "not
restricted".

`report` and `block` are unrestrictable. Reporting is the intake valve for
abuse reports and blocking is how a user protects themselves; a restriction that
removed either would be a moderator mistake with a product-wide consequence, and
neither failure shows up in any metric the platform can see. Removals are
filtered against `UNRESTRICTABLE_CAPABILITIES` rather than trusted, in both the
grant and a caller's narrowing context.

## 3. Role and permission model

| Role | Clearance | Can do | Cannot do |
|------|-----------|--------|-----------|
| `user` | `user` | own profile, own media, own recovery | anything moderation-shaped |
| `support` | `internal` | read session metadata, read `internal` audit | complete a recovery, read evidence, read `sensitive` |
| `moderator` | `sensitive` | open/read/decide cases, restrict, suspend, ban, read reported media | lift a ban, read the `restricted` audit trail |
| `senior_moderator` | `restricted` | all of the above, plus `lift_ban` and the restricted audit trail | — |
| `system` | `internal` | integration calls, `internal` audit | read case evidence, open or decide a case, read `sensitive` |

`system` is the row that matters. It is the role a detector, a queue worker, and
a scheduled job run as, and it deliberately holds no judgement permission. A
detector that could read evidence would be an enforcement decision made by a
machine, which is exactly what commitment 2 forbids.

Least privilege is expressed twice, and both gates run on every action:

1. **Permission** — does the role hold the permission the action requires?
2. **Clearance** — may the role observe the highest classification the action
   can return?

The second gate is what stops "grant support one more permission" from becoming
"support can now read liveness artefacts". A new permission added to a role does
not raise that role's clearance ceiling.

Support holds `support.session.read` but **not** `auth.recover.own`. Support
answers "when did your last login happen"; it does not mint a credential. That
distinction is the whole reason support and moderation are different roles.

## 4. Data-sensitivity access matrix

Rows are the five classes from the shared kernel. Columns are the reading
context. `own` means the subject reading their own field; a `user`-class field
belonging to somebody else is readable by nobody.

| Class | `user` | `support` | `moderator` | `senior_moderator` | `system` |
|-------|--------|-----------|-------------|---------------------|----------|
| `public` | read | read | read | read | read |
| `user` | own only | — | — | — | — |
| `internal` | — | read | read | read | read |
| `sensitive` | — | — | read (logged) | read (logged) | — |
| `restricted` | — | — | — | read (logged) | — |

Two notes on the shape of that table:

- `sensitive` is Identity and Trust & Safety only, per the overview. Moderators
  appear here because a moderator acting on a *case* needs the evidence the case
  points at — and every such read is an audit action, not a console feature.
- `restricted` is a single cell. Moderation evidence, case notes, and the audit
  trail are readable by one role and recorded when read. If that cell ever needs
  a second entry, the second entry is a new role, not a wider clearance.

The matrix is `CLEARANCE_BY_ROLE` plus `PERMISSIONS_BY_ROLE` in
`packages/platform/src/authz.ts`, and the two are deliberately separate
records: editing one does not edit the other.

## 5. Redaction at the sink

The enforcement point named in [ADR 0005](./adr/0005-sensitive-data-classification.md).
The rule:

> Every value that leaves a process for a log line, an analytics property bag, an
> error report, or a moderator screen is serialised by `redact()` /
> `serializeForSink()` against the **destination's** clearance. A field
> classified above that clearance never reaches the bytes.

Three properties make it more than a convention:

- **Classification is not optional.** `ClassifiedField` requires a
  `sensitivity`. There is no constructor that produces an unclassified field, so
  "we added a field and nobody said which class" is a type error.
- **The filter is in the sink, not the call site.** The leak that actually
  happens is a debug log three directories from the thing it logs. The sink is
  the last place the value passes through, and it is the same code for logs,
  analytics, support exports, and error reports.
- **It recurses.** A field's value may be a nested `ClassifiedRecord`, and the
  sink descends into it. Without that, "public" would become a word for
  "anything I did not think about" and a liveness score would ride out inside a
  profile blob the first time somebody grouped two fields for convenience.

Request logs are built by `requestLogEntry()`, which takes a classified record
and a **fixed** `internal` clearance the caller cannot raise. A caller that
could pass `{upTo: 'restricted'}` would be a caller that could log a selfie.
The entry also reports the names of the fields it dropped, so the filter is
itself observable without logging what it filtered.

A duplicate field name throws. A record that names the same field twice invites
a "the public copy wins" shadowing rule, and that rule is a leak waiting for the
one field somebody misclassifies.

## 6. Audit versus analytics

They look like the same table with different retention. They are not.

| | Audit | Analytics |
|---|---|---|
| Completeness | Every fact, always | Sampled, rate-controlled, extrapolated |
| Mutability | Append-only; records are frozen | Overwritten, aggregated, deleted on a schedule |
| Subject | One named subject; a case whenever enforcement is involved | No subject; only declared dimensions |
| Clearance | Up to `restricted` | `internal` at most |
| Expiry | Retention is a legal question | Retention is a budget question |
| Consumers | Moderation, appeals, incident review | Product engineering |

**What goes where.**

- Safety and identity events go to audit and nowhere else. `identity_status.changed`
  is `public` on the bus — a client must know whether the current user is
  verified — and it is still `audit: true, analytics: false` in `routeEvent()`.
  A metrics sink that can be sliced by subject is one query away from a "who was
  reported" list, which the overview forbids the product from knowing.
- Content goes to neither. A metrics sink is aggregatable and therefore widely
  readable; a log of message bodies is a product-wide liability that buys no
  safety. The guard is a type rule (`CONTENT_BEARING_TYPES`) plus the
  classification, because clearance alone would let an `internal` subscriber see
  a `user` event.
- The `auth.` prefix is audit-required for the same reason: recovery abuse is a
  safety signal, so `auth.recovery_abuse_suspected` is an event, not a metric.
- Product metrics for the identity and safety journeys come from the anonymous
  counters in the catalogue (`account.registration_completed`), never from
  subscribing the metrics sink to a safety stream.

**Analytics discipline** is enforced at the sink, not by review:
`recordAnalyticsEvent()` refuses an unregistered name (including an inherited
one like `"toString"`), a property from `ANALYTICS_FORBIDDEN_PROPERTIES`
(`userId`, `caseId`, `latitude`, `messageBody`, …), a property the event did not
declare as a dimension, a non-scalar value, and a sample rate outside `[0, 1]`.
Declared dimensions are the review surface: adding one is a diff in
`ANALYTICS_EVENTS`.

Sampling is deterministic on the correlation id, so a retried publish neither
double-counts nor flickers between runs.

## 7. Location precision

**Decision.** The platform stores one quantised anchor per user, classified
`sensitive`, and hands out a named distance **band**. There is no API that
returns a coordinate, and the projection type has no field a coordinate could
occupy — that is checked at compile time in `test/location.test.ts`, not by
review.

```ts
interface CoarseLocation {
	ownerId: UserId;
	band: 'same_area' | 'nearby' | 'regional' | 'distant' | 'unknown';
	label: string;        // client copy for the band, never a number
	observedAt: Date;
}
```

**Why bands and not "12 km".** A number is a coordinate difference and a stable
one: two observations 200 m apart in a 40 km band are two constraints, and a few
of them intersect. A band is stable only up to its own width, so intersecting
observations cannot narrow a position below the band. `same_area` is 8 km rather
than "same city" because a city boundary is published data, and two coordinates
inside one city can still be kilometres apart.

**Threat model — distance inference from repeated observation.** The realistic
attack is not a database read; it is a bored user with a screenshot and a weekend.
Sequences of bands leak even when each individual band does not:

- *Trip detection.* A band that changes three times in an hour is a commute. The
  stored anchor is quantised to a ~9 km grid cell offset deterministically by
  account, so a stationary user produces a stable anchor instead of a GPS-noise
  track, and two nearby users are not represented identically.
- *Home vs work.* The strongest signal is a band that stops changing at night
  and starts in the morning. Mitigation: the anchor is stored with an accuracy
  and an observation time, retention is bounded, and the band vocabulary is
  coarse enough that the home/work distinction is not a conclusion a reader can
  draw from a month of bands. A production system should additionally widen bands
  for infrequent observations — that is an open question, not a decision.
- *Grid inversion.* Because the quantisation offset is a function of the account,
  an attacker who can observe many bands cannot average them into a shared grid
  unless they can enumerate accounts, which is the enumeration problem and is
  bounded by the same rate limits as the rest of the product.
- *Cross-feature correlation.* A coarse band is safe on its own and dangerous
  next to a city-level "workplace" field or a timezone from a phone number. The
  rule is that the platform emits the band and nothing else, and any feature that
  wants more must go through the data-residency answer in §12 before it ships.

**What is explicitly not protected.** A user who deliberately tells a match
their city is outside this system, and we do not pretend otherwise. The band
protects a user from inference, not from their own disclosure.

## 8. Media access

The upload lifecycle is a transition table, so "can this asset be served?" is a
readable block rather than an `if`:

```
initiated ──begin_scan──▶ scanning ──approve(clean)──▶ approved   (terminal)
                          │       └─reject(verdict≠clean, reason)──▶ rejected
                          │                                              │
                          └──────────────────────────────────────────────┘
                                       reprocess(reviewer) ──▶ initiated
```

Only `approved` media is servable, and even then never from a public URL.
`MediaAsset` carries no address, so a bucket URL cannot be constructed from
stored state even by accident; the only producer of a URL is
`issueMediaAccess()`, a pure function of (asset, requester, purpose, expiry,
signing key).

- The owner gets a URL only for `approved` media, and never on the
  `moderation_review` path — that would be a way to see a restricted asset
  through an unmoderated door.
- A non-owner gets nothing, on any purpose, unless the purpose is
  `moderation_review` **and** `authorize(principal, 'media.read_any')` passes
  with a case. Rejected media is exactly what a review needs to see.
- Grants are short-lived (120 s), bound to asset + owner + requester + purpose +
  expiry in the signed claim, and re-verified at serve time, so a leaked URL
  stops working when the asset is later rejected and cannot be replayed onto
  another asset or another requester.
- Issued and denied are separate audit actions. "Who tried to read this and was
  refused" is the signal worth keeping, and it is invisible if only successes
  are logged.

## 9. Notifications

Three rules, in priority order:

1. **`safety` and `account` are not suppressible.** A quiet-hours setting that
   could silence "someone reported your photo" is a safety control operated by
   the person it protects. Preferences, muted channels, and quiet hours are all
   ignored for these categories; the only thing that can stop them is the account
   not having that channel. A channel the account does not have is recorded as
   `channel_unavailable` rather than retried forever, and safety notices fan out
   across every channel the account *does* have.
2. **Quiet hours are per recipient and per timezone.** "Quiet hours" is a local
   fact; 22:30 UTC is 23:30 in Berlin and 17:30 in New York, and the same
   instant is quiet for one recipient and not for another. Windows may span
   midnight (start inclusive, end exclusive).
3. **The idempotency key is derived from the event, not the notification**, and
   includes the recipient and channel. A redelivery, an at-least-once
   publisher, and a user tapping twice all collapse onto one claim; a fan-out
   across four channels is four distinct deliveries of one event.

## 10. External integration seam

No domain imports a vendor SDK. A verification provider, an email relay, APNs,
and an SMS gateway all arrive as the same three shapes:

```ts
interface IntegrationPort {
	execute<P, T>(request: ExternalRequest<P>): Promise<IntegrationResult<T>>;
}
```

- A request with a stable `idempotencyKey`, forwarded to the vendor's own
  idempotency support where one exists.
- A uniform failure taxonomy — `timeout | unavailable | rejected | rate_limited
  | malformed_response` — so callers branch on five cases rather than on four
  different vendors' status codes. Swapping a provider is an adapter change and
  nothing else.
- A retry policy keyed off whether repeating the call is **safe**, declared per
  operation rather than per attempt.

The subtle case is a timeout on a non-idempotent operation. The vendor may have
processed it. A retry there is not "try again", it is "do it twice" — so
verification operations get exactly one attempt, and the caller decides what a
possibly-completed verification means. Notification operations are keyed by the
caller's idempotency key and safe to repeat, because the duplicate-notification
risk is handled at the ledger, upstream, where the recipient is known.

Rate limits from the vendor take precedence over our exponential backoff.

## 11. Observability

- One correlation id is minted at the edge (`newRequestTrace`) and inherited
  everywhere. `inheritEventContext` never re-mints it; re-minting is how a
  cross-domain trace silently splits in two.
- Causation names the one event that immediately caused this one. A chain
  carrying both reads as a story; a chain carrying only a correlation id is a
  pile.
- An audit record built from an event takes its timestamp and correlation id
  from that event, so every audit fact ties back to the envelope that caused it.

## 12. Open questions

Recorded rather than guessed, because guessing is worse than writing down the
gap.

- **Identity provider selection.** Which vendor verifies documents and liveness,
  and whether likeness scoring is a build or a buy. It determines the media
  pipeline's cost per upload, the shape of `scanVerdict`, and whether
  `verify_document`'s single-attempt policy survives a vendor that charges for
  abandoned reviews. Depends on vendor pricing and latency research.
- **Key management.** Media grant signing and any pseudonymous analytics key
  need a key store, a rotation policy, and an answer for what happens during a
  rotation window. The platform injects the signer rather than importing a crypto
  helper precisely so this decision is not already made.
- **Pseudonymous analytics keys.** v0.1 analytics carries no subject at all: only
  declared dimensions. The first feature that needs a per-user funnel will need a
  per-install random join key with a stated lifecycle, and a legal answer on
  whether that crosses into personal data in our markets.
- **Per-market data residency.** Which markets require data to stay in-region,
  and whether a coarse band derived from a coordinate inherits the residency of
  the coordinate. This changes the topology (regional anchors) rather than the
  contract, but it is expensive to retrofit and cheap to decide now.
- **Notification channel priorities per market.** Which channels are legally
  permitted, and which the population will actually read, in each launch market.
  The critical/suppressible split is settled; the channel fan-out order is not.
- **Evidence and audit retention.** How long `restricted` records live, and the
  erasure story for a user who deletes their account while a case against them
  is open. The technical answer is a tombstone; the legal answer is not ours.
- **Band width per market.** 8/40/160 km suits a dense city market. A rural
  market, or a market where people drive between cities, may need different
  edges, and the band vocabulary is a client-visible contract.
