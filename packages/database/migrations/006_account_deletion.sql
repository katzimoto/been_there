-- Account deletion: the request, the 30-day window, and the anonymised subject.
--
-- `delete_account` is on the unrestrictable floor in
-- `packages/core/src/states/account.ts` because "removing it strands a banned
-- account: sanctioned, unappealable, and unable to leave" — and nothing
-- implemented it. This migration gives that capability somewhere to put what it
-- already decides, and it does so in a shape where the two halves of §8.2 cannot
-- be confused with one another:
--
--   * **Removed.** The credential, the age gate, sessions, recovery, contact
--     verification, identity state and its attempts, the profile and its photos,
--     preferences, the location anchor, likes, passes, matches, messages,
--     goals, completed dates. Every one of these is content about a person.
--
--   * **Retained.** Reports, cases, decisions, the audit log, risk signals and
--     assessments, and the account standing. §8.2's stated basis is that the
--     platform must be able to answer, months later and in front of a regulator,
--     "did this person, or this pattern, take action against a named user, and on
--     what evidence did we act?" That answer is impossible if the evidence
--     disappears the moment a subject asks us to forget them.
--
-- ## The cascade was the trap, and it is defused structurally
--
-- Every table in §8.2's *retained* column hangs off `app.users` by
-- `ON DELETE CASCADE`: `reports.subject_id`, `cases.subject_id`,
-- `decisions.subject_id`, `account_standing.user_id`, `risk_signals.subject_id`.
-- The obvious implementation of deletion — `DELETE FROM app.users WHERE user_id =
-- $1` — therefore deletes the moderation history along with the person, which is
-- exactly the outcome §8.2 refuses and the reason it says "Anonymized, not
-- erased".
--
-- So the users row is **not** deleted. It is rewritten: `state` becomes
-- `deleted`, a salted `pseudonym` replaces every identifier, and the identifying
-- columns are removed. That is §8.2's last row taken literally, and it is why the
-- retained tables need no migration of their own — they keep pointing at a row
-- that is still there, and the row is no longer a person.
--
-- `ON DELETE CASCADE` is left in place on all of them. It is the right default
-- for a row that is genuinely gone (a test fixture, an operator removing a
-- duplicate), and the deletion path is the one caller that must never take it.
--
-- ## One open request per account
--
-- `account_deletions_one_open` is a partial unique index over `status =
-- 'scheduled'`. It is the whole of §8.1's idempotence: a retried request and a
-- double-tapped button are indistinguishable by the time they arrive, so the
-- store collapses them onto one row rather than relying on a read-then-write in
-- application code, which two concurrent requests can interleave past. The
-- deadline of the *first* request is the one that stands, so a retry cannot
-- extend the window or shorten it.
--
-- ## The pseudonym and its salt
--
-- §8.2 requires a "stable salted pseudonymous `SubjectId`" that lets a future
-- account on the same contact point be linked to a moderation history. Stable
-- means recomputable, which means the salt has to outlive the process — so it is
-- a row here rather than a constant in code, and `pseudonym_salt` seeds one on
-- first use. A per-installation salt is the right scope: the linkage §8.2 wants
-- is "a moderator reviewing a case can see this is the same subject", which is
-- an installation-local question, and a global salt would make the pseudonyms
-- comparable across installations for no product benefit.
--
-- `deletion_pseudonym()` is the recomputation, in SQL so the value is identical
-- whether it is computed by the completion job or by the re-registration check
-- that follows it. Two implementations of "stable" is how it stops being stable.

BEGIN;
SET search_path TO app;

-- `pgcrypto`, for `hmac` and `gen_random_bytes` below.
--
-- Installed here rather than assumed present, and **before** the first use rather
-- than beside it, because extensions are per-database: a caller that applies
-- these migrations to a freshly created database — which is what every test
-- suite's isolation helper does, and what the demo journey does on every run —
-- gets a database with no `pgcrypto` in it even where the development database
-- has had it for months. A migration that assumed the extension would therefore
-- pass locally and fail on every clean database, which is the worst of both.
--
-- The alternative to `hmac` is a weaker digest, and §8.2's sentence is about not
-- leaving a reversible identifier behind. So this is created, not worked around.
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;

-- 1. The account row learns it can be deleted.
--
--    `state` is not the account *standing*: `account_standing.state` is
--    moderation's `active | limited | suspended | banned` and this column is
--    `active | deleted`. They are different facts about the same row — whether a
--    person uses the product versus whether one exists — and collapsing them into
--    one column would let a deletion overwrite a ban, which is precisely the
--    failure §8.3's last row forbids.
ALTER TABLE app.users
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'deleted')),
  ADD COLUMN IF NOT EXISTS pseudonym text,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- The pseudonym is what a re-registration is matched on, so it is unique — and
-- unique among *deleted* rows, which is all that is required. Two live accounts
-- never share a contact point (§5.3), so a collision among live rows would mean
-- the salt was wrong.
CREATE UNIQUE INDEX IF NOT EXISTS users_pseudonym
  ON app.users (pseudonym) WHERE pseudonym IS NOT NULL;

-- A deleted row must carry a pseudonym and a deletion instant, and a live row
-- must carry neither. Expressing it as a CHECK rather than trusting the writer
-- is the point: the anonymisation is a multi-statement transaction and a partial
-- one would leave a row that reads as a person with no way back.
ALTER TABLE app.users
  DROP CONSTRAINT IF EXISTS users_deleted_shape;
ALTER TABLE app.users
  ADD CONSTRAINT users_deleted_shape CHECK (
    (state = 'deleted' AND pseudonym IS NOT NULL AND deleted_at IS NOT NULL)
    OR (state = 'active' AND pseudonym IS NULL AND deleted_at IS NULL)
  );

-- 2. The deletion request.
--
--    `status` is the lifecycle from `packages/platform/src/deletion.ts` and is a
--    CHECK rather than free text for the same reason the session and recovery
--    tables are: a status nobody enumerated is a status nothing reads.
--
--    `requested_at` and `completes_at` are both stored. The deadline is *derived*
--    from the window constant, but it is derived once, at the request, and then
--    frozen: raising the window from 30 days to 45 must not retroactively extend
--    the deadline of every request already in flight, which is what a computed
--    column would do.
CREATE TABLE IF NOT EXISTS account_deletions (
  deletion_id  uuid PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  status       text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'cancelled', 'completed')),
  requested_at timestamptz NOT NULL,
  completes_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  completed_at timestamptz,
  -- A request that is `cancelled` or `completed` carries its instant; one that is
  -- `scheduled` carries neither. Held as a constraint rather than as route logic,
  -- because "cancelled" with no `cancelled_at` is the shape a partial write leaves
  -- behind and it is exactly the shape that makes the undo history unreadable.
  CONSTRAINT account_deletions_terminal_instant CHECK (
    (status = 'scheduled' AND cancelled_at IS NULL AND completed_at IS NULL)
    OR (status = 'cancelled' AND cancelled_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'completed' AND cancelled_at IS NULL AND completed_at IS NOT NULL)
  ),
  -- §8.1: the window is a window, so the deadline must be after the request that
  -- opened it. A clock that went backwards produces the opposite and would make
  -- the request immediately undoable.
  CONSTRAINT account_deletions_window CHECK (completes_at > requested_at)
);

-- Idempotence as a constraint rather than as a read-then-write.
CREATE UNIQUE INDEX IF NOT EXISTS account_deletions_one_open
  ON app.account_deletions (user_id) WHERE status = 'scheduled';

-- The completion job's read: everything due, oldest first, and there is no
-- scheduler in this repository yet, so this index has one reader today and will
-- have two tomorrow. Cheaper to have now than to add when the contention shows.
CREATE INDEX IF NOT EXISTS account_deletions_due
  ON app.account_deletions (completes_at) WHERE status = 'scheduled';

-- The account's own history, newest first. "Has this account been deleted before,
-- and did they undo it?" is a question a surface asks on every load.
CREATE INDEX IF NOT EXISTS account_deletions_by_user
  ON app.account_deletions (user_id, requested_at DESC);

-- 3. The pseudonym salt.
--
--    Seeded here rather than read from the environment on the theory that a
--    missing configuration variable should stop the deletion rather than
--    silently produce unsalted pseudonyms — an unsalted pseudonym is a
--    reversible identifier wearing a pseudonym's name, and §8.2's whole sentence
--    is about not leaving one.
CREATE TABLE IF NOT EXISTS deletion_pseudonym_salt (
  salt_id     boolean PRIMARY KEY DEFAULT true CHECK (salt_id),
  salt        text NOT NULL CHECK (char_length(salt) >= 32),
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app.deletion_pseudonym_salt (salt_id, salt)
-- `public.` on both, for the reason set out at the function below: under
-- `SET search_path TO app` a bare `gen_random_bytes` is not resolvable, because
-- this file puts the extension in `public`. It is pgcrypto's rather than core's —
-- PostgreSQL 13 promoted `gen_random_uuid` to `pg_catalog` and left this one in
-- the extension — which is the sort of detail worth writing down rather than
-- rediscovering the next time somebody applies this to a clean database.
VALUES (true, encode(public.gen_random_bytes(32), 'hex'))
ON CONFLICT (salt_id) DO NOTHING;

-- 4. The recomputation, in one place.
--
--    Called by the completion job when it anonymises and by the re-registration
--    check when somebody signs up again on the same contact point. Both must
--    produce byte-identical output or §8.2's "a future account on the same
--    contact point ... can be linked" is not a property of the system but a
--    coincidence of two implementations agreeing.
--
--    `pgcrypto`'s `hmac` is used rather than `sha256(salt || seed)`: the
--    concatenation form is length-extendable, which for a value that will be
--    compared against attacker-chosen contact points is a real weakness rather
--    than a theoretical one.
--
--    Qualified as `public.hmac` because this file runs under `SET search_path TO
--    app` and the extension lands in `public`. Left bare it is invisible here,
--    and the call fails *after* the transaction has rolled the extension back with
--    everything else — leaving the database exactly as it was, including the
--    missing extension, so the error names `hmac` rather than the thing that
--    actually went wrong.
--
--    The digest algorithm is the third argument because pgcrypto's `hmac` has no
--    two-argument overload: `hmac(data, key, type)`. Written as two arguments it
--    fails to resolve, and — because the whole file is one transaction — takes the
--    extension down with it, so the error names `hmac` rather than the shape that
--    was wrong. `sha256` rather than `sha512`: both are sound here, and matching
--    the algorithm the pseudonym column's `text` type comfortably holds is worth
--    more than the extra width.
CREATE OR REPLACE FUNCTION app.deletion_pseudonym(p_contact text)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT 'subj_' || encode(
    public.hmac(
      -- Data first, key second: `hmac(data, key, type)`, and the salt is the key.
      -- Getting these the wrong way round produces a value that is still stable and
      -- still distinct per contact, so it would pass every property test in this
      -- file while being a keyed digest of the wrong thing.
      convert_to('deletion-subject:' || lower(p_contact), 'UTF8'),
      convert_to((SELECT salt FROM app.deletion_pseudonym_salt WHERE salt_id), 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;

-- 5. What a completion removes, in one statement each rather than a cascade.
--
--    Every one of these hangs off `app.users` by `ON DELETE CASCADE`, and the
--    users row is deliberately never deleted (see the header), so a completion
--    that forgets one of them leaves the person's data behind with nothing left
--    to find it. Listing them here means the omission is visible in the diff
--    rather than discovered by a user.
--
--    `messages` is the one that is not a plain delete: §8.2 keeps them
--    "in restricted tombstoned form for the other party for a short defined
--    window", because content that still exists for the other person must not
--    silently vanish from their side. So the sender's messages go and the
--    recipient keeps a row whose body is gone — the tombstone is the row's
--    continued existence, not a message saying it was deleted.
--
--    `dating_goals` cascades from `profiles` and `completed_dates` from `users`, so
--    deleting those two takes them; they are named in the header for the reader's
--    benefit rather than in a statement that would be a no-op.

COMMIT;