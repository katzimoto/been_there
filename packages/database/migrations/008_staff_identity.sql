-- Staff identity.
--
-- The gap this closes: a moderator queue had no way for a human to reach it. The
-- only credential that could open one was a bearer token compared in JavaScript at
-- a composition root, with `actorId` set to the token string. Every decision row
-- therefore named a credential rather than a person, and the only thing standing
-- between "somebody holds a shared secret" and "somebody signed in" was a literal
-- in an env file.
--
-- 1. ONE session table, not a second one.
--
-- There is no `staff_sessions` here, and the reason is the one this repository has
-- already paid for twice: a second table is a second answer to "how is this caller
-- authenticated", and two answers to an authentication question disagree exactly
-- where it matters. `account_sessions` gains a *subject* instead — a discriminated
-- pair saying whose session this is. Revocation, expiry, rotation and the
-- concurrent-session cap keep working unchanged because they never cared who the
-- subject was.
--
-- The CHECK at the bottom is what makes the discrimination load-bearing rather
-- than decorative: a row names exactly one subject, and the `subject_kind` must
-- agree with which columns are set. A session that is both a member's and a
-- moderator's cannot be written, so "which account does this session belong to"
-- has one answer at the storage layer and not merely in the code that reads it.
--
-- 2. The role lives on the identity, never on the session.
--
-- This is the whole of the revocation story for staff, and it is why there is no
-- `role` column on `account_sessions`. If the session carried the role, demoting
-- a moderator would leave every live session of theirs still holding the old one
-- until it expired — up to the refresh window — which is the precise window in
-- which you most need the demotion to have happened. The resolver reads the role
-- from `staff_identities` on every request, so suspending an identity stops the
-- next request and revoking a session stops the one in flight (see
-- `requireLiveSession`, which is why that exists).
--
-- 3. Least privilege, in the schema.
--
-- The role CHECK admits no `user` and no `system`. `user` would make a staff
-- identity a member as well as a moderator, and the whole argument for a
-- separate subject rests on those being different things. `system` is the
-- automation role: a human directory must not be able to mint a machine, or
-- commitment 2's "a decision requires a person" becomes a directory-management
-- decision instead of an authentication one.
--
-- A staff identity carries no capability grant either. Capabilities are computed
-- per account from `account_standing`, which is keyed by a member `user_id`; a
-- staff session has none, so there is no code path by which holding a moderation
-- role confers `browse_discovery` or `send_message`. That is the structural half
-- of "a staff session is not a superset of member capabilities" — the other half
-- is that a moderator still cannot strip `report`/`block`/`delete_account`, which
-- is `UNRESTRICTABLE_CAPABILITIES` and is unchanged by this migration.
--
-- 4. What is deliberately absent.
--
-- No `location`, no `device`, no coarse city, no last-seen. A staff identity is
-- more sensitive than a member's rather than less: it is the human on the other
-- side of a ban, and the audit log records their name on every action they take.
-- The fewer columns this table has, the fewer there are to leak.
--
-- There is also no clearance column. Clearance is a property of the role, already
-- declared once in `packages/platform/src/authz.ts` as `CLEARANCE_BY_ROLE`; a
-- second copy here would be a second thing to keep in step, and this repository
-- has already had one such list drift into an "unrestrictable" capability.

BEGIN;

-- Every migration sets the search path itself rather than inheriting the previous
-- file's, so this one does too. Without it `staff_identities` is created in
-- `public` and the `ALTER TABLE` below cannot resolve it — the file fails on its
-- own second statement, which is a confusing way to learn a migration is
-- self-contained.
SET search_path TO app;

-- 1. The directory of humans who may hold a staff session.
CREATE TABLE IF NOT EXISTS staff_identities (
  staff_id       uuid PRIMARY KEY,
  -- How they sign in. Normalised at the edge by the platform's own
  -- `normalizeContact`, never stored in any other form, exactly as
  -- `account_credentials` does it.
  contact_kind       text NOT NULL CHECK (contact_kind IN ('email', 'phone')),
  contact_identifier text NOT NULL,
  -- The credential a staff sign-in verifies against. Same shape as a member's
  -- (`scrypt:N:r:p$salt$digest`), because it is verified by the same function.
  password_hash   text NOT NULL,
  -- The name that lands in `decisions.moderator_id` and every audit row. A staff
  -- identity exists so that a decision names a person; a row that could not say
  -- which person would not be worth having.
  display_name    text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  -- `user` and `system` are refused, as point 3 above says. The list is spelled
  -- out rather than referencing the platform's `Role` union because a CHECK
  -- cannot, and a check constraint that admitted a role the code does not know
  -- would be a role nothing enforces.
  role            text NOT NULL CHECK (role IN
                    ('moderator', 'senior_moderator', 'support', 'identity_privacy_officer')),
  -- Suspension is the off switch that does not wait for a session to expire.
  -- `active`/`suspended` rather than a boolean so a future `revoked` is a
  -- migration rather than a reinterpretation of a stored `false`.
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at      timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL
);

-- One identity per contact. Without it two staff could share an address, and the
-- session would name whichever row the store happened to return first.
CREATE UNIQUE INDEX IF NOT EXISTS staff_identities_by_contact
  ON app.staff_identities (contact_identifier);

-- 2. The session's subject.
--
-- `user_id` loses NOT NULL and gains a sibling. Both are nullable and a CHECK
-- says exactly one is set — the nullable-both-and-guess alternative is how a
-- session would end up resolving to an account its holder never signed in to,
-- which is the hazard at `routes/account-sessions.ts` that this migration exists
-- to close.
ALTER TABLE app.account_sessions
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE app.account_sessions
  ADD COLUMN IF NOT EXISTS subject_kind text NOT NULL DEFAULT 'member'
    CHECK (subject_kind IN ('member', 'staff'));

-- 2a. Whether the holder of this session is a person.
--
-- This column exists because a first cut of this migration did not have it, and
-- the domain guard it feeds — `moderation.decision`'s refusal of an automated
-- actor — silently stopped firing: the flag was set on the in-memory session at
-- issue time and then read back as `false`, so a session minted for a machine
-- presented as a human on every subsequent request. That is the worst possible
-- failure for this column, because the guard that depends on it is the one that
-- stands between automation and enforcement.
--
-- So it is stored. `false` is the DEFAULT and is only *true* where a caller said
-- so at issue time; a member session is always a person, and a staff session is
-- a person unless whoever issued it said otherwise. Defaulting to `false` is
-- safe in the direction that matters: an unmarked staff session is treated as a
-- human, which is the ordinary case, and the automated paths — which exist for
-- detectors and integrations — have to say so.
ALTER TABLE app.account_sessions
  ADD COLUMN IF NOT EXISTS automated boolean NOT NULL DEFAULT false;

ALTER TABLE app.account_sessions
  ADD COLUMN IF NOT EXISTS staff_id uuid REFERENCES app.staff_identities (staff_id)
    ON DELETE CASCADE;

-- `ON DELETE CASCADE` on the way a moderator leaves: deleting the identity must
-- take its sessions with it, or a deleted human keeps a live credential until the
-- refresh window closes. This is deliberately the opposite of the member side,
-- where `ON DELETE CASCADE` from `app.users` is correct because a member's
-- sessions are worthless once they are gone.

-- 3. A staff sign-in is a different act from a member's, and says so. Without
-- this the row would claim `auth_method = 'password'` while having no member
-- credential behind it, and an audit reader could not tell the two apart.
ALTER TABLE app.account_sessions
  DROP CONSTRAINT IF EXISTS account_sessions_auth_method_check;
ALTER TABLE app.account_sessions
  ADD CONSTRAINT account_sessions_auth_method_check
    CHECK (auth_method IN ('password', 'recovery', 'passkey', 'oauth', 'staff_password'));

-- 4. Exactly one subject, and the discriminator must agree with it. This is the
-- constraint that makes the subject real: without it `subject_kind = 'staff'`
-- with a member's `user_id` set would be a session that resolves to both, and
-- every "whose session is this" question downstream would have two answers.
ALTER TABLE app.account_sessions
  DROP CONSTRAINT IF EXISTS account_sessions_one_subject;
ALTER TABLE app.account_sessions
  ADD CONSTRAINT account_sessions_one_subject CHECK (
    (subject_kind = 'member' AND user_id IS NOT NULL AND staff_id IS NULL) OR
    (subject_kind = 'staff'  AND user_id IS NULL     AND staff_id IS NOT NULL)
  );

-- 5. The staff queue: every live session a named moderator holds. Partial,
-- because the only reader is revocation-by-identity and it only cares about rows
-- that can still authenticate.
CREATE INDEX IF NOT EXISTS account_sessions_by_staff
  ON app.account_sessions (staff_id, last_active_at DESC)
  WHERE staff_id IS NOT NULL;

COMMIT;
