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



**What goes where.** The three rules, in the order `routeEvent()` applies them:

1. **Content goes to neither sink.** A metrics sink is aggregatable and
   therefore widely readable; a log of what people said to each other is a
   product-wide liability that buys no safety. The guard is
   `CONTENT_BEARING_TYPES`, and it names the events the packages actually
   publish — `communication.message_sent` today, and only that one. It used to
   list four names no package emits, which meant the rule protected nothing
   while reading as though it did, and the failure is silent: an unflagged event
   simply goes wherever its sensitivity allows. Every other event that could
   carry user content is `sensitive` or `restricted`, which the clearance check
   refuses regardless of its name.
2. **Safety and identity events go to audit and nowhere else.**
   `identity.status_changed` is `public` on the bus — a client must know whether
   the current user is verified — and it is still `audit: true, analytics:
   false` in `routeEvent()`. A metrics sink that can be sliced by subject is one
   query away from a "who was reported" list, which the overview forbids the
   product from knowing. Audit-required membership is by domain prefix
   (`identity.`, `moderation.`, `communication.`, `case.`, `account_state.`,
   `auth.`) with an explicit exception list for the safety facts whose type name
   carries no prefix (`verification.anomaly`, `risk.changed`). The legacy
   spelling `identity.status_changed` is on that list only until the rename in
   the feature specs lands; it is the row to delete, and not before.
3. **An event no sink may hold is reported, not discarded.** A `sensitive` event
   that is not an audit fact comes back `{ audit: false, analytics: false,
   rejection: 'unroutable' }`. A silent `{ audit: false, analytics: false }` is
   indistinguishable from a bug, and is how the entire moderation domain's
   safety record was dropped from both sinks while the router looked healthy.

Product metrics for the identity and safety journeys come from the anonymous
counters in the catalogue (`account.registration_completed`), never from
subscribing the metrics sink to a safety stream. Where a safety metric genuinely
needs a subject — median case resolution time, the block-to-report ratio — it is
computed from the **audit log**, which is the only store that holds case ids, and
not from analytics. `ANALYTICS_FORBIDDEN_PROPERTIES` refuses `caseId` and
`conversationId` precisely so that no one reaches for the sink to get them.

**Analytics discipline** is enforced at the sink, not by review:
`recordAnalyticsEvent()` refuses an unregistered name (including an inherited
one like `"toString"`), a property from `ANALYTICS_FORBIDDEN_PROPERTIES`
(`userId`, `caseId`, `conversationId`, `latitude`, `messageBody`, …), a property
the event did not declare as a dimension, and a non-scalar value. Declared
dimensions are the review surface: adding one is a diff in `ANALYTICS_EVENTS`.

**The sampling rate lives in the catalogue.** `AnalyticsEventSpec.sampleRate` is
the whole of the policy, and a caller cannot pass one: a rate chosen at the call
site is a per-site decision that drifts the moment two services disagree, and a
drifting rate silently changes a metric's denominator. Almost everything is
`1`; the exceptions are `discovery.page_served` at `0.1` — the one genuinely
high-volume event — and `notification.delivered` and `notification.failed` at
`0.25`. Sampling is deterministic on the correlation id, so a retried publish
neither double-counts nor flickers between runs, and the correlation id is the
only key the sink is allowed to see: `userId` and `sessionId` are forbidden
properties, so a hash over either of them is not merely unwise, it is
unconstructible.

### The two audit logs are not the same log

The repository contains both, and the one every production call site writes to
is not the one that classifies. Stated here because the pair reads as a
duplication until somebody says which half is the system of record.

| | Platform `InMemoryAuditLog` | Moderation `AuditLog` |
|---|---|---|
| Job | classification and access control | the domain's reconstruction of its own chain |
| Carries | a `sensitivity` per record, from `AUDIT_ACTIONS` | no classification of any kind |
| Reads | `read({ upTo })` decides from the **reader's** clearance | `byActor` / `bySubject` / `byEntity` / `forCase`, no clearance anywhere |
| `append` | `Result<AuditRecord, DomainError>`; an unclassified name is a `validation_failed` domain error rather than a `TypeError` | returns the entry; there is nothing for it to refuse |
| Written by | `routeEvent` and `auditRequestFromEvent` | `ctx.audit.append`, at all fifteen call sites in `packages/moderation/src` |

**Which one an appeal is answered from: both, and they are not
interchangeable.** The platform log is authoritative for *who may read the
record*. All sixteen moderation actions are classified `restricted`, so the
reply to "you were banned, here is the case, contest it here" has to be
readable by a `senior_moderator` and by nobody below one, and that cell is
`read({ upTo })`'s to decide rather than a role's to be trusted about. The
moderation log is authoritative for *what the chain said* — the reversal path,
the decision id, the evidence ids — because those are domain facts Platform
has no vocabulary for and must not invent.

**The gap, named rather than left to be discovered.** The chain that runs
today is the unclassified one. `new InMemoryAuditLog(` appears in no package's
`src/`; its only callers are the development dataset and Platform's own
tests, so a deployed system would hold an appeal record with no sensitivity on
it. The two logs are not connected by accident, though: `NewAuditEntry.detail`
is an unclassified `Record<string, string | number | boolean | null>` and
`AuditAppendRequest.fields` demands `ClassifiedField[]`, so the adapter has to
be written by someone who decides what each detail field *is*. That is
precisely the decision that must not be made by default — it is the same
classification every other field in the system makes, one level up. The
vocabulary is not the outstanding work: all sixteen names already agree with
the moderation source, and `moderation-audit-contract.test.ts` derives its
list from that source, so a seventeenth action fails there rather than in
production. See §13.

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
initiated ──begin_scan──▶ scanning ──approve(clean)──▶ approved (terminal)
                          │   │
                          │   └─reject(verdict≠clean, ≠inconclusive, reason)──▶ rejected ◀─┐
                          │           escalate(inconclusive)                           │  │
                          │                 │                                         │  │
                          │                 ▼                                         │  │
                          │           needs_human ──approve(reviewer)──▶ approved        │  │
                          │                 │                                         │  │
                          │                 └─reject(reviewer, reason)──────────────────┘
                          └───────────────────────────────────────────────────────────┘
                                       reprocess(reviewer) ──▶ initiated
```

**`needs_human` is the state that keeps screening from being enforcement.** A
scanner that reached a verdict may act on it: the rules in
[Profile & Personalization §6.2](../features/profile-and-personalization.md) are
a published list, and a photo that breaks one is rejected with the reason the
user is told. A scanner that could *not* decide has no such warrant, and the
only honest outcomes for it are "hold this for a person" and nothing else. The
held asset is not servable, not in the live set, and its owner is told it is
being checked rather than that it failed — because an auto-rejected borderline
photo is an enforcement decision about a stranger's face, made by a machine,
with no case behind it and nobody to appeal to.

Leaving `needs_human`, in either direction, requires a named `reviewerId`, on the
same rule as `reprocess`: a decision about a person is made by a person. Which
verdicts count as inconclusive is recorded as an open question in the feature
spec: only an explicit `inconclusive` verdict reaches the state today, and
promoting, say, `sexual_content` into a human queue is a queue-cost decision with
user-facing consequences, not a mechanical one.

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
  with a case. Rejected media is exactly what a review needs to see, and so is a
  held asset.
- Grants are short-lived (120 s), bound to asset + owner + requester + purpose +
  expiry in the signed claim, and re-verified at serve time, so a leaked URL
  stops working when the asset is later rejected and cannot be replayed onto
  another asset or another requester.
- Issued and denied are separate audit actions. "Who tried to read this and was
  refused" is the signal worth keeping, and it is invisible if only successes
  are logged.

One gap worth naming rather than discovering later: **a scan decision is written
nowhere.** The media machine publishes no event, so a rejected photo is in
neither the audit log nor any counter, and the `media.*` audit actions cover
access rather than screening. Until a media event or a scan audit action exists,
"how many photos did screening refuse last week" has no answer.

## 9. Notifications

Five rules, in the order `planNotification()` applies them:

1. **The catalogue is the notification.** `NotificationKind` is the stable
   identifier — twenty-one of them, in `NOTIFICATION_KINDS` — and each row
   states its category, its class, which channels it uses and how urgently,
   whether it is about one specific other person, and the closed set of facts
   a rendered body may bind. A kind that is not a row does not exist, which is
   what makes "a notification's content is reviewable" a property of a table
   rather than of a reviewer's memory.
2. **`verification` cannot be switched off; `account` and `safety` name their
   critical rows.** `NON_SUPPRESSIBLE_CATEGORIES` is `['verification']`, and a
   category in it is non-suppressible *whatever the row's own flag says* — so a
   twenty-second verification row cannot become muteable by being written
   `critical: false`. `account` and `safety` keep the per-row `critical` flag,
   because there criticality is a property of the notice rather than of the
   category: `account.restriction.applied` is about the recipient's own
   standing, `report.received` is a receipt for a report they filed, and no
   category-level rule can tell those apart. The resolved answer is read once
   per plan and threaded to the mute check, the quiet-hours check and the plan
   itself, because a rule that applied to a mute switch but not to a deferral
   would leave a verification notice non-suppressible in name only. A
   quiet-hours setting that could silence "someone reported your photo" is a
   safety control operated by the person it protects, and a user who cannot be
   told their verification failed cannot know why they are no longer visible.
   Critical kinds ignore both the preference and the window; the only thing that
   can stop them is the account not having that channel, which is recorded as
   `channel_unavailable` rather than retried forever.
3. **A block edge stops a pair notice on both sides, and no class overrides
   it.** `planNotification` refuses a pair-scoped kind whose caller did not state
   the edge, so the block is a required input rather than a default: a missing
   `blockedPair` is an error, not an assumption. Telling a blocked person that
   the other side is still active is a safety disclosure; telling the blocker
   that the other side still receives notices invites the abuse that caused the
   block.
4. **Quiet hours defer, they do not drop.** A non-critical push or email inside
   the recipient's window is planned with `mode: 'deferred'` and a `deliverAt` at
   the end of it, and it claims the same idempotency key it would have claimed
   immediately, so a held release and a retried immediate send cannot both
   deliver. The in-app entry is never deferred — it is the durable record. An
   email the catalogue marks `digest` is a *schedule*, not a prohibition: it is
   planned at the next window boundary, hourly aligned or weekly on the day and
   hour the recipient chose. Windows are per recipient and per timezone, because
   "quiet hours" is a local fact: 22:30 UTC is 23:30 in Berlin and 17:30 in New
   York, and the same instant is quiet for one recipient and not for another.
5. **The idempotency key is derived from the event, not the notification**, and
   includes the recipient and channel. A redelivery, an at-least-once publisher,
   and a user tapping twice all collapse onto one claim; a fan-out across three
   channels is three distinct deliveries of one event. The kind is not part of
   the key: it is a function of the event, so including it would let one event
   claim the same channel twice.

**The content vocabulary is enforced in two places, and the second is the one
that matters.** `NOTIFICATION_CONTENT_TOKENS` is a closed union, so a
catalogue row cannot *name* a message body. On its own that constrains the
catalogue to itself — a type on data that was already reviewable — which is why
the guarantee is made at the render boundary instead.
`renderNotificationBody(plan, copy, facts)` is the only function in the
repository that turns a set of facts into characters, and it refuses three
ways:

- a `{{slot}}` naming anything outside the union, `{{message_body}}` included.
  This *is* the guarantee: there is no value that could fill such a slot and
  no key a caller could spell to get one, so a template that tries comes back
  as a `validation_failed` rather than as a body with a literal brace pair
  sitting in the recipient's inbox;
- a slot naming a real fact this kind does not declare on this channel, and a
  value supplied for a fact it does not declare. Under-delivery and smuggling
  are the same mistake, so they are one check — the supplied set and the
  declared set must be equal;
- a declared fact with no value, so the catalogue row is a promise the body
  keeps rather than a suggestion.

The bindable set arrives **on the plan** (`NotificationPlan.content`) rather
than as a second lookup the adapter performs, so the set that reaches the bytes
is the set the planner read and not whichever copy of the catalogue the adapter
happened to open.

**What the renderer does not do**, stated rather than left to be assumed: it
does not police the literal prose. The copy is the notification layer's, owned
by [Notifications §3.1](../features/notifications.md) and reviewed as a string
like any other user-facing safety copy. And there is no caller: in the same way
`planNotification` takes `kind` as a parameter, nothing in any package emits a
notification today. `NOTIFICATION_KINDS` is a vocabulary of twenty-one rows and
zero producers — "the catalogue is the whole of what a notification may say"
is a contract Platform now enforces end to end for any caller that exists, and
a claim about a caller that does not.

**The in-app subset rule is conditional, and the condition is written down
here because a conditional invariant read as a universal one is how the bug
comes back.** "A channel may say less than the in-app record and never more"
holds *wherever a kind has an in-app record*. Four kinds have none, and each
has to match one of two structural shapes or the suite fails: either the
durable record already exists under another kind in the same category
(`message.digest`, whose per-message entry is `message.received`, and a second
in-app entry per window would say the same thing twice), or the user cannot
reach the app at all — a critical notice whose delivery guarantee is an
immediate email and nothing else (`account.banned`, `account.recovery`,
`account.deletion_completed`). An in-app surface added to any of them would be
a surface nobody will ever render.

`sms` is not a notification channel. A phone number is personal data the account
does not have to disclose in order to receive product mail, and a safety notice
that arrives by SMS is a notice a shared or coercive device can see. The recovery
*flow* may still use an SMS one-time code — that is a credential channel, and
nobody is ever notified by the channel they authenticate with.

## 10. Sessions

Three lifetimes, and conflating them is how a session policy ends up meaning
nothing:

| | Constant | Answer to | Why |
|---|---|---|---|
| Access token | `SESSION_TTL_SECONDS` — 15 min | "how long is this bearer token useful?" | A leaked access token is useless within a quarter hour, and every request can re-mint one. |
| Refresh window | `REFRESH_WINDOW_SECONDS` — 30 days | "how long may this login be *renewed*?" | Absolute, and deliberately **not** sliding. |
| Idle clock | `SESSION_IDLE_TIMEOUT_SECONDS` — 14 days | "has anyone used it lately?" | The half-life of the window. |

**Why the window does not slide.** A 30-day window that refreshes on activity is
a session that never ends: the one credential an attacker stole keeps working for
as long as the legitimate owner keeps using the product, so the window measures
nothing. The idle clock is what makes an absolute window compatible with
"refreshed on activity" — activity refreshes the *token*, not the window, and a
login nobody has touched for a fortnight dies with a fortnight still left on its
window. The two refusals stay distinct because one is routine and the other is a
signal: an `expired` access token is the normal fifteen minutes, an `idle` one
means a person stopped coming back.

The idle clock is checked on the **refresh** path, not on the validate path,
because a fortnight is also fifty-eight thousand access tokens — by then the
token is long expired, and `idle` would be a reason no caller could ever
observe.

**Concurrent sessions.** `MAX_CONCURRENT_SESSIONS` is 10. Past the cap the
least recently active session is evicted rather than the newcomer refused, so
signing in on a new device does not lock you out of the ten devices you actually
use, and the sessions that survive are the ones a person has touched. An
eviction comes back revoked with the reason `session_limit`, which is what lets
the owner be told on a channel they are still signed in on: an unexplained
sign-out is otherwise the only signal that a session limit exists.

> The feature spec [Account & Onboarding §5](../features/account-and-onboarding.md)
> currently reads "30 days rolling, refreshed on activity; idle timeout 14 days;
> 10 concurrent sessions". Rolling and idle are mutually exclusive as written —
> a session refreshed on activity is never idle for a fortnight — and the code
> follows the table above. That paragraph is the thing to correct, and it is not
> corrected here because that document is not this domain's.

## 11. External integration seam

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

## 12. Observability

- One correlation id is minted at the edge (`newRequestTrace`) and inherited
  everywhere. `inheritEventContext` never re-mints it; re-minting is how a
  cross-domain trace silently splits in two.
- Causation names the one event that immediately caused this one. A chain
  carrying both reads as a story; a chain carrying only a correlation id is a
  pile.
- An audit record built from an event takes its timestamp and correlation id
  from that event, so every audit fact ties back to the envelope that caused it.

## 13. Open questions

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
- **Classifying the moderation audit chain.** §6 says which log answers an
  appeal and which one runs; the two are not connected, and the adapter that
  connects them has to classify `NewAuditEntry.detail` field by field before
  it can be written. That is a Moderation decision wearing a Platform type, so
  it belongs to whoever owns the moderation payload schema, not to a default
  that marks everything `restricted` and calls the case closed. Until it
  exists, the classified sink guards the vocabulary and the runtime chain
  guards nothing.
