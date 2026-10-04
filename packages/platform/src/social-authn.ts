import { type DomainError, type Result, domainError, ok } from '@been-there/core';
import {
  type DateOfBirth,
  evaluateAgeGate,
  readDateOfBirth,
} from './age.js';
import { type NormalizedContact, isEmailDomainAllowed, normalizeContact } from './credentials.js';
import { type AuthMethod } from './authn.js';

/**
 * Signing up with Google, Apple or Meta, alongside email and password.
 *
 * This module owns the *vocabulary* and the *refusals*. It owns no HTTP, no
 * provider client and no token exchange: those need OAuth client credentials
 * that do not exist in this repository yet
 * ([`docs/features/social-sign-in.md`](../../docs/features/social-sign-in.md)
 * §8), and a route that "signs in" without verifying an assertion is exactly the
 * failure this repository exists to prevent. What is here is the part that is
 * true regardless of who holds the credentials, and it is written so that adding
 * the routes later is a wiring job rather than a re-derivation.
 *
 * ## The five properties, and where each one is structural
 *
 * 1. **A social sign-up creates an unverified account.** There is no
 *    verification field in `ValidatedSocialSignUp` and no identity event in
 *    anything below, so there is no value to write one from. `readSocialSignUpInput`
 *    additionally *refuses* a body carrying `verified`, `identityState`,
 *    `verificationStatus` or `contactVerified`, so a client cannot assert any of
 *    them into existence.
 * 2. **The age gate still applies.** `dateOfBirth` is a required field of the
 *    request type and the gate runs before anything is returned, for the same
 *    reason it does in `sign-up.ts`: an age gate a provider can satisfy is not
 *    an age gate.
 * 3. **There is no password.** `ValidatedSocialSignUp` has no hash field, and
 *    `evaluatePasswordSignIn` refuses a password presented against an account
 *    that has none, with a reason a client can render.
 * 4. **`contactVerified` only on a provider's word.** It is derived from
 *    `VerifiedSocialIdentity.emailVerified` and nothing else, and
 *    `SocialIdentity` — the only provider value written down — has two fields.
 * 5. **Sessions record `'oauth'`.** `SOCIAL_AUTH_METHOD`, typed as the
 *    `AuthMethod` the platform already defines.
 * 6. **No account is ever found by matching an email.** `resolveSocialSignIn`
 *    takes the provider-subject lookup and the contact lookup as two separate
 *    arguments and refuses the combination where only the contact matched.
 */

/**
 * The three providers this product offers, and the schema's CHECK agrees.
 *
 * `'meta'` rather than `'facebook'`: the name a provider gives its own product
 * changes, and the value is a durable internal identifier rather than a brand.
 * A fourth provider is a migration and a case in this union, which is the cost
 * that makes the choice deliberate.
 */
export type SocialProvider = 'apple' | 'google' | 'meta';

/** The same list as a lookup, for a caller validating a string it received. */
export const SOCIAL_PROVIDERS: Readonly<Record<SocialProvider, true>> = {
  apple: true,
  google: true,
  meta: true,
};

/** Narrows a string to the provider vocabulary. The schema enforces it too. */
export function isSocialProvider(value: string): value is SocialProvider {
  return Object.prototype.hasOwnProperty.call(SOCIAL_PROVIDERS, value);
}

/**
 * The session method a provider sign-in records.
 *
 * `'oauth'` because `AuthMethod` already carries it and the sessions table's
 * CHECK already admits it. Naming a social sign-in `'password'` would put an
 * audit of the rarer event behind the common one — the same reason
 * `staff_password` exists as its own value — and naming it `'apple'` or
 * `'google'` would put the *provider* where the *method* belongs, so the row
 * could no longer answer "did this session come from a human at a provider or
 * from this product's own email form".
 */
export const SOCIAL_AUTH_METHOD: AuthMethod = 'oauth';

/**
 * What a verified provider assertion yields, and the ceiling on what any adapter
 * may hand back.
 *
 * Four fields, and the absence is the design. There is no identity token, no
 * authorization code, no nonce, no provider response body and no display name
 * — a verifier that produced more would be producing a reason to store more,
 * and the row type downstream has nowhere to put it. An adapter's job is to
 * check a signature and answer two questions: who is this (`providerSubject`)
 * and what did the provider vouch for (`emailVerified`).
 *
 * `email` is `null` when the provider supplied none. Apple returns an address
 * only on the first authorisation, and Meta returns none at all unless the
 * integration asks for one, so "no email" is the common case rather than the
 * exceptional one and the type says so.
 */
export interface VerifiedSocialIdentity {
  readonly provider: SocialProvider;
  /**
   * The stable subject identifier the provider assigned to this person.
   *
   * Opaque and provider-scoped: the same human is a different `sub` at Google
   * and at Apple, and a changed subject at one provider is a different person as
   * far as this platform is concerned. Never an email address — a subject that
   * changes when somebody changes their address is not an identity.
   */
  readonly providerSubject: string;
  readonly email: string | null;
  /** True only when the provider states the address is verified for this person. */
  readonly emailVerified: boolean;
}

/**
 * The only provider values this platform writes down.
 *
 * Two fields. `SocialIdentityRow` in the contracts carries the same pair plus
 * the member and the timestamp, and there is no third provider-derived column
 * anywhere in the stack — so "what does a provider sign-in write?" is a
 * two-element answer rather than a policy.
 */
export interface SocialIdentity {
  readonly provider: SocialProvider;
  readonly providerSubject: string;
}

/**
 * The shape the shape-shaping function accepts.
 *
 * There is no assertion, no token and no provider response in it, which is the
 * whole mechanism behind property 1: a function that decides what gets written
 * has nothing in its input to write an identity state from. The caller verifies
 * an assertion separately and hands over only this.
 */
export interface SocialSignUpRequest {
  readonly verified: VerifiedSocialIdentity;
  /** ISO `YYYY-MM-DD`. Required even when the provider could have supplied one. */
  readonly dateOfBirth: string;
  readonly termsVersion: string;
  /**
   * The member's own contact, required when the provider attested no address
   * and refused when it attested a different one. See `evaluateSocialSignUp`.
   */
  readonly contact?: string;
  readonly journeyId?: string;
}

/** The provider assertion as it arrives, before anything has verified it. */
export interface SocialSignUpInput {
  readonly provider: string;
  /**
   * The identity token, verbatim, for a verifier to check.
   *
   * It lives on this type and on no other in this file. `readSocialSignUpInput`
   * exists so that a route has something typed to hand to a verifier, and the
   * value's journey ends there — it is never a field of the request, of the
   * validated sign-up, or of anything a store writes.
   */
  readonly assertion: string;
  readonly dateOfBirth: string;
  readonly termsVersion: string;
  readonly contact?: string;
  readonly journeyId?: string;
}

/** What a social sign-up writes. No password, no verification, no identity state. */
export interface ValidatedSocialSignUp {
  /** The two fields above, and the only provider data that is persisted. */
  readonly identity: SocialIdentity;
  readonly contact: NormalizedContact;
  /** True only when the provider attested a verified address. See §4 of the spec. */
  readonly contactVerified: boolean;
  readonly dateOfBirth: DateOfBirth;
  /** `YYYY-MM-DD`, the form `account_onboarding.date_of_birth` stores. */
  readonly dateOfBirthIso: string;
  readonly ageBand: string;
  readonly termsVersion: string;
  readonly journeyId: string;
}

/**
 * Client-supplied fields that are refused by name.
 *
 * The age spellings are `sign-up.ts`'s list, repeated rather than imported:
 * that module belongs to the service and Platform does not import service
 * internals, so sharing them would mean a domain import across a boundary. Two
 * names would drift instead of three, and both are named in the refusal so the
 * answer is actionable.
 *
 * The identity spellings are this module's own and they are the reason property
 * 1 is more than a convention. A social sign-up is not a way to declare an
 * identity state, and a body carrying one has a stale or hostile client — either
 * way the useful answer is a refusal naming the field, not a sign-up that
 * quietly ignored it.
 */
const FORBIDDEN_FIELDS: readonly string[] = [
  'age',
  'ageYears',
  'ageInYears',
  'verified',
  'identityState',
  'verificationStatus',
  'contactVerified',
  'providerSubject',
];

/**
 * Reads a provider sign-up body, or refuses it.
 *
 * The assertion is read as an opaque string and handed straight to a verifier.
 * Nothing here interprets it, and nothing here keeps it.
 */
export function readSocialSignUpInput(
  body: Readonly<Record<string, unknown>>,
): Result<SocialSignUpInput, DomainError> {
  const forbidden = FORBIDDEN_FIELDS.find((field) => body[field] !== undefined);
  if (forbidden !== undefined) {
    return domainError(
      'validation_failed',
      'platform.social',
      'that field is decided by the platform, not by the client',
      { field: forbidden },
    );
  }
  const provider = body['provider'];
  if (typeof provider !== 'string' || !isSocialProvider(provider)) {
    return domainError('validation_failed', 'platform.social', 'the provider is not one this product offers', {
      field: 'provider',
      expected: Object.keys(SOCIAL_PROVIDERS).join(', '),
    });
  }
  const assertion = body['assertion'];
  if (typeof assertion !== 'string' || assertion.length === 0) {
    return domainError('validation_failed', 'platform.social', 'the provider assertion is required', {
      field: 'assertion',
    });
  }
  const dateOfBirth = body['dateOfBirth'];
  if (typeof dateOfBirth !== 'string' || dateOfBirth.length === 0) {
    return domainError('validation_failed', 'platform.social', 'a date of birth is required', {
      field: 'dateOfBirth',
    });
  }
  const termsVersion = body['termsVersion'];
  if (typeof termsVersion !== 'string' || termsVersion.length === 0) {
    return domainError('validation_failed', 'platform.social', 'the accepted terms version is required', {
      field: 'termsVersion',
    });
  }
  const contact = body['contact'];
  if (contact !== undefined && (typeof contact !== 'string' || contact.length === 0)) {
    return domainError('validation_failed', 'platform.social', 'the contact is not a usable string', {
      field: 'contact',
    });
  }
  const journeyId = body['journeyId'];
  return ok({
    provider,
    assertion,
    dateOfBirth,
    termsVersion,
    ...(typeof contact === 'string' ? { contact } : {}),
    ...(typeof journeyId === 'string' && journeyId.length > 0 ? { journeyId } : {}),
  });
}

/**
 * The service's `evaluateTermsAcceptance`, as a parameter.
 *
 * Passed in rather than imported because the terms catalogue and the copy that
 * goes with it are the service's, and Platform does not import service
 * internals. Passing the check as a value keeps the accepted-version rule
 * *inside* the ordered list below — a caller cannot evaluate terms early and
 * then forget to check the outcome — while leaving ownership where it is.
 */
export type TermsAcceptanceCheck = (acceptedVersion: string) => Result<true, DomainError>;

/**
 * Turns a verified provider assertion into an account, or refuses.
 *
 * ## The order, and why it is this order
 *
 * Contact, then the age gate, then terms. The same order `sign-up.ts` uses with
 * the password step removed, because the copy in §6 is specific to each failure
 * and a member told "that date doesn't look right" must not first be told their
 * address was unusable. Nothing expensive sits in this function at all: there is
 * no scrypt call, because there is no password to hash, which is the one
 * measurable saving a provider sign-up brings and the only one.
 *
 * ## Where the contact comes from
 *
 * The provider's attested address wins, and a `contact` sent alongside a
 * *different* address is refused rather than preferred. Silently preferring the
 * client's copy would make `contactVerified` a claim about a string the client
 * chose; silently preferring the provider's would ignore what the member typed
 * and change the account's contact without telling them.
 *
 * When the provider attested nothing — Meta, and Apple after the first sign-in —
 * the member's own address is used and `contactVerified` is `false`, which is
 * the same state an email-and-password sign-up starts in. The account is
 * therefore created, still unverified, with a contact that the ordinary
 * contact-verification flow will confirm later. Requiring the field in that case
 * is what keeps "the provider supplied nothing" from becoming "the account has
 * no contact at all".
 */
export function evaluateSocialSignUp(
  request: SocialSignUpRequest,
  now: Date,
  evaluateTerms: TermsAcceptanceCheck,
): Result<ValidatedSocialSignUp, DomainError> {
  const subject = request.verified.providerSubject.trim();
  if (subject.length === 0) {
    return domainError('validation_failed', 'platform.social', 'the provider returned no account subject', {
      field: 'providerSubject',
    });
  }
  const contact = contactFor(request);
  if (!contact.ok) {
    return contact;
  }
  const allowed = isEmailDomainAllowed(contact.value);
  if (!allowed.ok) {
    return allowed;
  }
  const ageGate = ageGateFor(request.dateOfBirth, now);
  if (!ageGate.ok) {
    return ageGate;
  }
  const terms = evaluateTerms(request.termsVersion);
  if (!terms.ok) {
    return terms;
  }
  return ok({
    identity: { provider: request.verified.provider, providerSubject: subject },
    contact: contact.value,
    contactVerified: request.verified.emailVerified,
    dateOfBirth: ageGate.value.dateOfBirth,
    dateOfBirthIso: `${String(ageGate.value.dateOfBirth.year).padStart(4, '0')}-${String(
      ageGate.value.dateOfBirth.month,
    ).padStart(2, '0')}-${String(ageGate.value.dateOfBirth.day).padStart(2, '0')}`,
    ageBand: ageGate.value.ageBand,
    termsVersion: request.termsVersion,
    journeyId: request.journeyId ?? new Date().getTime().toString(36),
  });
}

/**
 * The contact an account is created against, and the only place a
 * `contactVerified` value is derived.
 *
 * `emailVerified` is the sole input to the boolean. There is no branch that
 * infers it from the address looking real, from the provider having returned
 * one at all, or from the member having typed it — because "the provider said
 * so" and "we believe it" are different claims and only the first one is
 * evidenced.
 */
function contactFor(request: SocialSignUpRequest): Result<NormalizedContact, DomainError> {
  const attested = request.verified.email;
  if (attested === null) {
    if (request.contact === undefined) {
      return domainError(
        'validation_failed',
        'platform.social',
        'the provider supplied no email address, so one is required',
        { field: 'contact' },
      );
    }
    return normalizeContact('email', request.contact);
  }
  const fromProvider = normalizeContact('email', attested);
  if (!fromProvider.ok) {
    return fromProvider;
  }
  if (request.contact === undefined) {
    return fromProvider;
  }
  const fromMember = normalizeContact('email', request.contact);
  if (!fromMember.ok) {
    return fromMember;
  }
  if (fromMember.value.identifier !== fromProvider.value.identifier) {
    return domainError(
      'validation_failed',
      'platform.social',
      'the address you entered is not the one the provider verified',
      { field: 'contact' },
    );
  }
  return fromProvider;
}

/**
 * The gate, in one place, so no caller can order it differently and so the
 * missing-password shape has no way to appear.
 *
 * This is the age gate rather than a reimplementation of it: an age gate that
 * existed twice would eventually be the copy that is one release behind.
 */
function ageGateFor(
  dateOfBirth: string,
  now: Date,
): Result<{ readonly dateOfBirth: DateOfBirth; readonly ageBand: string }, DomainError> {
  const parsed = readDateOfBirth(dateOfBirth, now);
  if (!parsed.ok) {
    return parsed;
  }
  const outcome = evaluateAgeGate(parsed.value, now);
  if (!outcome.ok) {
    return outcome;
  }
  return ok({ dateOfBirth: parsed.value, ageBand: outcome.value.ageBand });
}
