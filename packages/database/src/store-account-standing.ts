/**
 * `AccountStandingStore` against Postgres.
 *
 * This table is the reason a ban has an effect on the product. A decision is
 * recorded in moderation and the product reads what *this* row says, so if the
 * standing lived only in a projection the service would rebuild on boot, a
 * restart would hand every sanctioned account back its capabilities. So the row
 * is written the moment a decision acts on it, and `find` answers `null` for a
 * user who has never been sanctioned rather than inventing an `active` row:
 * the default belongs to the account machine and to the service's projection,
 * not to a read that cannot tell "unrestricted" from "never judged".
 *
 * Three properties are load-bearing and are why it is written this way.
 *
 * **It never opens a transaction.** Every method runs on the `PoolClient` the
 * caller's transaction already holds, through the one `clientOf` in
 * `./transaction.js`. A standing is written inside the same unit of work as the
 * decision and the audit row explaining it; a store that issued its statement
 * on a second connection would look identical in the type and would half-succeed
 * the first time a ban committed without the case that justifies it.
 *
 * **`upsert` is an optimistic-concurrency write.** The caller's expected
 * generation goes in the conflict clause's `WHERE`, so a writer holding a stale
 * read applies nothing and learns so from the row count. Last-write-wins here
 * would mean one enforcement decision quietly overwriting another: a ban that
 * lost a race against a lifting of an earlier suspension would leave an account
 * in the product, and the moderation record would still say it was banned.
 *
 * **Reads validate.** A row whose `capabilities` is not an array, or whose
 * `state` is not one the account machine can produce, is a corrupt row. It is
 * reported as a `StoreError` rather than handed on, because downstream the
 * capabilities are an `includes` membership test and a missing array would
 * answer "may do anything" for a banned account.
 */
import type { QueryResultRow } from 'pg';
import { StoreError } from '@been-there/contracts';
import type { AccountStandingRow, AccountStandingStore, Transaction } from '@been-there/contracts';
import { accountMachine, castId } from '@been-there/core';
import type { UserId } from '@been-there/core';
import { isConflict, isRetryable } from './errors.js';
import { clientOf } from './transaction.js';

/**
 * The states a standing may be in, taken from the machine rather than written
 * out again here.
 *
 * The schema's CHECK on `app.account_standing.state` lists the same four, and
 * the two have to agree: a state the machine produces but the column refuses
 * would turn a decision into a constraint violation, and a state the column
 * permits but the machine does not produce would be a standing no domain can
 * have taken. Sourcing this from `accountMachine` means adding a state to the
 * domain fails the standing tests until the migration allows it, which is the
 * direction that surfaces the gap.
 */
const ACCOUNT_STATES: readonly string[] = accountMachine.states;
/**
 * Every fault leaves here as a `StoreError`, classified.
 *
 * The split is the point: a check or foreign-key violation is a caller bug
 * worth surfacing verbatim, a serialization failure is contention worth
 * retrying, and anything else is a plain fault. Collapsing them would mean
 * either reporting a transient blip as a sanction refusal nobody hears about,
 * or retrying a bad request forever.
 */
function toStoreError(operation: string, error: unknown): StoreError {
  if (error instanceof StoreError) {
    return error;
  }
  const message = error instanceof Error ? error.message : `${operation} failed`;
  if (isRetryable(error)) {
    return new StoreError(`${operation}: ${message}`, { retryable: true, cause: error });
  }
  if (isConflict(error)) {
    return new StoreError(`${operation}: constraint violation: ${message}`, {
      retryable: false,
      cause: error,
    });
  }
  return new StoreError(`${operation}: ${message}`, { retryable: false, cause: error });
}

/** A column that is not what its type says is a corrupt row, not a value. */
function malformed(column: string, detail: string): StoreError {
  return new StoreError(`app.account_standing.${column} ${detail}`, { retryable: false });
}

function readText(value: unknown, column: string): string {
  if (typeof value !== 'string') {
    throw malformed(column, `is ${value === null ? 'null' : typeof value}, expected text`);
  }
  return value;
}

function readNullableText(value: unknown, column: string): string | null {
  return value === null || value === undefined ? null : readText(value, column);
}

/**
 * The published grant, as a list of capability names.
 *
 * Only the shape is checked, for the same reason `PgRiskStore` checks only the
 * shape of its detector list: the column is `text[]`, so Postgres cannot hold a
 * non-string element, and a per-element check would guard against nothing. What
 * is worth failing on is a driver handing back something that is not a list at
 * all — the domain's gate is `capabilities.includes('browse_discovery')`, and an
 * `undefined` or a JSON blob would either close the product for everyone or
 * throw three layers from the row that caused it.
 */
function readCapabilities(value: unknown, column: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw malformed(column, `is ${value === null ? 'null' : typeof value}, expected a text array`);
  }
  const items: readonly unknown[] = value;
  return items as readonly string[];
}

/**
 * A timestamp that is not a `Date` means the driver's type parser was changed or
 * bypassed, and "when was this standing last written" would then be string
 * comparison. Refuse rather than pass it on.
 */
function readTimestamp(value: unknown, column: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw malformed(column, 'is not a valid timestamp');
  }
  return value;
}

function readBoolean(value: unknown, column: string): boolean {
  if (typeof value !== 'boolean') {
    throw malformed(column, `is ${value === null ? 'null' : typeof value}, expected a boolean`);
  }
  return value;
}

/**
 * The counter, validated rather than trusted. A generation of zero or less
 * cannot be the row a caller read, and treating it as a miss would let a write
 * claim a standing nobody held.
 */
function readGeneration(value: unknown, column: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw malformed(column, `is ${String(value)}, expected a positive integer`);
  }
  return value;
}

const STANDING_COLUMNS =
  'user_id, state, capabilities, visible_in_product, case_id, decision_id, generation, updated_at';

function toStandingRow(raw: QueryResultRow): AccountStandingRow {
  const state = readText(raw['state'], 'state');
  if (!ACCOUNT_STATES.includes(state)) {
    throw malformed('state', `is '${state}', which the account machine cannot produce`);
  }
  return {
    userId: castId<'UserId'>(readText(raw['user_id'], 'user_id')),
    state,
    capabilities: readCapabilities(raw['capabilities'], 'capabilities'),
    visibleInProduct: readBoolean(raw['visible_in_product'], 'visible_in_product'),
    // Why this row says what it says. A standing without an attributable case
    // is a sanction appearing from nowhere, so these are read as first-class
    // fields rather than left to a join the product surface cannot make.
    caseId: readNullableText(raw['case_id'], 'case_id'),
    decisionId: readNullableText(raw['decision_id'], 'decision_id'),
    generation: readGeneration(raw['generation'], 'generation'),
    updatedAt: readTimestamp(raw['updated_at'], 'updated_at'),
  };
}


/**
 * `AccountStandingStore` on Postgres.
 *
 * The constructor deliberately takes nothing. A store holding a pool could
 * reach around the caller's transaction, and the only defence against that is
 * not having one.
 */
export class PgAccountStandingStore implements AccountStandingStore {
  /**
   * The standing as last written, or `null` when nothing has ever judged this
   * account.
   *
   * `null` is a real answer and never covers a failure: a query that faults
   * throws a `StoreError`, so "nobody has sanctioned this account" and "we could
   * not tell" cannot be confused by a caller that forgot to check — and the
   * second is the one that must never be read as "unrestricted".
   *
   * `generation` comes back because the caller has to hand it to `upsert` for
   * the write to be applied. A read that dropped it would leave every caller
   * guessing, and a guess here is last-write-wins over a sanction.
   */
  async find(userId: UserId, tx: Transaction): Promise<AccountStandingRow | null> {
    try {
      const result = await clientOf(tx).query<QueryResultRow>(
        `SELECT ${STANDING_COLUMNS}
           FROM app.account_standing
          WHERE user_id = $1`,
        [userId],
      );
      const raw = result.rows[0];
      // Decoding inside the try is deliberate: `toStoreError` passes a
      // `StoreError` through untouched, so a corrupt row keeps its own message
      // instead of being reported as a query failure.
      return raw === undefined ? null : toStandingRow(raw);
    } catch (error) {
      throw toStoreError('find', error);
    }
  }

  /**
   * Writes the standing a decision produced, or refuses if the row moved under
   * the caller. `expectedGeneration` is what the caller read; `null` means it
   * read nothing, so this may only insert.
   *
   * The return is whether the write was applied, and `false` means exactly
   * "your write did not happen, re-read and re-decide" — never "the row is
   * gone". The service relies on that distinction to refuse a lost update rather
   * than retry a sanction against a standing it never saw.
   *
   * One statement covers both paths, with no branching and no read-then-write
   * window. The conflict clause's `WHERE` compares the row's generation against
   * the parameter, and a `NULL` parameter makes that comparison `NULL`, which
   * is not true — so `null` can only ever insert, and a row created by a racing
   * writer is left alone for the caller to re-read. Two concurrent first-writes
   * for one account therefore converge on one row instead of one of them
   * failing with a unique violation it cannot act on.
   *
   * `generation = generation + 1` rather than the value on `row`: a caller
   * echoing its stale read back must not be able to walk the counter back to a
   * generation it has already won. On the insert path the row's own generation
   * is written, since that is the first generation and there is nothing to be
   * stale against.
   *
   * `capabilities` is bound as a Postgres `text[]` parameter rather than a JSON
   * string, because the domain reads it as a list and a moderator-facing query
   * will want to join against it. The store replaces the value; it never merges
   * in SQL, because the resolved grant is the domain's whole decision and
   * merging against the row being overwritten would resurrect a capability the
   * domain dropped when it lifted a restriction.
   */
  async upsert(
    row: AccountStandingRow,
    expectedGeneration: number | null,
    tx: Transaction,
  ): Promise<boolean> {
    if (!isAccountState(row.state)) {
      // Refused before the statement rather than left to the CHECK: a check
      // violation aborts the caller's transaction, so learning your state was
      // invalid would cost a replay of the decision and its audit row.
      throw new StoreError(`upsert: '${row.state}' is not a state the account machine can produce`, {
        retryable: false,
      });
    }
    if (expectedGeneration !== null && (!Number.isInteger(expectedGeneration) || expectedGeneration < 1)) {
      // The same reason `PostgresIdentityStore.update` guards this: a caller
      // passing 0 would match no rows and be told it lost the race, which is a
      // different and entirely false story.
      throw new StoreError(
        `upsert: expectedGeneration must be a positive integer or null, got ${String(expectedGeneration)}`,
        { retryable: false },
      );
    }
    if (!(row.updatedAt instanceof Date) || Number.isNaN(row.updatedAt.getTime())) {
      throw new StoreError('upsert: updatedAt is not a valid timestamp', { retryable: false });
    }
    if (row.capabilities.some((capability) => typeof capability !== 'string')) {
      throw new StoreError('upsert: capabilities must all be strings', { retryable: false });
    }
    try {
      const result = await clientOf(tx).query(
        `INSERT INTO app.account_standing
           (user_id, state, capabilities, visible_in_product, case_id, decision_id, generation, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (user_id) DO UPDATE
            SET state = EXCLUDED.state,
                capabilities = EXCLUDED.capabilities,
                visible_in_product = EXCLUDED.visible_in_product,
                case_id = EXCLUDED.case_id,
                decision_id = EXCLUDED.decision_id,
                generation = app.account_standing.generation + 1,
                updated_at = EXCLUDED.updated_at
          WHERE app.account_standing.generation = $9`,
        [
          row.userId,
          row.state,
          [...row.capabilities],
          row.visibleInProduct,
          row.caseId,
          row.decisionId,
          row.generation,
          row.updatedAt,
          expectedGeneration,
        ],
      );
      return result.rowCount !== null && result.rowCount > 0;
    } catch (error) {
      throw toStoreError('upsert', error);
    }
  }
}

/** The columns a caller has to supply; named here so the port and the SQL agree. */
export const ACCOUNT_STANDING_COLUMNS: readonly (keyof AccountStandingRow)[] = [
  'userId',
  'state',
  'capabilities',
  'visibleInProduct',
  'caseId',
  'decisionId',
  'generation',
  'updatedAt',
];

/** Kept beside the class so a caller can build a row without restating the port. */
export type { AccountStandingRow, AccountStandingStore };
export { CAPABILITIES_COLUMNS as ACCOUNT_STANDING_READABLE_COLUMNS };
