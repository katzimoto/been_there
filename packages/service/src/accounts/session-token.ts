import { createHash, randomBytes } from 'node:crypto';

/**
 * The opaque session token, and the one digest of it that exists.
 *
 * §6 stores "an opaque server-side session id in a cookie". `account_sessions`
 * stores a digest of it, because a bearer token is a password: a database that
 * holds the plaintext holds every live session in one readable column. The token
 * is returned exactly once, at issue, and never persisted.
 *
 * The digest is plain salted-free SHA-256 rather than `hashOneTimeSecret`, and
 * the difference is load-bearing: a salted digest cannot be looked up, and a
 * session token has to be *resolved* by digest on every authenticated request.
 * `hashOneTimeSecret` is for a secret that is presented and compared once; this
 * is for one that is presented thousands of times and must index. A stolen table
 * of these digests is not login material the way a stolen table of scrypt password
 * hashes is not either — SHA-256 is fast, so an offline attacker could grind
 * candidates, but the input is 256 bits of `randomBytes` rather than a
 * human-chosen string, so there is no corpus to grind.
 *
 * Both functions live here rather than beside the routes because two callers
 * must agree on the answer exactly: the route that issues a token and the
 * resolver that reads one back. A digest computed in two places is two answers
 * waiting to disagree, and the failure mode is a session that cannot be used.
 */

const TOKEN_BYTES = 32;

/** A fresh bearer token. 64 hex characters, never stored, never logged. */
export function newSessionToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * The digest `account_sessions.token_hash` holds. Lower-case hex because that is
 * what Postgres returns from a `text` column and a `bytea` comparison here would
 * be a second encoding of the same key.
 */
export function sessionTokenDigest(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}