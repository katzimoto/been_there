-- Social sign-in: a provider identity beside the credential it authenticates.
--
-- The gap this closes: there was no place to record that an account signed in
-- with Google, Apple or Meta, and no way to say what a provider *did* attest.
-- Two properties above all are what the table is shaped for.
--
-- 1. ONE provider subject is one account, forever.
--
--    `social_identities (provider, provider_subject)` is unique, and that index
--    is the whole anti-takeover story for a returning member. Signing in resolves
--    on those two columns and on nothing else — never on an email address — so
--    the question "is this person the one who used this provider account" has one
--    answer and it is enforced by the database rather than by a read-then-write a
--    caller could forget.
--
--    The four columns are the entire vocabulary: the member, the provider, the
--    subject the provider assigned, and when the link was made. There is no
--    column for the identity token, the authorization code, the ID token's
--    claims, the provider's response body, or the address the provider returned.
--    That is not restraint for its own sake. A bearer credential from a provider
--    is a secret with a long tail, and a claims blob is a copy of somebody's
--    account at a third party that this product has no business keeping: the
--    address it attests enters through the same door as any other contact, in
--    `account_credentials`, and `contact_verified` is what records whether the
--    provider vouched for it. `migration-009.test.ts` asserts this column list
--    rather than trusting this paragraph.
--
-- 2. An account with no password is representable, and only there.
--
--    `account_credentials.password_hash` was `NOT NULL`, which made "this
--    account authenticates with a provider" inexpressible — the only way to
--    satisfy the column would have been to invent a hash of a password nobody
--    has, which is a credential that looks real and authenticates nobody. The
--    column becomes nullable and `credential_method` says which of the two it
--    is, so the invariant is one line:
--
--        a password method has a hash, and a social method does not.
--
--    `credential_method` exists for that CHECK and nothing reads it. That is
--    deliberate: the fact a caller asks about is whether a password is present,
--    which is `password_hash IS NOT NULL`, and a second label beside it would be
--    a second answer to the same question. The CHECK is what makes the invariant
--    storage-level rather than a convention in one writer.
--
-- What this migration does NOT do, because doing it honestly needs credentials
-- nobody in this repository holds: it adds no route, no token exchange and no
-- provider HTTP call. `docs/features/social-sign-in.md` records what a caller
-- must supply before any of that can be written.

BEGIN;
SET search_path TO app;

-- 1. The credential loses its "there is always a password" assumption.
ALTER TABLE app.account_credentials
  ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE app.account_credentials
  ADD COLUMN IF NOT EXISTS credential_method text NOT NULL DEFAULT 'password';

-- Existing rows are all password accounts: the column was NOT NULL before this
-- migration, so `password_hash IS NOT NULL` holds for every one of them and the
-- constraint below is satisfied without backfilling anything.
ALTER TABLE app.account_credentials
  ADD CONSTRAINT account_credentials_method_vocabulary
  CHECK (credential_method IN ('password', 'social'));

ALTER TABLE app.account_credentials
  ADD CONSTRAINT account_credentials_method_shape
  CHECK ((credential_method = 'password') = (password_hash IS NOT NULL));

-- 2. The provider identity. Three facts and nothing else.
--
--    The primary key is `(user_id, provider)` rather than `user_id` alone
--    because a member may hold more than one provider identity — someone with a
--    Google account and an Apple account is one member with two ways in — while
--    two identities from the *same* provider is a merge nobody has designed.
--    That asymmetry is the schema's way of saying which of the two questions has
--    an answer.
CREATE TABLE IF NOT EXISTS social_identities (
  user_id             uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  provider            text NOT NULL,
  -- The stable subject identifier the provider assigned to this person. Opaque,
  -- case-sensitive, and never an email address or a display name.
  provider_subject    text NOT NULL,
  -- When this provider identity was attached to this account, whether by signing
  -- up with it or by a later member-initiated link.
  linked_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, provider),
  CONSTRAINT social_identities_provider_vocabulary
    CHECK (provider IN ('apple', 'google', 'meta')),
  CONSTRAINT social_identities_subject_present
    CHECK (provider_subject <> '' AND provider_subject = btrim(provider_subject))
);

-- The anti-takeover index. Sign-in resolves here and nowhere else.
CREATE UNIQUE INDEX IF NOT EXISTS social_identities_provider_subject
  ON app.social_identities (provider, provider_subject);

COMMIT;