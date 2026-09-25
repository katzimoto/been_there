# ADR 0004 — Automation never enforces

**Status:** accepted · **Issue:** [#6](https://github.com/katzimoto/been_there/issues/6), [#7](https://github.com/katzimoto/been_there/issues/7)

## Context

Issue #1 requires both of these at once:

- Scenario 5: "suspicious repeated behavior can trigger **restrictions before many
  manual reports**" — i.e. proactive, automated action.
- Scenario 6: "enforcement state is reviewable and is **not an irreversible
  automated black box**".

Those pull in opposite directions unless the split is drawn in the wrong place. The
resolution is that **risk and enforcement are different acts**, not that
automation is allowed or banned.

## Decision

- **Detection** is automated. Detectors observe behaviour and emit signals.
- **Risk state** is automated. Signals, corroboration and decay move a subject
  between `normal`/`elevated`/`high`/`critical`.
- **Enforcement** is human. Restriction, suspension and ban require a `Case` and
  a named moderator. The `accountMachine` transition table rejects every
  enforcement event without a `caseId`; suspend and ban also require a
  `moderatorId`.
- **What is automated and immediate** is the *capability* response to a risk
  state, and only reversible ones: re-verification prompts, and rate limits.
  Neither is an enforcement action and neither is irreversible.

## Consequences

- We satisfy scenario 5 proactively: a high-risk account gets friction and a
  human review *before* users report it, which is the primary safety metric in
  issue #1.
- We satisfy scenario 6: no automated path can end a user's access, and every
  enforcement is attributable and reversible.
- Moderation queue volume is a real cost. Bounded by detector precision, and by
  requiring corroboration (two independent detectors) for `critical`.
- The `suspended` state cannot be reached by any automated path at all, which is
  intentional: suspension is a human judgement.

## Revisit when

Never, for irreversible actions. Revisit only the *rate* of automated reversible
friction.
