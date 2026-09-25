import { StoreError } from '@been-there/contracts';

/**
 * Postgres error codes that mean "try again", separated from the ones that mean
 * "this will never work".
 *
 * The distinction is load-bearing for a safety product. A unique-violation is a
 * conflict the caller must handle — a duplicate like is a fact, not a fault. A
 * serialization failure is contention, and a serializable transaction exists
 * precisely so that retrying is safe. Conflating them means either a user is
 * told a safety refusal is an outage, or a transient blip is swallowed as a
 * refusal nobody is ever told about.
 */
const RETRYABLE_CODES: Readonly<Record<string, true>> = {
  '40001': true, // serialization_failure
  '40P01': true, // deadlock_detected
  '55P03': true, // lock_not_available
  '08006': true, // connection_failure
  '08003': true, // connection_does_not_exist
  '57P01': true, // admin_shutdown
  '53300': true, // too_many_connections
};

const CONFLICT_CODES: Readonly<Record<string, true>> = {
  '23505': true, // unique_violation
  '23503': true, // foreign_key_violation
  '23514': true, // check_violation
  '23P01': true, // exclusion_violation
};

function codeOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

export function isRetryable(error: unknown): boolean {
  const code = codeOf(error);
  return code !== null && RETRYABLE_CODES[code] === true;
}

export function isConflict(error: unknown): boolean {
  const code = codeOf(error);
  return code !== null && CONFLICT_CODES[code] === true;
}

/**
 * Retries a body on transient faults only, with a bounded backoff.
 *
 * The bound matters more than the backoff: an unbounded retry against a
 * constraint the caller got wrong turns one bad request into an infinite loop
 * that looks like a hang. Three attempts, then the fault surfaces.
 */
export async function withRetry<T>(body: () => Promise<T>, attempts = 3, delayMs = 25): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await body();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) {
        break;
      }
      // Exponential, because a contended row does not resolve itself instantly.
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, delayMs * 2 ** (attempt - 1));
      await promise;
    }
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new StoreError('operation failed', { cause: lastError });
}
