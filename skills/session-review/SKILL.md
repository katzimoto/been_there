---
name: session-review
description: Run a structured review at the end of a working session to capture what was verified, what was assumed, what broke, and what to do differently. Use when a session's work is committed and verified, before reporting completion or starting the next session.
---

# Session review

Run this at the end of every working session. Its purpose is to leave the next
session a truthful starting point rather than an optimistic one.

## 1. Evidence — what did I actually run?

List the verification commands and their real result. Not "tests pass" — the
command and the count.

```bash
git log --stat -1
npx tsc --build && npx vitest run
```

Anything shipped without an observed run is unverified, and must be labelled so.

## 2. Findings — what did the work get wrong?

The valuable part. For each defect, record:

- **What it was** — a wrong API guess, a stale build, a loose assertion, a real
  hole in an invariant.
- **How it surfaced** — a failing test, a compile error, an agent report, or a
  human noticing.
- **Which check would have caught it earlier** — this is the transferable part.

Then ask: of the things that went wrong, how many were caught by verification
and how many by luck? That ratio is the session's real quality signal, and it is
what tells you where to add checks next.

## 3. Assumptions — what did I believe without checking?

List every claim taken on trust, and mark which were verified since. Common ones
in this repository: an agent's self-report ("tests pass"), a document's claim
that a design is enforced, a capability value copied from a spec.

**Agent reports are not evidence.** Re-run what a subagent claims to have
delivered, at least the headline number.

## 4. Divergence — where did parallel work disagree?

When several agents or a spec and its implementation touched the same contract,
list every mismatch found and how it was resolved, and who owned the decision.
Unresolved cross-document conflicts belong in the docs as open questions, not in
a comment thread that will be lost.

## 5. House rules — did anything slip?

Check the conventions in `AGENTS.md` and the reviewer's house rules against the
diff. Common slips: one-line wrapper functions, `Map`/`Set` for static string
lookups, `any` at a boundary, stubs or TODOs left in, files over 500 lines,
fences or internal links left broken.

## 6. Next session

Finish with the concrete next actions in priority order, and the single most
important open question. If the session's work left a system in a state you
would not want to find later, say that plainly in the first line.

## Output

Write the review to `docs/research/session-reviews/<yyyy-mm-dd>-<slug>.md` when
the session changed a design or fixed a real defect — those accumulate into
institutional memory. For routine sessions, keep it in the commit message and
the PR description.
