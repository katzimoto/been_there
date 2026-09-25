import type { Pool, PoolClient } from 'pg';
import type { Transaction } from '@been-there/contracts';
import { StoreError } from '@been-there/contracts';

/**
 * One place that turns a `Transaction` into the client it holds.
 *
 * Five stores all need this, and five independent implementations of "get me
 * the connection" is five places for the same mistake. The contract types the
 * handle as `unknown` so `@been-there/contracts` stays driver-free; this is the
 * single place it is narrowed back, and the single place a wrong handle is
 * turned into a loud failure rather than an `undefined` somewhere downstream.
 */
export function clientOf(tx: Transaction): PoolClient {
  const client = tx.client;
  if (client === null || typeof client !== 'object' || !('query' in client)) {
    throw new StoreError(
      'this transaction does not carry a database client; a store cannot run on it',
      { retryable: false },
    );
  }
  return client as PoolClient;
}

/**
 * A real transaction: one connection checked out for the unit of work, released
 * when it ends.
 *
 * Why this is not a wrapper over a pool of sessions: ADR 0001 chose a modular
 * monolith precisely so that a like which becomes a match and emits two
 * notifications cannot half-succeed. A "transaction" that quietly issued each
 * statement on its own pooled connection would be exactly that failure, while
 * looking identical in the type.
 *
 * The one thing it will not do is lie. If a `body` throws, the transaction rolls
 * back and the error propagates; there is no path that reports success for work
 * that was rolled back.
 */
export function createTransaction(pool: Pool): Transaction {
  return {
    /** Only meaningful inside `run`; outside it, the client has been released. */
    get client(): unknown {
      return undefined;
    },
    async run<T>(body: (tx: Transaction) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      const scoped: Transaction = { client, run: async () => undefined as never };
      try {
        await client.query('BEGIN');
        const value = await body(scoped);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        // Roll back on the failure path, and never let a rollback failure mask
        // the error that caused it — the caller needs the real cause.
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
