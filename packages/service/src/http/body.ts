import type { IncomingMessage } from 'node:http';
import type { DomainError, Result } from '@been-there/core';
import { err, ok } from '@been-there/core';
import { MISSING_FIELD, UNKNOWN_FIELD_VALUE } from './failure.js';

/**
 * Reading a request body into domain values.
 *
 * Everything here is shape-checking and nothing here decides anything. A missing
 * field, a field of the wrong type and a field carrying a value the domain does
 * not define are all transport problems, and they are all `validation_failed`
 * before any domain function is reached — which matters, because it means a
 * domain rule can never be the thing that discovers a malformed request, and a
 * malformed request can never be reported as a business refusal.
 */

/** A decoded object body. An empty object for a request that carried none. */
export type ObjectBody = Readonly<Record<string, unknown>>;

/**
 * 256 KiB. The largest legitimate body here is a profile with photos and a
 * conversation-evidence summary; anything past this is a client that is not
 * talking to this API, and buffering it unbounded would be the cheapest denial
 * of service available to it.
 */
const MAX_BODY_BYTES = 256 * 1024;

export async function readBody(message: IncomingMessage): Promise<Result<ObjectBody, DomainError>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of message) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      return err({
        code: 'validation_failed',
        domain: 'service.http',
        message: 'the request body is larger than this endpoint accepts',
        details: { maxBytes: MAX_BODY_BYTES },
        retryable: false,
      });
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) {
    return ok({});
  }
  const text = Buffer.concat(chunks).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err({
      code: 'validation_failed',
      domain: 'service.http',
      message: 'the request body is not valid JSON',
      retryable: false,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return MISSING_FIELD('body');
  }
  return ok(parsed as ObjectBody);
}

export function readString(body: ObjectBody, field: string): Result<string, DomainError> {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    return MISSING_FIELD(field);
  }
  return ok(value);
}

export function readOptionalString(
  body: ObjectBody,
  field: string,
): Result<string | null, DomainError> {
  const value = body[field];
  if (value === undefined || value === null) {
    return ok(null);
  }
  if (typeof value !== 'string') {
    return MISSING_FIELD(field);
  }
  return ok(value);
}

export function readNumber(body: ObjectBody, field: string): Result<number, DomainError> {
  const value = body[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return MISSING_FIELD(field);
  }
  return ok(value);
}

export function readStringArray(
  body: ObjectBody,
  field: string,
): Result<readonly string[], DomainError> {
  const value = body[field];
  if (!Array.isArray(value)) {
    return MISSING_FIELD(field);
  }
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      return MISSING_FIELD(field);
    }
    items.push(entry);
  }
  return ok(items);
}

/**
 * Narrows a string to one of a fixed vocabulary, or refuses it.
 *
 * The membership test is a lookup over a list the domain already published
 * rather than a `Set` built per call: the values are known at compile time, the
 * list is four or five long, and a `Set` here would be an allocation per request
 * for a comparison. The list itself always comes from a domain constant, never
 * from a literal in this file, so a value the domain does not define cannot be
 * written.
 */
export function readEnum<T extends string>(
  body: ObjectBody,
  field: string,
  allowed: readonly T[],
  fallback: T,
): Result<T, DomainError> {
  const value = body[field];
  if (value === undefined) {
    return ok(fallback);
  }
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    return UNKNOWN_FIELD_VALUE(field, allowed);
  }
  return ok(value as T);
}
