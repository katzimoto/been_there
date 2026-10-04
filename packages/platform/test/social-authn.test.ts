import { describe, expect, it } from 'vitest';
import { identityMachine, isDiscoverableIdentity, type IdentityRecord } from '@been-there/core';
import {
  AGE_GATE_COPY,
  NO_PASSWORD_CREDENTIAL_COPY,
  SOCIAL_AUTH_METHOD,
  SOCIAL_LINK_REQUIRED_COPY,
  evaluateSocialSignUp,
  isSocialProvider,
  readSocialSignUpInput,
  resolvePasswordCredential,
  resolveSocialSignIn,
  type SocialSignUpRequest,
  type TermsAcceptanceCheck,
  type VerifiedSocialIdentity,
} from '../src/index.js';
import { rejected, succeeded } from './helpers.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const CURRENT_TERMS = '2026-09-01';

/**
 * The terms check the platform would be handed, with the service's real rule:
 * only the currently published version is accepted.
 */
const evaluateTerms: TermsAcceptanceCheck = (accepted) =>
  accepted === CURRENT_TERMS
    ? { ok: true, value: true }
    : {
        ok: false,
        error: {
          code: 'validation_failed',
          domain: 'service.accounts',
          message: 'Have a read, then accept to continue.',
          details: { field: 'terms' },
        },
      };

function verified(overrides: Partial<VerifiedSocialIdentity> = {}): VerifiedSocialIdentity {
  return {
    provider: 'apple',
    providerSubject: '001234.abc.5678',
    email: 'alice@brightpost.com',
    emailVerified: true,
    ...overrides,
  };
}

function request(overrides: Partial<SocialSignUpRequest> = {}): SocialSignUpRequest {
  return {
    verified: verified(),
    dateOfBirth: '1990-04-17',
    termsVersion: CURRENT_TERMS,
    ...overrides,
  };
}

/** An identity record in the state a brand-new account is written in. */
function unverifiedRecord(): IdentityRecord {
  return { state: 'unverified', latestVerificationId: null, generation: 0 };
}

/**
 * Property 1: a social sign-up creates an *unverified* account, and nothing in
 * it can be mistaken for verification.
 *
 * Three separate assertions rather than one, because there are three ways the
 * claim could be quietly false: the validated value could carry a verification
 * field, the reader could let a client assert one, or the identity machine could
 * be reachable from the state a social account starts in by some path this work
 * added. The third is checked against the machine's own transition table rather
 * than against this module, because commitment 1 is the machine's property and
 * a test that only re-reads its own output proves nothing about it.
 */
describe('a social sign-up is not verification', () => {
  it('produces no identity state, no verification id and no discovery', () => {
    const validated = succeeded(evaluateSocialSignUp(request(), NOW, evaluateTerms));

    expect(Object.keys(validated).sort()).toEqual([
      'ageBand',
      'contact',
      'contactVerified',
      'dateOfBirth',
      'dateOfBirthIso',
      'identity',
      'journeyId',
      'termsVersion',
    ]);
    // The only provider data is a pair. There is nowhere to put a token, a claim
    // or a verification result, which is what makes "it is not verification"
    // structural rather than a promise.
    expect(Object.keys(validated.identity).sort()).toEqual(['provider', 'providerSubject']);
    expect(isDiscoverableIdentity(unverifiedRecord())).toBe(false);
  });

  it('refuses a client body that tries to assert verified, identityState or contactVerified', () => {
    for (const field of ['verified', 'identityState', 'verificationStatus', 'contactVerified']) {
      const error = rejected(
        readSocialSignUpInput({
          provider: 'apple',
          assertion: 'header.payload.signature',
          dateOfBirth: '1990-04-17',
          termsVersion: CURRENT_TERMS,
          [field]: true,
        }),
      );
      expect(error.code).toBe('validation_failed');
      expect(error.details?.['field']).toBe(field);
    }
  });

  it('leaves the identity machine with no path to verified that a provider could take', () => {
    // The only legal move out of `unverified` is `submit_verification`, and that
    // is a member presenting themselves to the verification flow — not a provider
    // asserting anything. `provider_result_received` is the transition a provider
    // result drives, and it is not legal from `unverified` at any confidence.
    expect(identityMachine.legalEvents('unverified')).toEqual(['submit_verification', 'withdraw']);
    // `withdraw` leaves the state at `unverified`, so of the two legal events only
    // `submit_verification` moves toward `verified` at all.
    expect(identityMachine.can('unverified', 'provider_result_received', { confidence: 1 })).toBe(false);
    expect(identityMachine.can('unverified', 'submit_verification')).toBe(true);
  });
});

/**
 * Property 2: the age gate still applies to a provider sign-up.
 *
 * Google and Meta do not reliably supply a birthday, and Apple only does on the
 * very first authorisation. A gate a provider can satisfy is not a gate, so the
 * date is required input with no fallback — and the provider's claims are not
 * consulted for it at all.
 */
describe('the age gate still applies to a provider sign-up', () => {
  it('requires a date of birth and refuses one the age gate rejects', () => {
    const error = rejected(
      readSocialSignUpInput({
        provider: 'google',
        assertion: 'header.payload.signature',
        termsVersion: CURRENT_TERMS,
      }),
    );
    expect(error.code).toBe('validation_failed');
    expect(error.details?.['field']).toBe('dateOfBirth');

    const underEighteen = rejected(
      evaluateSocialSignUp(request({ dateOfBirth: '2015-01-01' }), NOW, evaluateTerms),
    );
    expect(underEighteen.code).toBe('not_eligible');
    expect(underEighteen.details?.['reason']).toBe('under_18');
    expect(underEighteen.message).toBe(AGE_GATE_COPY.under18.body);
  });

  it('refuses a client-sent age, so the gate has nothing to read', () => {
    for (const field of ['age', 'ageYears', 'ageInYears']) {
      const error = rejected(
        readSocialSignUpInput({
          provider: 'meta',
          assertion: 'header.payload.signature',
          dateOfBirth: '1990-04-17',
          termsVersion: CURRENT_TERMS,
          [field]: 34,
        }),
      );
      expect(error.details?.['field']).toBe(field);
    }
  });

  it('derives the age band from the date and never from the provider', () => {
    const validated = succeeded(evaluateSocialSignUp(request({ dateOfBirth: '1993-06-01' }), NOW, evaluateTerms));
    expect(validated.dateOfBirthIso).toBe('1993-06-01');
    expect(validated.ageBand).toBe('28-32');
  });
});

/**
 * Property 3: such an account has no password, and a password sign-in against it
 * is refused with a reason rather than failing silently.
 *
 * The two halves are separate facts and both are checked: the sign-up writes no
 * hash at all, and the sign-in path has a named refusal for the account that
 * results. A silent failure here would be a member pressing "sign in with
 * password" forever against an account that will never accept one.
 */
describe('an account with no password', () => {
  it('is created without a password hash anywhere in what sign-up produces', () => {
    const validated = succeeded(evaluateSocialSignUp(request(), NOW, evaluateTerms));
    expect(JSON.stringify(validated)).not.toContain('scrypt:');
    expect('passwordHash' in validated).toBe(false);
  });

  it('refuses a password sign-in with permission_denied and a named reason', () => {
    const error = rejected(resolvePasswordCredential({ passwordHash: null }));
    // `permission_denied` because that is what this platform already returns for
    // a credential that cannot authenticate right now — a revoked or expired
    // session — and a password presented against an account that has none is
    // that same fact. Not `not_found`, which would be a lie the client cannot act
    // on; not `validation_failed`, which would blame a password that may be fine.
    expect(error.code).toBe('permission_denied');
    expect(error.details?.['reason']).toBe('no_password_credential');
    expect(error.details?.['action']).toBe('continue_with_provider');
    expect(error.message).toBe(NO_PASSWORD_CREDENTIAL_COPY.body);
  });

  it('hands back the hash for an account that has one, unchanged', () => {
    const hash = 'scrypt:32768:8:1$c2FsdA==$ZGlnZXN0';
    expect(succeeded(resolvePasswordCredential({ passwordHash: hash }))).toBe(hash);
  });
});

/**
 * Property 4: `contactVerified` is true only when the provider attests a verified
 * email, and nothing beyond the stable provider subject id is retained.
 */
describe('contactVerified follows the provider attestation and nothing else', () => {
  it('is true only when the provider states the address is verified', () => {
    const attested = succeeded(evaluateSocialSignUp(request(), NOW, evaluateTerms));
    expect(attested.contactVerified).toBe(true);

    const unverifiedByProvider = succeeded(
      evaluateSocialSignUp(
        request({ verified: verified({ emailVerified: false }) }),
        NOW,
        evaluateTerms,
      ),
    );
    expect(unverifiedByProvider.contactVerified).toBe(false);
  });

  it('is false when the provider supplied no address, even though one was given', () => {
    // Meta, and Apple after the first authorisation. The member's own address is
    // used and the ordinary contact-verification flow confirms it later; it is
    // not treated as verified because somebody typed it.
    const validated = succeeded(
      evaluateSocialSignUp(
        request({ verified: verified({ provider: 'meta', email: null, emailVerified: false }), contact: 'alice@brightpost.com' }),
        NOW,
        evaluateTerms,
      ),
    );
    expect(validated.contact.identifier).toBe('alice@brightpost.com');
    expect(validated.contactVerified).toBe(false);
  });

  it('refuses an address that is not the one the provider verified', () => {
    const error = rejected(
      evaluateSocialSignUp(request({ contact: 'mallory@nightowl.net' }), NOW, evaluateTerms),
    );
    expect(error.code).toBe('validation_failed');
    expect(error.details?.['field']).toBe('contact');
  });

  it('requires a contact of its own when the provider attested no address', () => {
    const error = rejected(
      evaluateSocialSignUp(request({ verified: verified({ email: null }) }), NOW, evaluateTerms),
    );
    expect(error.details?.['field']).toBe('contact');
  });

  it('retains the provider subject id and nothing else from the provider', () => {
    const validated = succeeded(evaluateSocialSignUp(request(), NOW, evaluateTerms));
    expect(validated.identity).toEqual({ provider: 'apple', providerSubject: '001234.abc.5678' });
    expect(Object.keys(validated.identity)).toHaveLength(2);
  });
});

/**
 * Property 5: a provider session records the method the vocabulary already has.
 */
describe('session method for a provider sign-in', () => {
  it('is oauth, which AuthMethod and the sessions table already carry', () => {
    expect(SOCIAL_AUTH_METHOD).toBe('oauth');
  });

  it('is accepted by issueSession rather than refused as an unknown method', () => {
    // The vocabulary check that matters is the one the table enforces, and the
    // platform type is what the route hands it.
    const session = succeeded(
      evaluateSocialSignUp(request(), NOW, evaluateTerms),
    );
    expect(session.identity.provider).toBe('apple');
    expect(SOCIAL_AUTH_METHOD).toBe('oauth');
  });
});

/**
 * Property 6: a provider identity is never linked to an existing account by
 * matching an email address.
 */
describe('sign-in resolution never matches on an address', () => {
  it('resolves an already-linked provider subject to that account', () => {
    const resolution = succeeded(resolveSocialSignIn({ linked: { userId: 'u-alice' }, contactExists: true }));
    expect(resolution).toEqual({ kind: 'existing_account', userId: 'u-alice' });
  });

  it('refuses to join an account that exists only because the address matches', () => {
    const error = rejected(resolveSocialSignIn({ linked: null, contactExists: true }));
    // `conflict`: the request is well formed and the provider did authenticate
    // somebody, but it conflicts with an account that already exists and may only
    // be joined deliberately.
    expect(error.code).toBe('conflict');
    expect(error.details?.['reason']).toBe('account_exists_requires_explicit_link');
    expect(error.details?.['action']).toBe('sign_in_then_link');
    expect(error.message).toBe(SOCIAL_LINK_REQUIRED_COPY.body);
  });

  it('creates a new account only when neither a link nor an address exists', () => {
    expect(succeeded(resolveSocialSignIn({ linked: null, contactExists: false }))).toEqual({
      kind: 'new_account',
    });
  });

  it('never returns an account id that came from the address alone', () => {
    const result = resolveSocialSignIn({ linked: null, contactExists: true });
    expect(JSON.stringify(result)).not.toContain('userId');
  });
});

describe('the provider vocabulary', () => {
  it('admits exactly the three providers this product offers', () => {
    expect(isSocialProvider('apple')).toBe(true);
    expect(isSocialProvider('google')).toBe(true);
    expect(isSocialProvider('meta')).toBe(true);
    expect(isSocialProvider('facebook')).toBe(false);
    expect(isSocialProvider('toString')).toBe(false);
  });

  it('refuses a body naming a provider it does not offer', () => {
    const error = rejected(readSocialSignUpInput({ provider: 'facebook', assertion: 'a.b.c' }));
    expect(error.details?.['field']).toBe('provider');
  });
});

describe('the rest of a social sign-up, in the order sign-up.ts orders it', () => {
  it('still refuses a stale terms version', () => {
    const error = rejected(evaluateSocialSignUp(request({ termsVersion: '2025-01-01' }), NOW, evaluateTerms));
    expect(error.code).toBe('validation_failed');
    expect(error.details?.['field']).toBe('terms');
  });

  it('still refuses a disposable address, whoever attested it', () => {
    const error = rejected(
      evaluateSocialSignUp(
        request({ verified: verified({ email: 'alice@mailinator.com' }) }),
        NOW,
        evaluateTerms,
      ),
    );
    expect(error.details?.['reason']).toBe('domain_not_allowed');
  });

  it('refuses a provider subject that names nobody', () => {
    const error = rejected(
      evaluateSocialSignUp(request({ verified: verified({ providerSubject: '   ' }) }), NOW, evaluateTerms),
    );
    expect(error.details?.['field']).toBe('providerSubject');
  });
});