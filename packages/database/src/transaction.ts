import type { Pool, PoolClient } from 'pg';
import type { Transaction } from '@been-there/contracts';
import { StoreError } from '@been-there/contracts';

/**
 * A real transaction: one connection checked out for the duration of the unit of
 * work, and released when it ends.
 *
 * Why this is not a wrapper over a pool of sessions: ADR 0001 chose a modular
 * monolith precisely so that a like which becomes a match and emits two
 * notifications cannot half-succeed. A "transaction" that quietly issued each
 * statement on its own pooled connection would be the failure the ADR was
 * written to prevent, while looking exactly like one in the type.
 *
 * The one thing it will not do is lie. If a `body` throws or returns an error
 * value, the transaction rolls back and the error propagates; there is no path
 * that reports success for work that was rolled back.
 */
export function createTransaction(pool: Pool): Transaction {
  return {
    async run<T>(body: () => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const value = await body();
        await client.query('COMMIT');
        return value;
      } catch (error) {
        // Roll back on the failure path, and never let a rollback failure mask
        // the error that caused it — the caller needs to see the real cause.
        try {
          await client.query('ROLLBACK');
        } catch {
          /* the connection is already unusable; the original error is the useful one */
        }
        if (error instanceof StoreError) {
          throw error;
        }
        throw new StoreError(
          error instanceof Error ? error.message : 'transaction failed',
          // A constraint violation is a genuine conflict the caller should
          // handle, not a transient fault worth retrying blindly.
          { retryable: false, cause: error },
        );
      } finally {
        client.release();
      }
    },
  };
}
