/**
 * The plumbing every store in this package needs, in one place.
 *
 * Six stores need to send a parameterised statement, turn a driver's error
 * into a `StoreError` so "the query failed" can never look like "no rows", and
 * read a value out of the untyped row bags the ports hand them. Six
 * independent implementations of each is six places for the same mistake —
 * and the mistake is always the same shape: a bag read that returns
 * `undefined` where the domain promised a string, which then reaches a
 * CHECK constraint as a fault the caller cannot act on.
 *
 * These functions are deliberately strict. A missing or malformed value is a
 * `StoreError` naming the key the caller wrote, never a silent default: the
 * ports say nothing about what a store should do with a row it cannot store,
 * and a default is how bad data becomes good data without anybody deciding.
 */
import type { PoolClient, QueryResultRow } from 'pg';
import { StoreError } from '@been-there/contracts';

/**
 * Sends one statement on the caller's connection and turns anything that is
 * not already a `StoreError` into one.
 *
 * No retry here, deliberately: a serialization failure has already poisoned
 * the caller's transaction, so re-sending the statement would fail for a
 * different reason. Retrying a unit of work belongs to the transaction that
 * owns it, the only layer that knows whether the work so far — the like, the
 * match, the events — may be redone together.
 */
export async function query<Row extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: unknown[],
): Promise<{ rows: Row[]; rowCount: number }> {
  try {
    const result = await client.query<Row>(text, values);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (error) {
    if (error instanceof StoreError) {
      throw error;
    }
    throw new StoreError(error instanceof Error ? error.message : 'query failed', { cause: error });
  }
}

/** A caller wrote something the store cannot store. Never swallowed, never defaulted. */
export function fault(message: string): StoreError {
  return new StoreError(message, { retryable: false });
}

export function requiredString(
  bag: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string {
  const value = bag[key];
  if (typeof value !== 'string' || value === '') {
    throw fault(`${where}: '${key}' must be a non-empty string`);
  }
  return value;
}

export function optionalString(
  bag: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string | null {
  const value = bag[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value === '') {
    throw fault(`${where}: '${key}' must be a non-empty string or null`);
  }
  return value;
}

/** A Date from the domain, or a string from an HTTP boundary. Never an epoch. */
function toDate(value: unknown, key: string, where: string): Date {
  const parsed = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (parsed === null || Number.isNaN(parsed.getTime())) {
    throw fault(`${where}: '${key}' must be a Date or an ISO-8601 string`);
  }
  return parsed;
}

export function requiredDate(
  bag: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): Date {
  return toDate(bag[key], key, where);
}

export function optionalDate(
  bag: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): Date | null {
  const value = bag[key];
  return value === undefined || value === null ? null : toDate(value, key, where);
}

export function stringArray(
  bag: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): string[] {
  const value = bag[key];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry === '')) {
    throw fault(`${where}: '${key}' must be an array of non-empty strings`);
  }
  return [...(value as string[])];
}

/** The two-entry arrays the schema CHECKs, as a tuple so no cast is needed. */
export function stringPair(
  bag: Readonly<Record<string, unknown>>,
  key: string,
  where: string,
): [string, string] {
  const entries = stringArray(bag, key, where);
  if (entries.length !== 2) {
    throw fault(`${where}: '${key}' must hold exactly 2 entries, got ${entries.length}`);
  }
  return [entries[0] as string, entries[1] as string];
}

/** A `jsonb` column arrives parsed; a value that is not an object is a broken row. */
export function jsonObject(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw fault(`${what} is not a jsonb object`);
  }
  return value as Readonly<Record<string, unknown>>;
}
