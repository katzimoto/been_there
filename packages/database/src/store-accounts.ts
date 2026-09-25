/**
 * `AccountPlatformStore` against Postgres.
 *
 * Eight tables that had no home: the credential, the date of birth and terms,
 * sessions, recoveries, contact verifications, the rate-limit log, the analytics
 * sink and the notice ledger. Before this, `POST /v1/accounts` minted a `users`
 * row and an identity row and stopped — no credential, no session, no age, no
 * terms, so the 18+ requirement was unenforceable and "authentication" was a
 * bearer string a test invented.
 *
 * Three properties are load-bearing:
 *
 * **It never opens a transaction.** Every method runs on the `PoolClient` the
 * caller's transaction already holds, through the one `clientOf` in
 * `./transaction.js`. A sign-up writes a credential, an onboarding row, a
 * session and a funnel event as one unit of work; a store that reached for a
 * second connection would look identical in the type and would half-succeed the
 * first time a session committed without the account it belongs to.
 *
 * **`lockContact` exists because the duplicate rules are a read-then-write.**
 * §5.3 resolves a repeat sign-up by reading the credential table and then
 * deciding. Two concurrent sign-ups for the same address would both read "no
 * match" and both insert, and the unique index would turn the loser into a
 * constraint violation it cannot act on. The advisory lock is taken on the
 * contact identifier before the read and released when the transaction ends, so
 * the two serialise and the second one takes the duplicate branch deliberately.
 *
 * **Nothing derived from the date of birth is stored.** No age, no band: both
 * depend on the clock, and a stored one is a value that was true once. The
 * column-level reason a `date` is read back in local components is in
 * `./account-rows.ts`.
 */
import type { QueryResultRow } from 'pg';
import { StoreError } from '@been-there/contracts';
import type {
  AccountPlatformStore,
  AnalyticsEventRow,
  ContactVerificationRow,
  CredentialRow,
  NoticeRow,
  OnboardingRow,
  RateLimitBucket,
  RecoveryRow,
  SessionRow,
  Transaction,
} from '@been-there/contracts';
import type { UserId } from '@been-there/core';
import {
  CREDENTIAL_COLUMNS,
  CONTACT_COLUMNS,
  NOTICE_COLUMNS,
  ONBOARDING_COLUMNS,
  RECOVERY_COLUMNS,
  SESSION_COLUMNS,
  decodeAnalyticsEvent,
  readInteger,
  toContactVerificationRow,
  toCredentialRow,
  toNoticeRow,
  toOnboardingRow,
  toRecoveryRow,
  toStoreError,
  toSessionRow,
} from './account-rows.js';
import { clientOf } from './transaction.js';

/**
 * The two statement shapes every method here uses.
 *
 * One place that classifies a fault and one place that reports a row count as a
 * boolean. Twenty-five methods that each wrapped their own `try` would be
 * twenty-five places to forget the classification, and a forgotten one is a
 * refused sign-up reported as an outage.
 */
async function rows(
  operation: string,
  tx: Transaction,
  text: string,
  values: readonly unknown[],
): Promise<readonly QueryResultRow[]> {
  try {
    return (await clientOf(tx).query<QueryResultRow>(text, [...values])).rows;
  } catch (error) {
    throw toStoreError(operation, error);
  }
}

/**
 * The write shape: an affected-row count, so a caller's `boolean` is the
 * database's answer and never an assumption that the row was there.
 */
async function affected(
  operation: string,
  tx: Transaction,
  text: string,
  values: readonly unknown[],
): Promise<number> {
  try {
    return (await clientOf(tx).query(text, [...values])).rowCount ?? 0;
  } catch (error) {
    throw toStoreError(operation, error);
  }
}

export class PgAccountPlatformStore implements AccountPlatformStore {
  /**
   * Serialises concurrent sign-ups on one contact identifier.
   *
   * `hashtext` is the 32-bit hash Postgres ships for exactly this, and the lock
   * is transaction-scoped, so a sign-up that aborts releases it with its
   * connection. A collision costs a little serialisation between two unrelated
   * sign-ups, which is the right trade against the alternative: a unique
   * violation the caller cannot turn into §5.3's duplicate answer.
   */
  async lockContact(contactIdentifier: string, tx: Transaction): Promise<void> {
    await affected('lockContact', tx, 'SELECT pg_advisory_xact_lock(hashtext($1))', [contactIdentifier]);
  }

  async findCredentialByContact(contactIdentifier: string, tx: Transaction): Promise<CredentialRow | null> {
    const found = await rows(
      'findCredentialByContact',
      tx,
      `SELECT ${CREDENTIAL_COLUMNS} FROM app.account_credentials WHERE contact_identifier = $1`,
      [contactIdentifier],
    );
    return found[0] === undefined ? null : toCredentialRow(found[0]);
  }

  async findCredential(userId: UserId, tx: Transaction): Promise<CredentialRow | null> {
    const found = await rows(
      'findCredential',
      tx,
      `SELECT ${CREDENTIAL_COLUMNS} FROM app.account_credentials WHERE user_id = $1`,
      [userId],
    );
    return found[0] === undefined ? null : toCredentialRow(found[0]);
  }

  async insertCredential(row: CredentialRow, tx: Transaction): Promise<void> {
    await affected(
      'insertCredential',
      tx,
      `INSERT INTO app.account_credentials
         (user_id, contact_kind, contact_identifier, contact_verified, password_hash, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $6)`,
      [row.userId, row.contactKind, row.contactIdentifier, row.contactVerified, row.passwordHash, row.createdAt],
    );
  }

  async markContactVerified(userId: UserId, at: Date, tx: Transaction): Promise<boolean> {
    return (
      (await affected(
        'markContactVerified',
        tx,
        'UPDATE app.account_credentials SET contact_verified = true, updated_at = $2 WHERE user_id = $1',
        [userId, at],
      )) > 0
    );
  }

  async updatePasswordHash(userId: UserId, passwordHash: string, at: Date, tx: Transaction): Promise<boolean> {
    return (
      (await affected(
        'updatePasswordHash',
        tx,
        'UPDATE app.account_credentials SET password_hash = $2, updated_at = $3 WHERE user_id = $1',
        [userId, passwordHash, at],
      )) > 0
    );
  }

  async findOnboarding(userId: UserId, tx: Transaction): Promise<OnboardingRow | null> {
    const found = await rows(
      'findOnboarding',
      tx,
      `SELECT ${ONBOARDING_COLUMNS} FROM app.account_onboarding WHERE user_id = $1`,
      [userId],
    );
    return found[0] === undefined ? null : toOnboardingRow(found[0]);
  }

  async insertOnboarding(row: OnboardingRow, tx: Transaction): Promise<void> {
    await affected(
      'insertOnboarding',
      tx,
      `INSERT INTO app.account_onboarding
         (user_id, date_of_birth, age_attested, terms_version, terms_accepted_at, coarse_area, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $5, $5)`,
      [row.userId, row.dateOfBirth, row.ageAttested, row.termsVersion, row.termsAcceptedAt, row.coarseArea],
    );
  }

  async acceptTerms(userId: UserId, termsVersion: string, at: Date, tx: Transaction): Promise<boolean> {
    return (
      (await affected(
        'acceptTerms',
        tx,
        `UPDATE app.account_onboarding
            SET terms_version = $2, terms_accepted_at = $3, updated_at = $3
          WHERE user_id = $1`,
        [userId, termsVersion, at],
      )) > 0
    );
  }

  async recordCoarseArea(userId: UserId, coarseArea: string, at: Date, tx: Transaction): Promise<boolean> {
    return (
      (await affected(
        'recordCoarseArea',
        tx,
        'UPDATE app.account_onboarding SET coarse_area = $2, updated_at = $3 WHERE user_id = $1',
        [userId, coarseArea, at],
      )) > 0
    );
  }

  async insertSession(row: SessionRow, tx: Transaction): Promise<void> {
    await affected(
      'insertSession',
      tx,
      `INSERT INTO app.account_sessions
         (session_id, user_id, auth_method, status, token_hash, issued_at, expires_at,
          refreshable_until, last_active_at, revoked_reason, superseded_by, device_label, coarse_city)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        row.sessionId,
        row.userId,
        row.authMethod,
        row.status,
        row.tokenHash,
        row.issuedAt,
        row.expiresAt,
        row.refreshableUntil,
        row.lastActiveAt,
        row.revokedReason,
        row.supersededBy,
        row.deviceLabel,
        row.coarseCity,
      ],
    );
  }

  async findSessionByToken(tokenHash: string, tx: Transaction): Promise<SessionRow | null> {
    const found = await rows(
      'findSessionByToken',
      tx,
      `SELECT ${SESSION_COLUMNS} FROM app.account_sessions WHERE token_hash = $1`,
      [tokenHash],
    );
    return found[0] === undefined ? null : toSessionRow(found[0]);
  }

  async findSession(sessionId: string, tx: Transaction): Promise<SessionRow | null> {
    const found = await rows(
      'findSession',
      tx,
      `SELECT ${SESSION_COLUMNS} FROM app.account_sessions WHERE session_id = $1`,
      [sessionId],
    );
    return found[0] === undefined ? null : toSessionRow(found[0]);
  }

  async listSessionsFor(userId: UserId, tx: Transaction): Promise<readonly SessionRow[]> {
    const found = await rows(
      'listSessionsFor',
      tx,
      `SELECT ${SESSION_COLUMNS} FROM app.account_sessions
        WHERE user_id = $1
        ORDER BY last_active_at DESC`,
      [userId],
    );
    return found.map(toSessionRow);
  }

  async updateSession(row: SessionRow, tx: Transaction): Promise<boolean> {
    return (
      (await affected(
        'updateSession',
        tx,
        `UPDATE app.account_sessions
            SET status = $2, token_hash = $3, issued_at = $4, expires_at = $5, refreshable_until = $6,
                last_active_at = $7, revoked_reason = $8, superseded_by = $9
          WHERE session_id = $1`,
        [
          row.sessionId,
          row.status,
          row.tokenHash,
          row.issuedAt,
          row.expiresAt,
          row.refreshableUntil,
          row.lastActiveAt,
          row.revokedReason,
          row.supersededBy,
        ],
      )) > 0
    );
  }

  /**
   * Slides the idle clock only. The refresh window is deliberately absent from
   * the statement: it is absolute, and a method that could move it would be a
   * rolling session with a different name.
   */
  async touchSession(sessionId: string, lastActiveAt: Date, tx: Transaction): Promise<boolean> {
    return (
      (await affected(
        'touchSession',
        tx,
        'UPDATE app.account_sessions SET last_active_at = $2 WHERE session_id = $1',
        [sessionId, lastActiveAt],
      )) > 0
    );
  }

  async insertRecovery(row: RecoveryRow, tx: Transaction): Promise<void> {
    await affected(
      'insertRecovery',
      tx,
      `INSERT INTO app.account_recoveries
         (recovery_id, user_id, method, status, secret_hash, requested_at, expires_at,
          attempts, consumed_at, revoked_session_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        row.recoveryId,
        row.userId,
        row.method,
        row.status,
        row.secretHash,
        row.requestedAt,
        row.expiresAt,
        row.attempts,
        row.consumedAt,
        [...row.revokedSessionIds],
      ],
    );
  }

  async findRecovery(recoveryId: string, tx: Transaction): Promise<RecoveryRow | null> {
    const found = await rows(
      'findRecovery',
      tx,
      `SELECT ${RECOVERY_COLUMNS} FROM app.account_recoveries WHERE recovery_id = $1`,
      [recoveryId],
    );
    return found[0] === undefined ? null : toRecoveryRow(found[0]);
  }

  async findOpenRecoveryFor(userId: UserId, tx: Transaction): Promise<RecoveryRow | null> {
    const found = await rows(
      'findOpenRecoveryFor',
      tx,
      `SELECT ${RECOVERY_COLUMNS} FROM app.account_recoveries
        WHERE user_id = $1 AND status = 'pending'
        ORDER BY requested_at DESC
        LIMIT 1`,
      [userId],
    );
    return found[0] === undefined ? null : toRecoveryRow(found[0]);
  }

  async updateRecovery(row: RecoveryRow, tx: Transaction): Promise<boolean> {
    return (
      (await affected(
        'updateRecovery',
        tx,
        `UPDATE app.account_recoveries
            SET status = $2, attempts = $3, consumed_at = $4, revoked_session_ids = $5
          WHERE recovery_id = $1`,
        [row.recoveryId, row.status, row.attempts, row.consumedAt, [...row.revokedSessionIds]],
      )) > 0
    );
  }

  /**
   * Closes every open verification for the account. The partial unique index
   * allows one `pending` row per user, so a re-issue has to retire the old one
   * first — and retire it rather than delete it, because "this link has already
   * been used" is copy the product has to be able to give.
   */
  async expireOpenContactVerifications(userId: UserId, at: Date, tx: Transaction): Promise<number> {
    return affected(
      'expireOpenContactVerifications',
      tx,
      `UPDATE app.contact_verifications
          SET status = 'expired', expires_at = LEAST(expires_at, $2)
        WHERE user_id = $1 AND status = 'pending'`,
      [userId, at],
    );
  }

  async insertContactVerification(row: ContactVerificationRow, tx: Transaction): Promise<void> {
    await affected(
      'insertContactVerification',
      tx,
      `INSERT INTO app.contact_verifications
         (verification_id, user_id, channel, status, secret_hash, attempts, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.verificationId,
        row.userId,
        row.channel,
        row.status,
        row.secretHash,
        row.attempts,
        row.createdAt,
        row.expiresAt,
      ],
    );
  }

  async findOpenContactVerification(userId: UserId, tx: Transaction): Promise<ContactVerificationRow | null> {
    const found = await rows(
      'findOpenContactVerification',
      tx,
      `SELECT ${CONTACT_COLUMNS} FROM app.contact_verifications
        WHERE user_id = $1 AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId],
    );
    return found[0] === undefined ? null : toContactVerificationRow(found[0]);
  }

  async updateContactVerification(row: ContactVerificationRow, tx: Transaction): Promise<boolean> {
    return (
      (await affected(
        'updateContactVerification',
        tx,
        `UPDATE app.contact_verifications
            SET status = $2, attempts = $3, expires_at = $4
          WHERE verification_id = $1`,
        [row.verificationId, row.status, row.attempts, row.expiresAt],
      )) > 0
    );
  }

  async recordRateLimitEvent(
    bucket: RateLimitBucket,
    subjectKey: string,
    at: Date,
    tx: Transaction,
  ): Promise<void> {
    await affected(
      'recordRateLimitEvent',
      tx,
      'INSERT INTO app.account_rate_limit_events (bucket, subject_key, occurred_at) VALUES ($1, $2, $3)',
      [bucket, subjectKey, at],
    );
  }

  async countRateLimitEvents(
    bucket: RateLimitBucket,
    subjectKey: string,
    since: Date,
    tx: Transaction,
  ): Promise<number> {
    const found = await rows(
      'countRateLimitEvents',
      tx,
      `SELECT count(*)::text AS count FROM app.account_rate_limit_events
        WHERE bucket = $1 AND subject_key = $2 AND occurred_at >= $3`,
      [bucket, subjectKey, since],
    );
    const counted = found[0];
    if (counted === undefined) {
      throw new StoreError('countRateLimitEvents returned no row', { retryable: true });
    }
    return readInteger(counted['count'], 'account_rate_limit_events', 'count');
  }

  async insertAnalyticsEvent(row: AnalyticsEventRow, tx: Transaction): Promise<void> {
    await affected(
      'insertAnalyticsEvent',
      tx,
      `INSERT INTO app.account_analytics_events (event_id, type, occurred_at, correlation_id, properties)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [row.eventId, row.type, row.occurredAt, row.correlationId, JSON.stringify(row.properties)],
    );
  }

  async listAnalyticsEvents(type: string, since: Date, tx: Transaction): Promise<readonly AnalyticsEventRow[]> {
    const found = await rows(
      'listAnalyticsEvents',
      tx,
      `SELECT event_id, type, occurred_at, correlation_id, properties
         FROM app.account_analytics_events
        WHERE type = $1 AND occurred_at >= $2
        ORDER BY occurred_at ASC`,
      [type, since],
    );
    return found.map(decodeAnalyticsEvent);
  }

  async insertNotice(row: NoticeRow, tx: Transaction): Promise<void> {
    await affected(
      'insertNotice',
      tx,
      `INSERT INTO app.account_notices
         (notification_id, user_id, kind, channel, status, suppression_reason, idempotency_key,
          deliver_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
      [
        row.notificationId,
        row.userId,
        row.kind,
        row.channel,
        row.status,
        row.suppressionReason,
        row.idempotencyKey,
        row.deliverAt,
      ],
    );
  }

  async listNoticesFor(userId: UserId, tx: Transaction): Promise<readonly NoticeRow[]> {
    const found = await rows(
      'listNoticesFor',
      tx,
      `SELECT ${NOTICE_COLUMNS} FROM app.account_notices
        WHERE user_id = $1
        ORDER BY created_at ASC`,
      [userId],
    );
    return found.map(toNoticeRow);
  }
}
