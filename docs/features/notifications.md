# Notifications

> Issue [#16](https://github.com/katzimoto/been_there/issues/16). Parent:
> [#1](https://github.com/katzimoto/been_there/issues/1).
> Authority: [System domains & boundaries](../architecture/00-overview.md). If this
> document contradicts the overview's eight commitments, the overview wins.
>
> Vocabulary used here — account state, identity state, risk state, `caseId`,
> `DataSensitivity` — is the overview's, not a local synonym set.

Notifications are a **Platform** capability (domain 6 in the overview). They carry
no product rule of their own: Platform decides *how* to tell someone, the owning
domain decides *what happened*. Every notification in this document is derived
from a `DomainEvent` that the owning domain already published; Platform never
subscribes to another domain's internals and never decides that an event is
"notifiable".

## 1. Boundary

| This spec owns | This spec never owns |
|----------------|---------------------|
| The notification catalogue (which events notify, on which channel, with which content rules) | Whether an event happens — that is the owning domain's state machine |
| Idempotency of a notification, so a retried event never double-notifies | Idempotency of the *action* that caused the event (see [Product Quality & Measurement](./product-quality-and-measurement.md) §4) |
| Critical vs. non-critical classification, and the suppression rules that follow | Account state, risk state, or the existence of a moderation case |
| Quiet hours, digest windows, channel fallbacks, redacted templates | Message content, profile content, moderation reasons, detector names |
| Reading the recipient's notification settings (class `user`, owner-only) | Writing anyone's settings on their behalf, or defaulting a *safety* setting to off |
| Emitting `notification.dispatched` / `.suppressed` / `.failed` | Emitting product events such as `match.created` — those belong to their domains |

Platform's contract in one line: **it is a delivery mechanism with a redaction
layer, and it is not allowed to invent a reason.**

## 2. Classification: critical vs. non-critical

A notification is **critical** if failing to deliver it can leave a user
misinformed about their own safety, their own account standing, or their own
ability to use the product. Everything else is **non-critical** and
user-suppressible.

| Class | Definition | Suppressible? | Quiet hours? | Email? |
|-------|------------|---------------|-------------|--------|
| Critical | The user must know to avoid harm or to exercise a right | **No** | **No — delivered immediately** | Yes, always, in addition to push |
| Non-critical | Engagement or convenience information | Yes, per channel and per category | Yes — deferred to next wake | Digest only |
| Transcendental | Neither a user-facing event nor a product event; the platform's own operational signals (`notification.failed`) | n/a | n/a | Never user-facing |

The two things a user may never switch off, stated once and for everything:

1. **Safety and account-state notifications.** A user cannot opt out of being
   told their account was restricted, suspended, or banned.
2. **Verification-outcome notifications.** A user cannot opt out of being told
   that verification passed, failed, needs review, or expired, because those
   states determine whether they are discoverable at all.

Everything else in §3 marked non-critical is suppressible.

### 2.1 Why safety and account-state notifications are not suppressible

This is the one place where "the user knows best" is wrong, and the reasoning is
worth writing down because it will otherwise be re-litigated by the first user
who complains.

- **The notice is the mechanism of appeal.** Moderation may only act on a
  recorded case, and a case the user never learns about cannot be contested. If
  enforcement notifications were suppressible, the platform would be enforcing
  invisibly, which is precisely the "irreversible automated black box" that
  acceptance scenario 6 of issue #1 rules out.
- **A restriction that the user cannot learn about is indistinguishable from a
  bug.** A user whose `like` capability was removed by a `limited` account state
  will otherwise conclude the app is broken. Non-delivery destroys the ability
  to report a broken system, and with it the last line of defence against our own
  error.
- **A user can act on a suppression request.** A user who does not want dating
  notifications can unmatch and delete their account. A user who does not want to
  hear that they were suspended has no equivalent act that resolves the actual
  problem, and the underlying reason will still apply to their next account.
- **Suppression of safety notices creates an attack surface.** Anyone able to
  suppress a victim's notifications — a compromised session, a shared device, a
  coercive partner — can hide enforcement, block confirmations, and identity
  warnings. Suppressible safety notices are a control on the victim's safety that
  an attacker can reach.
- **It does not conflict with the safety spine.** The overview states that the
  only thing enforcement publishes outward is `account_state.changed`, and that
  product domains must not be able to infer that a user was reported, reviewed,
  or restricted. A notification about *the recipient's own* account state is not
  a leak to another user. The notice names the resulting state, the case
  reference, and the route to contest it — never the reporter, never the
  evidence, never a detector name.

The suppression API is honest about this: `NotificationPreferences` has no field
that can turn off a critical kind. There is no `false` to set, so there is no
value to accidentally store, and no client that can request it.

## 3. Notification catalogue

`Kind` is the stable notification identifier. Every catalogue row is a `Kind` in
`packages/platform`. The idempotency key is computed by Platform from the event;
it is *not* supplied by the emitting domain, so a domain cannot accidentally
notify twice by publishing two shapes of the same fact.

Channel shorthand: **P** push, **E** email, **I** in-app. "Digest" means the
notification is accumulated and sent at the next digest window (§6) and never
sent immediately.

| # | Kind | Triggering event (source domain) | P | E | I | Class | Content rules | Idempotency key |
|---|------|----------------------------------|---|---|---|-------|----------------|-----------------|
| 1 | `match.created` | `match.created` (Dating Core) | yes | digest | yes | Non-critical | First name only. No photo, no bio, no distance. Deep link to the conversation. | `match:{matchId}` |
| 2 | `message.received` | `message.recorded` (Communication) | yes | digest | yes | Non-critical | **No message text, ever, on any channel.** Sender first name only, and only if the recipient has not blocked them. | `message:{messageId}:{recipientUserId}` |
| 3 | `message.digest` | Accumulated `message.recorded` (Communication) | — | yes | yes | Non-critical | Per conversation: sender first names and message counts. No text. | `digest:message:{recipientUserId}:{windowStartIso}` |
| 4 | `like.received` | `like.recorded` (Dating Core) | opt-in | digest | opt-in | Non-critical | No name, no photo, no distance. Off by default. | `like:{likeId}` |
| 5 | `verification.passed` | `verification.attempt.completed` with attempt state `passed` (Identity) | yes | yes | yes | **Critical** | States that the account is now discoverable. No provider name, no scores, no likelihood values. | `verification:{attemptId}:{subjectUserId}:passed` |
| 6 | `verification.failed` | `verification.attempt.completed` with attempt state `failed` (Identity) | yes | yes | yes | **Critical** | Says which step failed in neutral terms and what to do next. **Never** says "you look like a criminal" or quotes a similarity score. | `verification:{attemptId}:{subjectUserId}:failed` |
| 7 | `verification.review_required` | `verification.attempt.completed` with attempt state `manual_review` (Identity) | yes | yes | yes | **Critical** | States that a human is reviewing and gives an expected timeframe. | `verification:{attemptId}:{subjectUserId}:review` |
| 8 | `verification.expired` | Attempt state `expired`, or the identity machine's `expire` transition (Identity) | yes | yes | yes | **Critical** | States the account is no longer discoverable and what to do to restore it. | `verification:{subjectUserId}:expired:{occurredAtDate}` |
| 9 | `account.restriction.applied` | `account_state.changed` → `limited` (Moderation) | yes | yes | yes | **Critical** | Names each removed capability, the case reference, the date, and the appeal route. **No** moderator note, no report count, no detector name, no reporter. | `restriction:{caseId}:{subjectUserId}:{capability}` |
| 10 | `account.suspended` | `account_state.changed` → `suspended` (Moderation) | yes | yes | yes | **Critical** | Same content rules as #9 plus what is still possible (`report`, `block`, `delete_account`). | `enforcement:{caseId}:{subjectUserId}:suspended` |
| 11 | `account.banned` | `account_state.changed` → `banned` (Moderation) | no¹ | yes | yes¹ | **Critical** | Email is the primary channel because a banned user may not be able to log in. Never states who reported or why in the body; points to the appeal route. | `enforcement:{caseId}:{subjectUserId}:banned` |
| 12 | `account.reinstated` | `account_state.changed` → `active` (Moderation) | yes | yes | yes | **Critical** | States the standing is restored and which capabilities returned. | `enforcement:{caseId}:{subjectUserId}:reinstated` |
| 13 | `moderation.warning_issued` | `case.resolved` with outcome `warned` (Moderation) | yes | yes | yes | **Critical** | Warns that a case exists and what behaviour was out of bounds, in the moderator's own words. No evidence, no reporter identity, no counterparty name. | `warning:{caseId}:{subjectUserId}` |
| 14 | `appeal.resolved` | `case.resolved` on an appeal case (Moderation) | yes | yes | yes | **Critical** | Outcome and the effective date. | `appeal:{caseId}:{subjectUserId}` |
| 15 | `report.received` | `report.submitted` (Moderation) | no | yes | yes | Non-critical | Confirmation receipt with the report reference the user can quote. No case status, ever — that would leak moderation pipeline state back to a reporter. | `report:{reportId}:{reporterUserId}` |
| 16 | `match.ended_by_other` | `match.ended` where `initiatorId` is the other party (Dating Core) | yes | digest | yes | Non-critical | Generic end-of-contact copy. **Must not** reveal that a block occurred, who caused it, or that a report exists. Push/email body is the short generic variant; the in-app surface uses the fuller `SAFETY_BLOCK_RECEIVED` / end-of-match string owned by [User Safety Controls](./user-safety-controls.md) §10. See [Privacy & User Settings](./privacy-and-user-settings.md) §5. | `match_ended:{matchId}:{recipientUserId}` |
| 17 | `login.new_device` | `account.session_started` with a new device fingerprint (Platform) | yes | yes | yes | **Critical** | Device label, coarse city of the login, time. No IP address in the body, no session token material. | `login:{sessionId}` |
| 18 | `account.recovery` | `account.recovery_started` (Platform) | no | yes | no | **Critical** | Confirms a recovery attempt. Body never states whether the address exists beyond what the account-recovery flow already guarantees. | `recovery:{requestId}` |
| 19 | `account.deletion_completed` | `account.deletion_completed` (Platform) | no | yes | no | **Critical** | States deletion completed, what was deleted, and that reports the user filed are retained. The 30-day restore window and its own email are owned by [Account & Onboarding](./account-and-onboarding.md) §8.1. | `deletion:{requestId}` |
| 20 | `discovery.weekly_digest` | Scheduled (Dating Core read-model) | no | yes | yes | Non-critical | Count of new eligible profiles in the user's own preference range. **No** names, photos, or distances. | `digest:discovery:{recipientUserId}:{isoWeek}` |

¹ A `banned` account has no product surface by definition
(`isVisibleInProduct('banned') === false`), so push and in-app are unreachable;
email is the delivery guarantee, and the dismissal of the notice happens through
the appeal flow rather than a product read.

### 3.1 Copy

Copy is part of the contract: a notification is a safety surface, so wording
changes go through review like any other user-facing safety string. Placeholders
in `{braces}` are rendered only from fields cleared for the recipient.

**#1 `match.created`**
- Push title: `You matched with {firstName}`
- Push body: `Say hello — you've liked each other.`
- Email subject: `You matched with {firstName} on Been There`
- Email body: `You and {firstName} liked each other. Your conversation is ready. Open Been There to send a message.`
- In-app: `{firstName} liked you back.`

**#2 `message.received`**
- Push title: `New message from {firstName}`
- Push body: `Tap to open. You'll see it in the app.`
- Email subject: `New message from {firstName}`
- Email body: `{firstName} sent you a message on Been There. Open Been There to read it — message text is never included in email.`
- In-app: `{firstName}: new message`

**#3 `message.digest`**
- Email subject: `{n} new conversations on Been There`
- Email body: `You have new messages from {firstNames}. Open Been There to reply.`

**#4 `like.received`**
- Push title: `Someone likes you`
- Push body: `Tap to see who.`
- In-app: `Someone likes you.`

**#5 `verification.passed`**
- Push title: `You're verified`
- Push body: `Your profile can now appear in discovery.`
- Email subject: `You're verified on Been There`
- Email body: `Your identity check is complete. Your profile is now visible to other verified members.`
- In-app: `Verified. You're now visible in discovery.`

**#6 `verification.failed`**
- Push title: `We couldn't verify you`
- Push body: `Tap for what to try next.`
- Email subject: `Action needed: we couldn't complete your verification`
- Email body: `We couldn't confirm your identity from the selfie you submitted. This is usually a lighting or framing problem. Try again in a well-lit room, facing the camera. If you keep failing, contact support.`
- In-app: `Verification didn't go through. Here's what to try.`

**#7 `verification.review_required`**
- Push title: `We're reviewing your verification`
- Push body: `Usually within 24 hours.`
- Email subject: `Your Been There verification is under review`
- Email body: `A person on our team is reviewing your verification. You can keep using the app while we do; you'll get another email when there's a decision.`
- In-app: `Verification under review.`

**#8 `verification.expired`**
- Push title: `Your verification has expired`
- Push body: `Re-verify to stay visible in discovery.`
- Email subject: `Re-verify to keep your Been There profile visible`
- Email body: `Your verification has expired, so your profile is hidden from discovery. Re-verify to switch it back on.`
- In-app: `Verification expired — re-verify to be visible again.`

**#9 `account.restriction.applied`**
- Push title: `Some features are paused on your account`
- Push body: `Tap to see which.`
- Email subject: `Action required: changes to your Been There account`
- Email body: `Following a review by our moderation team, the following is currently unavailable on your account: {capabilities}. This took effect on {date}. Your reference is {caseRef}. Reply to this email to contest it.`
- In-app: `Paused for now: {capabilities}. Reference {caseRef}.`

**#10 `account.suspended`**
- Push title: `Your Been There account is suspended`
- Push body: `Tap for details and how to respond.`
- Email subject: `Your Been There account has been suspended`
- Email body: `Your account is suspended as of {date}. While suspended you can still report abuse, block someone, and delete your account. Your reference is {caseRef}. To contest this decision, reply to this email.`
- In-app: `Account suspended. Reference {caseRef}. You can still report and block.`

**#11 `account.banned`**
- Email subject: `Your Been There account has been permanently closed`
- Email body: `Your account is closed as of {date}. Your reference is {caseRef}. If you believe this is a mistake, reply to this email to request a review. You may also delete your data at any time from this link.`

**#12 `account.reinstated`**
- Push title: `Your account is active again`
- Push body: `You're back in discovery.`
- Email subject: `Your Been There account is active again`
- Email body: `Your account is active as of {date}. The following are available again: {capabilities}.`
- In-app: `Account active again.`

**#13 `moderation.warning_issued`**
- Push title: `A note about your activity on Been There`
- Push body: `Tap to read it.`
- Email subject: `About your activity on Been There`
- Email body: `Our moderation team reviewed your account and want you to know that {behaviourSummary} falls outside our community guidelines. Please adjust your behaviour. Further action may restrict your account. Your reference is {caseRef}.`
- In-app: `A moderation note has been added to your account.`

**#14 `appeal.resolved`**
- Push title: `We finished reviewing your appeal`
- Email subject: `The outcome of your Been There appeal`
- Email body: `Your appeal was {outcome} as of {date}. Your reference is {caseRef}.`

**#15 `report.received`**
- Email subject: `We received your report`
- Email body: `Thanks — your report is logged under reference {reportRef}. Our team reviews reports alongside automated safety signals. We won't be able to discuss individual reports.`
- In-app: `Report received. Reference {reportRef}.`

**#16 `match.ended_by_other`**
- Push title: `A match has ended`
- Push body: `This conversation is no longer available.`
- Email subject: `A match on Been There has ended`
- Email body: `This conversation is no longer available. If something felt wrong, you can still report it from your settings — reporting stays available after a match ends.`
- In-app: `This match has ended.`

**#17 `login.new_device`**
- Push title: `New sign-in to your account`
- Push body: `{deviceLabel} · {city}`
- Email subject: `New sign-in to your Been There account`
- Email body: `Your account was accessed from {deviceLabel} in {city} at {time}. If this wasn't you, secure your account immediately.`
- In-app: `New sign-in from {deviceLabel}.`

**#18 `account.recovery`**
- Email subject: `Reset your Been There password`
- Email body: `We received a request to reset your password. If it was you, use the link below. The link expires in {ttlMinutes} minutes.`

**#19 `account.deletion_completed`**
- Email subject: `Your Been There account has been deleted`
- Email body: `Your account and profile were deleted on {date}. You can still report abuse until {retainedUntil} by replying to the email we sent when you requested deletion.`

The 30-day undo window, the restore email, and the retention of reports the
deleted user filed are owned by
[Account & Onboarding](./account-and-onboarding.md) §8.1–§8.2. This
notification covers only the terminal event, and it deliberately repeats the
reporting route, because after deletion the account no longer exists to report
from and a reporter who is left silent is a reporter who stops trying.

**#20 `discovery.weekly_digest`**
- Email subject: `{n} new verified people match your preferences`
- Email body: `There are {n} new verified members who match the age, distance, and compatibility settings you chose. Open Been There to browse.`

**One string, one owner.** The push, email, and in-app bodies above are the
notification layer's copy. Where a sibling spec already owns the in-app string
for the same fact, this spec does not restate it — it defers, so there is one
reviewable string per fact rather than two that drift:

| Notification | In-app string owned by |
|--------------|------------------------|
| #9–#13, #16, #15 | [User Safety Controls](./user-safety-controls.md) §10 (`SAFETY_ACCOUNT_RESTRICTED`, `SAFETY_ACCOUNT_SUSPENDED`, `SAFETY_ACCOUNT_BANNED`, `SAFETY_ACCOUNT_REINSTATED`, `SAFETY_ACCOUNT_WARNING`, `SAFETY_REPORT_SENT`, `SAFETY_BLOCK_RECEIVED`) and [Account Restrictions & Re-verification](./account-restrictions-and-reverification.md) §6 |
| #5–#8 | [User Safety Controls](./user-safety-controls.md) §10.3 (`SAFETY_VERIFICATION_FAILED`, `SAFETY_VERIFICATION_REVIEW`) plus Identity for the pass and expiry notices |
| #1–#4, #20 | This spec |
| #17–#19 | [Account & Onboarding](./account-and-onboarding.md) |

The rule that makes this safe: the **push and email** bodies are owned here and
are always the shorter, redacted variant of the in-app string. Shortening for a
locked screen may remove detail, never add it, and never add a fact the in-app
string does not show.

## 4. Content privacy

### 4.1 The redaction rule

A notification body is assembled by a template, and a template may only bind
fields that are cleared for the recipient. Concretely:

1. **No message text on any channel, ever** — not push, not email, not in-app,
   not in a digest. The recipient must open the app to read a message. This is
   not a push-notification limitation; it is the product rule.
2. **Names.** A counterparty name may appear only after a `match` exists
   between the two users, and only the display name. A `like.received`
   notification for an unmatched user renders no name at all.
3. **Location.** No notification contains any location value. The coarse distance
   band is not included either: a notification is rendered on a device that may
   not be the user's own, and the band plus the notification's arrival time is
   more than a notification should carry.
4. **Moderation content.** Enforcement notifications may name the resulting
   account state, the removed capabilities, the case reference, the date, and the
   contest route. They may never contain: the reporter's identity, the evidence,
   moderator notes, the detector or model that raised the signal, the risk state,
   or a confidence score.
5. **Verification content.** Verification notifications may state the resulting
   identity state and the next action. They may never contain biometric
   artefacts, provider responses, provider names, or likeness scores.
6. **Redaction is a type-level constraint, not a lint.** The template binder
   accepts only `PublicRenderable` fields; anything of class `internal`,
   `sensitive`, or `restricted` is not expressible in a template and a binding to
   one is a compile error. This is the notification-domain expression of the
   overview's commitment 7.

```ts
// CONTRACT SKETCH — not an implemented API.
// The shapes the notifications package will expose; fields only, no logic.
type NotificationClass = 'critical' | 'non_critical';

/** Fields a notification body is permitted to bind. */
interface PublicRenderable {
	readonly firstName?: string;        // only when a match exists
	readonly capabilityName?: string;   // only for enforcement notices
	readonly caseRef?: string;          // opaque reference, never a case id to a third party
	readonly city?: string;             // coarse city only, for the new-device notice
}

interface NotificationPreferences {
	// Non-critical categories. Absent means "on" for the default-on ones.
	readonly pushLikes: boolean;        // default false
	readonly pushMessages: boolean;     // default true
	readonly pushMatches: boolean;      // default true
	readonly emailDigest: boolean;      // default true
	readonly emailDiscoveryDigest: boolean; // default true
	readonly quietHours: { readonly from: 'HH:mm'; readonly to: 'HH:mm' }; // default 22:00–08:00 local
	// NOTE: there is deliberately no field for critical kinds. See section 2.1.
}

interface NotificationRequest {
	readonly kind: NotificationKind;
	readonly recipientUserId: string;
	readonly class: NotificationClass;
	readonly channels: readonly ('push' | 'email' | 'in_app')[];
	readonly bind: Readonly<Record<string, PublicRenderable[keyof PublicRenderable]>>;
	readonly idempotencyKey: string;    // computed by Platform, never by the emitter
}
```

## 5. Quiet hours

- Quiet hours are a per-user, local-time window, default **22:00–08:00**. A user
  may change the window or disable it.
- **Critical notifications ignore quiet hours entirely.** A restriction,
  suspension, ban, reinstatement, verification failure, or new-device sign-in is
  delivered immediately on every available channel. Deferred delivery of a safety
  notice is indistinguishable from no notice.
- Non-critical push is **deferred, not dropped**: it is held and released at
  the end of quiet hours, as one coalesced push carrying a count
  (`3 new messages`, not three pushes). A held notification is still
  idempotency-keyed on release, so the release path and the immediate path cannot
  double-notify.
- Email digests respect quiet hours by construction: a digest window that falls
  inside quiet hours is sent at the end of it.
- In-app entries are never deferred. The in-app list is the durable record and is
  the source of truth; a push is a courtesy.
- Users may opt out of *all* non-critical push, in which case critical push
  remains, and there is no setting that removes it.

## 6. Digest vs. immediate for non-critical

| Non-critical kind | Delivery | Why |
|-------------------|----------|-----|
| `message.received` | Immediate push (unless quiet hours) + in-app; email in digest | Delay on a message is the single most common complaint in messaging products, and the user is in a live conversation |
| `match.created` | Immediate push + in-app; email in digest | A new match is the product's payoff moment and is time-sensitive; waiting a day is indistinguishable from no match |
| `like.received` | In-app only by default; opt-in push | Very high volume, low information |
| `message.digest` | Email at the next digest window | Reduces channel churn without losing the information |
| `discovery.weekly_digest` | Email, weekly, at the user's chosen hour | A periodic summary is the right shape for a periodic fact |
| `report.received` | In-app immediately, email immediately | The user is waiting on a confirmation while they compose the report |
| `match.ended_by_other` | In-app immediately; push only if quiet hours are not active | The user may not want a push about a relationship ending |

Digest windows: message/notification email digest hourly, aligned to the hour;
discovery digest weekly on the user's chosen day and hour. A digest is rebuilt
from the event log, so a digest entry that is also sent individually is
deduplicated by the same idempotency key with a `:digest` suffix on the window.

## 7. Reliability

- Delivery is **at-least-once**, and every channel adapter is idempotent on
  `(recipientUserId, idempotencyKey)`. A provider retry, a redelivered event, or
  a restarted worker therefore produces exactly one user-visible notification.
- The idempotency record is retained for **30 days**. Beyond that, a replay is
  possible in principle; the acceptance criterion is "no double-notification
  inside the replay window", not "never, forever".
- A notification that fails on every channel retries with exponential backoff
  (1 min, 5 min, 30 min, 6 h) and then emits `notification.failed`. A failed
  *critical* notification raises a reliability alert: an undelivered enforcement
  notice is an operational incident, not a metric.
- **Partial failure is not user-visible for critical notices.** The in-app record
  is written transactionally with the notification request; if push and email
  fail, the user still sees the notice in the app on next sign-in. If the
  in-app record itself cannot be written, the source event is not acknowledged
  and is redelivered.
- Notification dispatch latency p95 ≤ 30 s from the source event is an SLO; see
  [Product Quality & Measurement](./product-quality-and-measurement.md) §5.

## 8. Cross-references

- [Privacy & User Settings](./privacy-and-user-settings.md) §2 rows 16–21 — the
  notification preferences this spec reads; §5.2 — why the blocked party gets
  generic end-of-contact copy.
- [Product Quality & Measurement](./product-quality-and-measurement.md) §2.6 —
  the notification event index; §4 — notification idempotency keys; §5 — the
  dispatch SLO and the failed-critical-notice page.
- [Account Restrictions & Re-verification](./account-restrictions-and-reverification.md)
  §6 — the enforcement copy and the appeal route the critical notices point at.
- [User Safety Controls](./user-safety-controls.md) §10 — the in-app string
  catalogue this spec defers to.


## 9. Measurement

Notification events are indexed in the taxonomy of
[Product Quality & Measurement](./product-quality-and-measurement.md) §2:
`notification.dispatched`, `notification.suppressed`, `notification.failed`.
There is no notification-specific metric in issue #1's list, so the only
notification measures the MVP commits to are dispatch reliability, dispatch
latency, and suppression rate — the last one as a support signal, because a
suspiciously high suppression rate on a category is more likely a bug than a
preference.

## 10. Open questions

- Should `like.received` be a per-user toggle or a single global switch? Drafted
  per-user, because "I want to know but not on my phone" is a real preference.
- Email provider and whether a queued critical email may be sent during a
  provider outage, or must wait. Current assumption: retry and alert, never
  silently drop.
- Whether a `warn` outcome (#13) should also generate an in-app persistent
  banner beyond the notification. Deferred to
  [Account Restrictions & Re-verification](./account-restrictions-and-reverification.md).
- Whether `discovery.weekly_digest` should use a coarse count or a list of
  first names. Count chosen, because the list is a re-introduction of the
  discovery surface in a channel that is not moderated.
