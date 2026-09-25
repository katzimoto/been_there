# Feature — Account & Onboarding

> Issue [#9](https://github.com/katzimoto/been_there/issues/9) · Parent: [#1](https://github.com/katzimoto/been_there/issues/1)
> Authority: [`docs/architecture/00-overview.md`](../architecture/00-overview.md). If this document contradicts it, that document wins.
> Related designs: Identity & Verification ([#3](https://github.com/katzimoto/been_there/issues/3)), Platform & Privacy ([#8](https://github.com/katzimoto/been_there/issues/8)).
> Adjacent feature specs: [Profile & Personalization](./profile-and-personalization.md) ([#10](https://github.com/katzimoto/been_there/issues/10)), [Preferences & Discovery](./preferences-and-discovery.md) ([#11](https://github.com/katzimoto/been_there/issues/11)), [Account Restrictions & Re-verification](./account-restrictions-and-reverification.md) ([#15](https://github.com/katzimoto/been_there/issues/15)).

## 1. Goal and done-when

**Done when:** a legitimate adult can install, create an account, prove ownership
of a contact channel, pass the age gate, verify their identity, build a complete
profile, set discovery preferences, and appear in discovery — and can later log
in, log out, recover access, and delete their account under a stated retention
rule.

The paths in this document are written as steps that a client, a test, or a
moderator can each execute. Anything stated as "must" is a contract; anything
uncertain is in §13.

## 2. Boundary

This is a **feature specification**, not a state owner. The onboarding funnel
orchestrates other domains' states; it never holds a copy that can disagree with
them.

| Piece of state | Owning domain | How this feature reads it | Never owned here |
|---|---|---|---|
| `IdentityState` (`unverified … expired`) | Identity & Verification | `identity.status_changed` → versioned projection | Any local copy of verification state or evidence |
| `AccountState` (`active limited suspended banned`) + capability set | Moderation & Enforcement | `account_state.changed` → versioned projection | Any write to account state; any inference of *why* a state exists |
| Credential, session, contact-verification, rate-limit | Platform (authn) | Platform command interface | Storing a password or a recovery token outside Platform |
| Profile content, completeness, profile state | Dating Core | `profile.published` / owner profile projection | Profile fields (see [Profile & Personalization](./profile-and-personalization.md)) |
| Discovery preferences and eligibility | Dating Core | `DiscoveryStandingProjection` (fed by `identity.status_changed`) and `AccountStandingProjection` (fed by `account_state.changed`) | Candidate ordering, filters, or the eligibility rule itself |
| Risk state | Trust & Safety | never read by product surfaces | Risk, detectors, scores |
| Reports, cases, evidence, retention | Moderation & Enforcement | moderator-only surfaces | Deleting evidence on user request |

Explicit non-ownership, restated because it is the most common way this feature
goes wrong:

- This feature never sets an account state. A user who fails verification is
  `verification_failed` **identity**, not `suspended` **account**.
- No product surface renders a risk level, a report count, or a moderation reason.
- The onboarding funnel does not decide who is a good user. It decides whether the
  path to discovery has been completed.

## 3. The first-launch path

Steps are ordered. "Blocking" means the user cannot advance past the step in this
session. "Deferrable" means the user may skip it now and continue inside the
product, but the product is unreachable without it.

| # | Step | Owner | Blocking? | Skippable? | Discoverable after this step? |
|---|---|---|---|---|---|
| 0 | First launch, install attribution | Platform | no | yes | no — no account exists |
| 1 | Sign up: email + password, accept nothing yet | Platform | **yes** | no | no |
| 2 | Contact verification (email link, phone OTP) | Platform | **yes** | no | no |
| 3 | Age gate: date of birth, computed server-side | Platform (stores DOB) | **yes** | no | no |
| 4 | Terms + privacy policy acceptance | Platform | **yes** | no | no |
| 5 | Discovery coarse-location grant (city area, not a coordinate) | Platform | no | yes, re-promptable | no |
| 6 | Identity verification: selfie + liveness | Identity | **no** | yes, once, deferrable | **no** — `verified` is the only discoverable state |
| 7 | Build profile: name, photos, bio, intent, prompts | Dating Core | no | yes, in-app | no — profile not yet `live` |
| 8 | Set discovery preferences | Dating Core | no | yes, in-app | no |
| 9 | Photo screening + likeness check resolve | Identity / Moderation | no | no | no |
| 10 | **Enter discovery** | Dating Core | — | — | **yes** |

Where the user stops being discoverable, stated once and precisely:

> A user is discoverable **iff** `identity.state === 'verified'` **and**
> `account.state === 'active'` **and** the profile is `live` **and** discovery
> preferences are set. The `verified` clause is a property of the identity
> transition table, not of this funnel: there is no onboarding path, no retry
> counter, no support override and no test fixture that reaches discovery with a
> non-`verified` identity.

The funnel may reorder steps 5 and 6/7, and may re-ask step 3 after a
`verification_failed`; it may never skip 1–4.

Re-entry after a deferral: the app's home surface is a *readiness checklist* driven
by the projections above, not a hard-coded "you are not verified" flag. Removing
an item from the checklist is driven by an event from its owner, so the checklist
cannot drift from the truth.

<!-- contract sketch: illustrative shape, not an implemented API -->
```ts
/**
 * CONTRACT SKETCH — not an implemented API.
 * The readiness projection a client renders. Every field is a copy of another
 * domain's state, carried by that domain's event; the platform never writes one.
 */
interface OnboardingReadinessProjection {
	readonly version: number; // monotonic; a stale read re-fetches
	readonly accountId: string;
	readonly contactVerified: boolean; // owner: Platform
	readonly ageGatePassed: boolean; // owner: Platform
	readonly termsAcceptedVersion: string | null; // owner: Platform
	readonly identity: {
		readonly state: 'unverified' | 'pending' | 'verified' | 'review_required' | 'verification_failed' | 'expired';
		readonly discoverable: boolean;
	};
	readonly profileState: 'draft' | 'incomplete' | 'live' | 'paused' | 'hidden';
	readonly preferencesSet: boolean; // owner: Dating Core
	readonly outstanding: readonly OnboardingStepId[];
}

type OnboardingStepId =
	| 'contact_verification'
	| 'age_gate'
	| 'terms'
	| 'identity_verification'
	| 'profile'
	| 'preferences'
	| 'photo_screening';
```

## 4. The age gate

### 4.1 What is asked

A date-of-birth field, month/day/year (no free-text, no "how old are you" stepper —
a stepper is trivially lied to and produces a wrong age band). The age is computed
**server-side** from the submitted date at the moment of submission, using the
account's declared region calendar. The client may not submit an age, and a
submitted `ageYears` is rejected.

The privacy spec ([#17 §4](./privacy-and-user-settings.md)) records the age gate
as attestation-based. A bare attestation — "I am 18 or over", a checkbox — is
kept as a separate recorded fact, but it is **not** the gate: anyone can attest
to anything, and a gate that accepts a promise is not a gate. The date of birth
is what the gate computes from; the attestation records that the user was told
the rule and agreed to it.

### 4.2 What the user is told

> **"Been There is 18+."**
> We ask for your date of birth so we can keep the community adults-only. Your
> date of birth is never shown to anyone. Other members see only your age range —
> something like "late 20s" — never a number and never an exact age.

If the computed age is below 18:

> **"We can't create an account for you yet."**
> Been There is for adults 18 and over. Please come back when you are 18. We
> haven't created an account or sent any email.

Consequences of an under-18 result, all of them deliberate:

- No `Account` row is created, no contact-verification message is sent, no
  verification provider is called. A rejected sign-up leaves no account-shaped
  residue.
- The rejection is counted for the funnel (§11) with a coarse `ageBand: 'under_18'`
  marker. The exact date of birth is never stored, hashed into an identifier, or
  written to analytics.

### 4.3 What is stored, and with which sensitivity

| Field | Class | Owner | Rule |
|---|---|---|---|
| `dateOfBirth` | `user` | Platform | Owner-only. **Never rendered, in any surface, ever** — not to the owner, not to staff, not in a receipt. Read access is limited to the age computation and is logged. |
| `ageYears` (derived) | `user` | Platform | Owner-only, never displayed. Derived at each read, not persisted as a drifting copy. |
| `ageBand` (exposed) | `public` | Dating Core projection | The **only** form any other user ever sees. Computed by Platform from the date of birth; the band is what crosses the boundary, the age is not. |
| `isMinor` / `ageGateFailed` | `internal` | Platform | Eligibility reason. Consumed by onboarding and by Trust & Safety intake; never rendered as an age. |
| Verification evidence (selfie, liveness) | `sensitive` | Identity | Owned by Identity. This feature never reads it ([#3](https://github.com/katzimoto/been_there/issues/3)). |

No domain other than Platform receives `dateOfBirth`. Trust & Safety receives
`ageBand` and an `internal` `underAgeSignal: boolean` derived by Platform, so no
safety detector needs a birth date to do its job.

### 4.4 The age band, and why it is five years wide

Bands are half-open, five years each, floored at 18:

```
18-22  23-27  28-32  33-37  38-42  43-47  48-52  53-57  58+
```

Band width **w = 5** is the decision. The trade-off is that a band must be coarse
enough that a stated age is not a quotable, correlatable identifier, and narrow
enough to keep an age preference filter and a first conversation meaningful. The
reasoning behind 5 specifically:

- **Coarse enough.** A band's job is to make "how old is this person exactly?"
  unanswerable. With a public photo, a city, a job-shaped bio and an exact age,
  a person is often identifiable; with a five-year band the same tuple is shared
  by a large group, and the combination stops being a lookup key. Narrower bands
  (2–3 years) shrink the anonymity set sharply, and the protection comes mostly
  from the *label*, not the number — a client that prints "29" has thrown away the
  whole design, which is why the client is specified to receive the band only.
- **Narrow enough.** A 10-year band makes discovery filters and conversation
  awkward ("are we in the same band?" becomes a coin flip for a 19 and a 29), and
  makes the 18+ floor blur at the youngest band. Five keeps the youngest band
  (`18-22`) narrow enough that the adult boundary is visible in the product.
- **Stable.** Five divides evenly through the ranges people actually use when
  describing themselves ("early 30s", "late 20s"), so the label is native rather
  than a computed artefact.
- **Filtering happens on bands only.** Age preference filters
  ([#11](https://github.com/katzimoto/been_there/issues/11)) compare band
  intervals, never exact ages, so widening the band never leaks a range the user
  did not consent to.

The band label rendered to another user is a phrase (`"late 20s"`,
`"early 30s"`), and the band's bounds are never printed in the same surface as
the label.

## 5. Sign-up

### 5.1 Validation rules

| Rule | Value | Failure |
|---|---|---|
| Email | RFC-shaped, ≤ 254 chars, lowercased, punycode-normalised domain; must not be a role/disposable domain from a Platform-maintained list | `validation_failed` with field `email` |
| Password | ≥ 10 chars, ≤ 200, no composition rules; checked against a breached-password list at set and at login | `validation_failed` with field `password`; breached ⇒ `validation_failed` + `password_known_breached` |
| Date of birth | A real calendar date, not in the future, age ≥ 18 | `not_eligible` (§4.2) |
| Terms | `termsVersion` accepted, equal to the currently published version | `validation_failed` with field `terms` |
| Rate limit | ≤ 5 sign-up attempts per IP per hour, ≤ 3 per contact identifier per day | `rate_limited` |

No CAPTCHA on the happy path. If a sign-up attempt trips a risk signal, the
challenge is a single invisible check plus a contact-verification delay — an
explicit friction step is a detector's proposal, and per the architecture it may
never become an enforcement decision.

Deliberately absent from validation: real-name matching, government ID, address,
and any question whose honest answer a legitimate user would not want recorded.

### 5.2 Contact verification

- One verified channel is required. The sign-up form offers email or phone; the
  channel the user already entered is the one offered first, and phone is offered
  as an upgrade when the email domain looks disposable or is already in use.
- Email: single-use link, 15-minute expiry, one active link at a time, new link
  invalidates the old. Phone: 6-digit OTP, 5 attempts, 10-minute expiry, 60-second
  resend floor.
- Codes and links are compared in constant time. All failures return one message
  (see §9) so the form is not an account-existence oracle.
- Verification state lives in Platform and is exposed to the product only as
  `contactVerified: boolean`. The product never sees the address or the number it
  belongs to.
- **Unverified contact is blocking.** It is what makes recovery possible, and
  recovery is the weakest link in the account lifecycle (§7).

### 5.3 Duplicate accounts

One verified contact identifier → one account. Resolution order:

1. **Exact contact match, account active.** No merge, no second account. The
   response is the same "check your email" copy; the existing owner is notified
   ("someone tried to sign up with your email") and the attempt is counted as
   `identity.duplicate_account_signal`. This is the response to a person signing
   up twice by accident, and it is also the response to an attacker probing for
   existence — which is why the *submitter* is not told.
2. **Exact contact match, account `suspended` or `banned`.** Sign-up is refused
   with generic copy. The moderation standing and the case behind it are never
   surfaced; the new `AccountId` is attached to the existing subject for
   correlation and a case is opened by Moderation under its own rules, not by this
   feature.
3. **No contact match.** A new account is created.

There is no "merge my accounts" in v0.1. A duplicate-account claim routes to
support, which routes to a moderator (the merge would otherwise let a banned
subject launder a ban).

Device-level fingerprint similarity (same device, many contacts) is a
`sensitive` signal raised to Trust & Safety. It may open a case. It never blocks
sign-up by itself and never sets an account state — a detector proposing is not
enforcement.

## 6. Login and sessions

| Property | Value |
|---|---|
| Session lifetime | 30 days rolling, refreshed on activity; idle timeout 14 days |
| Re-authentication required for | deletion, recovery, email/phone change, view of verification evidence |
| Session storage | Opaque server-side session id in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; rotated on every privilege change |
| Concurrent sessions | 10 per account; the 11th evicts the oldest and notifies the owner |
| Failed login | ≤ 5 per account per 15 min, then progressive delay; generic failure copy |
| Post-login check | Account standing is read before the home surface renders. A `banned` account never gets a normal product surface. A `suspended` account gets a suspension notice and, where the standing still allows it, `report` and `delete_account` — the exact capability set comes from the Moderation projection, never from this document. |

"Show my sessions" is a Platform surface: device, coarse city, last-seen, current
marker. It is owner-only (`user`).

### 6.1 Logout

- **This device** — revokes the current session, clears its cookie, returns to the
  marketing surface. Conversation state is untouched on the server.
- **All devices** — revokes every session, clears all cookies, emits
  `account.session_revoked` (analytics) and `auth.session_revoked` (audit), and
  sends a notification to the verified channel: *"We signed you out on all
  devices. If this wasn't you, secure your account now."* The notification is
  sent on success, always, even
  when the requester triggered it from a compromised session — the owner is the
  person who needs to know.

## 7. Account recovery

Recovery exists for the case where a legitimate adult cannot get in. Its design
constraint is that it must be useful to that person and useless as a harassment
channel against them.

### 7.1 The flow

1. **Request** — email or the phone number on file. Rate-limited to 3 per account
   per day and 5 per source address per day.
2. **Neutral request response** — identical whether or not the account exists, and
   whether or not the identifier matches:
   > "If that account exists, we've sent a link. It expires in 30 minutes."
3. **Factor of possession** — the reset link (email) or a 6-digit code (phone).
   Possession of the contact channel is the whole proof; there is no
   security-question fallback and no email-plus-DOB fallback, because those are
   guessable from a public profile and from a data breach respectively.
4. **Reset** — new password, **every existing session revoked**, every "remember
   this device" record cleared, recovery-mode exited.
5. **Security events** — `auth.recovery_completed` and `auth.session_revoked` are
   written to the audit log, and the owner is notified on the verified channel
   with the device list that was revoked.

A `unverified` or `expired` identity does not block recovery — recovery is access,
not eligibility. A `banned` account can be recovered into; it lands on the
suspension notice, which is the correct product behaviour and is the same for
"recovered" and "signed in".

### 7.2 Using recovery as a harassment channel

The attack is: a third party repeatedly requests recovery for a victim, using it to
(later) lock them out, to probe whether they are on the platform, or to trigger
notification spam.

| Defence | Rule |
|---|---|
| No notification to the requester | The requester receives nothing that distinguishes an existing account from a typo. There is no "a recovery was requested for your account" message, ever, sent to anyone but the verified channel after a *successful* recovery. |
| No notification flood to the victim | Failed attempts do **not** notify the victim. Notifying per attempt hands the attacker a notification oracle and turns recovery into a harassment tool aimed at the victim. |
| Silent escalating friction | Attempts 1 and 2 proceed normally. The 3rd attempt inside a 24-hour window pauses recovery for that account, and the only remaining remedy is the other verified factor. The owner is told once: "we paused sign-in recovery on your account after repeated attempts — your account is fine and nothing was changed." That message is safe to send: it discloses nothing the attacker does not already know, and it is only reachable by the account's real owner because it is delivered to the verified channel. |
| Signal to safety, not enforcement | A burst of recovery attempts against one account publishes `auth.recovery_abuse_suspected`. Trust & Safety decides whether a case is opened. No account state changes; a locked recovery is a Platform access control, not a moderation verdict, and it is not shown to the account as a restriction. |
| Phone-upgrade | If email recovery is the channel being abused, the account's recovery is switched to the phone factor, and the victim is told how to change channels in the same notice. |

The invariant: **the account owner learns that recovery was used against them
exactly once, after it succeeded or after the abuse threshold was crossed — never
on a per-attempt basis, and never in a form that confirms anything to the
attacker.**

## 8. Account deletion

Deletion is a first-class product feature, not a support action, and it is
executed as a job with a reversible window, not as a request to a human.

### 8.1 Request and the undo window

- Entry points: Settings → Delete account; and, for a `banned` or `suspended`
  account, the standing screen (the capability set already grants
  `delete_account`).
- Confirmation: type the phrase `delete my account`, then re-authenticate. A typed
  confirmation is deliberate: this is irreversible after the window, and a
  destructive one-tap is how an accidental deletion happens.
- **30-day undo window.** During it: sign-in is blocked, the account is
  `hidden` from discovery and from messaging, and a single email is sent to the
  verified channel with a restore link. Restoring cancels the job, re-applies the
  account standing, and returns the profile to its prior state.
- After 30 days the job runs to completion and cannot be undone.

### 8.2 What happens to each thing

| Data | Action | Why |
|---|---|---|
| Profile fields, photos, prompts, bio, interest selections | **Deleted** | Pure product content. No safety value after the account is gone. |
| Messages sent and received | **Deleted** for the user who deleted; retained in `restricted` tombstoned form for the *other* party for a short defined window (90 days proposed — the duration is open, §13) | Content that still exists for the other person must not silently vanish from their side; it is tombstoned, then purged. |
| Matches | Deleted | No residual discovery coupling. |
| Likes (given and received) | Deleted | Same. |
| `dateOfBirth`, contact identifier, password hash | **Deleted** | The strongest identifiers are removed with the account. |
| Exact location, device identifiers, raw IP history | **Deleted** | No retention basis; already over-collected. |
| Verification evidence (selfie, liveness artefacts) | **Deleted** under Identity's retention rule | Identity evidence exists to answer a verification question; once the subject is gone, keeping biometrics on file is the highest-harm retention in the system. |
| Reports **filed by** the user, and report evidence attached to them | **Retained**, `restricted` | The right to report and the evidence behind a case are not the reporter's to erase. See below. |
| Moderation cases naming the user, moderator decisions, audit log | **Retained**, `restricted` | Below. |
| Risk state and detector history | **Retained**, `internal`, detached from the identity | A pattern that only appears over months is the asset; a single account's snapshot is not. |
| The account row itself | **Anonymized, not erased** | The row becomes `deleted` with a salted pseudonym, retaining only what a safety decision needs. |

**The retention basis, stated plainly.** Moderation evidence and the audit log are
retained because the platform must be able to answer, months later and in front of
a regulator, a question of the form *"did this person, or this pattern, take
action against a named user, and on what evidence did we act?"* That answer is
impossible if the evidence disappears the moment a subject asks us to forget them,
and it is a defence obligation, not a convenience. The same records are what allow
a re-registered account to be recognised as the same subject. Everything retained
is minimised to that purpose, held at `restricted` with per-access logging, purged
on the retention schedule in §13, and never used for advertising or profiling.

The identity is anonymised, not merely deleted: the row keeps a stable salted
pseudonymous `SubjectId` so that a future account on the same contact point, or
with the same photos, can be linked to a moderation history **by a human moderator
reviewing a case**, never automatically and never in the product.

### 8.3 Re-entry rules

| Situation | Rule |
|---|---|
| Restore inside 30 days | Full restore, including photos and messages. No new verification. |
| Re-register after 30 days | Allowed. Treated as a **new account**: new `AccountId`, new identity verification, no data restored. |
| Re-register with a previously deleted contact point | Allowed after the grace period, but the account starts with `suspicious_reentry: true` (`internal`): the re-verification likeness check runs, and photo upload is perceptual-hash-deduplicated against the deleted account's photo hashes. A match on a protected subject's photos routes to a case, and a human decides. |
| Re-register while a case is open or the prior standing was `banned` | Sign-up is allowed but the new account is not discoverable until Moderation has reviewed the re-entry. The user sees "we're checking your new account before it appears in discovery" — a real explanation, no case detail. |
| A deleted account's moderation outcome | Still stands for the pseudonymous subject. Deleting the account is not a way to shed a ban; it only removes the user's own ability to use the product. |

## 9. Every failure the user can hit, and the copy

A failure a user cannot act on is a defect. Every row below has at least one
action that changes the outcome, and every row has a defined resulting state.

| Situation | Copy (title — body) | Actions | Resulting state |
|---|---|---|---|
| Email/phone code wrong or expired | **That code isn't right.** Codes expire after 10 minutes — request a new one. | Resend, change channel | Still unverified; attempt counted |
| Code entered too often | **Too many tries.** Wait 10 minutes, then try again. | Wait (timer shown) | Locked 10 min |
| Verification link already used | **This link has already been used.** For your security each link works once. | Request a new link | Still unverified |
| Under 18 | **We can't create an account for you yet.** Been There is for adults 18 and over. We haven't created an account or sent any email. | Leave | No account created |
| Impossible date of birth | **That date doesn't look right.** Check it and try again. | Edit | On the age gate |
| Terms version changed under them | **We've updated our terms.** Have a read, then accept to continue. | Read, accept | On terms step |
| Identity verification failed | **We couldn't verify this time.** This is more often a lighting or framing problem than a real one. Try again in good light, holding your phone at eye level. | Retry now, see tips, contact support | `verification_failed`; **not** discoverable; **not** an account penalty |
| Verification retried too soon | **Give it a moment.** You can take a new selfie every 15 minutes, up to 5 a day. Your verification isn't affected — this only paces the attempts. | Wait (timer shown), see tips, contact support | Still `verification_failed`; **not** an account penalty |
| Verification attempts exhausted today | **That's a lot of tries for one day.** Come back tomorrow and we'll pick up where you left off — your verification is unaffected. | Come back tomorrow, contact support | Still `verification_failed`; **not** an account penalty |
| Verification needs a human | **We're double-checking your account.** Most checks finish within 24 hours. Nothing is needed from you; if we need more, we'll email you. | Dismiss, check email | `review_required`; not discoverable; **no** risk level shown |
| Verification expired after 90 days | **Your verification needs a refresh.** It takes about a minute — photo and a quick selfie. | Re-verify | `expired`; not discoverable; profile preserved |
| Identity looks inconsistent with the profile | **Your photos need another look.** One of your profile photos doesn't match the person in your verification photo. Replace it to keep appearing in discovery. | Replace photo, appeal | Profile `incomplete`; not discoverable; identity untouched |
| Account limited | **Some features are turned off on your account right now.** You can keep using the app, but you can't [named capabilities] until [date or case outcome]. | View details, appeal, report, delete account | `limited` (Moderation-owned) |
| Account suspended | **Your account is suspended.** You can still report a problem and delete your account. Appeals are open. | Appeal, delete | `suspended` |
| Account banned | **This account is closed.** You can still appeal and delete your account. | Appeal, delete | `banned` |
| Sign-up blocked by rate limit | **Too many attempts from this network.** Try again later, or use a different network. | Wait | No state change |
| Email domain rejected | **We can't use that email address.** Use a personal email address, or continue with a phone number instead. | Use phone | On sign-up |
| Password breached | **That password has appeared in a data breach.** Choose a different one. | Choose new password | On sign-up |
| Sign-in fails (wrong password) | **That email and password don't match.** | Retry, forgot password | No state change |
| Sign-in fails (account unknown) | *identical copy* | — | No state change; attempt counted |
| Recovery requested for an unknown email | **If that account exists, we've sent a link.** | — | No state change |
| Recovery locked by abuse threshold | **We paused sign-in recovery on your account after repeated attempts.** Your account is fine and nothing was changed. You can restore recovery immediately by signing in on a device you're already logged in on. | Sign in, or change the recovery factor | Recovery paused; account untouched |
| Session expired | **You've been signed out for security.** Sign in again to pick up where you left off. | Sign in | Session revoked |
| Deletion scheduled | **Your account will be deleted in 30 days.** You can restore it any time before then from the link we emailed you. | Restore now | `hidden`, discovery off, messaging off |
| Deletion completed | **Your account is deleted.** | — | Terminal |
| Something we did not anticipate | **Something went wrong on our side.** We've logged it — nothing was lost. Try again. | Retry, contact support | No state change |

Two copy rules hold across the table: (1) no copy reveals that a moderation case,
report, or risk level exists; (2) no copy ends without an action, and the actions
never include "contact a moderator" except through the appeals path that
Moderation owns.

## 10. Rate limits

| Action | Limit | On breach |
|---|---|---|
| Sign-up per IP | 5 / hour | `rate_limited` |
| Sign-up per contact identifier | 3 / day | `rate_limited` + `identity.duplicate_account_signal` |
| Login per account | 5 / 15 min, then exponential delay up to 15 min | Delay, `account.session_failed` |
| Password reset per account | 3 / day | Recovery paused 24 h (§7.2) |
| Verification code attempts | 5 per issued code | Code invalidated, 10 min lock |
| Verification link re-issues | 3 per hour | `rate_limited` |
| Deletion re-issue | once per 30 days | Restore, then a new request |

A rate limit is a Platform access control. It never sets an account state, never
appears in the product as a restriction, and never reaches a moderator queue on
its own.

## 11. Events emitted for measurement ([#18](https://github.com/katzimoto/been_there/issues/18))

Names come from the Platform catalogue (`packages/platform`), not from a local
literal. The convention is `<domain>.<object>_<past_tense_verb>`, and there are
**two sinks with different rules**:

- **Analytics** — aggregate, sampled, for the funnel in #18. Content never
  enters it: no bio, no prompt text, no user-visible copy, no identifiers, no
  exact coordinates, no dates of birth.
- **Audit** — complete, append-only, for security, safety and enforcement
  facts. Identity and moderation facts are audit-only; a product domain never
  re-emits them as analytics events.

Every event carries the standard `packages/core` envelope (`eventId`, `type`,
`version`, `occurredAt`, `actorId`, `subjectId`, `correlationId`, `sensitivity`).
`correlationId` is the **onboarding run id**, which makes the funnel one joinable
series; the per-install key is the platform's `user_journey_id`, which survives
sign-up so pre- and post-registration steps join.

### 11.1 Analytics — the #9 funnel

Every name and dimension below is registered in the Platform catalogue
(`ANALYTICS_EVENTS`) and is imported, never re-declared. The recorder rejects any
undeclared dimension, so a new field here is a catalogue change, not a call-site
change.

| Event | Dimensions | Funnel position |
|---|---|---|
| `account.app_opened` | `surface`, `journey_id` | 0 — first launch |
| `account.registration_started` | `contact_kind: 'email' \| 'phone'` | 1 |
| `account.registration_completed` | `contact_kind` | 1 — verification message sent |
| `account.registration_rejected` | `reason_code: 'under_18' \| 'invalid_input' \| 'duplicate' \| 'rate_limited' \| 'breached_password' \| 'domain_not_allowed'`, `age_band` | drop-off at 1 |
| `account.onboarding_step_completed` | `step: 'contact_verification' \| 'age_gate' \| 'terms' \| 'location'`, `source` | 2–5 |
| `account.onboarding_step_failed` | `step`, `reason_code` | drop-off at 2–5 |
| `account.session_started` | `surface`, `auth_method: 'password' \| 'recovery'` | re-entry |
| `account.session_failed` | `reason_code`, `auth_method` | — |
| `account.recovery_started` | `contact_kind` | — |
| `account.recovery_completed` | `sessions_revoked_count` | **security metric** |
| `account.recovery_locked` | `reason_code: 'abuse_threshold' \| 'rate_limit'`, `window_hours` | — |
| `account.session_revoked` | `scope: 'this_device' \| 'all_devices' \| 'recovery' \| 'limit' \| 'enforcement'` | — |
| `account.deletion_requested` | `retention_bucket` | — |
| `account.deletion_cancelled` | `retention_bucket` | — |
| `account.deletion_completed` | `retention_bucket` | — |
| `account.capability_denied` | `capability`, `reason_code` — **never a case id** | — |
| `profile.published` | `surface` | 7 — the funnel's real terminal for this feature |
| `discovery.entered` | *(Dating Core domain event; #9 consumes it, never re-emits it)* | 10 |

`age_band` is a band, never an age and never a date. Dimensions are names and
buckets; a **value** is never a dimension — no free-text reason, no copy, no
identifier.

`journey_id` is a random per-install id generated on first launch. It is never
derived from a user id, never reused across installs, and never written to an
audit event. If that guarantee cannot be made for a surface, the surface emits
`is_new_install` + `surface` instead and the funnel loses one joinable series,
which is a better outcome than a stable cross-install identifier.

### 11.2 Audit-only — security and safety facts

Names under the `auth.`, `identity.`, `case.` and `account_state.` prefixes are
**audit-required by construction**: the platform's router returns
`{ audit: true, analytics: false }` for them, so a bug cannot promote a safety
fact into a metrics sink.

| Event | Fields | Consumer |
|---|---|---|
| `auth.recovery_requested` | `recovery_id`, `method`, `status` | #18, Trust & Safety |
| `auth.recovery_completed` | `recovery_id`, `method`, `status`, `attempts`, `revoked_session_count` | Trust & Safety, #18 |
| `auth.session_revoked` | `scope`, `revoked_count`, `reason` | #18, Trust & Safety |
| `auth.recovery_abuse_suspected` | `attempt_count`, `window_hours`, `distinct_sources` | **Trust & Safety** |
| `identity.duplicate_account_signal` | `matched_contact_kind`, `prior_account_standing` (coarse) — `sensitive` | Trust & Safety |
| `identity.status_changed` | *(Identity owns it)* | the **product** projection only |
| `account_state.changed` | *(Moderation owns it)* | the **product** projection only |

The two deliberately-audit-only signals, and why:

- `identity.duplicate_account_signal` describes *another* person's account
  standing and touches contact data. In analytics it would let a metrics query
  answer "how many of today's sign-ups matched a banned account" about real
  people. It is a safety signal, not a funnel metric.
- `auth.recovery_abuse_suspected` is a claim about someone's account security
  posture. It reaches Trust & Safety and a moderator; it never becomes a chart.

### 11.3 How the verification portion of the funnel is measured

The product subscribes to `identity.status_changed` at `public` clearance to
advance its own readiness projection — a client must be able to ask "is the
current user verified?" without a cross-domain call. The **metrics sink never
receives that stream**. The funnel counts registrations from
`account.registration_completed` and joins the two series in analysis, so the
pairing is stated here so that nobody later "fixes" the funnel by subscribing
analytics to identity.

Event rules:

- **No payload ever contains** a date of birth, an exact age, a coordinate, a
  password, a code, a contact identifier, a bio, a prompt answer, or any
  verification artefact. The recorder refuses `userId`/`subjectId`/`caseId`/
  `email`/coordinates/content fields outright, and audit records are written
  without the email, the phone number, or the token.
- One event per logical attempt, keyed by
  `idempotency_key = journey_id + step + attempt_number`, so a double-tap or a
  retried request cannot double-count the funnel.
- `account.capability_denied` carries the capability and a coarse reason code so
  #18 can measure friction without any product surface learning *why* a
  capability was removed.
- `auth.*` and `identity.duplicate_account_signal` are consumed only by Trust &
  Safety, Moderation and #18, and are never part of a product read-model.


## 12. Acceptance scenarios

Given/when/then, mapped to the scenarios in
[#1](https://github.com/katzimoto/been_there/issues/1).

**A1 — Legitimate onboarding** (issue #1 scenario 1)

- *Given* an adult with a valid email address and a phone number,
  *when* they sign up, verify the contact, enter a date of birth that computes to
  19, accept the current terms, complete selfie + liveness verification, publish a
  profile that meets the completeness rule set, and set discovery preferences,
  *then* the account exists, `identity.state === 'verified'`, `account.state ===
  'active'`, the profile is `live`, and the user appears in discovery.
- *And* at every point before the last step, the user is **not** discoverable, by
  construction rather than by a check.
- *And* the funnel emits one `account.onboarding_step_completed` per completed
  step, one `profile.published`, and one `discovery.entered` for the run.

**A2 — Verification failure is not a dead end**

- *Given* an account whose identity is `verification_failed`,
  *when* the user retries from the failure screen,
  *then* the attempt is allowed, subject to `ATTEMPT_POLICY` (5 attempts per rolling day, 15-minute retake cooldown) — a refusal is a `rate_limited` error carrying `retryAt`, and the screen renders "Try again in {minutes}" rather than a dead "Try again now",
  and* no capability is lost and `verification_failed` is not an account state: the account remains
  `active` and the user can still delete it, report, or contact support.

**A3 — Under-18 sign-up leaves no account**

- *Given* a date of birth that computes to 17,
  *when* the user submits it,
  *then* no account is created, no verification message is sent, and the user is
  told the product is 18+, with no action other than leaving.

**A4 — Age is never exposed as a number**

- *Given* any two users,
  *when* one views the other in discovery, in a match, or in an export,
  *then* the age appears only as a band phrase, the user's exact age is nowhere
  retrievable, and no API response in either direction contains `dateOfBirth` or
  `ageYears`.

**A5 — Recovery protects the account owner** (issue #1 scenarios 4, 6)

- *Given* a user who has completed recovery,
  *when* recovery succeeds,
  *then* every prior session is revoked, an `auth.recovery_completed` audit record
  and an `account.recovery_completed` metric are written, and the owner receives a
  notification listing what was revoked.
- *Given* an attacker issuing recovery requests against a victim,
  *when* the attempts pass the abuse threshold,
  *then* recovery pauses for the account, the owner is told once that their
  account is untouched, an `auth.recovery_abuse_suspected` signal reaches Trust
  & Safety, and **no** account state changes without a moderator and a case.

**A6 — Deletion is honest about what survives**

- *Given* a user who has reported a harasser and then deletes their account,
  *when* the 30-day window elapses,
  *then* their profile, photos, messages-to-others and identifiers are deleted, the
  case and its evidence survive in anonymized `restricted` form, and the deletion
  summary states both halves of that in the user's own terms.

**A7 — Enforcement stays human** (issue #1 scenarios 5, 6)

- *Given* any account,
  *when* any amount of onboarding, verification, or recovery pressure is applied,
  *then* no transition out of `active` occurs without a `caseId`, and none out of
  `suspended`/`banned` without a `caseId` and a `moderatorId`, and the product
  never renders a reason, a case, or a risk level.

## 13. Open questions

- **Retention duration per market.** §8.2 states that evidence is retained "on the
  retention schedule" but not how long. This needs a per-market regulatory
  answer (GDPR erasure timelines vs. US platform-liability exposure), not a
  technical one, and it is the same open question the architecture overview
  records. Owner: legal. Blocks: the deletion job's purge step.
- **Identity-evidence retention on deletion.** The identity design ([#3](https://github.com/katzimoto/been_there/issues/3)) must state whether selfie/liveness artefacts survive subject deletion, and for how long. §8.2 assumes they do not; if the identity design disagrees, this document is wrong and the disagreement must be resolved in the identity design, not here.
- **Age-band width for markets with a different adult age.** 18+ is assumed throughout. A market with a higher adult age needs a separate gate, and whether the band floor moves with it is undecided.
- **Re-entry detection sensitivity.** Perceptual-hash matching of photos against deleted accounts will produce both true hits and collisions. The threshold that avoids locking out a legitimate person who happens to reuse a stock photo is unmeasured.
- **Whether a deleted account's restore window may be extended** by support on request, and if so under what evidence standard. Currently no.
- **SSO / passkey sign-in.** The session model is designed for it, but no MVP
  issue asks for it; whether it lands in v0.1 is undecided.
