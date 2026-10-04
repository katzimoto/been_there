/**
 * `StaffIdentityStore` against Postgres.
 *
 * Five methods over two tables, and the reason there are two is the reason
 * there is no `staff_sessions` table: a session's subject is a discriminated
 * pair inside `app.account_sessions`, so expiry, rotation and revocation of a
 * moderator's session are the same code that already handles a member's. What
 * lives here is the part that is *not* the same — the directory of humans, and
 * the query that finds a moderator's sessions by identity rather than by
 * account id.
 *
 * Two properties are load-bearing:
 *
 * **It never opens a transaction.** Every method runs on the `PoolClient` the
 * caller's transaction already holds, through the one `clientOf` in
 * `./transaction.js`, for the reason `store-accounts.ts` gives. Signing a
 * moderator in reads an identity, verifies a password, and writes a session as
 * one unit of work; a second connection would look identical in the type and
 * would half-succeed the first time a session committed with no identity behind
 * it.
 *
 * **`listSessionsForStaff` is the counterpart of `listSessionsFor`, and the two
 * must never meet.** A member's query filters `user_id = $1`, which a staff row
 * cannot match because its `user_id` is NULL, and this one filters
 * `staff_id = $1`. Overlap between them would mean a member pressing "sign out"
 * revoked a moderator's access.
 */
import type { QueryResultRow } from 'pg';
import type {
  SessionRow,
  StaffIdentityRow,
  StaffIdentityStore,
  Transaction,
} from '@been-there/contracts';
import { SESSION_COLUMNS, STAFF_COLUMNS, toSessionRow, toStaffRow, toStoreError } from './account-rows.js';
import { clientOf } from './transaction.js';

/**
 * The two statement shapes every method here uses.
 *
 * The same pair `store-accounts.ts` has, and for the same reason: one place
 * that classifies a fault, one place that turns a row count into a boolean.
 * Five methods that each wrapped their own `try` would be five places to forget
 * the classification, and a forgotten one is a refused sign-in reported as an
 * outage.
 */
async function rows(
  operation: string,
  tx: Transaction,
  text: string,
  values: readonly unknown[],
): Promise<readonly QueryResultRow[]> {
  try {
    return (await clientOf(tx).query<QueryResultRow>(text, [...values])).rows;
  } catch (error) {
    throw toStoreError(operation, error);
  }
}

/** The write shape: an affected-row count, so a `boolean` is the database's answer. */
async function affected(
  operation: string,
  tx: Transaction,
  text: string,
  values: readonly unknown[],
): Promise<number> {
  try {
    return (await clientOf(tx).query(text, [...values])).rowCount ?? 0;
  } catch (error) {
    throw toStoreError(operation, error);
  }
}

/**
 * `StaffIdentityStore` on Postgres. The constructor takes nothing: a store
 * holding a pool could reach around the caller's transaction, and the only
 * defence against that is not having one.
 */
export class PgStaffIdentityStore implements StaffIdentityStore {
  /**
   * Writes one identity.
   *
   * No conflict translation here, deliberately. The unique index on
   * `contact_identifier` is the refusal, and it arrives as a `StoreError` the
   * caller can already act on — a second staff identity for one address is a
   * fact about the request, and inventing a reason code for it in this file
   * would be a second vocabulary for the same refusal.
   */
  async insertStaff(row: StaffIdentityRow, tx: Transaction): Promise<void> {
    await affected(
      'insertStaff',
      tx,
      `INSERT INTO app.staff_identities
         (staff_id, contact_kind, contact_identifier, password_hash, display_name, role, status,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        row.staffId,
        row.contactKind,
        row.contactIdentifier,
        row.passwordHash,
        row.displayName,
        row.role,
        row.status,
        row.createdAt,
        row.updatedAt,
      ],
    );
  }

  async findStaffByContact(contactIdentifier: string, tx: Transaction): Promise<StaffIdentityRow | null> {
    const found = await rows(
      'findStaffByContact',
      tx,
      `SELECT ${STAFF_COLUMNS} FROM app.staff_identities WHERE contact_identifier = $1`,
      [contactIdentifier],
    );
    return found[0] === undefined ? null : toStaffRow(found[0]);
  }

  async findStaff(staffId: string, tx: Transaction): Promise<StaffIdentityRow | null> {
    const found = await rows(
      'findStaff',
      tx,
      `SELECT ${STAFF_COLUMNS} FROM app.staff_identities WHERE staff_id = $1`,
      [staffId],
    );
    return found[0] === undefined ? null : toStaffRow(found[0]);
  }

  /**
   * Suspension, as a write.
   *
   * `updated_at` moves with the status so a directory admin can see when the
   * off switch was thrown, and the boolean is the affected-row count: a
   * suspension of an identity that is not there has to say so rather than
   * return success and leave the caller believing a moderator was locked out.
   */
  async updateStaffStatus(staffId: string, status: string, at: Date, tx: Transaction): Promise<boolean> {
    return (
      (await affected(
        'updateStaffStatus',
        tx,
        `UPDATE app.staff_identities
            SET status = $2, updated_at = $3
          WHERE staff_id = $1`,
        [staffId, status, at],
      )) > 0
    );
  }

  /**
   * Every session one named moderator holds — revocation by identity, so a
   * moderator can be signed out everywhere at once.
   *
   * Not filtered on `status`: the caller decides what to do with a superseded
   * row, and a revocation that silently skipped rows would make a full sweep
   * look complete when it was not. The partial index
   * `account_sessions_by_staff` covers the leading `staff_id` equality, so the
   * ordering is free.
   */
  async listSessionsForStaff(staffId: string, tx: Transaction): Promise<readonly SessionRow[]> {
    const found = await rows(
      'listSessionsForStaff',
      tx,
      `SELECT ${SESSION_COLUMNS} FROM app.account_sessions
        WHERE staff_id = $1
        ORDER BY last_active_at DESC`,
      [staffId],
    );
    return found.map(toSessionRow);
  }
}