-- The personal dating goal and the completed-date history (issues #48, #49).
--
-- `packages/dating/src/goal.ts` has implemented both since it landed, with
-- thirty tests, and neither was reachable: there was no route and no table, so a
-- user could not set a target and their count did not survive a restart. This
-- migration gives the domain somewhere to put what it already decides.
--
-- Four decisions are load-bearing here, and each of them is a decision the domain
-- made first and this schema follows rather than the other way round:
--
--  1. **Two aggregates, two keys.** `dating_goals` is keyed by `profile_id`; the
--     ledger is keyed by `owner_id`. A profile is a card whose lifecycle ends in
--     `deleted`, and deleting one and making another is an ordinary act of
--     privacy — so the target starts again at the default while the history
--     behind it stays. That is why the goal cascades from `app.profiles` and the
--     ledger does not mention `app.profiles` at all: there is no foreign key
--     from a completed date to a profile for a cascade to travel along, so
--     "deleting a profile must not take the history" is the schema's shape and
--     not a promise.
--
--  2. **Corrections are an append-only log.** `completed_date_corrections` has
--     no mutable meaning: a withdrawal is a row, a restatement is a row. A
--     counter row cannot answer "why did this drop from 13 to 12?", which is why
--     the entry's day is the *effective* day — a projection of the log, the way
--     `likes.state` is a projection of likes and their supersessions — while the
--     log itself is only ever appended to.
--
--     The store holds **more** than the domain does here, deliberately and
--     asymmetrically: `correctCompletedDate` overwrites `occurredOn` and retains
--     only the days each restatement moved *to*, so restating 03 -> 02 -> 01
--     leaves the aggregate unable to say what was claimed first. This table adds
--     `superseded_on` — the day each restatement replaced — so the claim chain is
--     walkable in SQL. That is a storage-layer guarantee and not a claim about
--     what `CompletedDateRecord` carries; see the column for why the extra lives
--     here rather than in the domain type.
--
--  3. **The count is derived and is not a column.** There is no `completed`
--     anywhere in this file, and no sequence a correction could decrement below
--     zero. `completedDateCount` counts entries, so "the count cannot go
--     negative" is structural.
--
--  4. **`entry_id` is a caller-supplied retry token.** It is part of the primary
--     key rather than a surrogate column, so a double-tap, a retry after a
--     timeout and two workers racing on the same key all collapse onto one row.
--     Uniqueness is scoped to the owner, because a token is the owner's request
--     key and two owners may independently choose the same string.
--
-- Two things a future migration must not "helpfully" add:
--
--  * A `counterpart_id` foreign key. There is deliberately none. The domain
--    requires nothing of the other person — not a standing, not a block, not a
--    match, not a verification, and not an *existence* — because a date with
--    someone met offline is a real date too. An FK would reintroduce by
--    constraint the exact review requirement `recordCompletedDate` was shaped to
--    make unreachable. The column is a plain `uuid` with no reference.
--  * A `completed` counter column, for the reason above.
--
-- `occurred_on` is a real `date` and not text, so the database rejects
-- `2026-02-31` as well as the domain refusing it: two independent checks on one
-- fact, and the schema one costs nothing. `correction_key` is unique per entry
-- because that is the scope the domain compares it at.

BEGIN;
SET search_path TO app;

-- 1. The goal.
--
-- `app.profiles.profile_id` existed as a nullable column with a *partial*
-- unique index (`WHERE profile_id IS NOT NULL`), and a partial index cannot be
-- the target of a foreign key. So the full unique constraint is added here. It
-- admits exactly the same rows the partial index did — Postgres treats nulls as
-- distinct in a unique constraint, so the profiles predating the column all
-- still fit — and in exchange the goal gets a real referential link to the card
-- it is a setting on, which is what makes "a deleted profile takes its target
-- with it and the new one starts at the default" enforceable rather than
-- aspirational.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'profiles_profile_id_key'
  ) THEN
    ALTER TABLE app.profiles
      ADD CONSTRAINT profiles_profile_id_key UNIQUE (profile_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS dating_goals (
  -- A setting on a card, so it dies with the card. See point 1 above.
  profile_id  text PRIMARY KEY
    REFERENCES app.profiles (profile_id) ON DELETE CASCADE,
  -- Carried so the row is answerable without a join, and so an account's
  -- erasure takes its targets with it.
  owner_id    uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  -- The domain's own limits, as a constraint. `DATING_GOAL_LIMITS` is the
  -- authority in code; this is the same pair, so a goal outside it cannot be
  -- stored even by a writer that skipped the validator.
  target      integer NOT NULL CHECK (target BETWEEN 1 AND 100000),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dating_goals_by_owner
  ON app.dating_goals (owner_id);

-- 2. The dates.
--
-- The only foreign key here points at `app.users`. That is the whole of the
-- ownership statement: a completed date belongs to a person, not to a
-- publication, and nothing in this table can be reached by deleting a profile.
CREATE TABLE IF NOT EXISTS completed_dates (
  owner_id       uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  -- The caller's retry token, and part of the key rather than a column beside
  -- it. See point 4 above.
  entry_id       text NOT NULL CHECK (char_length(entry_id) BETWEEN 1 AND 200),
  -- NO foreign key, deliberately. See the header.
  counterpart_id uuid,
  -- The *effective* day. A restatement rewrites this and appends the day it
  -- replaced to the correction log, so the effective day is a projection of the
  -- log rather than the history itself.
  occurred_on    date NOT NULL,
  recorded_at    timestamptz NOT NULL,
  PRIMARY KEY (owner_id, entry_id)
);

-- Reading the history is "this owner's dates, oldest first", and the primary key
-- is on `(owner_id, entry_id)` — an id, not a time — so it cannot serve that
-- read. This index is what `findLedger` uses.
CREATE INDEX IF NOT EXISTS completed_dates_by_owner
  ON app.completed_dates (owner_id, recorded_at, entry_id);

-- 3. The corrections.
--
-- Append-only, and the port has no update and no delete to become one. The
-- foreign key to the date is `ON DELETE CASCADE` because an account's erasure
-- must take its whole history: that is the one delete that is a right rather
-- than a loss, and it reaches both tables from `app.users`. Nothing else deletes
-- a completed date — there is no statement anywhere that could.
CREATE TABLE IF NOT EXISTS completed_date_corrections (
  owner_id        uuid NOT NULL REFERENCES app.users (user_id) ON DELETE CASCADE,
  entry_id        text NOT NULL,
  -- The caller's retry token for the correction. Unique per entry, which is the
  -- scope `correctCompletedDate` compares keys at.
  correction_key  text NOT NULL CHECK (char_length(correction_key) BETWEEN 1 AND 200),
  kind            text NOT NULL CHECK (kind IN ('withdrawn', 'restated')),
  -- Present exactly when `restated`: the day the entry now says.
  occurred_on     date,
  -- Present exactly when `restated`: **the day this correction replaced.**
  --
  -- Read this as a *store* guarantee, and note that it is stronger than the one
  -- the domain makes. `correctCompletedDate` returns a record whose `occurredOn`
  -- is the new day and whose `corrections` hold the days each restatement moved
  -- *to*; restate 03 -> 02 -> 01 and the aggregate can no longer say what was
  -- claimed first. The domain's append-only guarantee covers the *existence* of
  -- the record and the fact that it was corrected — enough for "why did this drop
  -- from 13 to 12?", not for "when did I first say this was the 3rd?".
  --
  -- This column closes that gap at the storage layer, and deliberately only
  -- here: `CompletedDateRecord` has no field for it, and inventing one would
  -- change what the domain claims to guarantee, which is a product decision
  -- rather than a schema detail. So the chain is walkable in SQL — each
  -- correction says what it replaced, so the whole sequence of claims is
  -- recoverable — while the aggregate the domain hands out is unchanged.
  --
  -- Consequence, stated so nobody assumes otherwise: this table is a record of
  -- corrections *and of what each replaced*, not merely an annotation that a
  -- correction happened. If a future migration drops the column, the guarantee
  -- it carries goes with it and restatements become corrections rather than
  -- annotations.
  superseded_on   date,
  corrected_at    timestamptz NOT NULL,
  -- Monotonic within an entry, and the reason `corrected_at` is not enough on
  -- its own: two corrections can land inside the same millisecond, and ordering
  -- them by the caller's random `correction_key` instead would make "the
  -- correction that moved this entry to the day it now claims" a different
  -- answer per query planner. `superseded_on` is read by walking this order, so
  -- it has to be *the* append order and not merely a plausible one.
  --
  -- A `bigserial` rather than a per-entry counter because it needs no read to
  -- allocate: the sequence hands out a total order across the table for free,
  -- and the per-entry ordering is that order restricted to one entry. The
  -- sequence is not a fact about the owner — it is not exposed, and nothing
  -- outside this table's own reads depends on its values.
  seq             bigserial NOT NULL,
  PRIMARY KEY (owner_id, entry_id, correction_key),
  FOREIGN KEY (owner_id, entry_id)
    REFERENCES app.completed_dates (owner_id, entry_id) ON DELETE CASCADE,
  -- The two kinds carry different facts, and a row that claims `restated` with no
  -- day — or carries a day for a withdrawal — is not a correction the domain
  -- could have produced, so it is refused here rather than read back later.
  CHECK ((kind = 'restated') = (occurred_on IS NOT NULL AND superseded_on IS NOT NULL))
);

-- Folding a ledger reads one entry's corrections in append order. The primary key
-- covers `(owner_id, entry_id, correction_key)`, so it cannot order by *when* —
-- and this index leads with `seq` for the reason given on the column.
CREATE INDEX IF NOT EXISTS completed_date_corrections_by_entry
  ON app.completed_date_corrections (owner_id, entry_id, seq);

COMMIT;
