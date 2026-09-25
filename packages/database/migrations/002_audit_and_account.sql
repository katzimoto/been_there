-- Three defects the service surfaced by trying to use this schema, plus three
-- it asked for. All six are the schema being wrong, not the caller.
--
-- The first is the serious one. `likes_live_pair` indexed the *unordered* pair,
-- so a like from A to B and a like from B to A collided — and a match is exactly
-- two reciprocal live likes. The second like of every pair was unrepresentable,
-- so `POST /interactions/likes` could never produce a match and messaging was
-- unreachable behind it. Reproduced against the live database before this fix:
--
--   INSERT likes (A -> B);  -- ok
--   INSERT likes (B -> A);  -- duplicate key value violates likes_live_pair
--
-- Idempotence for a like is per *ordered* pair, not per unordered one: two
-- people liking each other is two likes, and `resolveMatch` needs both. The
-- unique index belongs on (from, to).

BEGIN;
SET search_path TO app;

-- 1. One live like per ordered pair, so reciprocal likes are both writable.
DROP INDEX IF EXISTS app.likes_live_pair;
CREATE UNIQUE INDEX IF NOT EXISTS likes_live_pair
  ON app.likes (from_user_id, to_user_id)
  WHERE state IN ('live', 'matched');

-- 2. Passes are per-pair suppression, but the unordered key also forbade two
--    opposing live passes. A passing B is a different fact from B passing A.
DROP INDEX IF EXISTS app.passes_live_pair;
CREATE UNIQUE INDEX IF NOT EXISTS passes_live_pair
  ON app.passes (from_user_id, to_user_id)
  WHERE state = 'live';

-- 3. A match id is the domain's own derivation, `match:{a}|{b}`, not a uuid.
--    Uniqueness is already carried by `pair_key`, so nothing is lost. The
--    foreign key is dropped first: Postgres cannot change the type of a column
--    another table references, and reports that as an unimplementable
--    constraint rather than as an ordering hint.
ALTER TABLE app.conversations DROP CONSTRAINT IF EXISTS conversations_match_id_fkey;
ALTER TABLE app.matches ALTER COLUMN match_id TYPE text USING match_id::text;
ALTER TABLE app.conversations ALTER COLUMN match_id TYPE text USING match_id::text;
ALTER TABLE app.conversations
  ADD CONSTRAINT conversations_match_id_fkey
  FOREIGN KEY (match_id) REFERENCES app.matches (match_id) ON DELETE CASCADE;

-- 4. Account standing. `AccountStandingProjection` had no persisted source, so
--    after a ban or suspend the product had nothing to read. A service that
--    guessed `active` would un-ban every sanctioned account on restart.
CREATE TABLE IF NOT EXISTS account_standing (
  user_id            uuid PRIMARY KEY REFERENCES app.users (user_id) ON DELETE CASCADE,
  state              text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'limited', 'suspended', 'banned')),
  -- The resolved grant, published so a client can render a reason without
  -- holding its own copy of the capability table (ADR 0005 forbids that).
  capabilities       text[] NOT NULL
    DEFAULT ARRAY['browse_discovery','like','send_message','report','block','edit_profile'],
  visible_in_product boolean NOT NULL DEFAULT true,
  -- Why this row says what it says, so a standing is always attributable.
  case_id            uuid REFERENCES app.cases (case_id) ON DELETE SET NULL,
  decision_id        uuid,
  generation         integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_standing_by_state ON app.account_standing (state)
  WHERE state <> 'active';

-- 5. Conversations carry `stateChangedAt`, so the column has to exist.
ALTER TABLE app.conversations
  ADD COLUMN IF NOT EXISTS state_changed_at timestamptz;

-- 6. Audit idempotence, in the only honest form. A unique index on
--    (entity, action, actor) would collapse a genuine repeat: a moderator
--    re-reading the same evidence twice is two real rows, and the appeal record
--    must not lose that distinction. Retries cannot be told from repeats by any
--    columns describing *what happened*. So the caller supplies `dedupe_key`;
--    null for an action that may legitimately repeat, unique when present.
ALTER TABLE app.audit_log ADD COLUMN IF NOT EXISTS dedupe_key text;

CREATE UNIQUE INDEX IF NOT EXISTS audit_log_dedupe_key
  ON app.audit_log (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

COMMIT;

-- 7. Verification attempts are a first-class aggregate with their own lifecycle,
--    so they need somewhere to live between "submit" and "record the provider's
--    result". Without this a restart mid-verification makes the user start over
--    at the gate into the product.
CREATE TABLE IF NOT EXISTS verification_attempts (
  attempt_id  text PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  state       text NOT NULL DEFAULT 'initiated'
    CHECK (state IN ('initiated', 'capturing', 'awaiting_provider',
                     'passed', 'failed', 'manual_review', 'expired')),
  -- Derived check results, not biometric artefacts: an artefact has no column
  -- here, and a provider response is a reference rather than a payload.
  checks      jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_reference text,
  opened_at   timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz
);

-- At most one open attempt per user, so a second device cannot open a second
-- attempt and a retry loop cannot fan out into concurrent verifications.
CREATE UNIQUE INDEX IF NOT EXISTS verification_attempts_one_open
  ON app.verification_attempts (user_id)
  WHERE closed_at IS NULL;

-- 8. Risk assessments need the same optimistic concurrency as identity. A lost
--    update is survivable in the way that matters - the assessment is a pure
--    fold over `risk_signals`, so the next signal recomputes it - but until that
--    signal the subject is under-scored, and under-scoring is the direction
--    that hurts. The window is wider than two concurrent signals: decay sweeps,
--    applyDispute and reassessByHuman all rewrite this row.
ALTER TABLE app.risk_assessments
  ADD COLUMN generation integer NOT NULL DEFAULT 1 CHECK (generation > 0);

-- 9. Arrival order. `compareSignals` in trust-safety sorts a ledger by
--    (occurredAt, detector, subjectId), so the store orders to match. The
--    residual tie - same instant and same detector - is arrival order, which no
--    column recorded. A sequence closes it, so a replayed ledger produces the
--    same repeat count as an in-memory one.
ALTER TABLE app.risk_signals ADD COLUMN seq bigserial;
CREATE INDEX IF NOT EXISTS risk_signals_ordered
  ON app.risk_signals (subject_id, occurred_at, detector, seq);

-- 10. A released block must be re-creatable. `blocks_pair` was a UNIQUE index
--     on the canonical unordered pair with no WHERE clause, so the row left
--     behind by a release permanently blocked any future block between the same
--     two people. The port says "at most one *active* block", and the index
--     said otherwise: a user who blocked and then unblocked could never block
--     that person again. The history row stays; only the uniqueness is partial.
DROP INDEX IF EXISTS app.blocks_pair;
CREATE UNIQUE INDEX IF NOT EXISTS blocks_pair
  ON app.blocks (LEAST(blocker_id, blocked_id), GREATEST(blocker_id, blocked_id))
  WHERE lifted_at IS NULL;

-- 11. `ProfileRow.profileId` had no column. The domain identifies a profile by
--     its own id, and dropping it from the port to match the key would lose the
--     identity a photo or a prompt references.
ALTER TABLE app.profiles ADD COLUMN IF NOT EXISTS profile_id text;
CREATE UNIQUE INDEX IF NOT EXISTS profiles_profile_id
  ON app.profiles (profile_id) WHERE profile_id IS NOT NULL;

-- 12. `MessageRow.state` had no column. Every row that can exist today is
--     `sent`, so a store that hard-codes the constant is correct right now and
--     wrong the moment delivery receipts or moderation deletion are added — and
--     it would be wrong silently, because the constant would still typecheck
--     against the port. The column is cheaper than that lie.
ALTER TABLE app.messages
  ADD COLUMN IF NOT EXISTS state text NOT NULL DEFAULT 'sent'
    CHECK (state IN ('sent', 'delivered', 'read', 'failed', 'deleted'));
