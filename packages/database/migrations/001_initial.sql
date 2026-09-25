-- The v0.1 schema for the modular monolith (ADR 0001: one store, one database).
--
-- Design rules that are load-bearing rather than conventional:
--
--  * Identity state is written only by the identity domain's transitions. There
--    is no trigger that could grant `verified`, and the `generation` column
--    makes a stale write detectable rather than silent.
--  * The audit log has no UPDATE or DELETE grant. It is the appeal record, and
--    the appeal is the only thing standing between "irreversible automated
--    black box" and a contestable decision.
--  * A pair has at most one match, enforced by a unique index on the canonical
--    sorted pair, so two concurrent reciprocal likes cannot produce two matches.
--    The application derives the same key; the index is what makes a race
--    impossible rather than unlikely.
--  * One conversation per match, for the same reason.

BEGIN;

CREATE SCHEMA IF NOT EXISTS app;
SET search_path TO app;

-- ---------------------------------------------------------------- identity --

CREATE TABLE IF NOT EXISTS users (
  user_id    uuid PRIMARY KEY,
  account_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identity_state (
  user_id               uuid PRIMARY KEY REFERENCES app.users (user_id) ON DELETE CASCADE,
  state                 text NOT NULL
    CHECK (state IN ('unverified', 'pending', 'verified', 'review_required',
                     'verification_failed', 'expired')),
  -- Monotonic. Any increment forces re-verification downstream, and a write
  -- carrying a stale generation is rejected rather than applied.
  generation            integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  latest_verification_id uuid,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------- dating --

CREATE TABLE IF NOT EXISTS profiles (
  user_id    uuid PRIMARY KEY REFERENCES app.users (user_id) ON DELETE CASCADE,
  state      text NOT NULL
    CHECK (state IN ('draft', 'incomplete', 'complete', 'paused', 'hidden')),
  content    jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS preferences (
  user_id    uuid PRIMARY KEY REFERENCES app.users (user_id) ON DELETE CASCADE,
  -- null means "unbounded", not "matches nothing". A user who has expressed no
  -- preference must not silently exclude everyone.
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS likes (
  like_id            uuid PRIMARY KEY,
  from_user_id       uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  to_user_id         uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  state              text NOT NULL DEFAULT 'live'
    CHECK (state IN ('live', 'withdrawn', 'matched')),
  -- The pass this like overrode, so the history of a supersession survives.
  superseded_pass_id uuid,
  CHECK (from_user_id <> to_user_id)
);

-- The idempotence guarantee: one live like per ordered pair. A duplicate tap
-- and a retried request are indistinguishable at this layer, so the store is
-- where they collapse.
CREATE UNIQUE INDEX IF NOT EXISTS likes_live_pair
  ON app.likes (LEAST(from_user_id, to_user_id), GREATEST(from_user_id, to_user_id))
  WHERE state IN ('live', 'matched');

CREATE TABLE IF NOT EXISTS passes (
  pass_id      uuid PRIMARY KEY,
  from_user_id uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  to_user_id   uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  state        text NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'superseded')),
  CHECK (from_user_id <> to_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS passes_live_pair
  ON app.passes (LEAST(from_user_id, to_user_id), GREATEST(from_user_id, to_user_id))
  WHERE state = 'live';

CREATE TABLE IF NOT EXISTS blocks (
  block_id     uuid PRIMARY KEY,
  blocker_id   uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  blocked_id   uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  lifted_at    timestamptz,
  CHECK (blocker_id <> blocked_id)
);

-- Stored in one direction and applied in both. The index is on the canonical
-- unordered pair so the two-way lookup is a single index probe, and the
-- constraint makes a self-block unrepresentable rather than merely unlikely.
CREATE UNIQUE INDEX IF NOT EXISTS blocks_pair
  ON app.blocks (LEAST(blocker_id, blocked_id), GREATEST(blocker_id, blocked_id));
CREATE UNIQUE INDEX IF NOT EXISTS blocks_active
  ON app.blocks (blocker_id, blocked_id) WHERE lifted_at IS NULL;

CREATE TABLE IF NOT EXISTS matches (
  match_id     uuid PRIMARY KEY,
  -- The canonical pair. Two concurrent reciprocal likes collide here and one
  -- loses, which is what makes "exactly one match" true rather than likely.
  pair_key     text NOT NULL UNIQUE,
  participants uuid[] NOT NULL CHECK (array_length(participants, 1) = 2),
  like_ids     uuid[] NOT NULL,
  -- Per-party, because the cause of an end is shared and the standing is not.
  standings    text[] NOT NULL CHECK (array_length(standings, 1) = 2),
  created_at   timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  ended_cause  text
);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_id uuid PRIMARY KEY,
  -- One per match, for the same reason the pair is unique.
  match_id        uuid NOT NULL UNIQUE REFERENCES app.matches (match_id) ON DELETE CASCADE,
  participants    uuid[] NOT NULL CHECK (array_length(participants, 1) = 2),
  state           text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'blocked', 'frozen_by_restriction', 'ended_by_unmatch', 'ended')),
  opened_at       timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz
);

CREATE TABLE IF NOT EXISTS messages (
  message_id      uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES app.conversations (conversation_id) ON DELETE CASCADE,
  sender_id       uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  body            text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Delivery is at-least-once on the wire, so a replayed id collapses here rather
-- than showing the same message twice.
CREATE UNIQUE INDEX IF NOT EXISTS messages_id ON app.messages (message_id);
CREATE INDEX IF NOT EXISTS messages_by_conversation
  ON app.messages (conversation_id, created_at);

-- ---------------------------------------------------------- trust & safety --

CREATE TABLE IF NOT EXISTS risk_signals (
  signal_id   uuid PRIMARY KEY,
  subject_id  uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  detector    text NOT NULL,
  behaviour   text NOT NULL,
  entity_id   text,
  -- Derived metadata only. A message body or an identity artefact has no column
  -- here, so a later query cannot reconstruct one either.
  facts       jsonb NOT NULL DEFAULT '{}'::jsonb,
  weight      real NOT NULL CHECK (weight > 0 AND weight <= 1),
  occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS risk_signals_by_subject
  ON app.risk_signals (subject_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS risk_assessments (
  subject_id            uuid PRIMARY KEY REFERENCES app.users (user_id) ON DELETE CASCADE,
  assessment_id         uuid NOT NULL,
  state                 text NOT NULL
    CHECK (state IN ('normal', 'elevated', 'high', 'critical')),
  last_signal_at        timestamptz,
  contributing_detectors text[] NOT NULL DEFAULT '{}',
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------- moderation --

CREATE TABLE IF NOT EXISTS reports (
  report_id        uuid PRIMARY KEY,
  subject_id       uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  -- null = anonymous. Anonymity never weakens the record.
  reporter_id      uuid REFERENCES app.users (user_id) ON DELETE SET NULL,
  reason           text NOT NULL,
  statement        text,
  -- Frozen at submission: this is what a case reads months later, and it
  -- survives the relationship that produced it.
  relationship     jsonb NOT NULL,
  captured_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  state            text NOT NULL DEFAULT 'submitted',
  merged_case_id   uuid,
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cases (
  case_id       uuid PRIMARY KEY,
  subject_id    uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  origin        text NOT NULL,
  state         text NOT NULL,
  priority      text NOT NULL,
  queue         text NOT NULL,
  opened_at     timestamptz NOT NULL,
  due_at        timestamptz NOT NULL,
  opened_by     text NOT NULL,
  assigned_moderator_id text,
  report_ids    uuid[] NOT NULL DEFAULT '{}',
  evidence_ids  uuid[] NOT NULL DEFAULT '{}',
  resolution_decision_id uuid,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The moderator queue is a real queue, so it needs a real ordering index.
CREATE INDEX IF NOT EXISTS cases_queue
  ON app.cases (queue, priority, opened_at)
  WHERE resolution_decision_id IS NULL;

CREATE TABLE IF NOT EXISTS decisions (
  decision_id   uuid PRIMARY KEY,
  case_id       uuid NOT NULL REFERENCES app.cases (case_id) ON DELETE CASCADE,
  subject_id    uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  action        text NOT NULL
    CHECK (action IN ('warn', 'restrict', 'suspend', 'ban', 'clear')),
  -- Non-null for everything except `clear`. A reversal names what it reverses,
  -- so the original decision is referenced rather than overwritten.
  reverses     uuid REFERENCES app.decisions (decision_id),
  removed_capabilities text[] NOT NULL DEFAULT '{}',
  -- The human who took it. Non-null because automation never enforces.
  moderator_id  text NOT NULL,
  rationale     text NOT NULL,
  decided_at    timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ audit --

CREATE TABLE IF NOT EXISTS audit_log (
  seq         bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  actor_id    text NOT NULL,
  action      text NOT NULL,
  entity_type text NOT NULL,
  entity_id   text NOT NULL,
  subject_id  uuid,
  case_id     uuid,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS audit_by_actor ON app.audit_log (actor_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_by_subject ON app.audit_log (subject_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_by_entity ON app.audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_by_case ON app.audit_log (case_id) WHERE case_id IS NOT NULL;

COMMIT;
