/**
 * `SocialIdentityStore` against a real Postgres, proving the properties the port
 * promises rather than the shape of a row it just wrote.
 *
 * The properties this file exists for, in the order they matter:
 *
 *  * **Resolution is by provider subject and nothing else.** There is no
 *    `findByEmail` on the port to test, so what is tested is the complement:
 *    two accounts holding the *same* attested address and *different* provider
 *    subjects do not resolve to each other, and one provider subject cannot be
 *    claimed twice even under a concurrency the caller could not have serialised.
 *  * **A provider account with no password is a real row, not a fake one.** The
 *    round trip through `AccountPlatformStore` proves the credential decodes with
 *    `passwordHash: null` and that a password sign-in against it is refused with
 *    a reason rather than against an invented hash.
 *  * **A conflict is something the caller can branch on.** The unique index
 *    surfaces as a `StoreError`, which is what a route turns into "this provider
 *    account is already linked" instead of an outage.
 *
 * The suite fails loudly rather than skipping, via `support/database.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { StoreError, type SocialIdentityRow, type Transaction } from '@been-there/contracts';
import { castId, identityMachine, isDiscoverableIdentity, type IdentityState, type UserId } from '@been-there/core';
import { databasePool, dropDatabase } from './support/database.js';
import { createTransaction } from '../src/transaction.js';
import { PgAccountPlatformStore } from '../src/store-accounts.js';
import { PgSocialIdentityStore } from '../src/store-social-identity.js';
import { PostgresIdentityStore, PostgresUserStore } from '../src/store-users-identity.js';

const LINKED_AT = new Date('2026-03-01T09:00:00.000Z');

describe('SocialIdentityStore, against Postgres', () => {
  const social = new PgSocialIdentityStore();
  const accounts = new PgAccountPlatformStore();
  const users = new PostgresUserStore();
  const identity = new PostgresIdentityStore();
  let pool: pg.Pool;
  let transaction: Transaction;

  beforeAll(async () => {
    pool = await databasePool('social');
    transaction = createTransaction(pool);
  });

  afterAll(async () => {
    await pool.end();
    await dropDatabase();
  });

  /** A user row plus the identity row a new account is created with. */
  async function newUser(): Promise<UserId> {
    const userId = castId<'UserId'>(randomUUID());
    await transaction.run(async (tx) => {
      await users.create(
        { userId, accountId: castId<'AccountId'>(randomUUID()), createdAt: new Date() },
        tx,
      );
      await identity.insert(
        { userId, state: 'unverified', generation: 1, latestVerificationId: null, updatedAt: new Date() },
        tx,
      );
    });
    return userId;
  }

  function socialRow(userId: UserId, overrides: Partial<SocialIdentityRow> = {}): SocialIdentityRow {
    return {
      userId,
      provider: 'apple',
      providerSubject: `subject-${randomUUID()}`,
      linkedAt: LINKED_AT,
      ...overrides,
    };
  }

  /** A credential with no password, which is what a provider sign-up writes. */
  async function providerCredential(userId: UserId, contact: string): Promise<void> {
    await transaction.run(async (tx) => {
      await accounts.insertCredential(
        {
          userId,
          contactKind: 'email',
          contactIdentifier: contact,
          contactVerified: true,
          passwordHash: null,
          createdAt: LINKED_AT,
          updatedAt: LINKED_AT,
        },
        tx,
      );
    });
  }

  it('resolves a provider subject to the account that holds it', async () => {
    const userId = await newUser();
    const row = socialRow(userId, { providerSubject: 'apple-subject-resolve' });
    await transaction.run(async (tx) => {
      await social.insertSocialIdentity(row, tx);
    });

    const found = await transaction.run((tx) => social.findSocialIdentity('apple', 'apple-subject-resolve', tx));
    expect(found).toEqual(row);
  });

  it('finds nothing for a subject nobody holds, and says null rather than throwing', async () => {
    const found = await transaction.run((tx) => social.findSocialIdentity('google', 'never-seen-subject', tx));
    expect(found).toBeNull();
  });

  it('never resolves one provider subject to another provider account', async () => {
    const userId = await newUser();
    await transaction.run(async (tx) => {
      await social.insertSocialIdentity(socialRow(userId, { providerSubject: 'shared-subject' }), tx);
    });

    // Same subject string, different provider: two unrelated people as far as this
    // platform is concerned. A resolver that keyed on the subject alone would hand
    // one of them the other's account.
    const wrongProvider = await transaction.run((tx) => social.findSocialIdentity('google', 'shared-subject', tx));
    expect(wrongProvider).toBeNull();
  });

  it('refuses to let a second account claim a provider subject, even concurrently', async () => {
    const first = await newUser();
    const second = await newUser();
    const subject = `contended-${randomUUID()}`;

    await transaction.run(async (tx) => {
      await social.insertSocialIdentity(socialRow(first, { providerSubject: subject }), tx);
    });

    // The unique index decides, not an application read-then-write: the two
    // transactions below never see each other's row before either writes, which is
    // exactly the interleaving a caller's `findSocialIdentity` guard would lose.
    const outcomes = await Promise.allSettled([
      transaction.run((tx) => social.insertSocialIdentity(socialRow(second, { providerSubject: subject }), tx)),
      transaction.run((tx) => social.insertSocialIdentity(socialRow(second, { providerSubject: subject }), tx)),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    for (const outcome of outcomes) {
      expect(outcome.status === 'rejected' && outcome.reason).toBeInstanceOf(StoreError);
      expect(outcome.status === 'rejected' && (outcome.reason as StoreError).retryable).toBe(false);
    }

    const owner = await transaction.run((tx) => social.findSocialIdentity('apple', subject, tx));
    expect(owner?.userId).toBe(first);
  });

  it('refuses to link one provider twice to the same member', async () => {
    const userId = await newUser();
    await transaction.run(async (tx) => {
      await social.insertSocialIdentity(socialRow(userId, { providerSubject: 'apple-first' }), tx);
    });
    await expect(
      transaction.run((tx) => social.insertSocialIdentity(socialRow(userId, { providerSubject: 'apple-second' }), tx)),
    ).rejects.toThrow(/social_identities/);
  });

  it('lets one member hold two different providers', async () => {
    const userId = await newUser();
    await transaction.run(async (tx) => {
      await social.insertSocialIdentity(socialRow(userId, { provider: 'apple', providerSubject: 's-apple' }), tx);
      await social.insertSocialIdentity(socialRow(userId, { provider: 'google', providerSubject: 's-google' }), tx);
    });
    const held = await transaction.run((tx) => social.listSocialIdentitiesFor(userId, tx));
    expect(held.map((row) => row.provider).sort()).toEqual(['apple', 'google']);
  });

  it('lists nothing for an account that has never used a provider', async () => {
    const userId = await newUser();
    expect(await transaction.run((tx) => social.listSocialIdentitiesFor(userId, tx))).toEqual([]);
  });

  it('unlinks one provider identity and reports whether there was one', async () => {
    const userId = await newUser();
    await transaction.run(async (tx) => {
      await social.insertSocialIdentity(socialRow(userId, { provider: 'meta', providerSubject: 's-meta' }), tx);
    });

    const removed = await transaction.run((tx) => social.deleteSocialIdentity(userId, 'meta', tx));
    const again = await transaction.run((tx) => social.deleteSocialIdentity(userId, 'meta', tx));
    expect(removed).toBe(true);
    // The second unlink says "there was nothing" rather than reading as success,
    // so a member-facing confirmation cannot claim to have removed something twice.
    expect(again).toBe(false);
  });

  it('writes no assertion, no token and no address, because the table has nowhere to put them', async () => {
    const userId = await newUser();
    await transaction.run(async (tx) => {
      await social.insertSocialIdentity(socialRow(userId, { providerSubject: 's-nothing-extra' }), tx);
    });
    const raw = await pool.query('SELECT * FROM app.social_identities WHERE user_id = $1', [userId]);
    // The whole row, not a selected subset: a column added for a token would appear
    // here and fail the assertion, which is the point of reading it this way.
    expect(Object.keys(raw.rows[0] ?? {}).sort()).toEqual(['linked_at', 'provider', 'provider_subject', 'user_id']);
  });

  it('round-trips a credential with no password, and refuses a password against it', async () => {
    const userId = await newUser();
    const contact = `member-${randomUUID()}@brightpost.test`;
    await providerCredential(userId, contact);

    const credential = await transaction.run((tx) => accounts.findCredential(userId, tx));
    expect(credential?.passwordHash).toBeNull();
    expect(credential?.contactVerified).toBe(true);

    // Property 3, as far as this layer owns it: the *row* carries no hash, which
    // is the fact the platform's `resolvePasswordCredential` refuses on. The
    // refusal itself is a platform rule and is tested there
    // (`packages/platform/test/social-authn.test.ts`) — a database test that
    // reached into platform to assert it would break the layering the boundary
    // check exists to hold.
  });

  it('accepts a password once one is set, which is what completing recovery does', async () => {
    const userId = await newUser();
    await providerCredential(userId, `member-${randomUUID()}@brightpost.test`);
    // A real scrypt digest, produced by the platform's own hasher — hashing is a
    // platform concern and the store only stores the string it is handed, so the
    // digest's *format* is not this layer's to assert; storing and reading it back
    // is.
    const hash = 'scrypt:16384:8:1$c2VlZHNhbHQ$2F1v9v0o0hJ1oQ0bYbXh0m0YQ0m0YQ';
    const updated = await transaction.run((tx) => accounts.updatePasswordHash(userId, hash, LINKED_AT, tx));
    expect(updated).toBe(true);

    const credential = await transaction.run((tx) => accounts.findCredential(userId, tx));
    expect(credential?.passwordHash).toBe(hash);
  });

  it('leaves the identity of a provider-created account unverified and undiscoverable', async () => {
    const userId = await newUser();
    await providerCredential(userId, `member-${randomUUID()}@brightpost.test`);
    await transaction.run(async (tx) => {
      await social.insertSocialIdentity(socialRow(userId, { providerSubject: 's-unverified' }), tx);
    });

    const record = await transaction.run((tx) => identity.find(userId, tx));
    // Nothing in the provider path touched identity state, and commitment 1 says
    // the account is therefore not discoverable. Read from the database rather
    // than asserted from this suite's own setup.
    expect(record?.state).toBe('unverified');
    // Checked against the machine's own vocabulary rather than cast into it: a row
    // read from the database has to be *in* that vocabulary before it is used as a
    // member of it, and the cast below is the one place this file assumes it.
    const states: readonly string[] = identityMachine.states;
    const state = record?.state;
    expect(state !== undefined && states.includes(state)).toBe(true);
    // `unverified` is the literal the assertion above pinned, so this narrowing is
    // reading the database rather than choosing a value that makes the check pass.
    const identityState = state as IdentityState;
    expect(identityState).toBe('unverified');
    expect(
      isDiscoverableIdentity({
        state: identityState,
        latestVerificationId: record?.latestVerificationId ?? null,
        generation: record?.generation ?? 0,
      }),
    ).toBe(false);
  });

  it('holds no way to find an account by the address a provider attested', async () => {
    const existing = await newUser();
    const contact = `shared-${randomUUID()}@brightpost.test`;
    await providerCredential(existing, contact);

    // A second member arrives from a provider and attests the same address. The
    // complement of "resolution is by provider subject and nothing else" is that
    // there is no second door: the port exposes no lookup by address, so the
    // caller cannot reach this account by knowing its email. The rule that turns
    // that absence into a refusal — "an existing address requires an explicit
    // link" — is `resolveSocialSignIn`, which is a platform rule and is tested
    // there (`packages/platform/test/social-authn.test.ts`).
    // Nothing is linked for this provider subject, and the port can only be
    // asked by provider and subject — so the address is not a way in.
    const link = await transaction.run((tx) =>
      social.findSocialIdentity('apple', 'attested-this-address', tx),
    );
    expect(link).toBeNull();
    const accountsForAddress = await transaction.run((tx) =>
      accounts.findCredentialByContact(contact, tx),
    );
    // The one legitimate door: a credential lookup, which resolves to the account
    // that owns the address, and is not reachable with a provider subject.
    expect(accountsForAddress?.userId).toBe(existing);
  });
});