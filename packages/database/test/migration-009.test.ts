import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { databasePool, dropDatabase } from './support/database.js';

/**
 * Migration 009 against a database built from nothing.
 *
 * Every other suite in this package migrates a database that 009 has already been
 * applied to, so a mistake inside the migration — a missing `SET search_path`, a
 * constraint that only holds on a table that already existed — would show up as
 * "already applied" and pass. This suite builds the schema from zero, which is
 * the only way the file's own ordering is checked.
 *
 * The properties it asserts are the two the migration exists for, and both are
 * claims about what the schema *refuses*:
 *
 *  * `social_identities` has exactly four columns. The claim "no assertion, no
 *    token, no claims blob and no provider-supplied address is ever stored" is
 *    not checkable by reading a comment; it is checkable by reading
 *    `information_schema` and finding nowhere to put one.
 *  * A password method has a hash and a social method does not, in both
 *    directions.
 */
describe('migration 009: social sign-in, from an empty database', () => {
  let pool: pg.Pool;

  // `databasePool` creates the per-suite database and applies every migration to
  // it, which is the point: this suite needs the schema built from zero.
  beforeAll(async () => {
    pool = await databasePool('migration-009');
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await dropDatabase();
  });

  async function newUser(): Promise<string> {
    const userId = randomUUID();
    await pool.query('INSERT INTO app.users (user_id, account_id, created_at) VALUES ($1, $2, now())', [
      userId,
      randomUUID(),
    ]);
    return userId;
  }

  async function credential(userId: string, method: string, hash: string | null): Promise<void> {
    await pool.query(
      `INSERT INTO app.account_credentials
         (user_id, contact_kind, contact_identifier, contact_verified, password_hash,
          credential_method, created_at, updated_at)
       VALUES ($1, 'email', $2, false, $3, $4, now(), now())`,
      [userId, `${randomUUID()}@brightpost.test`, hash, method],
    );
  }

  it('puts social_identities in the app schema, not public', async () => {
    const result = await pool.query(
      `SELECT table_schema FROM information_schema.tables WHERE table_name = 'social_identities'`,
    );
    expect(result.rows).toEqual([{ table_schema: 'app' }]);
  });

  it('gives social_identities four columns and no room for an assertion or a claim', async () => {
    const result = await pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'social_identities'
        ORDER BY column_name`,
    );
    // This is the assertion that makes "the raw assertion is never stored"
    // checkable rather than aspirational. Adding a column for a token, a claims
    // blob or the provider's address breaks this test, which is the point: the
    // shape is what stops it.
    expect(result.rows).toEqual([
      { column_name: 'linked_at' },
      { column_name: 'provider' },
      { column_name: 'provider_subject' },
      { column_name: 'user_id' },
    ]);
  });

  it('admits no provider outside the three this product offers', async () => {
    const userId = await newUser();
    for (const provider of ['apple', 'google', 'meta']) {
      await expect(
        pool.query(
          'INSERT INTO app.social_identities (user_id, provider, provider_subject) VALUES ($1, $2, $3)',
          [userId, provider, `subject-${provider}`],
        ),
      ).resolves.toBeDefined();
    }
    for (const provider of ['facebook', 'twitter', 'tiktok']) {
      await expect(
        pool.query(
          'INSERT INTO app.social_identities (user_id, provider, provider_subject) VALUES ($1, $2, $3)',
          [userId, provider, `subject-${provider}`],
        ),
      ).rejects.toThrow(/social_identities_provider_vocabulary/);
    }
  });

  it('holds one provider subject to one account, and refuses the second', async () => {
    const first = await newUser();
    const second = await newUser();
    await pool.query('INSERT INTO app.social_identities (user_id, provider, provider_subject) VALUES ($1, $2, $3)', [
      first,
      'google',
      'shared-subject',
    ]);
    // This index, not an application read-then-write, is what stops a second
    // account claiming the provider account that already belongs to the first —
    // including under concurrency, where the read-then-write would not hold.
    await expect(
      pool.query('INSERT INTO app.social_identities (user_id, provider, provider_subject) VALUES ($1, $2, $3)', [
        second,
        'google',
        'shared-subject',
      ]),
    ).rejects.toThrow(/social_identities_provider_subject/);
  });

  it('lets one member hold two providers but never two identities from one', async () => {
    const userId = await newUser();
    await pool.query('INSERT INTO app.social_identities (user_id, provider, provider_subject) VALUES ($1, $2, $3)', [
      userId,
      'apple',
      'subject-a',
    ]);
    await expect(
      pool.query('INSERT INTO app.social_identities (user_id, provider, provider_subject) VALUES ($1, $2, $3)', [
        userId,
        'google',
        'subject-g',
      ]),
    ).resolves.toBeDefined();
    await expect(
      pool.query('INSERT INTO app.social_identities (user_id, provider, provider_subject) VALUES ($1, $2, $3)', [
        userId,
        'apple',
        'subject-a2',
      ]),
    ).rejects.toThrow(/social_identities_pkey/);
  });

  it('refuses a blank or padded subject, because a normalised key is the lookup key', async () => {
    const userId = await newUser();
    for (const subject of ['', '   ', ' padded']) {
      await expect(
        pool.query('INSERT INTO app.social_identities (user_id, provider, provider_subject) VALUES ($1, $2, $3)', [
          userId,
          'meta',
          subject,
        ]),
      ).rejects.toThrow(/social_identities_subject_present/);
    }
  });

  it('lets a credential have no password only when it is a provider credential', async () => {
    const social = await newUser();
    const password = await newUser();
    const mismatched = await newUser();

    // The two legal shapes. A successful insert resolves to `undefined` because
    // the statement has no `RETURNING`; what is being checked is that it does not
    // throw, so the assertion is written as the absence of a rejection.
    await expect(credential(social, 'social', null)).resolves.toBeUndefined();
    await expect(credential(password, 'password', 'scrypt:32768:8:1$c2FsdA==$ZGlnZXN0')).resolves.toBeUndefined();

    // A social method with a hash would be a credential that looks real and
    // authenticates nobody; a password method with none would break every
    // existing reader that assumes a hash is there.
    await expect(credential(mismatched, 'social', 'scrypt:32768:8:1$c2FsdA==$ZGlnZXN0')).rejects.toThrow(
      /account_credentials_method_shape/,
    );
    await expect(credential(mismatched, 'password', null)).rejects.toThrow(/account_credentials_method_shape/);
  });

  it('admits no credential method outside the two', async () => {
    const userId = await newUser();
    await expect(credential(userId, 'passkey', null)).rejects.toThrow(/account_credentials_method_vocabulary/);
  });

  it('leaves every credential that carries a hash labelled as a password credential', async () => {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS mismatched
         FROM app.account_credentials
        WHERE password_hash IS NOT NULL AND credential_method <> 'password'`,
    );
    // 009 adds the column with a default and adds the CHECK afterwards, so the
    // `NOT NULL` column it used to carry satisfies the new constraint without a
    // backfill. If that ever stops being true — a later migration, a restored
    // dump — this is where it shows. Provider credentials carry no hash and are
    // deliberately not counted here.
    expect(result.rows).toEqual([{ mismatched: 0 }]);
  });

  it('admits oauth as a session method, which is the value a provider sign-in records', async () => {
    const userId = await newUser();
    await credential(userId, 'social', null);
    await expect(
      pool.query(
        `INSERT INTO app.account_sessions
           (session_id, user_id, subject_kind, automated, auth_method, status, token_hash,
            issued_at, expires_at, refreshable_until, last_active_at)
         VALUES ($1, $2, 'member', false, 'oauth', 'active', $3, now(), now(), now(), now())`,
        [randomUUID(), userId, `digest-${randomUUID()}`],
      ),
    ).resolves.toBeDefined();
    // And no other spelling of "signed in with Apple" is accepted, because a
    // second vocabulary for one method is a second answer to "how did this
    // session authenticate".
    await expect(
      pool.query(
        `INSERT INTO app.account_sessions
           (session_id, user_id, subject_kind, automated, auth_method, status, token_hash,
            issued_at, expires_at, refreshable_until, last_active_at)
         VALUES ($1, $2, 'member', false, 'apple', 'active', $3, now(), now(), now(), now())`,
        [randomUUID(), userId, `digest-${randomUUID()}`],
      ),
    ).rejects.toThrow(/account_sessions_auth_method_check/);
  });

  it('deletes a provider identity with the account it belonged to', async () => {
    const userId = await newUser();
    await pool.query('INSERT INTO app.social_identities (user_id, provider, provider_subject) VALUES ($1, $2, $3)', [
      userId,
      'meta',
      'subject-to-cascade',
    ]);
    await pool.query('DELETE FROM app.users WHERE user_id = $1', [userId]);
    const remaining = await pool.query('SELECT COUNT(*)::int AS n FROM app.social_identities WHERE user_id = $1', [
      userId,
    ]);
    expect(remaining.rows).toEqual([{ n: 0 }]);
  });
});