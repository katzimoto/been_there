import { randomUUID } from 'node:crypto';
import { type DomainError, type Result, domainError, ok } from '@been-there/core';
import {
  type ContactKind,
  type DateOfBirth,
  evaluateAgeGate,
  evaluatePassword,
  hashPassword,
  isEmailDomainAllowed,
  normalizeContact,
  readDateOfBirth,
} from '@been-there/platform';
import { evaluateTermsAcceptance } from './terms.js';

/**
 * Sign-up: the ten-step path's blocking steps 1, 3 and 4, and the one place a
 * date of birth is ever taken from a client.
 *
 * ## What this module refuses to accept
 *
 * There is no `age` field on `SignUpInput`, and that is the design rather than an
 * oversight. §4.1 says the client may not submit an age and a submitted
 * `ageYears` is rejected, and the way to make that structural rather than a
 * check someone might forget is to give the input type no field to put it in. A
 * gate that reads a number the client typed is a gate that accepts a promise, so
 * the age is *derived* here from a calendar date at the moment of submission.
 *
 * `readSignUpInput` refuses a body carrying `age` or `ageYears` explicitly rather
 * than ignoring them, because a client sending one has a stale build and the
 * useful answer is a refusal that says so, not a sign-up that quietly used the
 * date instead.
 *
 * ## The order of the checks
 *
 * Contact, then password, then age gate, then terms — and the age gate runs
 * *before* the password is hashed. The reasons are that the copy in §9 is
 * specific to each failure, so a user who is told "that date doesn't look right"
 * must not first be told their password was too short, and that an under-18 date
 * of birth should cost one SHA-256 rather than a 250 ms scrypt. The order is
 * therefore the copy order of the failure table, with the expensive step last.
 *
 * ## What an under-18 result leaves behind
 *
 * Nothing. No user row, no credential, no onboarding row, no contact
 * verification, no provider call, no email. `SignUpInput` is a pure value: it
 * reads and validates, and the caller does the writing. That separation is what
 * makes the guarantee checkable — the gate returns a `Result`, and the caller
 * that writes has not been reached.
 */

/** The only shape sign-up accepts. There is no `age` here, on purpose. */
export interface SignUpInput {
  /** RFC-shaped, normalised and domain-checked by the platform. */
  readonly contact: string;
  readonly password: string;
  /** ISO `YYYY-MM-DD`. Never an age, never a year alone. */
  readonly dateOfBirth: string;
  /** The version the client says it displayed. Compared, never defaulted. */
  readonly termsVersion: string;
  /** The onboarding run id. Optional; minted when the client supplies none. */
  readonly journeyId?: string;
}

export interface SignUpContact {
  readonly kind: ContactKind;
  readonly identifier: string;
}

/**
 * A client-supplied age is refused by name.
 *
 * Both spellings are listed because both are plausible in a stale client: `age`
 * is the obvious one and `ageYears` is what §4.1 names. Accepting neither is the
 * point; naming both in the refusal is what makes the refusal actionable rather
 * than mysterious.
 */
const AGE_FIELDS: readonly string[] = ['age', 'ageYears', 'ageInYears'];

export function readSignUpInput(body: Readonly<Record<string, unknown>>): Result<SignUpInput, DomainError> {
  const forbidden = AGE_FIELDS.find((field) => body[field] !== undefined);
  if (forbidden !== undefined) {
    return domainError(
      'validation_failed',
      'service.accounts',
      'the age gate computes your age from your date of birth, so an age may not be sent',
      { field: forbidden, expected: 'dateOfBirth' },
    );
  }
  const contact = body['contact'];
  if (typeof contact !== 'string' || contact.length === 0) {
    return domainError('validation_failed', 'service.accounts', 'a contact identifier is required', {
      field: 'contact',
    });
  }
  const password = body['password'];
  if (typeof password !== 'string' || password.length === 0) {
    return domainError('validation_failed', 'service.accounts', 'a password is required', {
      field: 'password',
    });
  }
  const dateOfBirth = body['dateOfBirth'];
  if (typeof dateOfBirth !== 'string' || dateOfBirth.length === 0) {
    return domainError('validation_failed', 'service.accounts', 'a date of birth is required', {
      field: 'dateOfBirth',
    });
  }
  const termsVersion = body['termsVersion'];
  if (typeof termsVersion !== 'string' || termsVersion.length === 0) {
    return domainError('validation_failed', 'service.accounts', 'the accepted terms version is required', {
      field: 'termsVersion',
    });
  }
  const journeyId = body['journeyId'];
  return ok({
    contact,
    password,
    dateOfBirth,
    termsVersion,
    ...(typeof journeyId === 'string' && journeyId.length > 0 ? { journeyId } : {}),
  });
}

export interface ValidatedSignUp {
  readonly contact: SignUpContact;
  readonly passwordHash: string;
  readonly dateOfBirth: DateOfBirth;
  /** `YYYY-MM-DD`, the form `account_onboarding.date_of_birth` stores. */
  readonly dateOfBirthIso: string;
  readonly ageBand: string;
  readonly termsVersion: string;
  readonly journeyId: string;
}

/**
 * Validates a sign-up without writing anything.
 *
 * Returning the values the caller needs to write — rather than writing them — is
 * what makes "an under-18 sign-up leaves no account" a property of this module
 * rather than a property of the route's ordering. There is no code path on which
 * this function has written and then declined.
 */
export async function validateSignUp(
  input: SignUpInput,
  now: Date,
): Promise<Result<ValidatedSignUp, DomainError>> {
  const contact = normalizeContact(input.contact.includes('@') ? 'email' : 'phone', input.contact);
  if (!contact.ok) {
    return contact;
  }
  const allowed = isEmailDomainAllowed(contact.value);
  if (!allowed.ok) {
    return allowed;
  }
  const ageGate = ageGateFor(input.dateOfBirth, now);
  if (!ageGate.ok) {
    return ageGate;
  }
  const password = evaluatePassword(input.password);
  if (!password.ok) {
    return password;
  }
  const terms = evaluateTermsAcceptance(input.termsVersion);
  if (!terms.ok) {
    return terms;
  }
  return ok({
    contact: { kind: contact.value.kind, identifier: contact.value.identifier },
    passwordHash: await hashPassword(input.password),
    dateOfBirth: ageGate.value.dateOfBirth,
    dateOfBirthIso: `${String(ageGate.value.dateOfBirth.year).padStart(4, '0')}-${String(
      ageGate.value.dateOfBirth.month,
    ).padStart(2, '0')}-${String(ageGate.value.dateOfBirth.day).padStart(2, '0')}`,
    ageBand: ageGate.value.outcome.ageBand,
    // `evaluateTermsAcceptance` proved these two are the same string, so the
    // accepted version is the input's. Re-deriving it from the constant would
    // store a second answer to a question that has already been settled.
    termsVersion: input.termsVersion,
    journeyId: input.journeyId ?? randomUUID(),
  });
}

/**
 * The gate, in one place, so no caller can order it differently.
 *
 * `readDateOfBirth` refuses a malformed or future date with §9's impossible-date
 * copy; `evaluateAgeGate` refuses an under-18 one with §9's under-18 copy and
 * returns the derived band on a pass. Both errors carry the title and the action
 * from the failure table in their details, because a refusal whose copy drifts
 * from its rule is a refusal nobody can act on.
 */
function ageGateFor(
  dateOfBirth: string,
  now: Date,
): Result<{ readonly dateOfBirth: DateOfBirth; readonly outcome: { readonly ageBand: string } }, DomainError> {
  const parsed = readDateOfBirth(dateOfBirth, now);
  if (!parsed.ok) {
    return parsed;
  }
  const outcome = evaluateAgeGate(parsed.value, now);
  if (!outcome.ok) {
    return outcome;
  }
  return ok({ dateOfBirth: parsed.value, outcome: outcome.value });
}

/**
 * The funnel's coarse marker for a refused sign-up. Never the date, never an
 * age: §11.1 says `age_band` is a band, and the only band-shaped answer
 * available for a date of birth the gate refused is the `under_18` marker the
 * platform publishes. Everything else is a reason code with no age at all, which
 * is why a stale terms version and a short password both land on
 * `invalid_input` rather than on a bucket of their own.
 */
export function rejectionReasonFor(error: DomainError): string {
  if (error.details?.['reason'] === 'under_18') {
    return 'under_18';
  }
  if (error.details?.['reason'] === 'domain_not_allowed') {
    return 'domain_not_allowed';
  }
  if (error.details?.['reason'] === 'password_known_breached') {
    return 'breached_password';
  }
  return 'invalid_input';
}

/**
 * The notice a user is shown before they are asked, and the two refusals the
 * gate can produce. Re-exported from the platform rather than restated: the copy
 * belongs to the age gate, and a second copy beside the gate is a second thing
 * to drift out of step with §9.
 */
export { AGE_GATE_COPY, AGE_GATE_NOTICE } from '@been-there/platform';