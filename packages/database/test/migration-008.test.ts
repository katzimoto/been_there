import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { databasePool, dropDatabase } from './support/database.js';

/**
 * Migration 008 against a database built from nothing.
 *
 * The suite this lives next to already proves the store round-trips, but every
 * other suite in this repository migrates a database that 008 has already been
 * applied to — so a mistake in the migration itself (a missing `SET search_path`,
 * a statement out of order, a constraint that only holds on a table that already
 * existed) shows up as "already applied" and passes. This one builds the schema
 * from zero, which is the only way the file's own ordering is checked.
 */
describe('migration 008: staff identity, from an empty database', () => {
  let pool: pg.Pool;

  // `databasePool` creates the per-suite database and applies every migration to
  // it, which is the point: this suite needs the schema built from zero rather
  // than inherited.
  beforeAll(async () => {
    pool = await databasePool('migration-008');
  }, 60_000);

  afterAll(async () => {
    await dropDatabase();
  });

  it('puts staff_identities in the app schema, not public', async () => {
    const result = await pool.query(
      `SELECT table_schema FROM information_schema.tables
        WHERE table_name = 'staff_identities'`,
    );
    // A bare CREATE TABLE lands in `public` unless the file sets the search path,
    // and then the ALTER TABLE in the same file cannot resolve the table it just
    // created. This assertion is the cheap half of catching that.
    expect(result.rows).toEqual([{ table_schema: 'app' }]);
  });

  it('adds the subject columns to account_sessions', async () => {
    const result = await pool.query(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'account_sessions'
          AND column_name IN ('user_id', 'subject_kind', 'staff_id', 'automated')
        ORDER BY column_name`,
    );
    expect(result.rows).toEqual([
      // Nullable, because a staff session has no member id. That is the whole
      // reason this column moved, and it is also the reason the two subject-kind
      // hazards in routes/account-sessions.ts became reachable.
      { column_name: 'automated', is_nullable: 'NO', column_default: 'false' },
      { column_name: 'staff_id', is_nullable: 'YES', column_default: null },
      { column_name: 'subject_kind', is_nullable: 'NO', column_default: "'member'::text" },
      { column_name: 'user_id', is_nullable: 'YES', column_default: null },
    ]);
  });

  it('refuses a session that is both a member and a staff identity', async () => {
    // A real identity, because `staff_id` carries a foreign key. Inserting a
    // dangling one would fail on the FK before it ever reached the CHECK, and the
    // test would be asserting the wrong constraint.
    await pool.query(
      `INSERT INTO app.staff_identities
         (staff_id, contact_kind, contact_identifier, password_hash, display_name, role, status,
          created_at, updated_at)
       VALUES ('22222222-2222-4222-8222-222222222222', 'email', 'mod@example.test', 'hash',
               'Moderator', 'senior_moderator', 'active', now(), now())`,
    );
    await pool.query(
      `INSERT INTO app.users (user_id, account_id) VALUES
         ('11111111-1111-4111-8111-111111111111', gen_random_uuid())`,
    );

    // Ten placeholders: session_id, user_id, auth_method, token_hash, the four
    // timestamps, subject_kind, staff_id.
    const session = (over: Record<string, unknown>): unknown[] => [
      '11111111-1111-4111-8111-111111111111',
      over['user_id'] ?? null,
      'password',
      'digest',
      new Date(),
      new Date(),
      new Date(),
      new Date(),
      over['subject_kind'] ?? 'member',
      over['staff_id'] ?? null,
    ];

    await expect(
      pool.query(
        `INSERT INTO app.account_sessions
           (session_id, user_id, auth_method, status, token_hash, issued_at, expires_at,
            refreshable_until, last_active_at, subject_kind, staff_id)
         VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, $10)`,
        session({ subject_kind: 'staff', staff_id: '22222222-2222-4222-8222-222222222222' }),
      ),
    ).resolves.toBeDefined();

    // Both subjects set. This is the state that lets a member's id resolve a
    // moderator's session, which is the hazard the CHECK exists to make
    // unrepresentable.
    await expect(
      pool.query(
        `INSERT INTO app.account_sessions
           (session_id, user_id, auth_method, status, token_hash, issued_at, expires_at,
            refreshable_until, last_active_at, subject_kind, staff_id)
         VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, $10)`,
        session({
          subject_kind: 'staff',
          user_id: '11111111-1111-4111-8111-111111111111',
          staff_id: '22222222-2222-4222-8222-222222222222',
        }),
      ),
    ).rejects.toThrow(/account_sessions_one_subject/);

    // Neither subject set: a session belonging to nobody.
    await expect(
      pool.query(
        `INSERT INTO app.account_sessions
           (session_id, user_id, auth_method, status, token_hash, issued_at, expires_at,
            refreshable_until, last_active_at, subject_kind, staff_id)
         VALUES ($1, $2, $3, 'active', $4, $5, $6, $7, $8, $9, $10)`,
        session({ subject_kind: 'member' }),
      ),
    ).rejects.toThrow(/account_sessions_one_subject/);
  });

  it('admits no staff role the platform does not define', async () => {
    const insert = (role: string) =>
      pool.query(
        `INSERT INTO app.staff_identities
           (staff_id, contact_kind, contact_identifier, password_hash, display_name, role, status,
            created_at, updated_at)
         VALUES (gen_random_uuid(), 'email', $1, 'hash', 'Someone', $2, 'active', now(), now())`,
        [`${role}@example.test`, role],
      );

    for (const role of ['moderator', 'senior_moderator', 'support', 'identity_privacy_officer']) {
      await expect(insert(role)).resolves.toBeDefined();
    }
    // `user` would make a staff identity a member as well, which is the
    // distinction the whole subject split rests on. `system` is the automation
    // role: a directory of humans must not be able to mint a machine.
    for (const role of ['user', 'system']) {
      await expect(insert(role)).rejects.toThrow();
    }
  });
});
