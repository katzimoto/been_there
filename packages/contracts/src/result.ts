/**
 * The persistence ports for the v0.1 end-to-end flow.
 *
 * This package exists so the service and the database implementation can be
 * built against one agreed surface instead of each inventing one. It contains
 * no behaviour: every function here is a promise about what a store must
 * provide, and the guarantee that matters is the one on `Transaction`.
 *
 * ## Why explicit ports rather than a generic repository
 *
 * `Repository<T> { get(id); put(entity) }` is the shape that looks tidy and
 * costs a week, because every real query is either not by id or not a whole
 * entity, and the interface ends up accumulating `findByX` methods that are
 * really the query layer wearing a repository's clothes. The methods below are
 * the ones the end-to-end flow actually performs, named for what they answer.
 *
 * ## Scope
 *
 * This is the slice issue #1 names: verified identity → profile → discovery →
 * like → match → chat → block/report → automated risk detection → moderation →
 * enforcement. Aggregates outside that chain get no port until something needs
 * one, because an unused port is a promise nobody is keeping.
 *
 * A domain package does not import this one. The service composes a domain's
 * pure functions with a store that satisfies the port it needs; the domain
 * itself never learns that storage exists (ADR 0003).
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
 */
export interface Transaction {
  /**
   * Runs `body` atomically, rolling back on any `Err` or thrown error.
   * Nested calls join the outer transaction rather than opening a second one.
   */
  run<T>(body: () => Promise<T>): Promise<T>;
}

/**
 * Storage failures that are not business outcomes. A domain `Result` means "the
 * request was refused and that is the answer"; this means "the answer is
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
