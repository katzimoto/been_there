import { createPublicKey, createVerify, type KeyObject } from 'node:crypto';
import { type DomainError, type Err, type Result, domainError, ok } from '@been-there/core';
import { type SocialProvider, type VerifiedSocialIdentity } from './social-authn.js';

/**
 * Verifying a Sign in with Apple identity token, for real.
 *
 * Apple signs the identity token with an asymmetric key and publishes the public
 * half at a published URL. Nothing about that requires an Apple Developer team
 * to *verify* — a team is needed to *obtain* a token, which is why no route
 * exists yet ([`docs/features/social-sign-in.md`](../../docs/features/social-sign-in.md)
 * §8). Verification is implemented here in full and tested against a real RSA
 * signature, because "we would verify it if we had credentials" is how a
 * verifier that has never run ships.
 *
 * ## What is checked, and why each check is not optional
 *
 * | Check | The attack it refuses |
 * |-------|----------------------|
 * | three-segment structure, base64url JSON | parsing something that is not a JWT at all |
 * | `alg === 'RS256'` | the `alg: none` and HMAC-confusion families |
 * | signature over the exact header and payload bytes | any claim edited after signing |
 * | `iss === 'https://appleid.apple.com'` | a token this product's own key signed, replayed at Apple |
 * | `aud` contains our `app_id` | a token minted for a *different* developer, replayed here |
 * | `nonce` equals the one we sent | a token replayed from our own logs into a fresh sign-in |
 * | `exp` in the future, `iat` not in the future | an expired or not-yet-valid token |
 * | `sub` present | a token that identifies nobody |
 * | `email_verified` read as a boolean | property 4's condition silently reading a string as absent |
 *
 * ## What is deliberately not here
 *
 * The authorization-code exchange. It needs a client secret, it needs a
 * `redirect_uri` registered against a paid team, and it is a network call to a
 * vendor endpoint — so it belongs with whoever holds those credentials. What is
 * here proves the assertion is genuine; it does not prove the code beside it was
 * issued to us, and the spec records the difference rather than blurring it.
 */

/** Where Apple's public signing keys live. Fetched; never hardcoded. */
export const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';

/** The only issuer an Apple identity token may carry. */
export const APPLE_ISSUER = 'https://appleid.apple.com';

/** One JWK from Apple's key set. Only the RSA signing fields are read. */
export interface AppleJsonWebKey {
  readonly kid: string;
  readonly kty: string;
  readonly alg?: string;
  readonly use?: string;
  readonly n: string;
  readonly e: string;
}

/** Apple's key set, as fetched from {@link APPLE_KEYS_URL}. */
export interface AppleKeySet {
  readonly keys: readonly AppleJsonWebKey[];
}

/**
 * Where the keys come from.
 *
 * A port rather than a call to `fetch` inside this module, for two reasons: the
 * verification rules become testable against a fixture key pair without a
 * network, and a caller owns the caching policy — Apple rotates keys, and a
 * verifier that refetches per request is a verifier that turns a sign-in into an
 * availability dependency.
 */
export type AppleKeyFetcher = () => Promise<AppleKeySet>;

export interface AppleAssertionRequest {
  /** The `identityToken` from the authorization response, verbatim. */
  readonly assertion: string;
  /** The `app_id` this product registered with Apple. Also checked as `aud`. */
  readonly audience: string;
  /** The nonce sent on the authorize request. Checked as the token's `nonce`. */
  readonly nonce: string;
  readonly now: Date;
  readonly fetchKeys: AppleKeyFetcher;
}

function base64UrlToBuffer(segment: string): Buffer {
  return Buffer.from(segment, 'base64url');
}

/**
 * Reads a segment as JSON, or refuses.
 *
 * `JSON.parse` on an untrusted string is the one place in this module where a
 * malformed input could otherwise become an unhandled exception rather than a
 * `Result`, so the shape is checked before the parse result is used as claims.
 */
function parseSegment(segment: string, label: string): Result<Record<string, unknown>, DomainError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlToBuffer(segment).toString('utf8'));
  } catch {
    return invalid(`the ${label} of the assertion is not readable JSON`, 'malformed_assertion');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return invalid(`the ${label} of the assertion is not a JSON object`, 'malformed_assertion');
  }
  return ok(parsed as Record<string, unknown>);
}

/**
 * Every malformed-assertion refusal, in one shape.
 *
 * `validation_failed` rather than `permission_denied`: the assertion is a piece
 * of input the client handed us and it does not meet the format. `permission_denied`
 * is reserved for "you are not allowed", and the two are told apart by callers
 * that retry — a client can fix a malformed token by getting a new one, and
 * cannot fix a denied one by anything.
 */
function invalid(message: string, reason: string): Err<DomainError> {
  return domainError('validation_failed', 'platform.apple', message, { reason });
}

/**
 * Apple's `email_verified` claim, read the way Apple writes it.
 *
 * Apple sends the string `"true"` or `"false"` rather than a JSON boolean, and
 * omits the claim on authorisations after the first. Reading it as a JavaScript
 * truthiness test is the specific bug that would make a verified address look
 * unverified: `"false"` is a non-empty string and therefore truthy. Three
 * inputs, three answers, and the absent one is `false` because an unstated claim
 * is not evidence.
 */
export function readAppleEmailVerified(claims: Readonly<Record<string, unknown>>): boolean {
  const raw = claims['email_verified'];
  if (typeof raw === 'boolean') {
    return raw;
  }
  return typeof raw === 'string' && raw === 'true';
}

/** The audience claim may be a string or an array of them. */
function audienceMatches(claim: unknown, audience: string): boolean {
  if (typeof claim === 'string') {
    return claim === audience;
  }
  return Array.isArray(claim) && claim.includes(audience);
}

/**
 * Resolves a `kid` to a usable public key, refusing anything that is not an RSA
 * signing key.
 *
 * The `kty`, `use` and `alg` refusals are the ones that matter: a key set that
 * also carries an encryption key, or a key advertising an algorithm this
 * verifier does not use, must not be silently accepted because its `kid`
 * matched. Accepting an `alg` other than the one the header named would defeat
 * the header check entirely.
 */
function signingKey(keySet: AppleKeySet, kid: string, alg: string): Result<KeyObject, DomainError> {
  const key = keySet.keys.find((candidate) => candidate.kid === kid);
  if (key === undefined) {
    return invalid('the assertion was signed with a key this product has not seen', 'unknown_signing_key');
  }
  if (key.kty !== 'RSA') {
    return invalid('the signing key is not an RSA key', 'unsupported_signing_key');
  }
  if (key.use !== undefined && key.use !== 'sig') {
    return invalid('the signing key is not a signature key', 'unsupported_signing_key');
  }
  if (key.alg !== undefined && key.alg !== alg) {
    return invalid('the signing key does not match the algorithm the assertion declares', 'alg_mismatch');
  }
  try {
    return ok(createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' }));
  } catch {
    return invalid('the signing key could not be read', 'malformed_signing_key');
  }
}

/**
 * Verifies an Apple identity token and returns the two things worth keeping.
 *
 * On success the caller receives a `VerifiedSocialIdentity` whose type has no
 * field for the token: the assertion is an input to this function and is not an
 * output of it, which is what makes "the raw assertion is never stored" a
 * property of the shapes rather than a rule someone has to remember.
 */
export async function verifyAppleAssertion(
  request: AppleAssertionRequest,
): Promise<Result<VerifiedSocialIdentity, DomainError>> {
  const parts = request.assertion.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    return invalid('the assertion is not a three-part signed token', 'malformed_assertion');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  const header = await parseSegment(encodedHeader, 'header');
  if (!header.ok) {
    return header;
  }
  if (header.value['alg'] !== 'RS256') {
    return invalid('only RS256 assertions are accepted', 'unsupported_alg');
  }
  const kid = header.value['kid'];
  if (typeof kid !== 'string' || kid.length === 0) {
    return invalid('the assertion does not name a signing key', 'missing_kid');
  }

  const keySet = await request.fetchKeys();
  const key = signingKey(keySet, kid, 'RS256');
  if (!key.ok) {
    return key;
  }
  if (!createVerify('RSA-SHA256').update(`${encodedHeader}.${encodedPayload}`).verify(key.value, base64UrlToBuffer(encodedSignature))) {
    return invalid('the assertion signature is not valid for this payload', 'bad_signature');
  }

  const claims = await parseSegment(encodedPayload, 'payload');
  if (!claims.ok) {
    return claims;
  }
  if (claims.value['iss'] !== APPLE_ISSUER) {
    return invalid('the assertion was not issued by Apple', 'wrong_issuer');
  }
  if (!audienceMatches(claims.value['aud'], request.audience)) {
    return invalid('the assertion was minted for another application', 'wrong_audience');
  }
  if (claims.value['nonce'] !== request.nonce) {
    return invalid('the assertion nonce does not match the one this request sent', 'nonce_mismatch');
  }
  const subject = claims.value['sub'];
  if (typeof subject !== 'string' || subject.trim().length === 0) {
    return invalid('the assertion names no account subject', 'missing_subject');
  }
  const nowSeconds = Math.floor(request.now.getTime() / 1000);
  const expiry = claims.value['exp'];
  if (typeof expiry !== 'number' || expiry <= nowSeconds) {
    return invalid('the assertion has expired', 'expired_assertion');
  }
  const issuedAt = claims.value['iat'];
  if (typeof issuedAt !== 'number' || issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) {
    return invalid('the assertion is not valid yet', 'assertion_not_yet_valid');
  }
  const email = claims.value['email'];
  if (email !== undefined && typeof email !== 'string') {
    return invalid('the assertion carries an email claim that is not a string', 'malformed_email_claim');
  }

  const provider: SocialProvider = 'apple';
  return ok({
    provider,
    providerSubject: subject,
    email: typeof email === 'string' ? email : null,
    emailVerified: readAppleEmailVerified(claims.value),
  });
}

/**
 * Tolerance for a clock a little ahead of ours, in seconds.
 *
 * Apple's `iat` is stamped by Apple's servers and a phone whose clock is a few
 * seconds fast would otherwise be told its own fresh assertion is not valid yet.
 * Sixty seconds is the ordinary tolerance for this and no more: a window wide
 * enough to matter as an attack would be minutes.
 */
const CLOCK_SKEW_SECONDS = 60;