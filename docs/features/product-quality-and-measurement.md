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
contract for the four critical actions, and the reliability policy.

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

This is the index. `Role` is one of:

- **Funnel** — onboarding, dating, or engagement funnel step.
- **Safety** — report, block, restriction, suspension, verification failure, risk.
- **Health** — reliability and operations, never user-facing.
- **Control** — analytics instrumentation, not a product or safety fact. Kept
  separate so a control event can never be mistaken for a funnel step.

Sensitivity is the `DataSensitivity` from the overview. Note that no event in
this table is `sensitive` or `restricted`: those classes never reach analytics.
`verification.anomaly` is published on the bus at `sensitive` for Identity and
Trust & Safety, and the analytics projection of it (`safety.verification_anomaly`)
carries only the fact of an anomaly, never the evidence.

### 2.1 Account & onboarding (Platform)

Adopted verbatim from [Account & Onboarding](./account-and-onboarding.md) §11,
which owns this catalogue. The names here are the same names; this table exists
so the index is complete, and it is a copy rather than a second source on
purpose.

| Event | Source | Emitted when | Sensitivity | Role |
|-------|--------|--------------|-------------|------|
| `account.app_opened` | Platform | A surface is opened; carries `surface`, `journey_id` | `internal` | Funnel |
| `account.registration_started` | Platform | Sign-up begins; carries `contact_kind` | `internal` | Funnel |
| `account.registration_completed` | Platform | The account row commits and a verification message is sent; carries `contact_kind` | `internal` | Funnel |
| `account.registration_rejected` | Platform | Sign-up is refused; carries a `reason_code` (`under_18`, `invalid_input`, `duplicate`, `rate_limited`, `breached_password`, `domain_not_allowed`) and an `age_band` | `internal` | Funnel |
| `account.onboarding_step_completed` | Platform | An onboarding step passes; carries `step` and `source` | `internal` | Funnel |
| `account.onboarding_step_failed` | Platform | An onboarding step fails; carries `step` and `reason_code` | `internal` | Funnel |
| `account.session_started` | Platform | A session is established; carries `surface` and `auth_method` | `internal` | Funnel |
| `account.session_failed` | Platform | Authentication fails; carries `reason_code` and `auth_method` | `internal` | Health |
| `account.recovery_started` | Platform | A recovery flow begins | `internal` | Funnel |
| `account.recovery_completed` | Platform | Recovery succeeds and sessions are revoked; carries `sessions_revoked_count` | `internal` | Health |
| `account.recovery_locked` | Platform | Recovery is locked by abuse threshold or rate limit | `internal` | Health |
| `account.session_revoked` | Platform | A session is ended; carries `scope` (`this_device`, `all_devices`, `recovery`, `limit`, `enforcement`) | `internal` | Health |
| `account.capability_denied` | Platform | A capability is refused; carries `capability` and a `reason_code`, **never a case id** | `internal` | Health |
| `account.deletion_requested` | Platform | A deletion request commits; idempotency key in §4, row 3 | `internal` | Health |
| `account.deletion_cancelled` | Platform | The user restores inside the 30-day window | `internal` | Health |
| `account.deletion_completed` | Platform | Deletion completes, after the undo window | `internal` | Funnel |
| `profile.published` | Dating Core | A profile goes live; the onboarding funnel's terminal step | `user` | Funnel |
| `profile.deleted` | Dating Core | A profile is removed | `user` | Funnel |
| `preferences.updated` | Dating Core | A preference record is written; carries `changedAxes` — axis names only, never values | `user` | Control |
| `settings.updated` | Platform | A non-preference settings write commits; carries the changed field **names** only | `user` | Control |

Three properties of this table are load-bearing for §3, and they come from #9:

- **`age_band` is a five-year band, never an age and never a date.** It is the
  only form of age that reaches analytics.
- **`account.capability_denied` carries a reason code and never a case id.** A
  denial is a fact about capability, not about moderation, and a case id in
  this event would let the funnel reconstruct the moderation pipeline.
- **`account.registration_rejected` carries `under_18` as a reason code.** The
  rejected user is counted in the funnel; nothing about them is stored.

`identity_status.changed` and `account_state.changed` are deliberately **absent
from this table**. They are domain events owned by Identity and Moderation, and
they are `public` on the bus for product projections. The metrics sink never
receives `identity_status.changed`: the verification funnel counts submissions
from `verification.*` in §2.2 and joins the two series in analysis. Subscribing
analytics to an identity stream to "simplify" the funnel is the mistake this
note exists to prevent.

`preferences.updated` and `settings.updated` are separate events because they
have separate owners and separate read-models. Folding them together would make
the Dating Core's analytics footprint depend on the Platform's settings
vocabulary.

### 2.2 Verification (Identity)

Names adopted from
[Identity & Verification](../architecture/identity-and-verification.md).
That document owns the emissions; the analytics-relevant subset is indexed here.

| Event | Source | Emitted when | Sensitivity | Role |
|-------|--------|--------------|-------------|------|
| `verification.attempt.started` | Identity | A verification attempt begins; carries the attempt id, a re-verification flag, and a reason code | `internal` | Funnel |
| `verification.attempt.completed` | Identity | An attempt resolves; carries the attempt id, attempt state, a decision **label**, and a **band** — never a score | `internal` | Funnel |
| `verification.review.proposed` | Identity | Evidence supports a human review; carries subject, detector, findings | `sensitive` (bus) / `internal` (analytics projection) | Safety |
| `verification.anomaly` | Identity | Identity evidence is internally inconsistent (impersonation, reuse, liveness failure); carries findings as codes and counts | `sensitive` (bus) / `internal` (analytics projection) | Safety |
| `verification.re_verification.requested` | Identity | A re-verification is requested by Trust & Safety or Moderation; carries a reason code and the requesting domain | `internal` | Safety |
| `verification.evidence.accessed` | Identity | Identity evidence is read; carries the audit entry, granted or denied | `restricted` | Health |

Three rules the metric definitions in §3 depend on:

- **The identity state is a dimension, not a separate event.**
  `verified` / `verification_failed` / `review_required` / `expired` are the
  decision label and state on `verification.attempt.completed`. Deriving
  `verification.failed` as a projection rather than a second emission is what
  keeps a funnel from double-counting: two code paths emitting one fact is
  precisely how a completion rate goes wrong.
- **A band, never a score.** `verification.attempt.completed` carries the
  decision band and not the likeness score. A score in the warehouse is a score
  in a breach, and it is also a per-user value that would identify anyone
  holding the model.
- **The product stream is not the metrics stream.** `identity.status_changed`
  (`public`, carrying the projection and nothing else) is what Dating Core and
  Discovery subscribe to. It is **not** in this taxonomy and must not be added to
  it: the metrics sink counts from `verification.attempt.*` and joins to the
  account funnel in analysis. Subscribing analytics to the identity status
  stream to "simplify" the funnel is the mistake this note exists to prevent —
  it would put identity state and its timings into a pipeline that has no need
  for them.

### 2.3 Discovery, likes, matches (Dating Core)

| Event | Source | Emitted when | Sensitivity | Role |
|-------|--------|--------------|-------------|------|
| `discovery.entered` | Dating Core | The viewer passes the discovery gate and opens the feed | `public` | Funnel |
| `discovery.page_served` | Dating Core | A page is returned, full or short; carries `poolBucket: 'empty' \| 'small' \| 'healthy'` | `internal` | Funnel |
| `discovery.exhausted` | Dating Core | The eligible pool is confirmed exhausted for this viewer | `internal` | Funnel |
| `discovery.viewer_ineligible` | Dating Core | The gate rejects the viewer; carries the gate **class** (`identity` \| `capability`), never the underlying state | `internal` | Funnel |
| `like.recorded` | Dating Core | A like is written for the first time. **Not** on a duplicate or retry; carries `outcome: 'pending' \| 'matched'` | `user` | Funnel |
| `like.withdrawn` | Dating Core | A like is withdrawn — superseded by a pass, or killed by a block or unmatch | `user` | Funnel |
| `pass.recorded` | Dating Core | A pass is written | `user` | Funnel |
| `match.created` | Dating Core | Exactly once per match episode | `user` | Funnel |
| `match.ended` | Dating Core | A match stopped being usable, for any reason; carries `reason: 'blocked' \| 'unmatched' \| 'declined'` and `initiatorId` where there is one | `user` | Funnel |
| `unmatch.performed` | Dating Core | An **actor-initiated** unmatch command is accepted | `user` | Funnel |

Two properties this table is load-bearing for, both stated in
[Likes & Matching](./likes-and-matching.md) §9:

- **`match.created` is emitted once per match episode**, and `like.recorded`
  carries the like's own outcome. Match rate is therefore computable from
  `like.recorded.outcome` without a join, and a double-tap cannot inflate the
  funnel.
- **`unmatch.performed` is the only actor-initiated end.** A match ended by a
  block, a deletion, or a moderator emits `match.ended` but **not**
  `unmatch.performed`, which is what lets the safety metrics separate "a person
  chose this" from "the platform or a block did".

`pass.recorded` is `user` sensitivity and never reaches analytics as a target
identity beyond the viewer's own record; the analytics projection carries a
count, not who was passed.

### 2.4 Messaging (Communication)


| Event | Source | Emitted when | Sensitivity | Role |
|-------|--------|--------------|-------------|------|
| `conversation.created` | Communication | A conversation record is opened, i.e. at match time | `user` | Funnel |
| `message.recorded` | Communication | A message is accepted for delivery | `user` | Funnel |
| `message.delivered` | Communication | A recipient's client acknowledges the message | `internal` | Health |
| `message.read` | Communication | A conversation's read watermark advances past a message | `internal` | Funnel |
| `conversation.activity` | Communication | A rolling window of conversation metadata — counts, distinct-content hashes, link count, median inter-message gap, conversation and match age | `user` (bus) / `internal` (analytics projection) | Safety |
| `conversation.flagged_pattern` | Communication | A structural pattern fires (`high_rate`, `repeated_content`, `link_density`); carries the pattern name and the detector's own confidence, **never content** | `user` (bus) / `internal` (analytics projection) | Safety |
| `message.withheld_by_system` | Communication | An outbound message is refused by a system rule; carries the rule name and **no body, no excerpt** | `internal` | Safety |
| `message.reported` | Communication | A message is attached to a report as evidence | `restricted` (case-scoped read) / `internal` (analytics projection) | Safety |

**Message text is not an event field, on any of these events.**
`conversation.activity` is deliberately built from counts, hashes, and timings:
it is the only channel by which messaging behaviour reaches Trust & Safety, and
if it carried content the overview's rule that Communication never decides a
message is abusive would become unverifiable. Evidence is read case-scoped from
the restricted read-model with a `CaseId`, never from the bus. An event carrying
an unknown field is rejected at ingest (§6.2), so a body cannot be introduced
quietly.

### 2.5 Safety and moderation (Trust & Safety, Moderation)

| Event | Source | Emitted when | Sensitivity | Role |
|-------|--------|--------------|-------------|------|
| `block.changed` | Moderation | A block edge is created or lifted; carries the blocker as actor, never the blocked user as an actor | `user` (bus) / `internal` (analytics projection) | Safety |
| `report.submitted` | Moderation | A report is filed; idempotency key in §4, row 4 | `internal` | Safety |
| `case.opened` | Moderation | A moderator opens a case, from a report, a risk escalation, or an abuse pattern; carries `origin` | `restricted` (bus) / `internal` (analytics projection) | Safety |
| `case.resolved` | Moderation | A case closes with outcome `warned` \| `restricted` \| `suspended` \| `banned` \| `cleared` | `restricted` (bus) / `internal` (analytics projection) | Safety |
| `account_state.changed` | Moderation | The account machine transitions; carries `from`, `to`, and for enforcement moves `caseId` and `moderatorId` | `public` (bus) / `internal` (analytics projection) | Safety |
| `account.restriction.applied` | Moderation | `to === 'limited'`; carries `removedCapabilities` and `caseId` | `public` (bus) / `internal` (analytics projection) | Safety |
| `account.restriction.lifted` | Moderation | `to === 'active'` from `limited` | `public` (bus) / `internal` (analytics projection) | Safety |
| `risk.changed` | Trust & Safety | The risk machine transitions; carries `from`, `to`, and the **set** of detector names that fired | `internal` | Safety |
| `risk.assessed` | Trust & Safety | A risk evaluation completes for a window; carries `state` and `detectorCount`, never a raw score | `internal` | Safety |
| `moderation.appealed` | Moderation | A user contests an enforcement outcome | `internal` | Safety |
### 2.6 Notifications (Platform)

| Event | Source | Emitted when | Sensitivity | Role |
|-------|--------|--------------|-------------|------|
| `notification.dispatched` | Platform | A notification is handed to a channel adapter | `internal` | Health |
| `notification.suppressed` | Platform | A notification is withheld: preferences, quiet hours, block separation, or a non-existent recipient | `internal` | Health |
| `notification.failed` | Platform | All channels for a notification exhausted their retries | `internal` | Health |
| `notification.duplicate_prevented` | Platform | An idempotency key was already dispatched | `internal` | Health |

`notification.duplicate_prevented` is the observable proof that idempotency is
working; a rate that is exactly zero on a working system means the key is being
computed wrong and collisions are being caused by over-broad keys.

### 2.7 Platform health (Platform)

| Event | Source | Emitted when | Sensitivity | Role |
|-------|--------|--------------|-------------|------|
| `slo.error_budget_exhausted` | Platform | A service exhausts its error budget for the window | `internal` | Health |
| `alert.fired` | Platform | An alert in §5.2 transitions to firing | `internal` | Health |
| `provider.verification_call` | Platform | A verification provider call completes; carries `outcome` and `latencyMs`, never the payload | `internal` | Health |
| `dependency.failed` | Platform | An external dependency call fails after retries | `internal` | Health |

## 3. Metric definitions

Conventions: the unit of analysis is the **user** unless stated. All rates are
computed per calendar week, UTC, on events that have been in the warehouse for
at least 24 h (`occurredAt` based, not ingest based — a funnel that shifts when
the pipeline shifts is not a funnel). Percentages are shown to one decimal.

The rates that are easy to get wrong are marked **[denominator trap]**.

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
- **Numerator:** users with a `confirmed_fraudulent` moderator finding, i.e. a `case.resolved` with outcome `banned` or `suspended` on fraud grounds, at any time **after** the verification event, attributed back to the verification cohort.
- **Denominator:** distinct users with `verification.attempt.completed` labelled `verified` in the cohort window.
- **[denominator trap]** The denominator is *all verified users*, not the moderated subset. Using "fraudulent profiles among reviewed cases" measures the review queue's composition, not the product's failure rate.
- **Pitfalls:** outcome-based, so it has a long tail and a small numerator — report it as a rate with a confidence interval and a minimum-count gate, never as a bare percentage. A sudden drop is as meaningful as a rise: it usually means moderation stopped, not that fraud stopped. It is also the metric most vulnerable to a loophole, so it is paired with the primary metric in §3.6.

### 3.4 Reports per 1,000 conversations

- **Formula:** `distinct report.submitted ÷ distinct conversation.created × 1000`
- **Denominator:** conversations created in the same window, **excluding conversations that a block later invalidated** (per [Privacy & User Settings §5.1](./privacy-and-user-settings.md)), so that a block spike does not deflate the rate.
- **Pitfalls:** one user filing five reports about one person is one numerator unit; dedupe by `(reporterId, subjectId)` per window and count the excess separately as `repeat_reporter` — that is itself a signal (a target being hammered, or a reporter misusing the form). Reports about *messages* and reports about *profiles* have different base rates and are reported separately, not summed.

### 3.5 Blocks per 1,000 conversations

- **Formula:** `distinct block.changed ÷ distinct conversation.created × 1000`
- **Denominator:** as §3.4.
- **Pitfalls:** a block is a *disclosure-free* safety action, so a rising block rate is often a rising trust signal rather than a rising harassment rate — it can mean users feel safe enough to act. It must be read with §3.9: blocks rising while reports stay flat is the expected shape of a healthy block feature. The number to alert on is the **block-to-report ratio**, because a low ratio means users are preferring conversation to disengagement.

### 3.6 High-risk behaviour detected before first report — **the primary safety metric**

- **Formula:** `users whose risk machine first reached 'high' or 'critical' before any report.submitted named them ÷ users who became a confirmed malicious account`
- **Denominator:** users with a confirmed malicious finding (`case.resolved` → `banned`, or `suspended` with a repeat-offence finding) in the window.
- **Numerator:** those users for whom there exists a `risk.changed` with `to ∈ {'high','critical'}` whose `occurredAt` is **earlier** than the first `report.submitted` naming them — or, for undetected-by-report cases, earlier than the `case.opened` that led to the finding. When both exist, the earlier of the two wins.
- **[denominator trap]** The denominator is **confirmed malicious accounts**, not all users. "Percentage of high-risk behaviour detected before first report" over an all-user denominator is a meaningless small number, and it is the single most common way this metric is misreported.
- **[denominator trap]** The numerator must exclude the moderator who opened the case from the detection path. A case opened *because* a human read the reports is not proactive detection.
- **Pitfalls:** `risk.changed` ordering must use `occurredAt`, not ingest time, or a late-arriving signal will be scored as a miss; a user with two `high` episodes is one unit; and because a confirmed-malicious cohort is small, report this with a cohort size and a Wilson interval, and treat a single-week move as noise.
- **Known limitation, stated because it will otherwise be discovered later:** this metric can only be computed for accounts that were *eventually confirmed malicious*, so it cannot measure a class of harm that moderation never caught. It is a lagging indicator by construction and must never be the trigger for a safety change on its own.

### 3.7 Moderator cases per 1,000 users

- **Formula:** `distinct case.opened ÷ distinct account.registration_completed × 1000`
- **Denominator:** users created in the same window, all states, including `banned`. The alternative denominator (active users only) makes the rate fall every time enforcement works, which is the wrong direction.
- **Pitfalls:** a case opened on a report and a case opened on a risk escalation are different work; `case.opened` carries an `origin` and the two rates are reported side by side. `case.opened` also counts cases later closed as `cleared`, which is intended — moderator time is spent either way.

### 3.8 Median moderation resolution time

- **Formula:** `median(case.resolved.occurredAt − case.opened.occurredAt)`
- **Denominator:** cases **resolved** in the window. Cases still open are excluded from the median and reported separately as the open-case count and the oldest-open-case age — a median over resolved cases alone will look excellent on the day a backlog is being ignored.
- **Pitfalls:** report the **p90 and p99 alongside the median**; a safety queue with a healthy median and a p99 of nine days is an unattended queue. Report by `origin` and by `priority` separately. Resolution time for a case that waits on the user (an appeal requiring information) is time the moderator is not spending, and excluding it is the difference between a queue metric and a service metric.
- **SLO link:** this metric has a target, not just a definition — median ≤ 24 h, p90 ≤ 72 h (§5.1).

### 3.9 Match → first-message rate

- **Formula:** `matches where the first message was sent by either party within 24 h ÷ all matches created in the window × 100`
- **[denominator trap]** The denominator is **all matches**, not "matches whose counterpart is still active". Filtering the denominator to active users inflates the rate exactly when the product is doing well, because the matches most likely to go quiet are with newly-signed-up users.
- **[denominator trap]** The 24-hour window is measured from `match.created` to the **first** `message.recorded` in the conversation, and the numerator counts a match once regardless of who spoke first. Two of these — "who spoke first" and "did anyone speak" — are separate metrics and get reported separately.
- **Pitfalls:** exclude a match from the numerator only when the counterpart was, at match time, `limited` in `send_message` — the silence is the platform's doing, not the user's.

### 3.10 Conversations with replies from both users

- **Formula:** `conversations with ≥1 message.recorded from each participant ÷ all conversation.created in the window × 100`
- **Denominator:** all conversations, including ones with zero messages. A conversation is created at match time, so this is well-defined and the denominator does not depend on the outcome being measured.
- **Pitfalls:** the message can be a single character and still counts — there is no quality bar in v0.1 and inventing one turns a participation metric into an opinion; conversations where one party has since been blocked stay in the denominator, because removing them after the fact is exactly the selection effect that makes blocks and reports look better than they are.

### 3.11 7-day and 30-day retention

- **Formula (7d):** `users with a qualifying session in [signup + 7d, signup + 7d + 1d) ÷ users created in the cohort window × 100`
- **Formula (30d):** `users with a qualifying session in [signup + 30d, signup + 30d + 1d) ÷ cohort users × 100`
- **Qualifying session:** any of `discovery.entered`, `conversation.created`, or `message.recorded` — an app open that leads to no interaction does not count, because a retention number that a push-notification tap can move is a notification metric.
- **[denominator trap]** Cohorts are by `account.registration_completed`, and the denominator is the **full cohort**, with no survival filtering. Users who deleted their account remain in the denominator. This makes deletion suppress retention, which is correct.
- **Pitfalls:** the 30-day window is unmeasurable for the most recent 30 days of cohorts and must be plotted with a lag marker, or every chart will show a cliff that is a reporting artefact; a deleted-then-recreated account is one new user, so a user who churns and returns is double-counted as a re-acquisition and must be tagged.

### 3.12 Support metrics

Not in issue #1's list, but required to interpret the list: `settings.updated` rate, notification opt-out rate per kind (a support signal, not a preference metric), `moderation.appealed` rate as a proxy for disagreement, and `repeat_reporter` count. Appeal rate is the early-warning indicator for a false-positive regression, and it moves days before the outcome metrics do.

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
- **Every critical action emits an event even on replay.** `notification.duplicate_prevented`-style accounting applies to all of them: an idempotent replay is observable in the health metrics, so a client stuck in a retry loop is visible in the dashboard rather than only in the logs.

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
| Verification completion collapse | >20% relative drop vs. same-hour 7-day baseline, for 2 h | **Page** | Verification pipeline or provider failure. Check `provider.verification_call` and `dependency.failed` first, not user sentiment |
| Verification provider error rate | >5% over 15 min | **Page** | Provider degradation |
| Block action failing | Any `block.changed` write failure | **Page** | Zero budget; a broken block is a safety outage |
| Report submission failure | >2% over 15 min | **Page** | Users believe reports are being silently lost |
| Enforcement notification not delivered | Any `notification.failed` for a critical kind | **Page** | A user is being enforced against without being told |
| Message send success | <99.5% over 10 min | **Page** | Transport or database |
| Match creation error | >1% over 10 min | **Page** | Transaction failure in like/match |
| Event bus lag | p95 >5 min, or ingest loss >0.5% | **Page** | Every dashboard is now lying |
| Duplicate critical action detected | `notification.duplicate_prevented` >0 outside client retry bursts, or any non-replay `duplicate_prevented` on like/match/restriction | **Page** | Idempotency key is wrong; a double-enforcement or double-like is in progress |
| Moderation queue age | Oldest open case >24 h, or p90 resolution >72 h | **Ticket → page** | Moderation capacity, not moderation policy |
| Appeal rate spike | >2× 4-week baseline over 7 days | **Ticket** | Likely a false-positive regression; a leading indicator of the outcome metrics |
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
| **Notification health** | Dispatch success and latency by kind and channel, `notification.suppressed` by reason, `notification.failed`, and `notification.duplicate_prevented` | Product, engineering |
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

| Event class | Sampling | Why |
|-------------|----------|-----|
| Safety events (`report.submitted`, `block.changed`, `case.opened`, `case.resolved`, `account_state.changed`, `account.restriction.*`, `risk.*`, `conversation.flagged_pattern`, `message.withheld_by_system`, `verification.review.proposed`, `verification.anomaly`, `verification.re_verification.requested`, `moderation.appealed`) | **100%** | Rare, high-consequence, and the sample size is already small. Sampling safety data makes every safety metric in §3 wrong, and it is the class most likely to be needed in a dispute |
| Funnel step events (`account.app_opened`, `account.registration_started`, `account.registration_completed`, `account.onboarding_step_completed`, `account.registration_rejected`, `verification.attempt.started`, `verification.attempt.completed`, `profile.published`, `discovery.entered`, `like.recorded`, `match.created`, `conversation.created`, `message.recorded`) | **100%** | The denominators of §3 live here. A sampled funnel step makes every downstream rate a biased estimate |
| `discovery.page_served` | **10%, deterministic hash of `userId` + `sessionId`** | The one genuinely high-volume event: ten cards per request. A deterministic hash keeps the sample unbiased across users and time, so a 10% sample scales to the full population rather than skewing toward whoever arrives first. Any rate computed from it uses the hash as a weighting factor, and the dashboard says "sampled" on the tile |
| `message.read`, `preferences.updated`, `settings.updated`, `moderation.appealed`, `discovery.exhausted` | **100%** | Low volume, and several are leading safety indicators |
| `notification.*` | 100% aggregate, `notification.dispatched`/`failed` sampled at 25% by the same hash | Volume scales with messages |
| Health events (`slo.*`, `alert.fired`, `dependency.failed`, `provider.verification_call`) | 100% counters, 100% with a 1-minute rollup for high-cardinality series | Counters, not rows |

Rule: **sampling is chosen per event, once, in this table.** An ad-hoc sample
rate on an unlisted event is a schema change, because it silently changes a
metric's denominator.

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
- Whether moderation capacity is staffed for a `case.opened` rate that is
  2× the projected load if §3.6 shows proactive detection working. Proactive
  detection generating cases is a success that costs money, and the trigger to
  hire is not written down.
- Whether `verification.anomaly` should contribute a numerator to §3.3
  (fraudulent profiles passing verification). It would catch a class of fraud that
  currently only surfaces at moderation, but an anomaly is a signal and not a
  finding, so counting it as a pass-through failure would inflate the metric with
  false positives. Recorded rather than guessed.
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
