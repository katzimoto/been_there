/**
 * `SocialIdentityStore` against Postgres.
 *
 * Four methods over one table, and the reason there is one table is the reason
 * there is no `oauth_tokens` table: a provider assertion is evidence about a
 * moment, and this platform keeps no evidence about moments. What survives a
 * provider sign-in is one opaque subject id and the member it belongs to.
 *
 * Two properties are load-bearing:
 *
 * **Resolution is by subject and nothing else.** `findSocialIdentity` filters on
 * `(provider, provider_subject)` and there is no second finder — not
 * `findByEmail`, not `findByContact`. Account takeover by matching an email
 * address is the failure this store exists to make unrepresentable, and the
 * cheapest way to make it unrepresentable is for the port not to offer the
 * question. The unique index behind the filter is what makes it hold under
 * concurrency, where a read-then-write in a caller would not.
 *
 * **It never opens a transaction.** Every method runs on the `PoolClient` the
 * caller's transaction already holds, through the one `clientOf` in
 * `./transaction.js`, for the reason `store-accounts.ts` gives. A social sign-up
 * writes a credential, an onboarding row, a provider identity and a session as
 * one unit of work, and a second connection would half-succeed the first time a
 * session committed without the account it belongs to.
 */
import type { QueryResultRow } from 'pg';
import type { UserId } from '@been-there/core';
import type { SocialIdentityRow, SocialIdentityStore, Transaction } from '@been-there/contracts';
import { toStoreError } from './account-rows.js';
import { requiredDate, requiredString } from './store-support.js';
import { clientOf } from './transaction.js';

/**
 * The two statement shapes every method here uses.
 *
 * One place that classifies a fault and one place that reports a row count as a
 * boolean, so a constraint violation cannot read as "no rows" in one method and
 * as an outage in another.
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

/** The write shape: an affected-row count, so a `boolean` is the database's answer. */
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

export const SOCIAL_IDENTITY_COLUMNS = 'user_id, provider, provider_subject, linked_at';

/**
 * Decodes a row, failing loudly rather than defaulting.
 *
 * A missing value is a `StoreError` naming the table and column. A silent
 * `undefined` here would reach sign-in resolution as a subject that matches
 * nothing, which is the failure mode of this store read backwards: an account
 * that exists and cannot be found by the member who owns it.
 */
function toSocialIdentityRow(raw: QueryResultRow): SocialIdentityRow {
  return {
    userId: requiredString(raw, 'user_id', 'social_identities') as UserId,
    provider: requiredString(raw, 'provider', 'social_identities'),
    providerSubject: requiredString(raw, 'provider_subject', 'social_identities'),
    linkedAt: requiredDate(raw, 'linked_at', 'social_identities'),
  };
}

/**
 * `SocialIdentityStore` on Postgres. The constructor takes nothing: a store
 * holding a pool could reach around the caller's transaction, and the only
 * defence against that is not having one.
 */
export class PgSocialIdentityStore implements SocialIdentityStore {
  async findSocialIdentity(
    provider: string,
    providerSubject: string,
    tx: Transaction,
  ): Promise<SocialIdentityRow | null> {
    const found = await rows(
      'findSocialIdentity',
      tx,
      `SELECT ${SOCIAL_IDENTITY_COLUMNS} FROM app.social_identities
        WHERE provider = $1 AND provider_subject = $2`,
      [provider, providerSubject],
    );
    return found[0] === undefined ? null : toSocialIdentityRow(found[0]);
  }

  async listSocialIdentitiesFor(userId: UserId, tx: Transaction): Promise<readonly SocialIdentityRow[]> {
    const found = await rows(
      'listSocialIdentitiesFor',
      tx,
      `SELECT ${SOCIAL_IDENTITY_COLUMNS} FROM app.social_identities
        WHERE user_id = $1
        ORDER BY linked_at DESC, provider ASC`,
      [userId],
    );
    return found.map(toSocialIdentityRow);
  }

  async insertSocialIdentity(row: SocialIdentityRow, tx: Transaction): Promise<void> {
    await affected(
      'insertSocialIdentity',
      tx,
      `INSERT INTO app.social_identities (user_id, provider, provider_subject, linked_at)
       VALUES ($1, $2, $3, $4)`,
      [row.userId, row.provider, row.providerSubject, row.linkedAt],
    );
  }

  async deleteSocialIdentity(userId: UserId, provider: string, tx: Transaction): Promise<boolean> {
    return (
      (await affected(
        'deleteSocialIdentity',
        tx,
        'DELETE FROM app.social_identities WHERE user_id = $1 AND provider = $2',
        [userId, provider],
      )) > 0
    );
  }
}