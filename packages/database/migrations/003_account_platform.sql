-- Platform account state: credentials, the age gate, terms, sessions,
-- recovery, contact verification, access-control counters, and the two sinks
-- the onboarding funnel writes to.
--
-- None of this existed, and the gap was not cosmetic: `POST /v1/accounts`
-- minted a `users` row and an `identity_state` row and stopped. There was no
-- credential to sign in with, no session to authenticate a request, no date of
-- birth, and no terms acceptance, so the 18+ requirement was unenforceable and
-- every route in the service was reachable by anyone who could guess a token.
--
-- Design rules that are load-bearing rather than conventional:
--
--  * A date of birth is stored and nothing derived from it is. The age and the
--    band are computed at read time, because both depend on the clock: a
--    persisted age is a number that was true once, and a persisted band is a
--    label that is wrong the day its owner has a birthday.
--  * `age_band` is not a column here for the same reason. The band is derived,
--    so a stored one could only ever be a second source of truth to disagree
--    with the date.
--  * One verified contact identifier is one account, enforced by a unique index
--    rather than by a read-then-write in application code. The read exists too
--    (the duplicate rules need it) but it is a courtesy, not the guarantee.
--  * The rate-limit table is an event log, not a counter row. A counter needs
--    an upsert that races; an append-only log needs an index and a count, and
--    the count of a window is the same answer either way.
--  * Secrets are never stored in a form that leaves the process readable: a
--    salted scrypt digest for a password, a salted SHA-256 digest for a
--    one-time code or reset link.

BEGIN;
SET search_path TO app;

-- 1. The credential. One contact identifier per account: §5.3 says one verified
--    contact identifier is one account, and the phone-as-an-upgrade defence
--    (§7.2) switches the recovery factor rather than adding a second one.
CREATE TABLE IF NOT EXISTS account_credentials (
  user_id             uuid PRIMARY KEY REFERENCES app.users (user_id) ON DELETE CASCADE,
  contact_kind        text NOT NULL CHECK (contact_kind IN ('email', 'phone')),
  -- Normalised at the edge: lowercased and punycode-encoded for an email,
  -- E.164 for a phone. Never stored in any other form.
  contact_identifier  text NOT NULL,
  -- The product reads only this boolean. It never sees the address or the number.
  contact_verified    boolean NOT NULL DEFAULT false,
  password_hash       text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS account_credentials_contact
  ON app.account_credentials (contact_identifier);

-- 2. The age gate and terms.
--
--    `age_attested` is the recorded fact that the user was told the 18+ rule and
--    agreed to it. It is deliberately NOT the gate: a bare attestation is a
--    promise, and the gate computes from `date_of_birth`.
--
--    `terms_version` is a single column rather than a history because the only
--    question the product ever asks is "is the version this account accepted the
--    version currently published", and a history table would answer that with a
--    query that can disagree with the column.
CREATE TABLE IF NOT EXISTS account_onboarding (
  user_id             uuid PRIMARY KEY REFERENCES app.users (user_id) ON DELETE CASCADE,
  date_of_birth       date NOT NULL,
  age_attested        boolean NOT NULL DEFAULT true,
  terms_version       text NOT NULL,
  terms_accepted_at   timestamptz NOT NULL,
  -- Step 5, deferrable. A city area, never a coordinate: the column has no
  -- latitude and no longitude, so a query cannot reconstruct one either.
  coarse_area         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- 3. Sessions. The three lifetimes from `authn.ts` are columns, not settings,
--    because a session that stores a policy rather than a deadline is a session
--    whose policy nobody has to notice changing.
--
--    `token_hash` is what the bearer token resolves to. The token itself is
--    returned once, at issue, and never stored.
CREATE TABLE IF NOT EXISTS account_sessions (
  session_id          uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  auth_method         text NOT NULL CHECK (auth_method IN ('password', 'recovery', 'passkey', 'oauth')),
  status              text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'revoked')),
  token_hash          text NOT NULL,
  issued_at           timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  -- Absolute and never slides forward; the idle clock is what makes an absolute
  -- window survivable. See `SESSION_REFRESH_WINDOW_SECONDS`.
  refreshable_until   timestamptz NOT NULL,
  last_active_at      timestamptz NOT NULL,
  revoked_reason      text,
  superseded_by       uuid REFERENCES app.account_sessions (session_id),
  device_label        text,
  coarse_city         text
);

CREATE UNIQUE INDEX IF NOT EXISTS account_sessions_token
  ON app.account_sessions (token_hash);
-- The concurrent-session cap evicts the least recently active session, so the
-- ordering this needs is the ordering this index has.
CREATE INDEX IF NOT EXISTS account_sessions_by_user
  ON app.account_sessions (user_id, last_active_at DESC);

-- 4. Recovery. `revoked_session_ids` is kept on the row because the takeover
--    point is only reconstructable afterwards: "which session did the attacker
--    have when the owner recovered" is the question an incident review asks.
CREATE TABLE IF NOT EXISTS account_recoveries (
  recovery_id         uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  method              text NOT NULL CHECK (method IN ('email', 'sms', 'device_code')),
  status              text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'consumed', 'expired', 'locked')),
  -- Salted digest of the code or the link token. A six-digit code is small
  -- enough that the comparison has to be constant-time, and it is.
  secret_hash         text NOT NULL,
  requested_at        timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  attempts            integer NOT NULL DEFAULT 0,
  consumed_at         timestamptz,
  revoked_session_ids uuid[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS account_recoveries_by_user
  ON app.account_recoveries (user_id, requested_at DESC);

-- 5. Contact verification. One open verification per account, so a second
--    request supersedes the first rather than running beside it: §5.2 allows one
--    active link at a time and a new link invalidates the old.
CREATE TABLE IF NOT EXISTS contact_verifications (
  verification_id     uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  channel             text NOT NULL CHECK (channel IN ('email', 'phone')),
  status              text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'consumed', 'expired', 'locked')),
  secret_hash         text NOT NULL,
  attempts            integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_verifications_one_open
  ON app.contact_verifications (user_id) WHERE status = 'pending';

-- 6. Access-control counters. An append-only log rather than a counter row,
--    because a counter is an upsert and an upsert under concurrency is where a
--    rate limit stops being a rate limit. The bucket names the limit
--    ("signup_per_ip", "recovery_per_account"), the key is whatever that limit
--    counts over, and the answer is a count inside a window.
--
--    This is a Platform access control and nothing more: nothing here reads an
--    account state, and no row in this table ever appears in a moderator queue.
CREATE TABLE IF NOT EXISTS account_rate_limit_events (
  event_id            bigserial PRIMARY KEY,
  bucket              text NOT NULL,
  subject_key         text NOT NULL,
  occurred_at         timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS account_rate_limit_events_window
  ON app.account_rate_limit_events (bucket, subject_key, occurred_at DESC);

-- 7. The analytics sink for the onboarding funnel.
--
--    Every row has been through `recordAnalyticsEvent`, which refuses an
--    unregistered name, an undeclared dimension, a forbidden property and any
--    non-scalar value. There is no date of birth, no age, no contact identifier
--    and no user id here, and the table has no column that could hold one.
CREATE TABLE IF NOT EXISTS account_analytics_events (
  event_id            uuid PRIMARY KEY,
  type                text NOT NULL,
  occurred_at         timestamptz NOT NULL,
  -- The onboarding run id. This is what makes the funnel one joinable series.
  correlation_id      text NOT NULL,
  properties          jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS account_analytics_events_by_type
  ON app.account_analytics_events (type, occurred_at DESC);

-- 8. Notices the account owner is owed.
--
--    `idempotency_key` is unique, and that is the whole of "the owner learns
--    once, never per attempt" (§7.2): a second attempt that would produce the
--    same notice collides instead of arriving, so a harassment burst cannot
--    become a notification flood aimed at the victim.
CREATE TABLE IF NOT EXISTS account_notices (
  notification_id     uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  kind                text NOT NULL,
  channel             text NOT NULL,
  -- `suppressed` rows are kept rather than dropped: a notice the planner
  -- suppressed is the record of why a person was not told something.
  status              text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'suppressed')),
  suppression_reason  text,
  idempotency_key     text NOT NULL,
  deliver_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS account_notices_idempotency
  ON app.account_notices (idempotency_key);
CREATE INDEX IF NOT EXISTS account_notices_by_user
  ON app.account_notices (user_id, created_at DESC);

COMMIT;
