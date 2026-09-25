/**
 * The shared result and storage primitives.
 *
 * This package exists so the service and the database implementation can be
 * built against one agreed surface instead of each inventing one. It contains
 * no behaviour: every function here is a promise about what a store must
 * provide, and the guarantee that matters is the one on `Transaction`.
 */

/** A page request. v0.1 caps `limit`; there is no cursor. */
export interface Page {
  readonly limit: number;
  readonly offset: number;
}

export interface PageResult<T> {
  readonly items: readonly T[];
  readonly total: number;
}

/**
 * The unit of atomicity. One request is one transaction, so a like that
 * becomes a match and emits two notifications cannot half-succeed — that is
 * the whole reason ADR 0001 chose a modular monolith over services.
 *
 * A store that cannot offer this must say so rather than pretending: a
 * `Transaction` that silently is not one would let a moderation decision
 * commit without its audit row.
 *
 * `client` is the live database handle for the duration of `run`. It is
 * exposed because every store method issues statements on *this* connection,
 * and a store that opened its own transaction per method would break
 * atomicity across stores in a way nothing would catch until production.
 * Typed `unknown` here so this package stays driver-free; the database
 * package narrows it once, in `clientOf`.
 */
export interface Transaction {
  /** The live handle. Valid only inside `run`. */
  readonly client: unknown;
  /**
   * Runs `body` atomically, rolling back on any thrown error. Nested calls
   * join the outer transaction rather than opening a second one.
   */
  run<T>(body: (tx: Transaction) => Promise<T>): Promise<T>;
}

/**
 * Storage failures that are not business outcomes. A domain `Result` means
 * "the request was refused and that is the answer"; this means "the answer is
 * unknown", and the two must never be conflated — a user must not be shown a
 * safety refusal because a query timed out.
 */
export class StoreError extends Error {
  readonly retryable: boolean;
  constructor(message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'StoreError';
    this.retryable = options.retryable ?? false;
  }
}
