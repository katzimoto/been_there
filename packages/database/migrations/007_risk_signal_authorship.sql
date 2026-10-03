-- Risk signals can be replayed into a ledger, and a mass-report campaign can be
-- counted after a restart.
--
-- ## What was broken
--
-- `risk_signals` recorded *that* a detector fired, at what weight, when — and
-- nothing about who authored the signal or who performed the behaviour. Two
-- consumers need both, and neither could be served:
--
--   1. `corroborate` reads `entry.actorId` to count a reporting campaign's
--      **distinct reporters**. With no actor column, a campaign of three
--      accounts against one victim is three indistinguishable rows, so the
--      cluster is invisible to a replay.
--   2. `SignalAuthor` (`reliability`, `category`, `escalation`) is what the
--      policy layer reads to decide what a signal is worth. A row without it is
--      not a `Signal`, so the log cannot be folded back into a `SignalLedger`.
--
-- The consequence was that corroboration state lived only in the service
-- process's memory (`wiring/safety.ts` holds a `Map<SubjectId, SignalLedger>`).
-- **A restart forgot it.** Two accounts behaving alike stopped corroborating
-- each other until one of them happened to be observed again — so a subject's
-- risk was recomputed from a *shorter* history after a deploy than before it.
-- Under-counting is the direction that hurts, and it happened silently.
--
-- ## `actor_id` is nullable, and `SET NULL` rather than `CASCADE`
--
-- Only `report_against` is ever performed by somebody other than its subject;
-- every other behaviour kind is self-attributed by construction
-- (`signal.ts`, `attributionIsValid`). The column is therefore nullable so a
-- writer that has not yet been taught the distinction is not forced to invent
-- an actor. The service passes it explicitly for every signal it folds.
--
-- `ON DELETE SET NULL`, not `CASCADE`: **an account's deletion must not delete
-- the evidence against it.** A deleted account's signals remain as evidence,
-- with the actor anonymised — the same reasoning `006_account_deletion.sql`
-- applies to `reports.reporter_id`, and the reason this is a deliberate repeat
-- of an existing decision rather than a new one.
--
-- ## The author columns are stored, not derived
--
-- `detector` is already stored, so these three are technically derivable by
-- joining the catalogue. They are stored anyway, and deliberately: the
-- derivation needs the *code* catalogue, and the catalogue is code that can
-- rename a detector. Storing the declaration makes the log self-describing and
-- keeps a replay independent of which version wrote it.
--
-- No foreign key to a `signal_authors` table is added here. That would couple
-- every historical signal row to a seed table that a future detector rename
-- has to migrate; the CHECK constraints below pin the closed vocabularies,
-- which is the property a FK was wanted for, without the coupling.

-- 1. Who performed the behaviour. Null for a self-attributed signal written
--    before this column existed, and null after the account is deleted.
ALTER TABLE app.risk_signals
  ADD COLUMN IF NOT EXISTS actor_id uuid REFERENCES app.users (user_id) ON DELETE SET NULL;

-- 2. The signal's author, as declared by the detector that produced it. These
--    three are what the policy layer reads; without them a stored row is not a
--    `Signal` and cannot be re-folded into a ledger.
--
--    Nullable on purpose. Rows written before this migration have no
--    declaration, and inventing one from the detector name would fabricate a
--    reliability the author never claimed. A null here marks the row
--    unreplayable, and `findSignalsFor` surfaces that rather than guessing.
ALTER TABLE app.risk_signals
  ADD COLUMN IF NOT EXISTS reliability text,
  ADD COLUMN IF NOT EXISTS category text,
  ADD COLUMN IF NOT EXISTS escalation text;

-- 3. The closed vocabularies, as CHECKs rather than enums: adding a
--    reliability is a code change in `signal.ts` first, and a migration after
--    that, which is the ordering that keeps the two from disagreeing.
--
--    `NOT VALID` then `VALIDATE CONSTRAINT` so the migration takes only a
--    brief lock rather than scanning the whole table under ACCESS EXCLUSIVE.
--    Both are no-ops on an empty table and correct on a populated one.
ALTER TABLE app.risk_signals
  ADD CONSTRAINT risk_signals_reliability_known
    CHECK (reliability IS NULL OR reliability IN ('low', 'medium', 'high')) NOT VALID,
  ADD CONSTRAINT risk_signals_category_known
    CHECK (category IS NULL OR category IN ('velocity', 'interaction', 'identity', 'network', 'report_pattern')) NOT VALID,
  ADD CONSTRAINT risk_signals_escalation_known
    CHECK (escalation IS NULL OR escalation IN ('corroboration_only', 'self_escalating')) NOT VALID;

ALTER TABLE app.risk_signals
  VALIDATE CONSTRAINT risk_signals_reliability_known,
  VALIDATE CONSTRAINT risk_signals_category_known,
  VALIDATE CONSTRAINT risk_signals_escalation_known;

-- 4. The campaign read. `corroborate` counts *distinct* `actor_id` for one
--    `subject_id` and one `behaviour` inside a window, which is exactly this
--    index. It is not part of `risk_signals_ordered`
--    (`subject_id, occurred_at, detector, seq`), which serves the ledger replay
--    in `compareSignals` order and would have to scan a subject's whole history
--    to answer "how many distinct accounts reported this one".
--
--    Partial on `actor_id IS NOT NULL` because the question is only meaningful
--    for a signal somebody else performed, and self-attributed rows — the
--    overwhelming majority — cannot contribute to it.
CREATE INDEX IF NOT EXISTS risk_signals_report_campaign
  ON app.risk_signals (subject_id, behaviour, occurred_at DESC)
  WHERE actor_id IS NOT NULL;