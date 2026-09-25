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

## 7. Turn each lesson into a durable change

A review that only writes a document has not changed anything. Every entry in
§2 must end in one of four dispositions, and an entry with none of them is not
finished:

| Disposition | Use when | Example from a real session |
|---|---|---|
| **A test** | The failure was a behaviour the code should have had | A commitment was unenforced → a test that fails if the guard is removed |
| **A check** | The failure was a mistake, and a mechanical gate catches it | A lockfile drifted from `package.json` → CI runs `npm ci` |
| **A skill** | The failure was a repeated procedural mistake | Anchored edits corrupted files → `tool-craft` §1 |
| **Nothing** | It was a one-off | A wrong API shape guessed once and caught by the compiler |

Be honest about which. A lesson recorded as a skill when a test would have
prevented it is a lesson that will be read once and then ignored, because a note
cannot fail. Conversely, a test for something that only ever happened once is
noise.

The test for a lesson worth keeping: **would following it have prevented the
defect, and would a violation be visible?** A lesson that is neither enforceable
nor checked is a note in a file nobody opens — write it down, but do not pretend
it is a practice.

## 8. Memory hygiene

Skills and research documents accumulate. Once a quarter, or whenever a document
contradicts the code:

- **Delete a lesson that is no longer true.** A stale rule is worse than a
  missing one, because it is followed confidently.
- **Resolve a contradiction in the file that owns the rule**, not in the one
  that noticed it.
- **Move a lesson from a skill to a test** the moment it becomes mechanically
  checkable. The skill keeps the reasoning; the test keeps the guarantee.
- **Prefer one document that is right over three that are compatible.** The
  review of this repository found specs written in parallel disagreeing with
  their own code; the fix is a single reconciled source, not a cross-reference

## Output

Write the review to `docs/research/session-reviews/<yyyy-mm-dd>-<slug>.md` when
the session changed a design or fixed a real defect — those accumulate into
institutional memory. For routine sessions, keep it in the commit message and
the PR description.

Then do §7 before finishing. A review with no durable change is a review that
will be read once and repeated.
