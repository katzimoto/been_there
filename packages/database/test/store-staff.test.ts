/**
 * `StaffIdentityStore` against a real Postgres, proving the properties the port
 * promises rather than the shape of a row it just wrote.
 *
 * The properties this file exists for, in the order they matter:
 *
 *  * **The subject is really discriminated.** `account_sessions_one_subject` is
 *    what turns `subject_kind` from a label into a fact, so the tests here try
 *    to write the two rows it forbids — both subjects set, and neither — and
 *    read the database's refusal rather than trusting the port.
 *  * **A member's sign-out cannot reach a moderator's session.** This is the
 *    hazard the whole staff-identity change exists to close: before
 *    `staff_id` existed, a static bearer token was the only thing standing
 *    between "somebody holds a shared secret" and "somebody signed in". The
 *    proof is that `listSessionsFor(memberId)` returns nothing when the only
 *    live session belongs to a moderator, and that
 *    `listSessionsForStaff(staffId)` returns it.
 *  * **Suspension is visible on the identity, not inferred from a session.**
 *    The role and the status live on the row so that a demotion takes effect
 *    on the next request rather than one refresh window later.
 *
 * The suite fails loudly rather than skipping, via `support/database.ts`, and
 * probes both tables in `beforeAll` so a database without migration 008 reports
 * a missing schema rather than five green ticks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { castId } from '@been-there/core';
import type { UserId } from '@been-there/core';
import type { SessionRow, StaffIdentityRow, Transaction } from '@been-there/contracts';
import { databasePool, dropDatabase } from './support/database.js';
import { createTransaction } from '../src/transaction.js';
import { PgAccountPlatformStore } from '../src/store-accounts.js';
import { PgStaffIdentityStore } from '../src/store-staff.js';

const ISSUED = new Date('2026-03-01T09:00:00.000Z');
const EXPIRES = new Date('2026-03-01T09:15:00.000Z');
const REFRESHABLE = new Date('2026-04-01T09:00:00.000Z');

describe('StaffIdentityStore, against Postgres', () => {
  const store = new PgStaffIdentityStore();
  const accounts = new PgAccountPlatformStore();
  let pool: pg.Pool;
  let raw: PoolClient;
  let transaction: Transaction;

  beforeAll(async () => {
    pool = await databasePool('staff');
    raw = await pool.connect();
    transaction = createTransaction(pool);
    // Connecting is not the same as reaching the schema this store reads.
    const probe = await raw.query<{ staff_id: string; role: string; status: string }>(
      'SELECT staff_id, role, status FROM app.staff_identities LIMIT 0',
    );
    expect(probe.rows).toEqual([]);
    const sessions = await raw.query<{ subject_kind: string; staff_id: string | null }>(
      'SELECT subject_kind, staff_id FROM app.account_sessions LIMIT 0',
    );
    expect(sessions.rows).toEqual([]);
  });

  afterAll(async () => {
    raw.release();
    await pool.end();
    await dropDatabase();
  });

  /** One unit of work, the way a sign-in gets one. */
  function inTx<T>(body: (tx: Transaction) => Promise<T>): Promise<T> {
    return transaction.run(body);
  }

  /** The FK to `app.users` still demands a real member for the sign-out case. */
  async function newMember(): Promise<UserId> {
    const userId = castId<'UserId'>(randomUUID());
    await raw.query('INSERT INTO app.users (user_id, account_id) VALUES ($1, $2)', [userId, randomUUID()]);
    return userId;
  }

  function identity(over: Partial<StaffIdentityRow> = {}): StaffIdentityRow {
    return {
      staffId: randomUUID(),
      contactKind: 'email',
      contactIdentifier: `mod-${randomUUID()}@example.test`,
      passwordHash: 'scrypt:16384:8:1$c2FsdA==$ZGlnZXN0',
      displayName: 'R. Moderator',
      role: 'moderator',
      status: 'active',
      createdAt: ISSUED,
      updatedAt: ISSUED,
      ...over,
    };
  }

  /** A session whose subject is the moderator, not a member. */
  function staffSession(staffId: string, over: Partial<SessionRow> = {}): SessionRow {
    return {
      sessionId: randomUUID(),
      userId: null,
      subjectKind: 'staff',
      staffId,
      automated: false,
      authMethod: 'staff_password',
      status: 'active',
      tokenHash: `digest-${randomUUID()}`,
      issuedAt: ISSUED,
      expiresAt: EXPIRES,
      refreshableUntil: REFRESHABLE,
      lastActiveAt: ISSUED,
      revokedReason: null,
      supersededBy: null,
      deviceLabel: null,
      coarseCity: null,
      ...over,
    };
  }

  // -------------------------------------------------------------- directory --

  it('round-trips an identity, by contact and by id', async () => {
    const row = identity({ displayName: 'A. Okafor', role: 'senior_moderator' });
    await inTx((tx) => store.insertStaff(row, tx));

    const byContact = await inTx((tx) => store.findStaffByContact(row.contactIdentifier, tx));
    expect(byContact).toEqual(row);

    const byId = await inTx((tx) => store.findStaff(row.staffId, tx));
    expect(byId).toEqual(row);
  });

  it('answers null for a contact that is not in the directory', async () => {
    const found = await inTx((tx) => store.findStaffByContact(`nobody-${randomUUID()}@example.test`, tx));
    expect(found).toBeNull();
  });

  it('refuses a second identity for one contact, so two staff cannot share an address', async () => {
    const first = identity();
    await inTx((tx) => store.insertStaff(first, tx));
    const second = identity({ contactIdentifier: first.contactIdentifier });

    await expect(inTx((tx) => store.insertStaff(second, tx))).rejects.toThrow();
    const stillOne = await inTx((tx) => store.findStaffByContact(first.contactIdentifier, tx));
    expect(stillOne?.staffId).toBe(first.staffId);
  });

  it('reads a suspended identity back as suspended', async () => {
    const row = identity();
    await inTx((tx) => store.insertStaff(row, tx));

    const at = new Date('2026-03-02T11:00:00.000Z');
    const moved = await inTx((tx) => store.updateStaffStatus(row.staffId, 'suspended', at, tx));
    expect(moved).toBe(true);

    const found = await inTx((tx) => store.findStaff(row.staffId, tx));
    expect(found?.status).toBe('suspended');
    // The instant moves with the status, so a directory admin can see when the
    // off switch was thrown.
    expect(found?.updatedAt).toEqual(at);
    expect(found?.role).toBe(row.role);
  });

  it('reports false for a suspension of an identity that is not there', async () => {
    const moved = await inTx((tx) =>
      store.updateStaffStatus(randomUUID(), 'suspended', new Date(), tx),
    );
    // The boolean is the affected-row count, not an assumption that the row was
    // there — otherwise a lockout would report success for nobody.
    expect(moved).toBe(false);
  });

  it('refuses a role the directory does not admit', async () => {
    const row = identity({ role: 'user' });
    await expect(inTx((tx) => store.insertStaff(row, tx))).rejects.toThrow();
  });

  // ---------------------------------------------------------------- session --

  it('writes a staff session with a NULL user_id and finds it by token', async () => {
    const staff = identity();
    await inTx((tx) => store.insertStaff(staff, tx));
    const session = staffSession(staff.staffId);
    await inTx((tx) => accounts.insertSession(session, tx));

    const found = await inTx((tx) => accounts.findSessionByToken(session.tokenHash, tx));
    expect(found).toEqual(session);
    // The decoded subject is the discriminated one, not a nullable guess.
    expect(found?.subjectKind).toBe('staff');
    expect(found?.userId).toBeNull();
    expect(found?.staffId).toBe(staff.staffId);
  });

  it('round-trips `automated: true`, so a machine’s session is not read back as a person’s', async () => {
    const staff = identity();
    await inTx((tx) => store.insertStaff(staff, tx));
    const session = staffSession(staff.staffId, { automated: true });
    await inTx((tx) => accounts.insertSession(session, tx));

    const found = await inTx((tx) => accounts.findSessionByToken(session.tokenHash, tx));
    // The column is NOT NULL with a default of `false`, so a suite that only
    // ever inserted `false` would pass against a decoder that dropped the
    // value — and `moderation.decision` refuses an automated actor, so a read
    // that lost the flag would let a machine land a decision. That is the bug
    // this round-trip exists for, not the session itself.
    expect(found?.automated).toBe(true);
    expect(found).toEqual(session);
  });

  it('lists a moderator’s own sessions and nothing else', async () => {
    const mine = identity();
    const theirs = identity();
    await inTx(async (tx) => {
      await store.insertStaff(mine, tx);
      await store.insertStaff(theirs, tx);
    });
    const mineOne = staffSession(mine.staffId);
    const mineTwo = staffSession(mine.staffId, { lastActiveAt: new Date('2026-03-01T10:00:00.000Z') });
    const theirsOne = staffSession(theirs.staffId);
    await inTx(async (tx) => {
      await accounts.insertSession(mineOne, tx);
      await accounts.insertSession(mineTwo, tx);
      await accounts.insertSession(theirsOne, tx);
    });

    const found = await inTx((tx) => store.listSessionsForStaff(mine.staffId, tx));
    expect(found.map((row) => row.sessionId).sort()).toEqual([mineOne.sessionId, mineTwo.sessionId].sort());
  });

  // ------------------------------------------------------------- the hazard --

  it('never returns a moderator’s session from a member’s sign-out query', async () => {
    const memberId = await newMember();
    const staff = identity();
    await inTx((tx) => store.insertStaff(staff, tx));

    const memberSession = staffSession('unused', {
      userId: memberId,
      subjectKind: 'member',
      staffId: null,
    });
    const moderatorSession = staffSession(staff.staffId);
    await inTx(async (tx) => {
      await accounts.insertSession(memberSession, tx);
      await accounts.insertSession(moderatorSession, tx);
    });

    const members = await inTx((tx) => accounts.listSessionsFor(memberId, tx));
    expect(members.map((row) => row.sessionId)).toEqual([memberSession.sessionId]);

    // And the moderator's is reachable only by identity.
    const moderators = await inTx((tx) => store.listSessionsForStaff(staff.staffId, tx));
    expect(moderators.map((row) => row.sessionId)).toEqual([moderatorSession.sessionId]);
  });

  it('answers an empty list for a member who holds no session, rather than every moderator’s', async () => {
    const memberId = await newMember();
    const staff = identity();
    await inTx((tx) => store.insertStaff(staff, tx));
    await inTx((tx) => accounts.insertSession(staffSession(staff.staffId), tx));

    expect(await inTx((tx) => accounts.listSessionsFor(memberId, tx))).toEqual([]);
  });

  // ---------------------------------------------------- the CHECK is real ---

  it('refuses a session that names both a member and a moderator', async () => {
    const memberId = await newMember();
    const staff = identity();
    await inTx((tx) => store.insertStaff(staff, tx));

    await expect(
      raw.query(
        `INSERT INTO app.account_sessions
           (session_id, user_id, subject_kind, staff_id, auth_method, status, token_hash, issued_at,
            expires_at, refreshable_until, last_active_at)
         VALUES ($1, $2, 'staff', $3, 'staff_password', 'active', $4, $5, $6, $7, $5)`,
        [randomUUID(), memberId, staff.staffId, `both-${randomUUID()}`, ISSUED, EXPIRES, REFRESHABLE],
      ),
    ).rejects.toThrow(/account_sessions_one_subject/);
  });

  it('refuses a session that names neither a member nor a moderator', async () => {
    await expect(
      raw.query(
        `INSERT INTO app.account_sessions
           (session_id, user_id, subject_kind, staff_id, auth_method, status, token_hash, issued_at,
            expires_at, refreshable_until, last_active_at)
         VALUES ($1, NULL, 'member', NULL, 'password', 'active', $2, $3, $4, $5, $3)`,
        [randomUUID(), `neither-${randomUUID()}`, ISSUED, EXPIRES, REFRESHABLE],
      ),
    ).rejects.toThrow(/account_sessions_one_subject/);
  });

  it('keeps the member session path intact alongside the staff one', async () => {
    const memberId = await newMember();
    const session = staffSession('unused', {
      userId: memberId,
      subjectKind: 'member',
      staffId: null,
      authMethod: 'password',
    });
    await inTx((tx) => accounts.insertSession(session, tx));

    const found = await inTx((tx) => accounts.findSession(session.sessionId, tx));
    expect(found).toEqual(session);
    expect(found?.subjectKind).toBe('member');
    expect(found?.staffId).toBeNull();

    // Which is the default the migration installed, so a member's session reads
    // back as a member's without the caller having to say so.
    const raw2 = await raw.query<{ subject_kind: string; staff_id: string | null }>(
      'SELECT subject_kind, staff_id FROM app.account_sessions WHERE session_id = $1',
      [session.sessionId],
    );
    expect(raw2.rows).toEqual([{ subject_kind: 'member', staff_id: null }]);
  });
});