import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  APPLE_ISSUER,
  type AppleKeySet,
  type AppleJsonWebKey,
  readAppleEmailVerified,
  verifyAppleAssertion,
} from '../src/index.js';
import { rejected, succeeded } from './helpers.js';

/**
 * Sign in with Apple, verified for real.
 *
 * The key pair is generated here rather than checked in and the tokens are
 * genuinely signed with it, so every test below runs the actual RSA-SHA256
 * verification path. A fixture that stubbed the verifier would prove only that
 * the stub agrees with itself, which is the failure this repository exists to
 * prevent — the same reasoning that makes a social sign-in button that does not
 * verify an assertion unacceptable.
 *
 * What is *not* faked is the thing that cannot be: Apple's keys are fetched from
 * a published URL by the caller, and no test reaches the network. The suite
 * substitutes the key source, which is a port this module declares for exactly
 * this reason.
 */
const AUDIENCE = 'com.beenthere.app';
const NOW = new Date('2026-03-01T12:00:00.000Z');
const NONCE = 'nonce-4f2a9c';

/** A fresh RSA-2048 pair. Expensive enough to be a real key, cheap enough per-suite. */
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

const kid = 'fixture-signing-key';
const appleKeySet: AppleKeySet = {
  keys: [
    {
      kid,
      kty: 'RSA',
      alg: 'RS256',
      use: 'sig',
      n: publicKey.export({ format: 'jwk' }).n ?? '',
      e: publicKey.export({ format: 'jwk' }).e ?? '',
    },
  ],
};

const fetchKeys = (): Promise<AppleKeySet> => Promise.resolve(appleKeySet);

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function sign(claims: Readonly<Record<string, unknown>>, header: Readonly<Record<string, unknown>> = {}): string {
  const encodedHeader = base64Url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT', ...header }));
  const encodedPayload = base64Url(JSON.stringify(claims));
  const signature = createSign('RSA-SHA256')
    .update(`${encodedHeader}.${encodedPayload}`)
    .sign(privateKey)
    .toString('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function goodClaims(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    iss: APPLE_ISSUER,
    aud: AUDIENCE,
    exp: Math.floor(NOW.getTime() / 1000) + 600,
    iat: Math.floor(NOW.getTime() / 1000) - 60,
    nonce: NONCE,
    sub: '001234.abc.5678',
    email: 'alice@brightpost.com',
    email_verified: 'true',
    ...overrides,
  };
}

function verify(assertion: string) {
  return verifyAppleAssertion({ assertion, audience: AUDIENCE, nonce: NONCE, now: NOW, fetchKeys });
}

describe('a genuine Apple identity token', () => {
  it('verifies and yields only the subject and the email attestation', async () => {
    const identity = succeeded(await verify(sign(goodClaims())));

    expect(identity).toEqual({
      provider: 'apple',
      providerSubject: '001234.abc.5678',
      email: 'alice@brightpost.com',
      emailVerified: true,
    });
    // The token is an input, never an output: the returned value has nowhere to
    // carry it, which is what makes "the raw assertion is never stored" a property
    // of the shapes rather than a rule somebody has to remember.
    expect(Object.keys(identity).sort()).toEqual(['email', 'emailVerified', 'provider', 'providerSubject']);
  });

  it('reports no email when Apple omitted it, which it does after the first authorisation', async () => {
    const identity = succeeded(await verify(sign(goodClaims({ email: undefined, email_verified: undefined }))));
    expect(identity.email).toBeNull();
    expect(identity.emailVerified).toBe(false);
  });

  it('accepts an aud array containing this application', async () => {
    const identity = succeeded(await verify(sign(goodClaims({ aud: ['com.other.app', AUDIENCE] }))));
    expect(identity.providerSubject).toBe('001234.abc.5678');
  });

  it('tolerates a clock a minute fast', async () => {
    const justAhead = Math.floor(NOW.getTime() / 1000) + 45;
    await expect(verify(sign(goodClaims({ iat: justAhead })))).resolves.toMatchObject({ ok: true });
  });
});

describe('an Apple identity token that is not ours', () => {
  it('refuses a tampered payload even though the header is intact', async () => {
    const genuine = sign(goodClaims());
    const [header, , signature] = genuine.split('.') as [string, string, string];
    const tampered = `${header}.${base64Url(JSON.stringify(goodClaims({ sub: '001999.evil.0000' })))}.${signature}`;

    const error = rejected(await verify(tampered));
    expect(error.details?.['reason']).toBe('bad_signature');
  });

  it('refuses a token signed by a key Apple did not publish', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const header = base64Url(JSON.stringify({ alg: 'RS256', kid: 'someone-elses-key' }));
    const payload = base64Url(JSON.stringify(goodClaims()));
    const signature = createSign('RSA-SHA256')
      .update(`${header}.${payload}`)
      .sign(other.privateKey)
      .toString('base64url');

    const error = rejected(await verify(`${header}.${payload}.${signature}`));
    expect(error.details?.['reason']).toBe('unknown_signing_key');
  });

  it('refuses a token minted for another application', async () => {
    const error = rejected(await verify(sign(goodClaims({ aud: 'com.somebody.else' }))));
    expect(error.details?.['reason']).toBe('wrong_audience');
  });

  it('refuses a token replayed into a fresh sign-in with a different nonce', async () => {
    const error = rejected(await verify(sign(goodClaims({ nonce: 'a-nonce-from-another-request' }))));
    expect(error.details?.['reason']).toBe('nonce_mismatch');
  });

  it('refuses an expired token', async () => {
    const error = rejected(
      await verify(sign(goodClaims({ exp: Math.floor(NOW.getTime() / 1000) - 1 }))),
    );
    expect(error.details?.['reason']).toBe('expired_assertion');
  });

  it('refuses a token that is not yet valid, past the clock tolerance', async () => {
    const error = rejected(
      await verify(sign(goodClaims({ iat: Math.floor(NOW.getTime() / 1000) + 600 }))),
    );
    expect(error.details?.['reason']).toBe('assertion_not_yet_valid');
  });

  it('refuses a token naming no issuer but ours', async () => {
    const error = rejected(await verify(sign(goodClaims({ iss: 'https://evil.example' }))));
    expect(error.details?.['reason']).toBe('wrong_issuer');
  });

  it('refuses a token naming no subject', async () => {
    const error = rejected(await verify(sign(goodClaims({ sub: '' }))));
    expect(error.details?.['reason']).toBe('missing_subject');
  });
});

describe('the algorithm check, which is not optional', () => {
  it('refuses alg none', async () => {
    const header = base64Url(JSON.stringify({ alg: 'none', kid }));
    const payload = base64Url(JSON.stringify(goodClaims()));
    const error = rejected(await verify(`${header}.${payload}.`));
    expect(error.code).toBe('validation_failed');
  });

  it('refuses an HS256 header before any key is fetched', async () => {
    const fetched: string[] = [];
    const counting = (): Promise<AppleKeySet> => {
      fetched.push('called');
      return Promise.resolve(appleKeySet);
    };
    const header = base64Url(JSON.stringify({ alg: 'HS256', kid }));
    const payload = base64Url(JSON.stringify(goodClaims()));
    const error = rejected(
      await verifyAppleAssertion({ assertion: `${header}.${payload}.abc`, audience: AUDIENCE, nonce: NONCE, now: NOW, fetchKeys: counting }),
    );
    expect(error.details?.['reason']).toBe('unsupported_alg');
    expect(fetched).toEqual([]);
  });

  it('refuses a key set whose key declares an algorithm the header did not', async () => {
    const mismatched: AppleKeySet = {
      keys: [{ kid, kty: 'RSA', alg: 'RS512', use: 'sig', n: appleKeySet.keys[0]?.n ?? '', e: appleKeySet.keys[0]?.e ?? '' }],
    };
    const error = rejected(
      await verifyAppleAssertion({
        assertion: sign(goodClaims()),
        audience: AUDIENCE,
        nonce: NONCE,
        now: NOW,
        fetchKeys: (): Promise<AppleKeySet> => Promise.resolve(mismatched),
      }),
    );
    expect(error.details?.['reason']).toBe('alg_mismatch');
  });

  it('refuses an encryption key offered under a matching kid', async () => {
    const encryptionKey: AppleJsonWebKey = {
      kid,
      kty: 'RSA',
      use: 'enc',
      n: appleKeySet.keys[0]?.n ?? '',
      e: appleKeySet.keys[0]?.e ?? '',
    };
    const error = rejected(
      await verifyAppleAssertion({
        assertion: sign(goodClaims()),
        audience: AUDIENCE,
        nonce: NONCE,
        now: NOW,
        fetchKeys: (): Promise<AppleKeySet> => Promise.resolve({ keys: [encryptionKey] }),
      }),
    );
    expect(error.details?.['reason']).toBe('unsupported_signing_key');
  });
});

describe('a malformed assertion', () => {
  it('refuses something that is not three segments', async () => {
    expect(rejected(await verify('not-a-token')).details?.['reason']).toBe('malformed_assertion');
    expect(rejected(await verify('a.b')).details?.['reason']).toBe('malformed_assertion');
    expect(rejected(await verify('a..c')).details?.['reason']).toBe('malformed_assertion');
  });

  it('refuses a header that is not readable JSON', async () => {
    const error = rejected(await verify(`${base64Url('nonsense')}.${base64Url('{}')}.sig`));
    expect(error.details?.['reason']).toBe('malformed_assertion');
  });

  it('refuses a header naming no key', async () => {
    const header = base64Url(JSON.stringify({ alg: 'RS256' }));
    const payload = base64Url(JSON.stringify(goodClaims()));
    const error = rejected(await verify(`${header}.${payload}.sig`));
    expect(error.details?.['reason']).toBe('missing_kid');
  });
});

/**
 * Property 4 again, at the claim level: Apple's `email_verified` arrives as a
 * *string*. Reading it as a JavaScript truthiness test is the specific bug that
 * would make a provider-attested address look unverified — `"false"` is a
 * non-empty string and therefore truthy — or, worse, the other way round.
 */
describe("Apple's email_verified, read the way Apple writes it", () => {
  it('reads the string true and the string false correctly', () => {
    expect(readAppleEmailVerified({ email_verified: 'true' })).toBe(true);
    expect(readAppleEmailVerified({ email_verified: 'false' })).toBe(false);
  });

  it('reads a JSON boolean correctly, for a provider that sends one', () => {
    expect(readAppleEmailVerified({ email_verified: true })).toBe(true);
    expect(readAppleEmailVerified({ email_verified: false })).toBe(false);
  });

  it('treats an absent claim as not verified, because an unstated claim is not evidence', () => {
    expect(readAppleEmailVerified({})).toBe(false);
    expect(readAppleEmailVerified({ email_verified: 'TRUE' })).toBe(false);
    expect(readAppleEmailVerified({ email_verified: 1 })).toBe(false);
  });

  it('carries that reading through the whole verification', async () => {
    const notVerified = succeeded(await verify(sign(goodClaims({ email_verified: 'false' }))));
    expect(notVerified.emailVerified).toBe(false);
    expect(notVerified.email).toBe('alice@brightpost.com');
  });
});

describe('the fixture key pair', () => {
  it('is a real RSA public key exported as a JWK, not a hardcoded string', () => {
    // A checked-in private key would make this suite a signing oracle for anyone
    // who found it, and a hardcoded modulus is exactly the "invented keys" this
    // work was told not to ship. Generated once per run and used nowhere else.
    const exported = publicKey.export({ format: 'jwk' });
    expect(exported.kty).toBe('RSA');
    expect(exported.n).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(exported.n).toBe(appleKeySet.keys[0]?.n);
  });
});