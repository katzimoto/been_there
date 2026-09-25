# Product Quality & Measurement

> Issue [#18](https://github.com/katzimoto/been_there/issues/18). Parent:
> [#1](https://github.com/katzimoto/been_there/issues/1).
> Authority: [System domains & boundaries](../architecture/00-overview.md). If this
> document contradicts the overview's eight commitments, the overview wins.
>
> Vocabulary used here — account state, identity state, risk state, `caseId`,
> `DataSensitivity` — is the overview's, not a local synonym set.

This document is the **single index of events for the MVP**. Every event named in
another feature spec appears in §2, and if it is not in §2 it does not exist. It
also fixes the denominators for the success metrics in issue #1, the idempotency
contract for the five critical actions, and the reliability policy.

§2 is two tables, and the distinction between them is load-bearing rather than
presentational: **§2.1 is what the metrics sink will accept** and **§2.2 is what
the domains publish**. A name in only one of them is not a naming disagreement to
be resolved later — it is the difference between an event Platform can record and
an event a domain owns, and writing one where the other was meant is how a
catalogue ends up describing a system nobody built.

Three rules that everything below follows from:

1. **Metrics never contain user content, and never contain a `sensitive` or
   `restricted` value.** Analytics is a `public`/`internal` sink. The classes in
   the overview's §6.3 table are the access policy for this document too.
2. **A denominator is part of the metric.** Several of issue #1's metrics are
   easy to compute wrong, and a metric with an ambiguous denominator is worse
   than no metric because it produces confident wrong answers. Every metric in §3
   names its numerator, denominator, unit of analysis, and time window.
3. **A safety regression is a page, not a dashboard.** The metrics in §3 tell
   you what happened; the alerts in §5.2 tell you to act.

## 1. Boundary

| This spec owns | This spec never owns |
|----------------|---------------------|
| The event taxonomy: names, source domain, trigger, sensitivity class, and role | The meaning or emission of any event — the owning domain emits it, and only when its state machine allows the transition |
| Metric definitions, formulas, denominators, and known pitfalls | The decision that a metric is acceptable; the measurement plan in §6 owns that |
| Idempotency keys, retry policy, and partial-failure UX for the four critical actions | Enforcement decisions; a restriction is idempotent but never automated |
| SLOs, error-budget policy, alert set, dashboard contents | The business consequence of an alert; routing is an ops concern, thresholds are ours |
| The analytics data-minimisation policy and sampling policy | Any product read-model used for the dating experience; analytics is write-only for everyone |
| Event *transport* reliability (no loss, no unbounded lag) | Event *content* semantics |

## 2. Event taxonomy

**Two tables, two vocabularies, and conflating them is the defect this section
exists to prevent.**

- **§2.1 is the metrics sink catalogue.** Every name in it is a member of
  `ANALYTICS_EVENTS` in `packages/platform`, and `recordAnalyticsEvent` refuses
  anything else with `validation_failed`. A name in §2.1 is a *counter or a
  projection* a service may push: it carries declared dimensions and nothing else.
- **§2.2 is the indexed domain stream.** These are published by their owning
  domain and routed by `routeEvent()`. They are never a metrics input, and the
  safety ones reach the audit log and nowhere else. A metric that needs a subject
  — median case resolution time, the block-to-report ratio — is computed from the
  **audit log**, which is the only store that holds case ids, because
  `ANALYTICS_FORBIDDEN_PROPERTIES` refuses `caseId` and `conversationId` to the
  sink on purpose.

**Who emits a §2.1 name.** Not a domain package: commitment 6 means no domain
imports the platform, and the six packages are domain cores, not services. The
caller is the service layer that hosts them, at the moment the fact happens, and
this catalogue is the contract that layer must satisfy. A §2.1 name with no such
caller is a hole in the instrumentation and belongs in §7.1's launch gate, not in
the table.

`Role` is one of:

- **Funnel** — onboarding, dating, or engagement funnel step.
- **Safety** — report, block, restriction, suspension, verification failure, risk.
- **Health** — reliability and operations, never user-facing.
- **Control** — analytics instrumentation, not a product or safety fact. Kept
  separate so a control event can never be mistaken for a funnel step.

Sensitivity is the `DataSensitivity` from the overview. No §2.1 entry is
`sensitive` or `restricted`: those classes never reach analytics, and an event
published at one of them (`verification.review.proposed`,
`verification.anomaly`, `verification.evidence.accessed`) belongs in §2.2.

### 2.1 The metrics sink catalogue

Every row is a member of `ANALYTICS_EVENTS`, transcribed from it. The **Rate**
column is `AnalyticsEventSpec.sampleRate` and it is the whole of the sampling
policy: `recordAnalyticsEvent` takes no rate from its caller, so a rate cannot
drift between two services that disagree about it, and a rate that drifts
silently changes a metric's denominator.

Dimensions are an allowlist, not a suggestion. A property that is not the
event's own declared dimension is refused with `validation_failed`, and so is any
name in `ANALYTICS_FORBIDDEN_PROPERTIES` — which now includes `conversationId`,
because a conversation is a pseudonym for two identified people and a metrics
sink that can be sliced by one is a "who was talking to whom" list.

#### Account, onboarding and settings (Platform)

| Event | Class | Dimensions | Rate | What it counts |
|-------|-------|-----------|------|----------------|
| `account.app_opened` | `internal` | `surface`, `journey_id` | 100% | App opened. `journey_id` is a per-install random key, never derived from a user id and never joined to an audit event. |
| `account.registration_started` | `public` | `surface` | 100% | Onboarding entry. No identity, no funnel position. |
| `account.registration_completed` | `public` | `surface` | 100% | A verified account exists. Counted, never attributed. |
| `account.registration_rejected` | `internal` | `reason_code`, `age_band` | 100% | Sign-up refused. Reason codes only; no entered values. |
| `account.onboarding_step_completed` | `public` | `step`, `source` | 100% | Progress through onboarding. Steps are a closed vocabulary. |
| `account.onboarding_step_failed` | `internal` | `step`, `reason_code` | 100% | Failure twin of `onboarding_step_completed`. |
| `account.session_started` | `internal` | `surface`, `auth_method` | 100% | A session began. Session churn is a security metric. |
| `account.session_failed` | `internal` | `reason_code`, `auth_method` | 100% | Counts failed logins, not who. |
| `account.session_revoked` | `internal` | `scope` | 100% | Sessions were killed — by logout, password change, recovery, the session cap, or enforcement. |
| `account.capability_denied` | `internal` | `capability`, `reason_code` | 100% | A product capability was refused. A denial is a fact about capability, not about moderation, so it must never carry a case id. |
| `account.recovery_started` | `internal` | `method` | 100% | A recovery was attempted. |
| `account.recovery_completed` | `internal` | `method`, `sessions_revoked_count` | 100% | Recovery succeeded and every other session was revoked. The blast radius as a count, never a session id; the detail of *which* sessions is the audit action `auth.recovery_completed`. |
| `account.recovery_locked` | `internal` | `reason_code`, `window_hours` | 100% | Recovery was locked after repeated failures. Counted; the detail is audit-only. |
| `account.deletion_requested` | `internal` | `retention_bucket` | 100% | Erasure was requested. Retention buckets only. |
| `account.deletion_cancelled` | `internal` | `retention_bucket` | 100% | Erasure was withdrawn inside the grace window. |
| `account.deletion_completed` | `internal` | `retention_bucket` | 100% | Erasure finished. Counts only. |
| `settings.updated` | `internal` | `changed_field`, `changed_field_count_bucket` | 100% | A non-preference settings write committed. Field names and a count, never the values written. |

`settings.updated` is separate from `preferences.updated` because they have
separate owners and separate read-models: folding them together would make the
Dating Core's analytics footprint depend on the Platform's settings vocabulary.

#### Profile and media (Dating Core, Platform)

| Event | Class | Dimensions | Rate | What it counts |
|-------|-------|-----------|------|----------------|
| `profile.published` | `public` | `surface` | 100% | A profile became visible in discovery. The onboarding funnel's terminal step. |
| `profile.state_changed` | `internal` | `from`, `to` | 100% | A profile lifecycle state moved. Enumerated states only. |
| `profile.updated` | `internal` | `changed_field_count_bucket`, `changed_field` | 100% | A profile was edited. Field names and a count bucket, never the values written. |
| `profile.photo_uploaded` | `internal` | `reason_code`, `bytes_bucket` | 100% | A photo entered the media pipeline. Bytes are bucketed, never sized exactly; `reason_code` carries the upload source, not a screening verdict. |
| `profile.photo_rejected` | `internal` | `reason_code` | 100% | Screening or policy refused a photo. |
| `profile.photo_set_updated` | `internal` | `photo_count_bucket` | 100% | The photo set changed. A count, not the media. |
| `media.signed_url_issued` | `internal` | `purpose` | 100% | A time-boxed media grant was created. |
| `media.access_denied` | `internal` | `purpose` | 100% | A media read was refused. Enumeration attempts cluster here. |
| `location.resolved` | `internal` | `band` | 100% | A coarse distance was produced. The band only; never a coordinate. |

`profile.photo_rejected` counts rejections, not people. A photo held for a
moderator (`needs_human` in the media machine) is not a rejection, and the two
must not share a counter: a rise in holds is a queue problem and a rise in
rejections is a screening problem.

#### Discovery (Dating Core)

| Event | Class | Dimensions | Rate | What it counts |
|-------|-------|-----------|------|----------------|
| `discovery.entered` | `public` | `surface` | 100% | The viewer passed the gate and opened the feed. The first dating-funnel step. |
| `discovery.page_served` | `internal` | `pool_bucket`, `page_size_bucket` | **10%** | A page of candidates was returned, full or short. The one genuinely high-volume event — ten cards per request — and the only one sampled. |
| `discovery.exhausted` | `internal` | `gate_class` | 100% | The eligible pool is confirmed exhausted for this viewer. A sudden rise means identity expiry, not a lack of users. |
| `discovery.viewer_ineligible` | `internal` | `gate_class` | 100% | The gate refused the viewer. The gate **class** only, never the underlying state. |

The `discovery.page_served` sample is deterministic on the event's **correlation
id** — the only opaque key the sink is permitted to see, since `userId` and
`sessionId` are both on `ANALYTICS_FORBIDDEN_PROPERTIES`. Hashing a user id was
never implementable here and would have been the wrong thing if it were: it would
make the sample a function of who the user is, which is a per-user sampling
decision wearing a uniform's clothes. Any rate computed from it carries a
weighting factor and the dashboard says "sampled" on the tile.

#### Messaging (Communication)

| Event | Class | Dimensions | Rate | What it counts |
|-------|-------|-----------|------|----------------|
| `conversation.created` | `internal` | — | 100% | A conversation opened, which is at match time. The denominator of every messaging rate. |
| `message.recorded` | `internal` | `message_length_bucket` | 100% | A message was accepted. A count and a length bucket, never a body, an excerpt, or a link. |
| `message.delivered` | `internal` | `latency_bucket` | 100% | A recipient's client acknowledged the message. |
| `message.read` | `internal` | — | 100% | A read watermark advanced. |
| `message.withheld_by_system` | `internal` | `rule` | 100% | An outbound message was refused by a system rule. The rule name and no body. |
| `conversation.flagged_pattern` | `internal` | `pattern` | 100% | A structural pattern fired. The pattern name only, never content and never a confidence value. |

**Message text is not an event field, on any of these.** The per-conversation
aggregates that §3.9–§3.11 need — participants who both spoke, inter-message
gaps, conversation age — come from the `conversation.activity` rollup
Communication already publishes for Trust & Safety, not from this sink. That is
why `conversationId` is a forbidden property here: the analytics sink holds
counts, and the one place a conversation is a key is the place that already
builds it from counts, hashes and timings.

#### Notifications (Platform)

| Event | Class | Dimensions | Rate | What it counts |
|-------|-------|-----------|------|----------------|
| `notification.delivered` | `internal` | `channel`, `category`, `critical` | 25% | A notice left the platform. Counts, not recipients. |
| `notification.suppressed` | `internal` | `channel`, `category`, `suppression_reason` | 100% | A notice was deliberately not sent, and why. |
| `notification.failed` | `internal` | `channel`, `category`, `retry_count_bucket` | 25% | Every channel for a notice exhausted its retries. An undelivered critical notice is an incident, not a metric. |

`delivered` rather than `dispatched`: the platform can observe that it handed a
notice to an adapter, and cannot observe whether the provider accepted it. A name
that claims otherwise is a name somebody will build a false alert on.

`suppression_reason` is a closed four-value vocabulary, one per fact, and the
fourth is the one that matters:

| Reason | Means | Should a product team be able to change it? |
|--------|-------|--------------------------------------------|
| `channel_muted` | The recipient has not switched this channel on for this category | Yes — it is a preference, and a rise on one category is usually a new default rather than a bug |
| `channel_unavailable` | The account has no such channel | No — it is a fact about the account's registered channels |
| `block_separation` | A block edge exists between the recipient and the other person | **No, ever.** This is a safety control, and a suppression rate that moves here is a signal about the product's blocking, not about anyone's preferences |
| `duplicate` | The idempotency key was already claimed | No — a working system has a non-zero rate |

`quiet_hours` is deliberately **not** on that list. A notice inside quiet hours is
deferred, not dropped, so a "we held your message" fact would need its own event
rather than borrowing the vocabulary of a suppression — which is the whole
distinction between the two and the reason a dashboard can trust the first row.

There is no `notification.duplicate_prevented` event, and its absence is not a
gap. A duplicate is a suppression with `suppression_reason = 'duplicate'`, and
the rate a *working* system shows is **non-zero**: retries, redeliveries and
double taps are the mechanism working, not a fault. An exactly-zero duplicate rate
means the key is not being claimed at all.

#### Platform health and integrations

| Event | Class | Dimensions | Rate | What it counts |
|-------|-------|-----------|------|----------------|
| `slo.error_budget_exhausted` | `internal` | `slo_name`, `window` | 100% | A service burned its error budget for the window. |
| `alert.fired` | `internal` | `alert_name`, `severity` | 100% | An alert transitioned to firing. The counter every runbook starts from. |
| `provider.verification_call` | `internal` | `provider`, `outcome`, `latency_bucket` | 100% | A verification provider call completed. The outcome and a latency bucket, never the payload. |
| `integration.call_failed` | `internal` | `provider`, `operation`, `failure` | 100% | A vendor call failed at the seam, with the uniform failure kind. |
| `integration.call_failed` also covers the alert set's "dependency failed" | | | | There is no separate `dependency.failed`: an external dependency failing and a vendor call failing are one event, and two names for one fact is how a dashboard ends up counting half of it. |

#### Safety counters

| Event | Class | Dimensions | Rate | What it counts |
|-------|-------|-----------|------|----------------|
| `risk.assessed` | `internal` | `state`, `detector_count_bucket` | 100% | A risk evaluation completed for the window. The state and a detector count, never a raw score. |

This is the only safety fact in the sink, and it is a snapshot rather than a
record: an aggregate state distribution with no subject, which is what the
risk-shift alert in §5.2 needs and the one thing about risk that a metrics sink
may hold. Every other safety fact — reports, cases, blocks, enforcement, appeals —
is §2.2, and reaches the audit log and nowhere else.

### 2.2 The indexed domain stream

Published by the owning domain, routed by `routeEvent()`. **None of these is a
metrics input.** They are listed because the metrics in §3 are computed from
them — in the audit log, which is the only store that holds a subject — and
because a name that is not in either table does not exist.

The names below are the names the packages publish. Several of them were wrong
in earlier drafts of this document, which is the same defect as a dead entry in
an allowlist: an identifier that looks like a published event and is not one
survives a name-only diff whenever its spelling happens to match something else.

#### Identity (Identity)

| Event | Class on the bus | Sink | Emitted when |
|-------|-----------------|------|--------------|
| `identity.status_changed` | `public` | **audit only** | The subject's identity state moved. The public projection and nothing else. |
| `verification.attempt.started` | `internal` | audit or analytics | An attempt was opened. |
| `verification.attempt.completed` | `internal` | audit or analytics | An attempt resolved, with a decision **label** and a confidence **band** — never a score. |
| `verification.re_verification.requested` | `internal` | audit or analytics | A re-verification was authorised, by Trust & Safety or Moderation. |
| `verification.review.proposed` | `sensitive` | audit only | Evidence supports a human review. |
| `verification.anomaly` | `sensitive` | **audit only** | Identity evidence is internally inconsistent. Findings as codes and counts only. |
| `verification.evidence.accessed` | `restricted` | audit only | Evidence was read, granted or denied. |

Three rules the metric definitions in §3 depend on:

- **The identity state is a dimension, not a separate event.** `verified` /
  `verification_failed` / `review_required` / `expired` are the decision label and
  state on `verification.attempt.completed`. Deriving the funnel from one emission
  rather than two is what keeps a completion rate from double-counting.
- **A band, never a score.** A score in the warehouse is a score in a breach, and
  it is also a per-user value that would identify anyone holding the model.
- **The product stream is not the metrics stream.** `identity.status_changed` is
  what Dating Core and Discovery subscribe to, and it is `audit: true,
  analytics: false` in the router. Subscribing analytics to it to "simplify" the
  funnel would put identity state and its timings into a pipeline that has no need
  for them.

#### Dating Core

| Event | Class on the bus | Sink | Emitted when |
|-------|-----------------|------|--------------|
| `profile.completed` | `public` | audit or analytics | A profile became complete. |
| `profile.deleted` | `public` | audit or analytics | A profile was removed. |
| `preferences.updated` | `user` | analytics | A preference record was written. Values are published on the bus; the sink receives axis **names** only. |
| `like.recorded` | `user` | analytics | A like is written for the first time. Not on a duplicate or a retry. |
| `like.withdrawn` | `user` | analytics | A like was withdrawn — superseded, blocked, or unmatched. |
| `pass.recorded` | `user` | analytics | A pass was written. |
| `match.created` | `public` | audit or analytics | Exactly once per match episode. |
| `unmatch.performed` | `internal` | analytics | An **actor-initiated** unmatch was accepted. |
| `match.ended` | `internal` | analytics | A match stopped being usable, for any reason. |
| `block.created` | `internal` | analytics | A block edge was created. |
| `block.released` | `internal` | analytics | A block edge was lifted. |

Two properties this table is load-bearing for:

- **`match.created` is emitted once per match episode** and `like.recorded`
  carries the like's own outcome, so the match rate is computable without a join
  and a double tap cannot inflate the funnel.
- **`unmatch.performed` is the only actor-initiated end.** A match ended by a
  block, a deletion, or a moderator emits `match.ended` and not
  `unmatch.performed`, which is what lets the safety metrics separate "a person
  chose this" from "the platform or a block did".

The block stream is `block.created` / `block.released`, not a single
`block.created` / `block.released`: a lifted block is a fact a safety reviewer asks about, and an
edge-shaped pair of events is the only way to answer "how many blocks are lifted"
without a diff.

#### Communication

| Event | Class on the bus | Sink | Emitted when |
|-------|-----------------|------|--------------|
| `communication.message_sent` | `internal` | **neither** | A message was accepted. Metadata only, and named in `CONTENT_BEARING_TYPES`: the highest-volume stream about what people said to each other does not reach either sink. |
| `communication.conversation_state_changed` | `internal` | audit | A conversation moved between lifecycle states, by user action or by case. |
| `communication.friction_applied` | `internal` | audit | A rate rule answered. Pressure is observable; nothing was judged. |
| `communication.evidence_captured` | `restricted` | audit | A scoped evidence view was produced for a recorded case. |

#### Trust & Safety and Moderation

| Event | Class on the bus | Sink | Emitted when |
|-------|-----------------|------|--------------|
| `risk.changed` | `internal` | **audit only** | The risk machine transitioned. |
| `review_candidate.raised` | `internal` | audit or analytics | A detector produced something for a human to look at. |
| `friction.proposed` | `internal` | audit or analytics | Reversible friction was proposed. |
| `moderation.report_submitted` | `restricted` | **audit only** | A report was filed. |
| `moderation.report_status_changed` | `restricted` | audit only | A report's triage status moved. |
| `moderation.case_opened` / `.case_assigned` / `.case_escalated` / `.case_reports_merged` | `restricted` | audit only | Case lifecycle. |
| `moderation.case_resolved` | `restricted` | audit only | A case closed, with an outcome. |
| `moderation.evidence_captured` / `.evidence_read` | `restricted` | audit only | Evidence was captured or read. |
| `moderation.decision_recorded` / `.decision_reversed` | `restricted` | audit only | A decision was recorded or reversed. |
| `moderation.restriction_applied` | `user` | audit or analytics | Capabilities were removed, with the case reference, the decision, and the standing it produced. |
| `moderation.restriction_lifted` | `user` | audit or analytics | A restriction was lifted. |
| `account_state.changed` | `public` | **audit only** | The account machine transitioned. Carries the new standing, the effective capabilities, and the removed set — and deliberately **not** a case id, because a case reference on a `public` event tells any consumer which case a named person is in. |

`moderation.restriction_applied` is the event the enforcement notifications are
triggered by, and the reason it is a `user`-clearance event in its own right: the
restricted user is entitled to the case reference that decides their case, and
that is a fact about them, not about anyone else.

## 3. Metric definitions

Conventions: the unit of analysis is the **user** unless stated. All rates are
computed per calendar week, UTC, on events that have been in the warehouse for
at least 24 h (`occurredAt` based, not ingest based — a funnel that shifts when
the pipeline shifts is not a funnel). Percentages are shown to one decimal.

The rates that are easy to get wrong are marked **[denominator trap]**.

**Where each metric is computed**, because the answer decides which store it can
be computed from. A metric whose unit of analysis is a *count* is a §2.1 sink
series. A metric that has to identify a person — a report filed, a case opened, a
case closed, a block — is **not** computable from analytics at all:
`ANALYTICS_FORBIDDEN_PROPERTIES` refuses `caseId`, `reportId` and `conversationId`
to the sink, and that refusal is the design. Those metrics are computed from the
**audit log** at whatever clearance the review requires, and the analytics sink
holds only the anonymous counters that make their shape visible. Each metric below
names its store; a metric that does not is a metric nobody has built.

### 3.1 Verification completion rate

- **Formula:** `users whose verification reached 'verified' ÷ users who started a verification attempt`
- **Numerator:** distinct `userId` with `verification.attempt.completed` whose decision label is `verified`, within the window.
- **Denominator:** distinct `userId` with `verification.attempt.started` in the same window, **plus** any attempt still open from the previous 3 days, so in-flight verifications are not counted as failures.
- **[denominator trap]** The naive denominator — "failed ÷ started" — silently converts every slow verification into a failure and will report a completion rate that swings with provider latency rather than with user behaviour. A cohort view (attempt started in week *W*, outcome resolved by *W+7d*) is the version to use for anything that goes on a slide.
- **Pitfalls:** a `review_required` outcome counts as *not yet verified*, not as failed; a user who retries is one denominator entry and can be many numerator entries, so dedupe by user; excluding users who never began an attempt measures nothing. The window is counted from `verification.attempt.*`, never from `identity.status_changed` — see §2.2.

### 3.2 Verification false-reject rate

- **Formula:** `users whose attempt was labelled 'verification_failed' and who later reached 'verified' within 30 days ÷ users whose attempt was labelled 'verification_failed'`
- **Denominator:** distinct users with a `verification_failed` decision label in the window.
- **Rationale for the 30-day lag:** a false reject that the user retries and passes is only observable as a false reject once the retry lands. Measuring at 0 days measures nothing.
- **Pitfalls:** this is a *lower bound* on the false-reject rate — a user who gives up and never returns is invisible to it. Pair it with a support-ticket rate on verification and with the appeal rate (§3.12). Reject-and-appeal is the observable path: appeals are the sampling frame for manual review, and the reviewed sample is where the true rate is estimated.

### 3.3 Fraudulent profiles passing verification

- **Formula:** `confirmed-fraudulent users who reached 'verified' ÷ users who reached 'verified'`
- **Store:** audit log (a `moderation.case_resolved` with a subject); the denominator's `verification.attempt.completed` series is in the sink.
- **Numerator:** users with a `confirmed_fraudulent` moderator finding, i.e. a `moderation.case_resolved` with outcome `banned` or `suspended` on fraud grounds, at any time **after** the verification event, attributed back to the verification cohort.
- **Denominator:** distinct users with `verification.attempt.completed` labelled `verified` in the cohort window.
- **[denominator trap]** The denominator is *all verified users*, not the moderated subset. Using "fraudulent profiles among reviewed cases" measures the review queue's composition, not the product's failure rate.
- **Pitfalls:** outcome-based, so it has a long tail and a small numerator — report it as a rate with a confidence interval and a minimum-count gate, never as a bare percentage. A sudden drop is as meaningful as a rise: it usually means moderation stopped, not that fraud stopped. It is also the metric most vulnerable to a loophole, so it is paired with the primary metric in §3.6.

### 3.4 Reports per 1,000 conversations

- **Formula:** `distinct moderation.report_submitted ÷ distinct conversation.created × 1000`
- **Store:** the numerator is a `moderation.report_submitted` in the **audit log**; the denominator is the `conversation.created` sink counter. The two are joined in analysis, not in the sink.
- **Denominator:** conversations created in the same window, **excluding conversations that a block later invalidated** (per [Privacy & User Settings §5.1](./privacy-and-user-settings.md)), so that a block spike does not deflate the rate.
- **Pitfalls:** one user filing five reports about one person is one numerator unit; dedupe by `(reporterId, subjectId)` per window and count the excess separately as `repeat_reporter` — that is itself a signal (a target being hammered, or a reporter misusing the form). Reports about *messages* and reports about *profiles* have different base rates and are reported separately, not summed.

### 3.5 Blocks per 1,000 conversations

- **Formula:** `distinct block.created ÷ distinct conversation.created × 1000`
- **Store:** both are sink series. A block edge carries no case and no report, which is what makes it a disclosure-free safety action and also what lets it be counted anonymously.
- **Denominator:** as §3.4.
- **Pitfalls:** a block is a *disclosure-free* safety action, so a rising block rate is often a rising trust signal rather than a rising harassment rate — it can mean users feel safe enough to act. It must be read with §3.9: blocks rising while reports stay flat is the expected shape of a healthy block feature. The number to alert on is the **block-to-report ratio**, because a low ratio means users are preferring conversation to disengagement.

### 3.6 High-risk behaviour detected before first report — **the primary safety metric**

- **Formula:** `users whose risk machine first reached 'high' or 'critical' before any `moderation.report_submitted` named them ÷ users who became a confirmed malicious account`
- **Store:** **audit log** for all three inputs. This is the primary safety metric and every one of its terms needs a subject, which is precisely why the sink may not hold it.
- **Denominator:** users with a confirmed malicious finding (`moderation.case_resolved` → `banned`, or `suspended` with a repeat-offence finding) in the window.
- **Numerator:** those users for whom there exists a `risk.changed` with `to ∈ {'high','critical'}` whose `occurredAt` is **earlier** than the first `moderation.report_submitted` naming them — or, for undetected-by-report cases, earlier than the `moderation.case_opened` that led to the finding. When both exist, the earlier of the two wins.
- **[denominator trap]** The denominator is **confirmed malicious accounts**, not all users. "Percentage of high-risk behaviour detected before first report" over an all-user denominator is a meaningless small number, and it is the single most common way this metric is misreported.
- **[denominator trap]** The numerator must exclude the moderator who opened the case from the detection path. A case opened *because* a human read the reports is not proactive detection.
- **Pitfalls:** `risk.changed` ordering must use `occurredAt`, not ingest time, or a late-arriving signal will be scored as a miss; a user with two `high` episodes is one unit; and because a confirmed-malicious cohort is small, report this with a cohort size and a Wilson interval, and treat a single-week move as noise.
- **Known limitation, stated because it will otherwise be discovered later:** this metric can only be computed for accounts that were *eventually confirmed malicious*, so it cannot measure a class of harm that moderation never caught. It is a lagging indicator by construction and must never be the trigger for a safety change on its own.

### 3.7 Moderator cases per 1,000 users

- **Formula:** `distinct moderation.case_opened ÷ distinct account.registration_completed × 1000`
- **Store:** the numerator is a `moderation.case_opened` in the **audit log**; the denominator is the `account.registration_completed` sink counter.
- **Denominator:** users created in the same window, all states, including `banned`. The alternative denominator (active users only) makes the rate fall every time enforcement works, which is the wrong direction.
- **Pitfalls:** a case opened on a report and a case opened on a risk escalation are different work; `moderation.case_opened` carries an `origin` and the two rates are reported side by side. It also counts cases later closed as `cleared`, which is intended — moderator time is spent either way.

### 3.8 Median moderation resolution time

- **Formula:** `median(moderation.case_resolved.occurredAt − moderation.case_opened.occurredAt)`
- **Store:** **audit log**, joined on `caseId`. A sink that could be sliced by case
  could be sliced by person, which is the one query this document exists to
  prevent.
- **Denominator:** cases **resolved** in the window. Cases still open are excluded from the median and reported separately as the open-case count and the oldest-open-case age — a median over resolved cases alone will look excellent on the day a backlog is being ignored.
- **Pitfalls:** report the **p90 and p99 alongside the median**; a safety queue with a healthy median and a p99 of nine days is an unattended queue. Report by `origin` and by `priority` separately. Resolution time for a case that waits on the user (an appeal requiring information) is time the moderator is not spending, and excluding it is the difference between a queue metric and a service metric.
- **SLO link:** this metric has a target, not just a definition — median ≤ 24 h, p90 ≤ 72 h (§5.1).

### 3.9 Match → first-message rate

- **Formula:** `matches where the first message was sent by either party within 24 h ÷ all matches created in the window × 100`
- **Store:** `match.created` and the `message.recorded` sink counters give the shape; the *per-match* first-message fact comes from the `conversation.activity` rollup, which Communication builds for Trust & Safety and which the sink may not rebuild because a conversation is a key.
- **[denominator trap]** The denominator is **all matches**, not "matches whose counterpart is still active". Filtering the denominator to active users inflates the rate exactly when the product is doing well, because the matches most likely to go quiet are with newly-signed-up users.
- **[denominator trap]** The 24-hour window is measured from `match.created` to the **first** `message.recorded` in the conversation, and the numerator counts a match once regardless of who spoke first. Two of these — "who spoke first" and "did anyone speak" — are separate metrics and get reported separately.
- **Pitfalls:** exclude a match from the numerator only when the counterpart was, at match time, `limited` in `send_message` — the silence is the platform's doing, not the user's.

### 3.10 Conversations with replies from both users

- **Formula:** `conversations with ≥1 message.recorded from each participant ÷ all conversation.created in the window × 100`
- **Store:** sink counters for the denominator, the `conversation.activity` rollup for the per-conversation numerator.
- **Denominator:** all conversations, including ones with zero messages. A conversation is created at match time, so this is well-defined and the denominator does not depend on the outcome being measured.
- **Pitfalls:** the message can be a single character and still counts — there is no quality bar in v0.1 and inventing one turns a participation metric into an opinion; conversations where one party has since been blocked stay in the denominator, because removing them after the fact is exactly the selection effect that makes blocks and reports look better than they are.

### 3.11 7-day and 30-day retention

- **Formula (7d):** `users with a qualifying session in [signup + 7d, signup + 7d + 1d) ÷ users created in the cohort window × 100`
- **Formula (30d):** `users with a qualifying session in [signup + 30d, signup + 30d + 1d) ÷ cohort users × 100`
- **Qualifying session:** any of `discovery.entered`, `conversation.created`, or `message.recorded` — an app open that leads to no interaction does not count, because a retention number that a push-notification tap can move is a notification metric.
- **[denominator trap]** Cohorts are by `account.registration_completed`, and the denominator is the **full cohort**, with no survival filtering. Users who deleted their account remain in the denominator. This makes deletion suppress retention, which is correct.
- **Pitfalls:** the 30-day window is unmeasurable for the most recent 30 days of cohorts and must be plotted with a lag marker, or every chart will show a cliff that is a reporting artefact; a deleted-then-recreated account is one new user, so a user who churns and returns is double-counted as a re-acquisition and must be tagged.

### 3.12 Support metrics

Not in issue #1's list, but required to interpret the list: the `settings.updated`
rate, the notification opt-out rate per kind (a support signal, not a preference
metric), the **appeal rate** as a proxy for disagreement, and the `repeat_reporter`
count. The appeal rate is the early-warning indicator for a false-positive
regression, and it moves days before the outcome metrics do.

**There is no `moderation.appealed` event, and the appeal rate does not need
one.** An appeal is a case, and `moderation.case_opened` carries the `origin` that
distinguishes it from a report or a risk escalation. An event named after the
*action* rather than the case would be a second name for one fact, and it would
have been an event with no emitter for as long as the appeal flow did not exist —
which is exactly the shape of promise the bus does not keep. The rate is
`count(moderation.case_opened where origin = 'appeal')` from the audit log, and it
is the earliest signal in the set.

## 4. Idempotency and reliability of critical actions

**The invariant:** a critical action either happened exactly once or did not happen, and the user can always tell which. No critical action is ever "maybe".

**Mechanism, common to all five:** the client generates a `clientRequestId` (a UUID) per user intent and sends it with the command. The owning domain stores `(action, subjectKey, clientRequestId)` with a unique constraint and returns the **original result** on replay, not a new one. Retries are therefore free and idempotent by construction, and a user hammering a button cannot double-apply anything. Server-side keys below are for the case where the client request id is lost (a retried job, a replayed event, a duplicate delivery from the bus).

| Action | Idempotency key | Retained | Retry policy | Partial failure UX |
|--------|-----------------|----------|---------------|--------------------|
| Like (row 1) | `like:{likerUserId}:{targetUserId}` — natural key, one like per pair per direction; `clientRequestId` dedupes retries of the same tap | 90 days | Client retries up to 3 times on `retryable` errors with backoff 1s/4s/16s. `validation_failed` and `permission_denied` are **not** retried | Optimistic UI; on failure the card reverts and shows "Couldn't send that — try again". Because the key is the pair, a retry after a lost response cannot create a second like, and a like that succeeded while the response was lost is confirmed on the next feed refresh rather than shown as an error |
| Match creation (row 2) | `match:{min(likerUserId,targetUserId)}:{max(...)}` — a match is a property of the pair, so the key is the sorted pair. Not `match:{matchId}`: a retried mutual-like must find the existing match | Life of the match | Same as like; a match is created transactionally with the second `like` write, so a failure rolls both back | The liker sees the match appear on the next session with no duplicate. A like that did not produce a match is indistinguishable from a like on a non-reciprocating profile |
| Account deletion (row 3) | `deletion:{accountId}:{clientRequestId}` — a user may delete, be restored, and delete again, so the key includes the request id, not a bare user id | Life of the anonymised account row | Non-retryable from the client: a repeated request returns the **existing** deletion request and the same completion date rather than starting a second 30-day window. The job itself retries with backoff 1m/10m/1h/6h and is resumable from its last completed step | The UI shows "Deletion scheduled — you can restore until {date}" and the same text on every repeat press. During the 30-day undo window the account is hidden from discovery and messaging by definition, so a half-applied deletion has no product meaning to explain. A failure after the window shows a specific, non-retryable message plus the reporting route, because the account no longer exists to retry from ([Account & Onboarding](./account-and-onboarding.md) §8.1) |
| Report submission (row 4) | `report:{reporterUserId}:{subjectUserId}:{interactionRef}:{clientRequestId}`, with a 24 h dedupe window on the first three components | Evidence retention period | Client retries up to 3 times, same key | The UI shows a deterministic receipt: "Report received — reference {reportRef}". A press of send after success returns the same reference, never a second report and never an error. This is the action where a false "we didn't get your report" is most damaging, because the user will believe nothing happened and stop trying |
| Restriction application (row 5) | `restriction:{caseId}:{subjectUserId}:{capability}` | Life of the case record | Non-retryable from any client — there is no client. Moderation's service retries with backoff 1m/10m/1h/6h, and the guard on the account machine (`caseId` + non-empty `removedCapabilities`) is the second line of defence | The account state change and the case record commit in **one transaction**; a failure rolls both back and retries. The notification is dispatched separately and independently — if the push fails, the in-app record and the account state are still correct, and an undelivered critical notice raises an alert rather than rolling back an enforcement action. A user never sees "restricted" without the case reference, and a case never exists without the restriction |

### 4.1 Rules that apply to all five

- **`retryable` is declared, not inferred.** The `DomainError` from
  `packages/core` carries a `retryable` flag. Only errors that set it are
  retried. Everything else surfaces immediately with a specific message, because
  a retried non-retryable error is a silent duplicate.
- **Retries never re-evaluate a decision.** A retried restriction application does not re-run detection or re-open a case; a retried report does not create a second case; a retried like does not re-run eligibility. The decision was made on the first attempt and is replayed.
- **The client never sees a bare failure.** Every terminal failure maps to one of: a specific user-facing error, or a receipt saying the action is in progress. "Something went wrong" is not an acceptable outcome for a critical action, because the only safe response to it is "press it again".
- **Bounded exposure of an in-flight action.** While a restriction or a deletion is pending, the user is in an explicit `*_pending` state whose product behaviour is defined (not in discovery, not messaging), so a half-applied enforcement action has no product meaning.
- **Every critical action emits an event even on replay.** The accounting is the same shape for all five: an idempotent replay is observable in the health metrics, so a client stuck in a retry loop is visible in the dashboard rather than only in the logs. For notifications that is a `notification.suppressed` with `suppression_reason = 'duplicate'`; for the other four it is the domain's own replay counter.

## 5. Product health

### 5.1 SLOs and error-budget policy

The service is a modular monolith, so the SLOs are per user-visible action, not per service. The target is 99.9% for everything a user *acts* on and 99.5% for everything they merely *see*.

| SLO | Target | Error budget (30 d) | Notes |
|-----|--------|--------------------|-------|
| Discovery feed returned | 99.9% / p95 ≤ 500 ms | 43 min | The product's front door |
| Like accepted | 99.9% / p95 ≤ 300 ms | 43 min | Idempotent, so a partial failure is recoverable |
| Match created | 99.9% / p95 ≤ 400 ms | 43 min | Transactional with the like |
| Message sent and accepted | 99.9% / p95 ≤ 400 ms | 43 min | The user's message existing is the product's core promise |
| Block applied | 100% / p95 ≤ 300 ms | **0** | A safety action that failed is a safety failure. No budget: the write is a single indexed insert and any failure is a page, not a degradation |
| Report submitted | 99.9% / p95 ≤ 1 s | 43 min | Slower because it attaches evidence |
| Notification dispatched (critical kinds) | 99.9% within 30 s | 43 min | Slower end-to-end path; an undelivered enforcement notice is an incident |
| Verification pipeline completion | 99.5% within 5 min of `verification.attempt.started` | 3.6 h | Provider-bound, hence 99.5% not 99.9% |
| Moderation case resolution | median ≤ 24 h, p90 ≤ 72 h | n/a (a target, not a budget) | §3.8 |
| Event bus delivery | 99.99%, p95 lag ≤ 60 s | 4.3 min | Everything else is measured from these events |
| Analytics ingest loss | ≤ 0.1% of published events | n/a | Loss is measured against a per-hour published-count counter, not sampled |

**Error-budget policy.** When a service's 30-day budget is exhausted: new
feature work on that service stops; only bug fixes, safety fixes, and reliability
work ship; the on-call is paged for any SLO breach until the budget recovers.
Safety-critical paths (block, report, enforcement, notification of enforcement)
are **exempt from the freeze** — a fix to a broken block button ships during a
freeze, every time. A budget is a prioritisation tool, not a shipping ban.

### 5.2 Alert set

The principle: **a sudden move in a safety or funnel metric is a pipeline or
product failure until proven otherwise.** Specifically, a 20% relative drop in
verification completion is a broken verification pipeline, not a change in user
behaviour — real user behaviour does not move 20% in an hour, and treating the
alert as behavioural is how a real outage is misread as a product problem.

| Alert | Condition | Severity | First hypothesis |
|-------|-----------|----------|-------------------|
| Verification completion collapse | >20% relative drop vs. same-hour 7-day baseline, for 2 h | **Page** | Verification pipeline or provider failure. Check `provider.verification_call` and `integration.call_failed` first, not user sentiment |
| Verification provider error rate | >5% over 15 min | **Page** | Provider degradation |
| Block action failing | Any `block.created` write failure | **Page** | Zero budget; a broken block is a safety outage |
| Report submission failure | >2% over 15 min | **Page** | Users believe reports are being silently lost |
| Enforcement notification not delivered | Any `notification.failed` for a critical kind | **Page** | A user is being enforced against without being told |
| Message send success | <99.5% over 10 min | **Page** | Transport or database |
| Match creation error | >1% over 10 min | **Page** | Transaction failure in like/match |
| Event bus lag | p95 >5 min, or ingest loss >0.5% | **Page** | Every dashboard is now lying |
| Duplicate critical action detected | A `duplicate` suppression on an **enforcement** notification outside a retry burst, or any non-replay duplicate on like/match/restriction | **Page** | Idempotency key is wrong; a double-enforcement or double-like is in progress. A duplicate on a *message* notice is routine and is not an alert |
| Moderation queue age | Oldest open case >24 h, or p90 resolution >72 h | **Ticket → page** | Moderation capacity, not moderation policy |
| Appeal rate spike | `moderation.case_opened` with `origin = 'appeal'` above 2× the 4-week baseline over 7 days | **Ticket** | Likely a false-positive regression; a leading indicator of the outcome metrics. Read from the audit log, where every appeal is a case |
| Block rate spike | >3× 4-week baseline over 24 h | **Ticket** | Either a real harm wave, or a false-positive enforcement wave making users block instead of report. Check against reports and risk before concluding |
| Risk-state distribution shift | Share of users at `high` or `critical` moves >50% relative in 24 h | **Ticket** | A detector changed, or a detector's input broke. This is the metric that catches a silent detector regression |
| `discovery.exhausted` spike | >10% of sessions for 1 h | **Ticket** | Eligibility filters or identity expiry, not a lack of users. A sudden rise usually means `verified` users stopped being discoverable |
| Profile completion drop | >20% relative vs. 7-day baseline | **Ticket** | Onboarding regression or a broken field |

Two structural rules: alerts are on **rates and relative changes**, never on
absolute volumes, because volume grows and a volume alert fires on the best day
in the product's history; and every safety alert names the hypothesis to check
first, because "the safety metric moved" without a first hypothesis produces
thirty minutes of nothing.

### 5.3 Dashboards

| Dashboard | Contents | Audience |
|-----------|----------|----------|
| **Onboarding funnel** | `account.app_opened` → `account.registration_started` → `account.registration_completed` → `account.onboarding_step_completed` (`step = age_gate`) → `verification.attempt.started` → `verification.attempt.completed` (state `passed`) → `profile.published` → first `discovery.entered`, with step-to-step conversion, `account.registration_rejected` broken out by `reason_code`, median time between steps, and the 7-day-baseline overlay | Product |
| **Dating funnel** | `discovery.entered` → `discovery.page_served` → `like.recorded` → `match.created` → `message.recorded` → `message.read`, plus match→first-message rate and both-sided-reply rate, split by signup cohort | Product |
| **Safety** | §3.3–§3.6 primary metrics with cohort sizes and intervals, the block-to-report ratio, the risk-state distribution, `safety.high_risk_before_first_report` with its cohort size, and the appeal rate | Safety, product |
| **Moderation ops** | Open case count by `origin` and priority, median/p90/p99 resolution time, outcome mix, the `account_state.changed` volume, and moderator throughput per case type | Moderation |
| **Reliability** | All SLOs with error-budget burn rate, idempotency replay counts, partial-failure counts, and the alert history | Engineering |
| **Notification health** | Delivery success and latency by kind and channel, `notification.suppressed` by reason including `duplicate`, and `notification.failed` | Product, engineering |
| **Privacy audit** | Reads of `sensitive` fields, cross-clearance delivery refusals, and a count of notification bodies whose bound fields exceed `public` | Engineering, safety |

The privacy audit dashboard is not optional. It is the operational expression of
commitments 5 and 7, and it is what makes a privacy regression visible as a
number rather than as a screenshot.

## 6. Analytics data minimisation

Analytics is write-only for every domain, and it is the one place where the
sensitivity model is easiest to violate by accident, because an event payload is
a convenient place to put a field that is "just this once".

### 6.1 What may be aggregated

- Counts and rates, per event, per cohort, per outcome, per day.
- `public`-class values: coarse distance **band**, five-year age band, `verified`
  badge, capability names, account state, identity state, risk state, detector
  name **set** (not scores), case `origin`, case `outcome`.
- Latency histograms, status codes, error codes.
- Notification `kind`, channel, and suppression reason.
- Whether an action was a first occurrence, a retry, or an idempotent replay.

### 6.2 What may never be sent

| Never in analytics | Why |
|--------------------|-----|
| Exact latitude or longitude, or any value from which one can be derived (a rounded coordinate, a city + timestamp, a band + a time) | Commitment 5; a coarse band in a time series is a track |
| Selfie, liveness, or any biometric artefact | `sensitive`; identity evidence stays in Identity |
| Verification provider responses, likeness scores, provider-internal reason codes | `sensitive`; a score in a warehouse is a score in a breach |
| Message text, message links, message media, message length in characters (bucket only) | The highest-sensitivity content in the product; a length histogram is the most we need |
| Bio, display name, email address, phone number, date of birth, occupation, education | `user`-class identity content |
| Report evidence, reporter identity, moderator notes, case notes, audit records | `restricted`, moderation role only |
| Raw risk scores, model versions' output weights, or an individual detector's signal value | `internal`; a score identifies a user to anyone holding the model |
| Any counterparty reference in a context that is not a `public` relationship (an unmatched like, a discovery impression) | Re-identification through co-occurrence |
| IP addresses, device fingerprints, advertising IDs, precise timestamps below the hour | Re-identification |

**Enforcement, not convention:** the analytics sink has a field allowlist per
event type, and ingestion **rejects** an event carrying a field that is not on the
list, dropping it to a quarantine topic with an alert. An allowlist that warns is
an allowlist that will be exceeded at 2 a.m. The `sensitive` and `restricted`
classes are not on any allowlist, which means a domain cannot export evidence by
accident even if it wanted to.

### 6.3 Sampling policy

**The rate is a column in §2.1, not a decision made at a call site.**
`AnalyticsEventSpec.sampleRate` holds it, `recordAnalyticsEvent` reads it from
there, and there is no parameter a caller can pass. That is the whole rule, and it
is enforced rather than described: a rate chosen per call site is a per-site
decision that drifts the moment two services disagree about it, and a rate that
drifts silently changes a metric's denominator — which is the one thing §3's
denominator discipline is for.

Three rates exist, and the reasons are the only three reasons any event should
ever be sampled:

| Rate | Events | Why |
|------|--------|-----|
| **100%** | Everything else, including every funnel step and every safety counter | A sampled funnel step makes every downstream rate a biased estimate, and a sampled safety counter makes the safety metrics wrong. The sample size is already small. |
| **10%** | `discovery.page_served` | The one genuinely high-volume event: ten cards per request. Ten per cent of it extrapolates to the population. |
| **25%** | `notification.delivered`, `notification.failed` | Volume scales with messages. `notification.suppressed` stays at 100% because it is a support signal, not a volume signal: a suspiciously high suppression rate on a category is more likely a bug than a preference, and a sampled bug is a bug nobody sees. |

**What the sample is keyed on: the correlation id.** `isSampled` hashes the
`correlationId` and nothing else, and that is a constraint rather than a shortcut
— `userId` and `sessionId` are both on `ANALYTICS_FORBIDDEN_PROPERTIES`, so a
hash over either is not merely unwise, it is unconstructible. It also would have
been the wrong thing if it were: sampling keyed on a user id makes the sample a
function of *who the user is*, which is a per-user sampling decision wearing a
uniform's clothes and biases any per-cohort rate built from it. Hashing the
correlation id keeps the sample unbiased across users and time, so a 10% sample
scales to the full population rather than skewing toward whoever arrives first.
The consequence to accept is that a retried publish of the same fact lands on the
same side of the rate, which is what stops it double-counting.

Any rate computed from a sampled event carries a weighting factor, and the
dashboard says "sampled" on the tile.

### 6.4 Retention

- Funnel and health aggregates: 25 months, in rollup form only.
- Safety events: retained for the evidence retention period, then deleted; the
  count is preserved as an aggregate so the historical rate stays computable
  after the rows are gone. Deleting evidence without preserving the *rate* would
  create a fake drop in §3.4–§3.6.
- Raw `discovery.page_served` rows: 30 days, then only the rollups.
- Deleting a user removes their rows from every class, and the aggregates are
  recomputed for the affected windows — the cost of getting deletion right is
  bounded by a weekly recompute, which is why the aggregates are derived rather
  than maintained.

## 7. Measurement plan

### 7.1 Instrumented before launch (the gate)

The MVP does not launch with a partial event set. A missing denominator is a
missing metric, and a missing metric cannot be reconstructed after launch.

1. Every event in §2 is emitted by its domain, verified by a contract test that
   asserts the emit happens on the named transition.
2. The analytics sink's allowlist (§6.2) is configured and the quarantine alert
   fires on a deliberately malformed test event.
3. Each of the eleven metrics in issue #1's list (§3.1–§3.11) is computed in a
   query and reviewed by a human against hand-counted ground truth from a
   staging dataset. A metric nobody has checked against the truth is a guess
   with a chart.
4. All seven dashboards in §5.3 are live, with cohort sizes and sampling labels
   visible on every tile.
5. All alerts in §5.2 have been fired at least once against a synthetic
   condition, and each routes to a named human within the stated time.
6. Idempotency (§4) is proven by a test that replays each of the five commands
   and asserts a single effect; a duplicate-effect bug found in staging is worth
   more than a week of post-launch instrumentation.
7. `sensitive`-field access logging is on, and the privacy audit dashboard has
   data in it.

### 7.2 Reviewed weekly

| Review | Content | Decision it can change |
|--------|---------|------------------------|
| Onboarding funnel (30 min) | Step conversion, median time per step, the 7-day overlay, verification completion, and `discovery.exhausted` | Whether a step is a product problem or a copy problem; whether the 18+ gate or the profile form is the drop; whether verification needs a retry affordance. **Can** change the onboarding flow and the verification prompt |
| Dating funnel (30 min) | Like rate, match rate, match→first-message, both-sided replies, by cohort | Whether discovery is showing the right people, whether a nudge to message a match is warranted, whether the candidate ordering needs work. **Can** change discovery ordering and the match celebration |
| Safety (45 min, with Trust & Safety and Moderation) | The primary metric §3.6 with cohort size, reports and blocks per 1,000, block-to-report ratio, the block of restricted accounts, appeal rate, the risk distribution, and moderator resolution times | Whether a detector is firing too often or too little; whether a restriction is too broad or too narrow; whether moderator capacity needs to change; whether `k`-anonymity or band widths are exposing anyone. **Can** change detector thresholds, capability definitions, moderator staffing, and location privacy parameters |
| Reliability (30 min, engineering) | SLOs and burn rate, idempotency replays and duplicates, partial failures, alert history, notification delivery | Whether a critical action needs a stronger retry or a different partial-failure UX; whether a budget freeze is in force. **Can** change the idempotency keys, the retry policy, and the release freeze |
| Product quality summary (written, 1 page) | The eleven metrics with their denominators, trends with confidence intervals, and every open question from §8 that the data can now answer | The roadmap. **Can** change what is built next, and it is the only artefact that changes priorities |

### 7.3 What the data may not be used for

- **No automated enforcement from a metric.** A metric that crosses a threshold
  may page a human or open a case for a human to look at. It may never move an
  account state. This is commitment 2 and the single most important line in this
  document: "detected before first report" is a metric about the *platform*, and
  an account that a metric decides to restrict without a case and a moderator
  would make the product exactly the thing it exists to avoid.
- **No per-user experimentation on safety-critical paths.** A/B testing
  enforcement copy or verification thresholds on a small cohort means a small
  cohort is enforced against under an unreviewed rule. Funnel copy and discovery
  ordering are testable; verification and enforcement are not, in v0.1.
- **No metric that cannot name its denominator goes on a slide.** If the
  denominator is unclear, the metric is not ready to be looked at.

## 8. Open questions

- Warehouse and analytics vendor. The allowlist/quarantine model in §6.2 is
  vendor-neutral but assumes schema enforcement on ingest, which some
  warehouses lack; if the chosen warehouse cannot reject fields, the
  minimisation rule becomes procedural only and the privacy audit dashboard
  becomes the only control, which is weaker.
- The k-anonymity floor and the 12-hour distance-band window in
  [Privacy & User Settings §3.3](./privacy-and-user-settings.md) are parameters
  this document's dashboards are meant to inform. Their initial values are
  drafted; the tuning needs post-launch `discovery.exhausted` and safety-review
  data, so the parameters are owned by the safety review, not by product growth.
- Whether a 25-month aggregate retention is the right answer to the "preserve the
  rate, delete the evidence" trade. It preserves historical comparability at the
  cost of a per-user identifier in an aggregate, which is a regulatory question
  and not a technical one.
- Whether moderation capacity is staffed for a `moderation.case_opened` rate that is
  2× the projected load if §3.6 shows proactive detection working. Proactive
  detection generating cases is a success that costs money, and the trigger to
  hire is not written down.
- Whether `verification.anomaly` should contribute a numerator to §3.3
  (fraudulent profiles passing verification). It would catch a class of fraud that
  currently only surfaces at moderation, but an anomaly is a signal and not a
  finding, so counting it as a pass-through failure would inflate the metric with
  false positives. Recorded rather than guessed.
- **Should `review_candidate.raised` and `friction.proposed` be audit-only?**
  Trust & Safety publishes both at `internal`, and neither is on the
  audit-required list, so both currently reach the metrics sink. That is
  defensible — a detector's output volume is a health metric, and the payloads
  are proposals rather than decisions — but it is also the only place a safety
  domain's outward stream is not audit-only, and the exception was made by
  omission rather than by decision. It needs to be one or the other on purpose.
  Not changed here: Trust & Safety's own document owns the claim, and this
  document does not get to make that call for it.
- **What is the source for the privacy-audit dashboard's "reads of `sensitive`
  fields"?** The audit log covers `restricted` and below; a read of a `sensitive`
  field by a moderator is logged as an audit action, but the *count* the
  dashboard needs has no §2.1 name, and inventing one would put a read counter in
  a sink that is not allowed to know who read. Likely a service-side metric
  rather than a sink event, which is why it is written down instead of guessed.
- Whether `blocked` is a reportable outcome in its own right in §3.4. The
  overview commits to safety being structural, and a block is disclosure-free
  disengagement rather than a harm claim, so the two are counted separately.
  Changing that changes a headline number, so it needs a decision before launch
  rather than after the first quarterly review.
- **Event-name reconciliation across specs, for the integrator.** The
  architecture and feature specs currently use two different names for the
  identity status stream — `identity.status_changed` in
  [Identity & Verification](../architecture/identity-and-verification.md) and
  `identity_status.changed` in six feature documents written against the
  overview's safety-spine diagram. This index follows the architecture doc,
  since the domain that owns the emission is the one whose spelling binds. The
  feature docs are not wrong in intent, only in spelling, and a single rename
  across them is a mechanical fix — but it should be one deliberate change, not
  six drifting ones. Until it happens, a reader searching for the identity
  stream will find both names, and the analytics rule in §2.2 ("never subscribe
  the metrics sink to the identity status stream") reads as though it applies to
  a differently-named event than the one the code will use.
- Whether `account.registration_rejected` broken out by `reason_code` counts an
  `under_18` rejection as onboarding drop-off. It is a funnel exit with a
  legitimate reason and no user, so counting it as a drop depresses the
  completion rate for a reason that is neither a product defect nor user
  behaviour. Currently excluded from step conversion and reported separately.
