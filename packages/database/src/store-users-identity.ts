import type { AccountId, UserId, VerificationId } from '@been-there/core';
import { castId } from '@been-there/core';
import type { IdentityRecordRow, IdentityStore, Page, Transaction, UserRecord, UserStore } from '@been-there/contracts';
import { StoreError } from '@been-there/contracts';
import { isConflict } from './errors.js';
import { clientOf } from './transaction.js';

/**
 * A constraint the database refused: a duplicate key, a missing parent row, or
 * a value the identity machine cannot produce.
 *
 * It exists because the `Transaction` port wraps an unknown driver error in a
 * plain `StoreError`, which drops the Postgres `code` on the floor — the caller
 * is left unable to tell "this user already exists" from "the database was
 * unreachable", which are opposite answers to a request. Carrying the code here
 * means `isConflict(error)` from `./errors.js` answers correctly for the errors
 * a store raises, so a caller needs no knowledge of Postgres to branch.
 */
export class StoreConflictError extends StoreError {
  /** The Postgres SQLSTATE, e.g. `23505` for a duplicate key. */
  readonly code: string;
  /** The constraint that refused, when the driver reported one. */
  readonly constraint: string | null;

  constructor(message: string, code: string, constraint: string | null, cause: unknown) {
    super(message, { retryable: false, cause });
    this.name = 'StoreConflictError';
    this.code = code;
    this.constraint = constraint;
  }
}

/**
 * Turns a driver error into one a caller can act on, and leaves alone anything
 * that already is.
 */
function classify(error: unknown): unknown {
  if (error instanceof StoreError || !isConflict(error)) {
    return error;
  }
  const detail = error as { readonly code?: unknown; readonly constraint?: unknown };
  const code = typeof detail.code === 'string' ? detail.code : 'unknown';
  const constraint = typeof detail.constraint === 'string' ? detail.constraint : null;
  return new StoreConflictError(
    constraint === null
      ? `storage refused the write (${code})`
      : `storage refused the write: ${constraint} (${code})`,
    code,
    constraint,
    error,
  );
}

function timestamp(value: unknown, column: string): Date {
  if (value instanceof Date) {
    return value;
  }
  // A driver type parser that has been reconfigured turns `timestamptz` into a
  // string, and a domain that then does arithmetic on it fails somewhere far
  // from the cause. Refusing to hand back a half-read row is the point.
  throw new StoreError(`column ${column} did not read back as a timestamp`);
}

function generation(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new StoreError('column generation did not read back as a positive integer');
}

function verificationId(value: unknown): VerificationId | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return castId<'VerificationId'>(value);
  }
  throw new StoreError('column latest_verification_id did not read back as a uuid or null');
}

/**
 * One statement on the caller's connection, with the faults it refuses to pass
 * on unlabelled.
 *
 * No retry here, deliberately. A store issues statements on a connection it
 * does not own, and the unit that can be retried after a serialization failure
 * is the caller's whole transaction rather than one query inside it; a retry in
 * place would be a loop over a connection Postgres has already aborted.
 */
async function query<R extends QueryResultRow>(
  tx: Transaction,
  sql: string,
  values: unknown[],
): Promise<QueryResult<R>> {
  try {
    return await clientOf(tx).query<R>(sql, values);
  } catch (error) {
    throw classify(error);
  }
}

interface UserRow {
  readonly user_id: string;
  readonly account_id: string;
  readonly created_at: unknown;
}

function toUserRecord(row: UserRow): UserRecord {
  return {
    userId: castId<'UserId'>(row.user_id),
    accountId: castId<'AccountId'>(row.account_id),
    createdAt: timestamp(row.created_at, 'users.created_at'),
  };
}

export class PostgresUserStore implements UserStore {
  /**
   * Creates the user. A `userId` that already exists is a `StoreConflictError`
   * (`23505`), not a fault: the caller is holding a user it cannot re-create,
   * and it has to be able to say so. The `account_id` unique index is the same
   * case under a different constraint, and reports itself separately.
   */
  async create(record: UserRecord, tx: Transaction): Promise<void> {
    await query(
      tx,
      'INSERT INTO app.users (user_id, account_id, created_at) VALUES ($1, $2, $3)',
      [record.userId, record.accountId, record.createdAt],
    );
  }

  async find(userId: UserId, tx: Transaction): Promise<UserRecord | null> {
    const result = await query<UserRow>(
      tx,
      'SELECT user_id, account_id, created_at FROM app.users WHERE user_id = $1',
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toUserRecord(row);
  }

  /**
   * Unknown account is `null`, not a throw. A login for an account that has
   * never been here is an ordinary answer, and an exception for it would train
   * callers to catch errors on the happy path.
   */
  async findByAccount(accountId: AccountId, tx: Transaction): Promise<UserRecord | null> {
    const result = await query<UserRow>(
      tx,
      'SELECT user_id, account_id, created_at FROM app.users WHERE account_id = $1',
      [accountId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toUserRecord(row);
  }
}

interface IdentityStateRow {
  readonly user_id: string;
  readonly state: string;
  readonly generation: unknown;
  readonly latest_verification_id: unknown;
  readonly updated_at: unknown;
}

function toIdentityRecord(row: IdentityStateRow): IdentityRecordRow {
  return {
    userId: castId<'UserId'>(row.user_id),
    state: row.state,
    generation: generation(row.generation),
    latestVerificationId: verificationId(row.latest_verification_id),
    updatedAt: timestamp(row.updated_at, 'identity_state.updated_at'),
  };
}

export class PostgresIdentityStore implements IdentityStore {
  /**
   * Creates the first generation for a user. A duplicate is a
   * `StoreConflictError`; a `userId` with no `users` row is `23503`, which the
   * caller tells apart because the two carry different codes.
   *
   * This is the only write in the class that does not check a generation, and
   * it is here because the port declares it: it establishes generation 1, so
   * there is nothing to be stale against. It is also, unavoidably, the one path
   * by which a caller could place `verified` without the identity machine ever
   * having produced it. Nothing a store can do narrows that — the store cannot
   * tell a machine's output from a hand-written row — so the gate belongs in the
   * service that calls `insert`, and the port's doc comment reads as though the
   * store already had one.
   */
  async insert(row: IdentityRecordRow, tx: Transaction): Promise<void> {
    await query(
      tx,
      `INSERT INTO app.identity_state
         (user_id, state, generation, latest_verification_id, updated_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.userId, row.state, row.generation, row.latestVerificationId, row.updatedAt],
    );
  }

  async find(userId: UserId, tx: Transaction): Promise<IdentityRecordRow | null> {
    const result = await query<IdentityStateRow>(
      tx,
      `SELECT user_id, state, generation, latest_verification_id, updated_at
         FROM app.identity_state
        WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    return row === undefined ? null : toIdentityRecord(row);
  }

  /**
   * Optimistic concurrency. The caller's expected generation goes in the WHERE
   * clause, so a writer holding a stale read updates nothing and learns so from
   * the row count rather than overwriting a decision taken after it read. Two
   * writers racing the same generation produce one winner and one `false`;
   * `false` means "your write did not happen, re-read", never "the row is gone".
   *
   * `generation = generation + 1` rather than a value from the row: a caller
   * echoing its stale read back must not be able to walk the counter back to a
   * generation it has already won.
   *
   * There is deliberately no second writer on this table. A `setState` beside
   * this one would hand out `verified` to anyone holding the store, and the
   * generation column would stop meaning anything.
   */
  async update(row: IdentityRecordRow, expectedGeneration: number, tx: Transaction): Promise<boolean> {
    if (!Number.isInteger(expectedGeneration) || expectedGeneration < 1) {
      // Guarded rather than left to the WHERE clause: a caller passing 0 would
      // match no rows and be told it lost the race, which is a different and
      // entirely false story.
      throw new StoreError(`expectedGeneration must be a positive integer, got ${String(expectedGeneration)}`);
    }
    const result = await query<IdentityStateRow>(
      tx,
      `UPDATE app.identity_state
          SET state = $1,
              generation = generation + 1,
              latest_verification_id = $2,
              updated_at = $3
        WHERE user_id = $4
          AND generation = $5
        RETURNING user_id`,
      [row.state, row.latestVerificationId, row.updatedAt, row.userId, expectedGeneration],
    );
    return result.rowCount !== null && result.rowCount > 0;
  }
}
