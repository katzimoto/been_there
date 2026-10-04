# Feature — Social Sign-In (Google, Apple, Meta)

> Authority: [`docs/architecture/00-overview.md`](../architecture/00-overview.md). If
> this document contradicts it, that document wins and this document is wrong.
> Platform & Privacy ([#8](https://github.com/katzimoto/been_there/issues/8)) owns
> authn; this feature is a set of rules *inside* that ownership, not a new domain.
> Adjacent specs: [Account & Onboarding](./account-and-onboarding.md)
> ([#9](https://github.com/katzimoto/been_there/issues/9)),
> [Account Restrictions & Re-verification](./account-restrictions-and-reverification.md)
> ([#15](https://github.com/katzimoto/been_there/issues/15)),
> [User Safety Controls](./user-safety-controls.md)
> ([#13](https://github.com/katzimoto/been_there/issues/13)).
>
> **Status: the domain, the schema, the store and the verification are built; no
> route and no button exist.** `packages/platform/src/social-authn.ts`,
> `packages/platform/src/apple-assertion.ts`,
> `packages/database/migrations/009_social_identity.sql`,
> `packages/database/src/store-social-identity.ts` and the ports in
> `packages/contracts/src/stores.ts` are real and tested. There is **no**
> `POST /v1/account-sessions/social`, no provider HTTP client, no authorization-code
> exchange and no UI control, because each of those needs credentials nobody holds
> yet. §8 states exactly what is missing and who must supply it. Nothing in this
> document describes behaviour that does not exist; every "must" in §5 is either
> implemented and named in §9, or listed in §8 as not built.

## 1. Goal and done-when

**Done when:** an adult can create an account by proving control of a Google, Apple
or Meta account instead of choosing a password, land in exactly the same
`unverified` state an email sign-up lands in, pass the age gate from a date they
supply, and sign back in by the provider account they came in with — with no
account ever joined to another by matching an email address, and no provider
assertion, token or claim retained by this platform.

**Not done when**, and each of these is stated as an absence rather than a
promise: a button that signs somebody in without verifying an assertion; an age
gate a provider can satisfy; a provider identity linked to an existing account by
address match; a raw token written to a column.

The properties that make it true are §3, and each has a named test in §9.

## 2. What this owns and never owns

### 2.1 Owns

| Owned | Where it lives |
|---|---|
| The provider vocabulary: `apple`, `google`, `meta` | `SocialProvider`, `app.social_identities`' CHECK |
| The session method a provider sign-in records: `'oauth'` | `SOCIAL_AUTH_METHOD` |
| Which order a social sign-up's checks run in, and what each refusal says | `evaluateSocialSignUp` |
| Whether an account holds a password, and the refusal when one is presented against an account that does not | `resolvePasswordCredential` |
| How a provider-subject assertion resolves to an account, and the refusal when only an address matched | `resolveSocialSignIn` |
| Verifying a Sign in with Apple identity token | `verifyAppleAssertion` |
| The schema for a provider identity, and its uniqueness | `app.social_identities`, migration 009 |

### 2.2 Never owns

| Never owns | Owner instead | Why |
|---|---|---|
| Identity state, verification evidence, `verified` | Identity & Verification | **Commitment 1.** A provider attests *an account at a company*, not *a real person*. Google and Apple will both sign an assertion for an account the holder did not create the person behind. Reading one as verification is exactly the "unverified means discoverable" hole commitment 1 exists to close. |
| The date of birth, its storage, or the age gate | Platform (`age.ts`) | The gate is computed from a calendar date at submission time. §5.2. |
| Terms and the accepted version | The service's `evaluateTermsAcceptance` | Passed into `evaluateSocialSignUp` as a check rather than imported, because Platform does not import service internals. |
| Contact verification — proving the member can receive mail at the address | Platform | A provider's word is recorded as `contact_verified`; it is not a substitute for the channel check that recovery depends on. |
| The OAuth protocol: redirect URIs, authorization codes, PKCE, client secrets, token endpoints | Whoever holds the OAuth credentials (§8) | The protocol work needs a registered client and a redirect URI on a real domain. |
| Identity verification vendor evidence | Identity & Verification | A provider subject is not a selfie, a liveness check or a likeness score. |
| Risk, detectors, cases, enforcement | Trust & Safety, Moderation | No provider field is a safety signal in this build. |

### 2.3 The boundary that shapes this document

Google and Meta sign-in require OAuth client credentials the product owner must
create in two vendor consoles. Sign in with Apple additionally requires a **paid**
Apple Developer team with the Sign in with Apple capability enabled, and the
product owner currently has no team at all. Those are facts about the world, not
about the design, and they are why §8 exists rather than a route.

The verification itself is built anyway, and it is built for real. Apple's
identity token is an RS256 JWT whose public keys are published at a URL; proving
that token is genuine needs none of those credentials.
`packages/platform/test/apple-assertion.test.ts` generates an RSA-2048 key pair
per run, signs tokens with it, and runs the real signature verification — a
fixture key, never a stubbed verifier.

## 3. The six properties

| # | Property | Enforced by |
|---|---|---|
| 1 | A social sign-up creates an **unverified** account. It is not verification and nothing in it may make an account discoverable or skip `identityMachine`. | The validated value has no verification field; the reader refuses `verified` / `identityState` / `verificationStatus` / `contactVerified` by name; no provider table is read by discovery. Commitment 1. |
| 2 | The **age gate still applies.** `dateOfBirth` is required. | `SocialSignUpRequest.dateOfBirth` has no fallback; `evaluateSocialSignUp` runs `evaluateAgeGate`; `readSocialSignUpInput` refuses `age` / `ageYears` / `ageInYears` by name. |
| 3 | Such an account has **no password**, and a password sign-in against it is refused with a clear reason. | `ValidatedSocialSignUp` has no hash field; `account_credentials_method_shape` makes "no hash" mean "social"; `resolvePasswordCredential` returns `permission_denied` / `no_password_credential`. |
| 4 | `contactVerified` is true **only** when the provider attests a verified email, and no claim beyond the stable subject id is retained. | One expression derives the boolean from `emailVerified` alone; `app.social_identities` has four columns and no column for a token, a claim or an address. |
| 5 | Sessions record the method as **`'oauth'`**. | `SOCIAL_AUTH_METHOD`, typed as the existing `AuthMethod`, and the sessions CHECK admits `'oauth'` and no provider name. |
| 6 | A social identity is never linked to an existing account by **matching an email address**. | `SocialIdentityStore` has no finder that takes an address; the resolution refuses when only the address matched. |

### 3.1 Why the age gate is not the provider's to answer

Google supplies a birthday only for accounts that have one, and only under its own
policies; Meta supplies none at all; Apple supplies the address only on the first
authorisation and never a birthday. A provider that could satisfy the gate would
make the gate a claim about a third party's account rather than a fact about the
person, and a person who can satisfy an age gate with a value they typed at another
company has satisfied nothing. So the date is required input on this path exactly
as it is on the email path, the provider's claims are never consulted for it, and a
client-sent `age` is refused by name in both readers.

### 3.2 Why `contactVerified` is narrower than it looks

The boolean is derived from one expression: `emailVerified` as the provider stated
it. It is **not** inferred from an address looking real, from a provider having
returned one, or from the member having typed it. The three cases that matter:

| Provider state | Contact used | `contactVerified` |
|---|---|---|
| Attested a verified address | the attested address | `true` |
| Returned an address but not as verified | the returned address | `false` |
| Returned no address (Meta; Apple after the first sign-in) | the member's own address, which is required | `false` |

The last row is why `contact` is required when the provider attested nothing. The
alternative — creating an account with no contact — would leave recovery and
contact verification with nothing to act on, and this product's recovery path
depends on the contact being a channel mail can reach. An account in that state is
unverified *and* unconfirmed, which is exactly the state an email sign-up starts
in, and the ordinary contact-verification flow confirms it later.

A member who supplies an address that differs from the one the provider verified
is **refused**, not silently resolved either way. Preferring the client's copy
would make `contact_verified` a claim about a string the client chose; preferring
the provider's would ignore what the member typed and change their contact without
telling them.

## 4. What is stored, and what is not

`app.social_identities` has four columns: `user_id`, `provider`,
`provider_subject`, `linked_at`. There is no column for the identity token, the
authorization code, the claims, the provider's response body, or the address the
provider returned. That is not restraint for its own sake:

- A bearer credential from a provider is a secret with a long tail. Storing one
  turns a compromise of this database into a credential that is still good at a
  third party, for as long as nobody revokes it — and this platform would have no
  way to know when to.
- A claims blob is a copy of somebody's account at another company, kept for no
  purpose this product has.
- The address the provider attests already enters through one door,
  `account_credentials.contact_identifier`, under the same normalisation, the same
  disposable-domain refusal and the same unique index as any other contact.

So the question "what does a provider sign-in write?" has a two-element answer, and
the schema is what makes that answer checkable rather than aspirational:
`packages/database/test/migration-009.test.ts` reads
`information_schema.columns` and asserts the four-column list.

`linked_at` records when a provider identity was attached, whether by signing up
with it or by a later member-initiated link. There is no `unlinked_at`: the audit
log is where that history belongs, and a nullable column on the row would be a
second, weaker copy of it.

## 5. The rules

### 5.1 Order of checks

`evaluateSocialSignUp` runs, in this order: contact resolution, the age gate, terms
acceptance. The same order `accounts/sign-up.ts` uses with the password step
removed, for the same reason — the copy in §9 is specific to each failure, so a
member told "that date doesn't look right" must not first be told their address was
unusable.

Nothing expensive sits in this function at all. There is no scrypt call, because
there is no password to hash. That is the one measurable saving a provider sign-up
brings and the only one, and it is stated here so nobody later mistakes it for a
reason the age gate can be skipped for speed.

### 5.2 The age gate

`dateOfBirth` is a required field of `SocialSignUpRequest`. It is parsed by
`readDateOfBirth` and evaluated by `evaluateAgeGate` — the same functions the email
path uses, not a second copy. An under-18 result returns `not_eligible` with
`reason: 'under_18'` and the platform's own copy, and leaves nothing behind,
because the function writes nothing at all.

### 5.3 No password

`ValidatedSocialSignUp` has no `passwordHash` field, so there is no value to
write a hash from. In the schema, `password_hash` is nullable and
`account_credentials_method_shape` says a password method has a hash and a social
method does not — in both directions, so neither a hash without a password nor a
password without a hash can be written.

A password presented against such an account is refused by
`resolvePasswordCredential` with:

| Field | Value |
|---|---|
| `code` | `permission_denied` |
| `details.reason` | `no_password_credential` |
| `details.action` | `continue_with_provider` |
| `details.title` / `message` | §9's copy |

**Why `permission_denied`.** It is the code this platform already returns for
exactly this situation: `validateSession` in `authn.ts` gives a revoked, a
superseded and an expired session `permission_denied`, because the caller's
credential does not currently authenticate them. A password presented against an
account with none is the same fact — the credential held cannot authenticate —
arrived at from a different direction. The alternatives were rejected on their
merits: `not_found` would be a lie the client cannot act on, since the account
exists and "no such account" sends a member to register a duplicate;
`validation_failed` blames a password that may be perfectly good and teaches the
member to keep editing something that is not broken; `conflict` describes a
disagreement between two requests, and there is only one here.

`details.reason` carries the machine-readable value and the copy lives in §9, so a
client renders the text and never matches on a sentence.

The account can still acquire a password: completing recovery sets one, and
`updatePasswordHash` moves `credential_method` to `'password'` in the same
statement. That is not a contradiction of "has no password" — after recovery it
holds one.

### 5.4 Sign-in resolution

`resolveSocialSignIn` takes two lookups as separate arguments and only the first
can produce an account:

| `linked` (by provider subject) | `contactExists` (by address) | Result |
|---|---|---|
| the account | anything | `existing_account` |
| `null` | `true` | `conflict` / `account_exists_requires_explicit_link` |
| `null` | `false` | `new_account` |

The middle row is property 6. "The addresses agree" is not evidence that the
person holding this provider account is the person who registered that address: a
provider account can be bought, inherited or shared, and an address on it can be
reassigned, while a member's own account cannot be. So the answer is a refusal
that names the remedy — sign in the original way, then link the provider from
settings — and `SocialIdentityStore` deliberately offers no finder that takes an
address, so no caller can reach the other answer.

`conflict` rather than `not_found`: the request is well formed and the provider
did authenticate somebody, but it conflicts with an account that already exists and
may only be joined deliberately. `permission_denied` would be wrong here for the
mirror of the reason it is right in §5.3 — this is not a request the caller is
barred from making, it is a step they have not taken yet.

## 6. Copy catalogue

Every string, with the next step offered. No dead ends.

| Key | `title` | `body` | Offered next |
|---|---|---|---|
| `social.no_password_credential` | This account signs in with a provider. | Continue with the provider you used when you joined, or set a password to use both. | the provider buttons; the set-a-password flow |
| `social.link_required` | That address already has an account. | Sign in the way you joined, then link this provider from settings. | the original sign-in method; settings |
| `social.age_gate_under_18` | (`platform.age`'s existing copy, reused) | — | — |
| `social.contact_required` | — | the provider supplied no email address, so one is required | the address field |
| `social.contact_mismatch` | — | the address you entered is not the one the provider verified | re-enter, or sign in the other way |

The two age-gate strings and the disposable-domain refusal are **not restated
here**: they are `platform.age`'s and `platform.credentials`'s, and a second copy
beside a rule is a second thing to drift out of step with it.

## 7. What a caller must do, and the order it must happen in

This is the shape of the route that is not written. It is recorded so that writing
it is wiring rather than re-derivation.

1. Read the body with `readSocialSignUpInput`. It refuses the fields in §5.
2. **Verify the assertion against the provider.** For Apple, `verifyAppleAssertion`
   with a cached key fetcher. For Google and Meta, this step has no implementation
   here — see §8.
3. Call `resolveSocialSignIn` with the provider-subject lookup and, separately, the
   contact lookup. Never resolve from the address.
4. On `existing_account`, mint a session with `SOCIAL_AUTH_METHOD`.
5. On `new_account`, call `evaluateSocialSignUp`, then write — in one transaction:
   the user row, the identity row (`unverified`), the credential
   (`passwordHash: null`), the onboarding row, the social identity row, and the
   session row.
6. On the refusal, render §9's copy. Do not add a fallback path that creates the
   account anyway.

## 8. What is not built, and exactly what is missing

**Not built: any route, any provider HTTP client, and any UI control.** The
reasons are external to this repository.

| Missing | Who must supply it | What it is |
|---|---|---|
| Google OAuth client id and secret | the product owner | Created in Google Cloud Console. Without them there is no `code` to exchange and no `aud` to check. |
| Meta app id and secret | the product owner | Created in Meta for Developers, with Facebook Login enabled. |
| An Apple Developer team, and Sign in with Apple enabled on it | the product owner, with payment | **The team does not exist today.** `app_id`, `team_id` and a `Services ID` all come from it. A free personal team does not carry the capability. |
| A registered redirect URI on a domain this service answers on | the product owner plus a deployment | Each provider rejects an unregistered one at the authorize step. |
| Key fetching and caching for Google and Meta | whoever writes the routes | `AppleKeyFetcher` is a port and the Apple verifier uses it; the Google and Meta verifiers do not exist. |
| The authorization-code exchange for Apple | whoever holds the team | `verifyAppleAssertion` proves the identity token is genuine. It does **not** prove the authorization code beside it was issued to this application; the code exchange does that, and it needs a client secret. |
| A UI button | the client | Deliberately absent. A button that signs somebody in without verifying an assertion is the failure this repository exists to prevent. |

**Not built: account linking from settings.** `insertSocialIdentity` takes a
`userId` the caller has already resolved by provider subject, and the port offers
no "find a plausible account" step — so a link only ever happens against an account
the member is already authenticated as. The route and its re-authentication
requirements are not written.

**Not built: unlinking from a client surface.** `deleteSocialIdentity` exists and is
tested; no route exposes it. What should happen to the account's password state
after an unlink is in §10.

**Not built: the `contact` requirement's client copy.** §6 has the server-side
strings. The client's rendering of "the provider supplied no email address" is not
written because there is no screen to put it on.

## 9. Acceptance scenarios, mapped to tests

Each numbered property, the test name that proves it, and the file it lives in.

| # | Scenario | Test |
|---|---|---|
| 1 | A social sign-up produces no identity state, no verification id and no discovery | `a social sign-up is not verification > produces no identity state, no verification id and no discovery` — `packages/platform/test/social-authn.test.ts` |
| 1 | A client cannot assert `verified`, `identityState`, `verificationStatus` or `contactVerified` | `a social sign-up is not verification > refuses a client body that tries to assert verified, identityState or contactVerified` |
| 1 | The identity machine offers no provider-driven path out of `unverified` | `a social sign-up is not verification > leaves the identity machine with no path to verified that a provider could take` |
| 1 | The account's identity row is `unverified` and undiscoverable, read from the database | `leaves the identity of a provider-created account unverified and undiscoverable` — `packages/database/test/store-social-identity.test.ts` |
| 2 | `dateOfBirth` is required, and an under-18 date is refused | `the age gate still applies to a provider sign-up > requires a date of birth and refuses one the age gate rejects` |
| 2 | A client-sent age is refused by name | `the age gate still applies to a provider sign-up > refuses a client-sent age, so the gate has nothing to read` |
| 2 | The band comes from the date, never from the provider | `the age gate still applies to a provider sign-up > derives the age band from the date and never from the provider` |
| 3 | Sign-up writes no hash anywhere | `an account with no password > is created without a password hash anywhere in what sign-up produces` |
| 3 | A password sign-in is refused with `permission_denied` and a reason | `an account with no password > refuses a password sign-in with permission_denied and a named reason` |
| 3 | The credential really round-trips with a null hash, and recovery can set one | `round-trips a credential with no password, and refuses a password against it` and `accepts a password once one is set, which is what completing recovery does` — `packages/database/test/store-social-identity.test.ts` |
| 4 | `contactVerified` follows the attestation only | `contactVerified follows the provider attestation and nothing else > is true only when the provider states the address is verified` |
| 4 | A provider-supplied absence leaves it false, not inferred | `... > is false when the provider supplied no address, even though one was given` |
| 4 | A mismatched address is refused | `... > refuses an address that is not the one the provider verified` |
| 4 | Only the subject id is retained | `... > retains the provider subject id and nothing else from the provider`; `gives social_identities four columns and no room for an assertion or a claim` — `packages/database/test/migration-009.test.ts` |
| 4 | Apple's `email_verified` string is read correctly end to end | `Apple's email_verified, read the way Apple writes it > carries that reading through the whole verification` — `packages/platform/test/apple-assertion.test.ts` |
| 5 | The session method is `'oauth'` | `session method for a provider sign-in > is oauth, which AuthMethod and the sessions table already carry` |
| 5 | The sessions CHECK admits `oauth` and no provider name | `admits oauth as a session method, which is the value a provider sign-in records` — `packages/database/test/migration-009.test.ts` |
| 6 | An already-linked subject resolves; an address-only match does not | `sign-in resolution never matches on an address > refuses to join an account that exists only because the address matches` |
| 6 | No result ever carries an account id that came from the address | `... > never returns an account id that came from the address alone` |
| 6 | One provider subject cannot be claimed by two accounts, even concurrently | `refuses to let a second account claim a provider subject, even concurrently` — `packages/database/test/store-social-identity.test.ts` |
| 6 | A provider-only account cannot be joined by address match, through the store | `refuses to resolve to an account that exists only because the address matches` |
| — | A genuine Apple token verifies, and a tampered, replayed, foreign-audience or wrong-alg one does not | `a genuine Apple identity token > verifies and yields only the subject and the email attestation`, `an Apple identity token that is not ours`, `the algorithm check, which is not optional`, `a malformed assertion` — `packages/platform/test/apple-assertion.test.ts` |
| — | The provider vocabulary is exactly three, and the schema agrees | `the provider vocabulary`, and `admits no provider outside the three this product offers` |

## 10. Open questions

Recorded rather than guessed, because guessing is worse than writing down the gap.

- **Whether an unlinked provider account should keep its password.** §5.3 makes
  "no password" a property of the credential method. If a member links a provider
  and then unlinks it, does the account fall back to `password`, or does it lose
  its only way in? Both are defensible and they are not equivalent: the second
  locks an account out unless recovery can reach its contact. Owner: product, with
  Trust & Safety, because an unrecoverable account is a safety question and not a
  convenience one. Blocks: the unlink route.
- **Whether an account may hold more than one provider.** The schema permits it —
  the primary key is `(user_id, provider)` — and nothing yet says a member may
  *use* it. Linking Google and Apple to one account makes that account's recovery
  story depend on two third parties instead of one. Owner: product and Trust &
  Safety. Blocks: the link route.
- **Whether the age gate should ever accept a provider-attested birthday.** §3.1
  says no, and the reason is the coherence of the argument rather than a policy
  preference. If a market demands it, this document is what must change, and it
  would need to say how a provider's claim about an account holder's date of birth
  becomes evidence about the person rather than about the account. Owner: Identity
  & Verification and legal, per market.
- **Whether `contact_verified` from a provider should ever satisfy the contact
  verification step** that gates full onboarding. Today it does not: it records
  that the provider vouched, and the channel check is still required. Recovery
  depends on a reachable channel, and a provider vouching is not the same fact as
  mail arriving. Owner: Platform and Trust & Safety. Blocks: whether step 2 of the
  onboarding path can be shortened for a provider account.
- **Apple relay addresses.** Apple's `is_private_email` claim is not read here. A
  member who hides their address gets a relay that reaches Apple, not this
  product's contact-verification mail, and §3.2's third row would then be handing
  them an account whose contact cannot be confirmed by the flow that is supposed to
  confirm it. Not decided, not implemented, and the honest statement is that the
  gap is known rather than absent.
- **Key caching and rotation policy for every provider.** `AppleKeyFetcher` is a
  port, and the policy — how long a key is cached, what happens on an unknown
  `kid`, whether an outage fetching keys fails a sign-in open — is undecided. Owner:
  Platform. Blocks: the routes.
- **Whether a provider outage should refuse sign-in or fall back to another
  method.** The current rules have no fallback and should not grow one silently: a
  fallback that "helpfully" accepts an unverified assertion is the failure this
  document exists to prevent. What the *copy* says when Google is down is
  undecided. Owner: product.

## 11. Where this is implemented

| Piece | Path |
|---|---|
| Provider vocabulary, order of checks, refusals, copy | `packages/platform/src/social-authn.ts` |
| Apple identity-token verification | `packages/platform/src/apple-assertion.ts` |
| Schema | `packages/database/migrations/009_social_identity.sql` |
| Port | `SocialIdentityStore`, `SocialIdentityRow` in `packages/contracts/src/stores.ts` |
| Adapter | `packages/database/src/store-social-identity.ts` |
| Domain tests | `packages/platform/test/social-authn.test.ts`, `packages/platform/test/apple-assertion.test.ts` |
| Schema tests | `packages/database/test/migration-009.test.ts` |
| Store tests | `packages/database/test/store-social-identity.test.ts` |

There is no route, no client and no screen. §8 says why, and §9 is the complete
list of what is proven.