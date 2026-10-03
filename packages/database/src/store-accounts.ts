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
  DeletedSubjectRow,
  DeletionOutcome,
  DeletionRequestRow,
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
  DELETION_COLUMNS,
  NOTICE_COLUMNS,
  ONBOARDING_COLUMNS,
  RECOVERY_COLUMNS,
  SESSION_COLUMNS,
  decodeAnalyticsEvent,
  readDeletionInstant,
  readInteger,
  toContactVerificationRow,
  toCredentialRow,
  toDeletionRow,
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

  /**
   * Serialises rate-limit work for one (bucket, subject) pair.
   *
   * A count-then-record is a read followed by a write, so without a lock two
   * concurrent sign-ups from one address can each read count=4 and each pass a
   * limit that admits one more. The limit then holds against a sequential test
   * and fails under real concurrency, which is the only place it matters.
   *
   * Transaction-scoped, so it releases on commit or rollback without a cleanup
   * path. Both parts of the key are included because `signup_per_ip` and
   * `signup_per_contact` must not serialise against each other.
   */
  async lockRateLimitSubject(bucket: string, subjectKey: string, tx: Transaction): Promise<void> {
    await affected('lockRateLimitSubject', tx, 'SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${bucket}:${subjectKey}`,
    ]);
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

  // --- Account deletion (§8) -----------------------------------------------------
  //
  // The request is soft and lives in one small table. The completion is where the
  // work is, and where the design decision that matters is written down: **the
  // users row is never deleted.** Every table in §8.2's retained column hangs off
  // `app.users` by `ON DELETE CASCADE`, so deleting it would delete the moderation
  // history with the person — which is the exact outcome §8.2 refuses when it says
  // "Anonymized, not erased". The row is rewritten instead, and the retained tables
  // keep pointing at a row that is still there.

  /**
   * Schedules a deletion, or returns the one already open.
   *
   * `ON CONFLICT DO NOTHING` followed by a read, rather than a read-then-write: the
   * partial unique index `account_deletions_one_open` is what decides, so two
   * concurrent requests cannot both insert and the loser gets the winner's row.
   *
   * The re-read is not a redundancy. `RETURNING` yields nothing when the insert is
   * skipped, so without it a concurrent second request would report "no row" for an
   * account that very much has one open — and the caller would answer a retry with
   * a 404, which is the opposite of §8.1's idempotence.
   */
  async scheduleDeletion(
    row: DeletionRequestRow,
    tx: Transaction,
  ): Promise<{ readonly request: DeletionRequestRow; readonly created: boolean }> {
    const inserted = await rows(
      'scheduleDeletion',
      tx,
      `INSERT INTO app.account_deletions
         (deletion_id, user_id, status, requested_at, completes_at, cancelled_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT DO NOTHING
       RETURNING ${DELETION_COLUMNS}`,
      [row.deletionId, row.userId, row.status, row.requestedAt, row.completesAt, row.cancelledAt, row.completedAt],
    );
    if (inserted[0] !== undefined) {
      return { request: toDeletionRow(inserted[0]), created: true };
    }
    const existing = await this.findOpenDeletionFor(row.userId, tx);
    if (existing === null) {
      // The insert lost to something and there is no open row to show for it, which
      // means another transaction inserted and completed or cancelled between the
      // two statements. Reported rather than papered over: the caller's next move
      // differs depending on which, and guessing would complete a deletion on the
      // strength of a conflict nobody can see.
      throw new StoreError(
        'scheduleDeletion: the insert was skipped and no open deletion exists for this account',
        { retryable: true },
      );
    }
    return { request: existing, created: false };
  }

  async findOpenDeletionFor(userId: UserId, tx: Transaction): Promise<DeletionRequestRow | null> {
    const found = await rows(
      'findOpenDeletionFor',
      tx,
      `SELECT ${DELETION_COLUMNS} FROM app.account_deletions
        WHERE user_id = $1 AND status = 'scheduled'`,
      [userId],
    );
    return found[0] === undefined ? null : toDeletionRow(found[0]);
  }

  async findDeletion(deletionId: string, tx: Transaction): Promise<DeletionRequestRow | null> {
    const found = await rows(
      'findDeletion',
      tx,
      `SELECT ${DELETION_COLUMNS} FROM app.account_deletions WHERE deletion_id = $1`,
      [deletionId],
    );
    return found[0] === undefined ? null : toDeletionRow(found[0]);
  }

  async updateDeletion(row: DeletionRequestRow, tx: Transaction): Promise<boolean> {
    return (
      (await affected(
        'updateDeletion',
        tx,
        `UPDATE app.account_deletions
            SET status = $2, cancelled_at = $3, completed_at = $4
          WHERE deletion_id = $1`,
        [row.deletionId, row.status, row.cancelledAt, row.completedAt],
      )) > 0
    );
  }

  /**
   * The pseudonym for a contact point, computed by the database.
   *
   * Delegated to `app.deletion_pseudonym()` so this and `completeDeletion` cannot
   * produce different values for the same contact — §8.2's promise that a future
   * account on the same contact point can be linked is a promise about *one*
   * function, and a second implementation is how it stops being true.
   *
   * `null` when the salt row is missing, which is a corrupt installation rather
   * than a normal answer: the migration seeds it, so its absence means the schema
   * was applied without section 3.
   */
  async deletionPseudonym(contactIdentifier: string, tx: Transaction): Promise<string | null> {
    const found = await rows(
      'deletionPseudonym',
      tx,
      `SELECT app.deletion_pseudonym($1) AS pseudonym
         FROM app.deletion_pseudonym_salt WHERE salt_id`,
      [contactIdentifier],
    );
    const value = found[0]?.['pseudonym'];
    return typeof value === 'string' && value.length > 0 ? value : null;
  }

  async findDeletedSubject(
    contactIdentifier: string,
    tx: Transaction,
  ): Promise<DeletedSubjectRow | null> {
    const pseudonym = await this.deletionPseudonym(contactIdentifier, tx);
    if (pseudonym === null) {
      return null;
    }
    const found = await rows(
      'findDeletedSubject',
      tx,
      `SELECT u.pseudonym,
              s.state AS prior_state,
              u.deleted_at,
              EXISTS (
                SELECT 1 FROM app.cases c
                 WHERE c.subject_id = u.user_id AND c.resolution_decision_id IS NULL
              ) AS open_case
         FROM app.users u
         LEFT JOIN app.account_standing s ON s.user_id = u.user_id
        WHERE u.pseudonym = $1 AND u.state = 'deleted'`,
      [pseudonym],
    );
    const row = found[0];
    if (row === undefined) {
      return null;
    }
    return {
      pseudonym,
      priorState: typeof row['prior_state'] === 'string' ? (row['prior_state'] as string) : null,
      openCase: row['open_case'] === true,
      deletedAt: readDeletionInstant(row['deleted_at'], 'users', 'deleted_at'),
    };
  }

  /**
   * §8.2, statement by statement.
   *
   * Two halves, and the order is not arbitrary.
   *
   * **Removed** — every table of content about a person. Each hangs off
   * `app.users` by `ON DELETE CASCADE`, and the users row is deliberately never
   * deleted, so a completion that forgot one of them would leave that data behind
   * with nothing left to find it by. Enumerating them here is what makes an omission
   * visible in a diff rather than discovered by a user.
   *
   * **Retained** — reports, cases, decisions, the audit log, risk signals and the
   * standing. Nothing in this method touches them. That is not an oversight: §8.2's
   * basis is that the platform must be able to answer, months later and in front of
   * a regulator, "did this person, or this pattern, take action against a named
   * user, and on what evidence did we act?" — and the whole reason the users row
   * survives is so these keep pointing at something.
   *
   * Messages are the one class that is not a plain delete. §8.2 keeps them "in
   * restricted tombstoned form for the other party", because content that still
   * exists for the other person must not silently vanish from their side. So a
   * message *sent* by the subject is blanked and kept; a message the subject
   * *received* is the other party's content and is left alone, because the subject
   * is gone and cannot read it either way.
   */
  async completeDeletion(
    userId: UserId,
    pseudonym: string,
    at: Date,
    tx: Transaction,
  ): Promise<DeletionOutcome> {
    const deleted: Record<string, number> = {};
    // Each statement carries its own parameters. That is not uniformity for its own
    // sake: Postgres refuses a parameter a statement does not reference, so binding
    // `at` to every statement fails the single-parameter ones. A shared `$1`
    // convention would remove the mistake class, but it costs more than it saves —
    // the two statements that need `$2` say so themselves.
    const removals: readonly {
      readonly name: string;
      readonly sql: string;
      readonly params: readonly unknown[];
    }[] = [
      { name: 'credentials', sql: 'DELETE FROM app.account_credentials WHERE user_id = $1', params: [userId] },
      { name: 'onboarding', sql: 'DELETE FROM app.account_onboarding WHERE user_id = $1', params: [userId] },
      { name: 'sessions', sql: 'DELETE FROM app.account_sessions WHERE user_id = $1', params: [userId] },
      { name: 'recoveries', sql: 'DELETE FROM app.account_recoveries WHERE user_id = $1', params: [userId] },
      { name: 'contact_verifications', sql: 'DELETE FROM app.contact_verifications WHERE user_id = $1', params: [userId] },
      { name: 'notices', sql: 'DELETE FROM app.account_notices WHERE user_id = $1', params: [userId] },
      { name: 'identity', sql: 'DELETE FROM app.identity_state WHERE user_id = $1', params: [userId] },
      { name: 'verification_attempts', sql: 'DELETE FROM app.verification_attempts WHERE user_id = $1', params: [userId] },
      { name: 'profile', sql: 'DELETE FROM app.profiles WHERE user_id = $1', params: [userId] },
      { name: 'photos', sql: 'DELETE FROM app.profile_photos WHERE user_id = $1', params: [userId] },
      { name: 'preferences', sql: 'DELETE FROM app.preferences WHERE user_id = $1', params: [userId] },
      { name: 'locations', sql: 'DELETE FROM app.location_anchors WHERE user_id = $1', params: [userId] },
      { name: 'goals', sql: 'DELETE FROM app.dating_goals WHERE owner_id = $1', params: [userId] },
      { name: 'completed_dates', sql: 'DELETE FROM app.completed_dates WHERE owner_id = $1', params: [userId] },
      { name: 'likes', sql: 'DELETE FROM app.likes WHERE from_user_id = $1 OR to_user_id = $1', params: [userId] },
      { name: 'passes', sql: 'DELETE FROM app.passes WHERE from_user_id = $1 OR to_user_id = $1', params: [userId] },
      // A block is deleted because it is the *subject's* protection and the subject
      // is gone; the person they blocked keeps their own rows and their own blocks.
      { name: 'blocks', sql: 'DELETE FROM app.blocks WHERE blocker_id = $1', params: [userId] },
      // §8.2 says matches are deleted and messages are *retained* tombstoned, and
      // those two rows are in tension in this schema: `messages.conversation_id` and
      // `conversations.match_id` both cascade, so deleting either takes the messages
      // with it and the other party's history silently vanishes — the exact failure
      // §8.2's own reason column names when it says content "must not silently vanish
      // from their side".
      //
      // So the coupling goes and the thread stays. Ending a match removes it from
      // every live-match read, which is what "no residual discovery coupling" means;
      // leaving the conversation row is what retaining the other party's view means.
      // Both rows hold, and this is the one place they had to be reconciled.
      {
        name: 'matches',
        sql: `UPDATE app.matches SET ended_at = $2, ended_cause = 'account_deleted'
                WHERE $1 = ANY (participants) AND ended_at IS NULL`,
        params: [userId, at],
      },
      {
        name: 'conversations',
        sql: `UPDATE app.conversations SET state = 'ended', state_changed_at = $2
                WHERE $1 = ANY (participants) AND state <> 'ended'`,
        params: [userId, at],
      },
      // Tombstoned, not removed — see the method comment. The body is blanked and
      // `state` carries the fact, which is why the column's CHECK has always allowed
      // `'deleted'`: the schema was built for this and nothing used it.
      {
        name: 'messages_sent',
        sql: `UPDATE app.messages SET body = '[removed]', state = 'deleted' WHERE sender_id = $1`,
        params: [userId],
      },
    ];
    for (const statement of removals) {
      deleted[statement.name] = await affected(
        'completeDeletion',
        tx,
        statement.sql,
        statement.params,
      );
    }

    const retained: Record<string, number> = {};
    const retainedCounts: readonly [string, string][] = [
      ['reports', 'SELECT count(*)::int AS n FROM app.reports WHERE subject_id = $1 OR reporter_id = $1'],
      ['cases', 'SELECT count(*)::int AS n FROM app.cases WHERE subject_id = $1'],
      ['decisions', 'SELECT count(*)::int AS n FROM app.decisions WHERE subject_id = $1'],
      ['audit', 'SELECT count(*)::int AS n FROM app.audit_log WHERE subject_id = $1'],
      ['risk', 'SELECT count(*)::int AS n FROM app.risk_signals WHERE subject_id = $1'],
    ];
    for (const [name, statement] of retainedCounts) {
      const found = await rows('completeDeletion', tx, statement, [userId]);
      retained[name] = Number(found[0]?.['n'] ?? 0);
    }

    // §8.2's last row. The row survives; the person does not.
    await affected(
      'completeDeletion',
      tx,
      `UPDATE app.users SET state = 'deleted', pseudonym = $2, deleted_at = $3 WHERE user_id = $1`,
      [userId, pseudonym, at],
    );
    return { pseudonym, deleted, retained };
  }
}
