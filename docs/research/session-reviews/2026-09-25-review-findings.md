# Session review — review findings, and the loop that produced them

**Date:** 2026-09-25 · **Branch:** `fix/review-findings` → merged as #25 · **Issues:** #20–#24 closed, #26 opened for what is left

## 1. Evidence — what was actually run

| Check | Result |
|---|---|
| `make check` (8 CI steps) | 712 tests, 46 files, all passing; typecheck clean; doc links 320 resolved; stale-artefact and lockfile checks pass; CI/Makefile parity green |
| GitHub Actions on #25 | pass |
| Local infrastructure | Docker was available (OrbStack), so the compose file, healthcheck, named volume, non-default port and schema gate were exercised against a real database, not simulated |
| Dataset invariants | proven non-vacuous by tampering — six distinct mutations each produced a specific failure |

## 2. Findings — what the work got wrong

| What | How it surfaced | Disposition |
|---|---|---|
| `vitest.config.js` and three siblings sat at the repository root, and the loader prefers the `.js` over the `.ts` — the suite was reading a compiled copy of its own configuration | `check-stale-artifacts.mjs`, on its first run | **Check.** The script stays and runs in CI. |
| The CI test-typecheck loop could never fail: without `set -e` the step's exit status is the last `echo`, so a failing package was masked by a later one that compiled | An agent hit it for real, mid-flight | **Check.** `set -euo pipefail`, and the Makefile equivalent already had it. |
| `git add -A` while four agents were writing swept half-finished files into a commit | An agent noticed its own files committed stale | **Skill.** Staging rule added to `AGENTS.md`; the sharper version is in `tool-craft` §4. |
| An agent reported writing a 68 KB research file that never existed; another returned a document as prose because it had no write tool | The first only surfaced because `git add -A` did not stage it | **Check.** `check-agent-claims.mjs` verifies file, symbol and command claims; tested in both directions. |
| Two new checks had false positives on first run — one flagged untracked build metadata, the other reported a workspace package missing because it checked dependencies before collecting all names | Both, immediately | **Test.** Rewritten; the second one's bug was iteration order, which is a class of bug the parity check does not catch. |
| The dating agent's scoped test run passed while its test *typecheck* was broken by its own module split | `make check`, after the agents reported success | **Check.** The scoped-run instruction was the problem; the full suite is the gate. |
| Anchored `edit` calls corrupted files repeatedly — clobbering imports, overwriting a signature, deleting a neighbour | Roughly a dozen turns, plus one full-file rewrite | **Skill.** `tool-craft` §1. Switching to whole-file `write` is named as the correct recovery, not a defeat. |

## 3. Assumptions — what I believed without checking

- **Six domain agents' self-reports.** Re-ran every package. The claims held on substance, but two agents had left a test-typecheck broken while reporting green, so the reports were accurate about what they ran and silent about what they did not.
- **The trust-safety and workflow research.** 121 and 107 source URLs. Spot-checked citation shape and claim-tagging, not every claim. One IC3 figure that changes sizing materially should be re-verified before it reaches a funding document.
- **Two agents pushing back on the review.** I checked both arguments and conceded on both — C-14 (the spec was right, `resolveMatch` tested for a pass's *existence* rather than whether one was *in effect*) and C-36 (document precedence is not a product argument). A pushback is a claim too, but a falsifiable one, and it was worth more than the review's authority.

## 4. Divergence in parallel work

- **Profile vs. privacy settings** disagreed on `display_name`/`bio` defaults and on `occupation`/`education`. Resolved by the two agents directly.
- **Discovery spec vs. `packages/dating`** diverged on `match.ended` reasons and invented like states. The spec was reconciled to the code — correctly, until the review showed the code was itself wrong about supersession.
- **Notification copy across three agents.** The moderation agent needed a case reference on enforcement notices; the platform agent owned the copy. They coordinated, and the platform agent then **argued me out of my own position on email** with a better reason than I had — a banned user who cannot log in has only the email. I conceded; the reasoning is recorded in the issue thread.
- **The review's authority was itself contested twice.** Both times correctly.

## 5. House rules

Two slips caught and fixed at source: a `Set` used for a static dedup in the kernel, and a `PUT` that replaced a line it should have inserted alongside. The second is the exact failure `tool-craft` §1 now documents, written after it happened rather than before.

## 6. What must not be lost

- **`packages/integration` is the only place a cross-domain claim can be proven.** Four of the safety holes were invisible to every owning package's tests.
- **`assertMachineIsTotal` ignores guards deliberately.** A guard is a runtime gate, not a structural edge; treating it as one made every guarded machine look terminal.
- **The event `sensitivity` gate drops an event a consumer is not cleared for** rather than filtering it after delivery. Filtering would let a consumer read what it may not hold.
- **Filtering lives at the sink, not at call sites**, so it fails toward under-exposure.

## 7. Turn each lesson into a durable change

| Lesson | Disposition | Where |
|---|---|---|
| Compiled output beside source | Check | `check-stale-artifacts.mjs`, in CI |
| Lockfile drift | Check | `check-workspace-lockfile.mjs`, in CI |
| A CI step that cannot fail | Check | `set -euo pipefail` + parity check |
| An agent's report is a hypothesis | Check | `check-agent-claims.mjs` |
| Anchored edits corrupt files | Skill | `tool-craft` §1 |
| Parallel agents need file ownership | Skill | `tool-craft` §3, `AGENTS.md` |
| Staging wholesale mid-flight | Skill | `tool-craft` §4 |
| A session review must change something | Skill | `session-review` §7, written last |
| Wrong API shapes, twice | Nothing | The compiler caught both |

Two of these became scripts *because the research said notes cannot fail*. A lesson that is neither enforceable nor checked is a note nobody opens.

## 8. Memory hygiene

- The two research documents proposed nine changes. Six were implemented, and the parity check rejected one until it was done properly — which is the intended behaviour.
- Three proposals were declined: a separate `dispatch-parallel-agents` skill (its content is in `tool-craft` §3), a memory index file (the lessons are in the skills where they are consulted), and a second cross-reference table for doc/code divergence (a single reconciled source beats three compatible documents).
- **Two findings are deliberately not closed** and are now #26: the trust-safety observation reduction seam, and symmetric messaging refusal. Both need a decision, not a patch, and both are real.

## 9. Next session

1. **#26** — decide whether a reduction layer is built or the observation vocabulary shrinks, and whether the counterpart's standing may reach communication. Both are contract decisions with privacy consequences, which is why they were not decided in passing.
2. **Re-verify the research citations that change a design or a procurement decision** — particularly the Entrust retention policy and the Australian age-assurance statute.
3. **Issue #1 is still open.** The domain contracts are executable and now reconciled with their specifications; the service, clients and database are not built. The local infrastructure is the first thing that makes building one possible.
4. **Reduce the integration-owner surface.** I own `packages/core`, `packages/integration`, the root config and the CI workflow, which is a single point of contention by design. The Makefile and `scripts/dev/` are now large enough to belong to a package of their own.
