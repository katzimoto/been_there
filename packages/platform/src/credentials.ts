import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { domainToASCII } from 'node:url';
import { type DomainError, type Result, domainError, ok } from '@been-there/core';

/**
 * Credentials and contact identifiers — Platform's, per the architecture's
 * ownership table ("Credential, session, contact-verification, rate-limit").
 *
 * Four rules live here rather than at a sign-up call site, because all four
 * exist to be *unbypassable*: a password policy checked in a handler is a policy
 * the next handler forgets, and a contact normaliser written twice is two
 * different answers to "is this the same person as the account I found".
 *
 * The hashing choices are the load-bearing part:
 *
 *  - Passwords use scrypt with a per-password salt. A password is a
 *    low-entropy secret chosen for memorability, so it is stretched rather than
 *    digested; an email address is not, and is not stored here at all.
 *  - One-time codes and reset links are compared against a salted digest with
 *    `timingSafeEqual`. A code is six digits, so the space is small enough that
 *    a timing side channel is a real attack rather than a theoretical one.
 *  - The stored form never contains the secret in a form that survives a
 *    database read into a support tool.
 */


export const PASSWORD_MIN_CHARS = 10;
export const PASSWORD_MAX_CHARS = 200;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: {
    readonly N: number;
    readonly r: number;
    readonly p: number;
    readonly maxmem: number;
  },
) => Promise<Buffer>;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_COST = 2 ** 15;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;

/**
 * Node's default `maxmem` is 32 MiB and scrypt's own requirement is
 * `128 * N * r`, which at these parameters is 33,554,432 bytes - exactly 32 MiB,
 * before any overhead. The default is therefore not merely tight, it is failing,
 * and every hash and every verify threw `digital envelope routines::memory limit
 * exceeded` until this was found. Unnoticed for as long as no route called them.
 *
 * Derived from the parameters and doubled, rather than a literal: raising
 * `SCRYPT_COST` later must not silently start throwing again, which is the same
 * failure the parameterised hash string exists to prevent.
 */
function scryptMemoryFor(cost: number, blockSize: number): number {
  return 128 * cost * blockSize * 2;
}

const SCRYPT_MAX_MEMORY = scryptMemoryFor(SCRYPT_COST, SCRYPT_BLOCK_SIZE);

export interface CredentialCopy {
  readonly title: string;
  readonly body: string;
}

/** The failure table's copy for a password that has already been breached. */
export const BREACHED_PASSWORD_COPY: CredentialCopy = {
  title: 'That password has appeared in a data breach.',
  body: 'Choose a different one.',
};

export const DOMAIN_NOT_ALLOWED_COPY: CredentialCopy = {
  title: "We can't use that email address.",
  body: 'Use a personal email address, or continue with a phone number instead.',
};

export const SIGN_IN_FAILED_COPY: CredentialCopy = {
  title: "That email and password don't match.",
  body: 'Try again, or reset your password.',
};

/**
 * A seed of the Platform-maintained breached-password list.
 *
 * §5.1 requires the check at set and at login, and the check has to be a
 * *list* — a composition rule would reject a passphrase and accept
 * `Password1234`, which is worse in both directions. What is here is the
 * always-present core of that list; it is a constant rather than a fetched
 * corpus because a network dependency in the sign-up path turns a breach check
 * into an outage. Swapping this for a full corpus load is a one-line change to
 * this file and nothing else.
 */
export const BREACHED_PASSWORDS: readonly string[] = [
  '123456789',
  '1234567890',
  'password12',
  'password123',
  'password1234',
  'qwerty12345',
  'iloveyou123',
  'letmein1234',
  'admin123456',
  'welcome1234',
  'football123',
  'baseball123',
  'sunshine123',
  'princess123',
  'trustno1234',
  'starwars123',
  'whatever123',
  'zaq12wsx345',
  'changeme123',
  'secret1234',
];

/**
 * Domains that exist to receive mail and throw it away, plus the role addresses
 * nobody signs up with. Both are refusals for the same reason: neither can
 * receive the message recovery depends on, and recovery is the weakest link in
 * the account lifecycle.
 */
export const DISPOSABLE_EMAIL_DOMAINS: readonly string[] = [
  'dispostable.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'mailinator.com',
  'maildrop.cc',
  'sharklasers.com',
  'tempmail.com',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
];

export const ROLE_EMAIL_DOMAINS: readonly string[] = [
  'example.com',
  'example.net',
  'example.org',
  'invalid',
  'localhost',
  'test',
];

export type ContactKind = 'email' | 'phone';

export interface NormalizedContact {
  readonly kind: ContactKind;
  /** Lowercased for email, E.164 for phone. The only form it is ever stored in. */
  readonly identifier: string;
}

const EMAIL_SHAPE = /^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/;
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Normalises a contact identifier, or refuses it.
 *
 * `domainToASCII` is the punycode step §5.1 asks for, and it is the library's
 * rather than a regex: an IDN has one correct encoding and a hand-rolled one is
 * a second answer to "which bytes are the domain". The local part is lowercased
 * because that is what every major provider treats as canonical, and the domain
 * is lowercased for the same reason.
 */
export function normalizeContact(kind: ContactKind, value: string): Result<NormalizedContact, DomainError> {
  if (kind === 'phone') {
    const digits = value.replace(/[\s()-]/g, '');
    if (!E164.test(digits)) {
      return domainError('validation_failed', 'platform.credentials', 'a phone number must be E.164', {
        field: 'contactIdentifier',
      });
    }
    return ok({ kind, identifier: digits });
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 254 || !EMAIL_SHAPE.test(trimmed)) {
    return domainError('validation_failed', 'platform.credentials', 'the email address is not a usable address', {
      field: 'contactIdentifier',
    });
  }
  const at = trimmed.lastIndexOf('@');
  const local = trimmed.slice(0, at).toLowerCase();
  const domain = domainToASCII(trimmed.slice(at + 1).toLowerCase());
  if (domain.length === 0) {
    return domainError('validation_failed', 'platform.credentials', 'the email domain is not a usable domain', {
      field: 'contactIdentifier',
    });
  }
  return ok({ kind, identifier: `${local}@${domain}` });
}

/**
 * Whether an email address may be used to sign up at all.
 *
 * Separate from `normalizeContact` on purpose: one of the two answers is "what
 * is this address" and the other is "may this product have an account at this
 * address", and a caller that asked both at once could not tell which rule it
 * broke. The copy names the phone route, because the refusal is only fair if it
 * says what to do instead.
 */
export function isEmailDomainAllowed(contact: NormalizedContact): Result<true, DomainError> {
  if (contact.kind !== 'email') {
    return ok(true);
  }
  const domain = contact.identifier.slice(contact.identifier.indexOf('@') + 1);
  if (DISPOSABLE_EMAIL_DOMAINS.includes(domain) || ROLE_EMAIL_DOMAINS.includes(domain)) {
    return domainError('validation_failed', 'platform.credentials', DOMAIN_NOT_ALLOWED_COPY.body, {
      field: 'contactIdentifier',
      title: DOMAIN_NOT_ALLOWED_COPY.title,
      reason: 'domain_not_allowed',
    });
  }
  return ok(true);
}

/**
 * The password rule, and nothing else.
 *
 * §5.1 asks for a length floor and no composition rules, deliberately: a rule
 * that demands a symbol pushes people towards `Passw0rd!` and towards writing
 * it on a sticky note. What it does demand is that the password is not already
 * in a breach corpus, which is the one check that measurably helps.
 */
export function evaluatePassword(password: string): Result<true, DomainError> {
  if (password.length < PASSWORD_MIN_CHARS || password.length > PASSWORD_MAX_CHARS) {
    return domainError(
      'validation_failed',
      'platform.credentials',
      `a password must be between ${PASSWORD_MIN_CHARS} and ${PASSWORD_MAX_CHARS} characters`,
      { field: 'password' },
    );
  }
  if (BREACHED_PASSWORDS.includes(password.toLowerCase())) {
    return domainError('validation_failed', 'platform.credentials', BREACHED_PASSWORD_COPY.body, {
      field: 'password',
      title: BREACHED_PASSWORD_COPY.title,
      reason: 'password_known_breached',
    });
  }
  return ok(true);
}

/**
 * Hashes a password. `scrypt:N:r:p$salt$digest` — every parameter the hash was
 * made with travels with it, so raising the cost later re-hashes on the next
 * successful login instead of invalidating every stored password at once.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELISM,
    maxmem: SCRYPT_MAX_MEMORY,
  })) as Buffer;
  return `scrypt:${SCRYPT_COST}:${SCRYPT_BLOCK_SIZE}:${SCRYPT_PARALLELISM}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Verifies a password against a stored hash, always in constant time relative
 * to the digest. A stored value that is not a hash this module wrote returns
 * `false` rather than throwing: a corrupt row is a failed login, and a failed
 * login is the answer a caller can act on.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3) {
    return false;
  }
  const [parameters, saltText, digestText] = parts;
  if (parameters === undefined || saltText === undefined || digestText === undefined) {
    return false;
  }
  const [algorithm, cost, blockSize, parallelism] = parameters.split(':');
  if (algorithm !== 'scrypt' || cost === undefined || blockSize === undefined || parallelism === undefined) {
    return false;
  }
  const expected = Buffer.from(digestText, 'base64');
  const derived = (await scryptAsync(password, Buffer.from(saltText, 'base64'), expected.length, {
    N: Number(cost),
    r: Number(blockSize),
    p: Number(parallelism),
    // From the *stored* parameters, not the current ones: a hash written at a
    // higher cost must still verify after the cost is lowered.
    maxmem: scryptMemoryFor(Number(cost), Number(blockSize)),
  })) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * A digest for a short-lived secret: a one-time code or a reset link.
 *
 * Not scrypt, deliberately. This is compared at most a handful of times per
 * issued code and the code is dead within minutes, so the work factor buys
 * nothing and a 250 ms KDF on the sign-in path is a latency budget nobody
 * approved. A per-secret salt is what matters here, and it is what stops a
 * stolen table from being precomputed against.
 */
export function hashOneTimeSecret(secret: string): string {
  const salt = randomBytes(16);
  return `${salt.toString('base64')}$${createHash('sha256').update(`${salt.toString('base64')}:${secret}`).digest('base64')}`;
}

/** Constant-time comparison of a presented secret against a stored digest. */
export function secretMatches(presented: string, stored: string): boolean {
  const [saltText, digestText] = stored.split('$');
  if (saltText === undefined || digestText === undefined) {
    return false;
  }
  const expected = Buffer.from(digestText, 'base64');
  const actual = createHash('sha256').update(`${saltText}:${presented}`).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
