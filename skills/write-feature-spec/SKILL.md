---
name: write-feature-spec
description: Write or revise a user-facing feature specification in docs/features/, in the house format, reconciled against the domain code it specifies against. Use for any MVP feature issue (#9-#18) or when a spec and its implementing package have drifted apart.
---

# Writing a feature specification

Feature specs live in `docs/features/`, one per MVP feature issue. They specify
**product behaviour**; `docs/architecture/` and `packages/` specify the domain
contracts. A spec may reference a contract but never restates it.

## Required structure

1. **Header** — issue link, parent (#1), related architecture issues, and a
   pointer to `docs/architecture/00-overview.md` stating the overview wins on
   any disagreement.
2. **Goal and done-when** — quote the issue's own Done-when criterion and state
   the properties that make it true.
3. **Scope** — in scope, and explicitly out of scope with the reason (usually
   "issue #1 lists this as P1").
4. **Boundaries** — a table of what this feature reads and writes, and which
   domain owns each piece of state. Name the read-model projections you depend
   on; if one does not exist yet, say so rather than inventing it.
5. **The specification itself** — the states, the rules, the order of checks.
6. **Copy catalogue** — every user-facing string, with the next step offered.
   No dead ends, no accusatory language, and never a disclosure of internal
   risk or enforcement reasoning.
7. **Acceptance scenarios** — given/when/then, mapped to the numbered acceptance
   scenarios in issue #1.
8. **Open questions** — recorded, not guessed in the body.

## Rules that get violated most

- **Eligibility and permission rules are ordered lists, and the order is the
  specification.** "Verification is checked first and unconditionally" is a rule;
  "eligibility is enforced" is not.
- **Never invent a state, event name, or reason value.** If the domain code
  defines `MatchStatus = 'active' | 'unmatched' | 'ended_by_block'`, the spec
  uses those three values. Check the source before writing the table, and
  re-check after any change — specs written in parallel with code drift.
- **No artificial limits.** Issue #1 forbids global/daily match caps. Rate
  limits for abuse are permitted; the separating test is that a rate limit
  bounds how fast a user acts and expires, while a cap bounds what a user
  achieves and never expires.
- **Safety and account-state notifications are not user-suppressible.** A
  setting that could hide them is a setting that would hide a suspension from
  the person suspended.
- **State the invariants by name** (e.g. "at most one match per episode,
  exactly one when reciprocal") and say what guarantees them.

## Reconciling a spec with its code

When a domain package lands, grep the spec against the implementation before
considering it done:

```bash
rg "state|reason|event" docs/features/<file>.md
rg "^export (const|type|function)" packages/<domain>/src/
```

Every event name, payload field, state value, and reason code in the spec must
exist in the package. When they disagree, **fix the spec to match the code** —
the code is the contract — and say so in the commit.

## Read the sibling specs

Adjacent features share copy and state. `messaging-experience.md`,
`user-safety-controls.md` and `account-restrictions-and-reverification.md` each
own part of the same user journey, and `account-and-onboarding.md` owns
deletion and recovery. Duplicate a string across documents and one of them will
drift; assign each string one owner and cross-reference it.
