/**
 * Row decoding for the account platform tables.
 *
 * Shared rather than inlined because eight tables have the same three
 * conversions and a decoder that is written twice is a decoder that will be
 * fixed once: a corrupt row must be reported by name, at the column, in every
 * table — not in the one somebody remembered.
 *
 * Every reader throws a `StoreError` naming the table and the column. That is
 * the whole policy: a row the driver did not return in the shape the domain
 * reads is a defect, and the only safe thing to do with it is fail loudly at the
 * boundary rather than hand a caller a `null` it would read as "no such account".
 */

import type { QueryResultRow } from 'pg';
import { StoreError } from '@been-there/contracts';
import type {
  AnalyticsEventRow,
  ContactVerificationRow,
  CredentialRow,
  DeletionRequestRow,
  NoticeRow,
  OnboardingRow,
  RecoveryRow,
  SessionRow,
} from '@been-there/contracts';
import type { UserId } from '@been-there/core';
import { isConflict, isRetryable } from './errors.js';

export function toStoreError(operation: string, error: unknown): StoreError {
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

function malformed(table: string, column: string, detail: string): StoreError {
  return new StoreError(`app.${table}.${column} ${detail}`, { retryable: false });
}

function readText(value: unknown, table: string, column: string): string {
  if (typeof value !== 'string') {
    throw malformed(table, column, `is ${value === null ? 'null' : typeof value}, expected text`);
  }
  return value;
}

function readNullableText(value: unknown, table: string, column: string): string | null {
  return value === null || value === undefined ? null : readText(value, table, column);
}

function readBoolean(value: unknown, table: string, column: string): boolean {
  if (typeof value !== 'boolean') {
    throw malformed(table, column, `is ${value === null ? 'null' : typeof value}, expected a boolean`);
  }
  return value;
}

function readTimestamp(value: unknown, table: string, column: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw malformed(table, column, 'is not a valid timestamp');
  }
  return value;
}

function readNullableTimestamp(value: unknown, table: string, column: string): Date | null {
  return value === null || value === undefined ? null : readTimestamp(value, table, column);
}

export function readInteger(value: unknown, table: string, column: string): number {
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw malformed(table, column, `is ${String(value)}, expected an integer`);
  }
  return value;
}

/**
 * A calendar date as `YYYY-MM-DD`.
 *
 * Both shapes are accepted because both are real: the driver hands back a
 * `Date` at local midnight, and a driver configured with a string parser (or a
 * test double) hands back the text. Local components, never `toISOString`,
 * because that converts to UTC and moves the date.
 */
function readIsoDate(value: unknown, table: string, column: string): string {
  if (typeof value === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw malformed(table, column, `is "${value}", expected a YYYY-MM-DD date`);
    }
    return value;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const year = String(value.getFullYear()).padStart(4, '0');
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  throw malformed(table, column, `is ${value === null ? 'null' : typeof value}, expected a date`);
}

function readUuidList(value: unknown, table: string, column: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw malformed(table, column, `is ${value === null ? 'null' : typeof value}, expected a uuid array`);
  }
  const items: readonly unknown[] = value;
  return items as readonly string[];
}

function readJsonObject(value: unknown, table: string, column: string): Readonly<Record<string, unknown>> {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    return readJsonObject(parsed, table, column);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw malformed(table, column, `is ${value === null ? 'null' : typeof value}, expected an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

export const CREDENTIAL_COLUMNS =
  'user_id, contact_kind, contact_identifier, contact_verified, password_hash, created_at, updated_at';

export function toCredentialRow(raw: QueryResultRow): CredentialRow {
  return {
    userId: readText(raw['user_id'], 'account_credentials', 'user_id') as UserId,
    contactKind: readText(raw['contact_kind'], 'account_credentials', 'contact_kind'),
    contactIdentifier: readText(raw['contact_identifier'], 'account_credentials', 'contact_identifier'),
    contactVerified: readBoolean(raw['contact_verified'], 'account_credentials', 'contact_verified'),
    passwordHash: readText(raw['password_hash'], 'account_credentials', 'password_hash'),
    createdAt: readTimestamp(raw['created_at'], 'account_credentials', 'created_at'),
    updatedAt: readTimestamp(raw['updated_at'], 'account_credentials', 'updated_at'),
  };
}

export const ONBOARDING_COLUMNS =
  'user_id, date_of_birth, age_attested, terms_version, terms_accepted_at, coarse_area, updated_at';

export function toOnboardingRow(raw: QueryResultRow): OnboardingRow {
  return {
    userId: readText(raw['user_id'], 'account_onboarding', 'user_id') as UserId,
    dateOfBirth: readIsoDate(raw['date_of_birth'], 'account_onboarding', 'date_of_birth'),
    ageAttested: readBoolean(raw['age_attested'], 'account_onboarding', 'age_attested'),
    termsVersion: readText(raw['terms_version'], 'account_onboarding', 'terms_version'),
    termsAcceptedAt: readTimestamp(raw['terms_accepted_at'], 'account_onboarding', 'terms_accepted_at'),
    coarseArea: readNullableText(raw['coarse_area'], 'account_onboarding', 'coarse_area'),
    updatedAt: readTimestamp(raw['updated_at'], 'account_onboarding', 'updated_at'),
  };
}

export const SESSION_COLUMNS =
  'session_id, user_id, auth_method, status, token_hash, issued_at, expires_at, refreshable_until, ' +
  'last_active_at, revoked_reason, superseded_by, device_label, coarse_city';

export function toSessionRow(raw: QueryResultRow): SessionRow {
  return {
    sessionId: readText(raw['session_id'], 'account_sessions', 'session_id'),
    userId: readText(raw['user_id'], 'account_sessions', 'user_id') as UserId,
    authMethod: readText(raw['auth_method'], 'account_sessions', 'auth_method'),
    status: readText(raw['status'], 'account_sessions', 'status'),
    tokenHash: readText(raw['token_hash'], 'account_sessions', 'token_hash'),
    issuedAt: readTimestamp(raw['issued_at'], 'account_sessions', 'issued_at'),
    expiresAt: readTimestamp(raw['expires_at'], 'account_sessions', 'expires_at'),
    refreshableUntil: readTimestamp(raw['refreshable_until'], 'account_sessions', 'refreshable_until'),
    lastActiveAt: readTimestamp(raw['last_active_at'], 'account_sessions', 'last_active_at'),
    revokedReason: readNullableText(raw['revoked_reason'], 'account_sessions', 'revoked_reason'),
    supersededBy: readNullableText(raw['superseded_by'], 'account_sessions', 'superseded_by'),
    deviceLabel: readNullableText(raw['device_label'], 'account_sessions', 'device_label'),
    coarseCity: readNullableText(raw['coarse_city'], 'account_sessions', 'coarse_city'),
  };
}

export const RECOVERY_COLUMNS =
  'recovery_id, user_id, method, status, secret_hash, requested_at, expires_at, attempts, consumed_at, revoked_session_ids';

export function toRecoveryRow(raw: QueryResultRow): RecoveryRow {
  return {
    recoveryId: readText(raw['recovery_id'], 'account_recoveries', 'recovery_id'),
    userId: readText(raw['user_id'], 'account_recoveries', 'user_id') as UserId,
    method: readText(raw['method'], 'account_recoveries', 'method'),
    status: readText(raw['status'], 'account_recoveries', 'status'),
    secretHash: readText(raw['secret_hash'], 'account_recoveries', 'secret_hash'),
    requestedAt: readTimestamp(raw['requested_at'], 'account_recoveries', 'requested_at'),
    expiresAt: readTimestamp(raw['expires_at'], 'account_recoveries', 'expires_at'),
    attempts: readInteger(raw['attempts'], 'account_recoveries', 'attempts'),
    consumedAt: readNullableTimestamp(raw['consumed_at'], 'account_recoveries', 'consumed_at'),
    revokedSessionIds: readUuidList(
      raw['revoked_session_ids'],
      'account_recoveries',
      'revoked_session_ids',
    ),
  };
}

export const CONTACT_COLUMNS =
  'verification_id, user_id, channel, status, secret_hash, attempts, created_at, expires_at';

export function toContactVerificationRow(raw: QueryResultRow): ContactVerificationRow {
  return {
    verificationId: readText(raw['verification_id'], 'contact_verifications', 'verification_id'),
    userId: readText(raw['user_id'], 'contact_verifications', 'user_id') as UserId,
    channel: readText(raw['channel'], 'contact_verifications', 'channel'),
    status: readText(raw['status'], 'contact_verifications', 'status'),
    secretHash: readText(raw['secret_hash'], 'contact_verifications', 'secret_hash'),
    attempts: readInteger(raw['attempts'], 'contact_verifications', 'attempts'),
    createdAt: readTimestamp(raw['created_at'], 'contact_verifications', 'created_at'),
    expiresAt: readTimestamp(raw['expires_at'], 'contact_verifications', 'expires_at'),
  };
}

export const NOTICE_COLUMNS =
  'notification_id, user_id, kind, channel, status, suppression_reason, idempotency_key, deliver_at, created_at';

export function toNoticeRow(raw: QueryResultRow): NoticeRow {
  return {
    notificationId: readText(raw['notification_id'], 'account_notices', 'notification_id'),
    userId: readText(raw['user_id'], 'account_notices', 'user_id') as UserId,
    kind: readText(raw['kind'], 'account_notices', 'kind'),
    channel: readText(raw['channel'], 'account_notices', 'channel'),
    status: readText(raw['status'], 'account_notices', 'status'),
    suppressionReason: readNullableText(
      raw['suppression_reason'],
      'account_notices',
      'suppression_reason',
    ),
    idempotencyKey: readText(raw['idempotency_key'], 'account_notices', 'idempotency_key'),
    deliverAt: readTimestamp(raw['deliver_at'], 'account_notices', 'deliver_at'),
    createdAt: readTimestamp(raw['created_at'], 'account_notices', 'created_at'),
  };
}

const ANALYTICS_COLUMNS = 'event_id, type, occurred_at, correlation_id, properties';

/**
 * The funnel event, decoded.
 *
 * `properties` is a jsonb object of declared dimensions. The declaration was
 * enforced by `recordAnalyticsEvent` before the row was written, so nothing
 * here has to re-check that a value is a scalar — and nothing here could, since
 * a value has already been through a filter that rejects one.
 */
export function decodeAnalyticsEvent(raw: QueryResultRow): AnalyticsEventRow {
  return {
    eventId: readText(raw['event_id'], 'account_analytics_events', 'event_id'),
    type: readText(raw['type'], 'account_analytics_events', 'type'),
    occurredAt: readTimestamp(raw['occurred_at'], 'account_analytics_events', 'occurred_at'),
    correlationId: readText(raw['correlation_id'], 'account_analytics_events', 'correlation_id'),
    properties: readJsonObject(raw['properties'], 'account_analytics_events', 'properties'),
  };
}

/**
 * The deletion statuses, validated on read.
 *
 * A row carrying a status nothing recognises is refused here rather than passed
 * on: `isWithinUndoWindow` answers "no" for any status that is not `scheduled`,
 * which the service reads as "the window has closed" and completes the deletion
 * on. So an unrecognised status would delete somebody's account early rather
 * than raising — the worst possible direction for a corrupt row to fail in.
 */
const DELETION_STATUSES: readonly string[] = ['scheduled', 'cancelled', 'completed'];

export const DELETION_COLUMNS =
  'deletion_id, user_id, status, requested_at, completes_at, cancelled_at, completed_at';

export function toDeletionRow(raw: QueryResultRow): DeletionRequestRow {
  const status = readText(raw['status'], 'account_deletions', 'status');
  if (!DELETION_STATUSES.includes(status)) {
    throw malformed('account_deletions', 'status', `"${status}" is not a deletion status`);
  }
  return {
    deletionId: readText(raw['deletion_id'], 'account_deletions', 'deletion_id'),
    userId: readText(raw['user_id'], 'account_deletions', 'user_id') as UserId,
    status,
    requestedAt: readTimestamp(raw['requested_at'], 'account_deletions', 'requested_at'),
    completesAt: readTimestamp(raw['completes_at'], 'account_deletions', 'completes_at'),
    cancelledAt: readNullableTimestamp(raw['cancelled_at'], 'account_deletions', 'cancelled_at'),
    completedAt: readNullableTimestamp(raw['completed_at'], 'account_deletions', 'completed_at'),
  };
}

/**
 * A non-null timestamp from a row that claims to be deleted.
 *
 * Separate from `readTimestamp` because the thing it refuses is specific:
 * `users.deleted_at` is `NOT NULL` whenever `state = 'deleted'`, by
 * `users_deleted_shape`. A null here means the query matched a row that says it
 * was deleted without saying when, and substituting the current clock for it
 * would make a corrupted row read as a deletion that happened just now — a much
 * harder thing to notice later than a loud failure now.
 */
export function readDeletionInstant(value: unknown, table: string, column: string): Date {
  const instant = readTimestamp(value, table, column);
  if (instant === null) {
    throw malformed(table, column, 'is null on a row that claims to be deleted');
  }
  return instant;
}
