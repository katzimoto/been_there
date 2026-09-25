# Session review — architecture baseline and domain contracts

**Date:** 2026-09-25 · **Branch:** `feat/architecture-baseline` · **PR:** #19

## 1. Evidence — what was actually run

| Check | Result |
|---|---|
| `npx tsc --build` | clean, 7 package projects |
| `npx vitest run` | 613 tests, 45 files, all passing |
| `npx tsc -p packages/*/test/tsconfig.json` | clean |
| `node scripts/check-doc-links.mjs` | 58 files, 300 relative links resolved |
| GitHub Actions on the PR | `npm ci`, solution typecheck, per-package test typecheck, vitest, doc links |

CI earned its place on the first run: it failed on `npm ci` because the lockfile
predated `packages/integration`. Every local run had been passing because the
lockfile had been generated before that package existed.

## 2. Findings — what the work got wrong

| What | How it surfaced | Check that would have caught it sooner |
|---|---|---|
| `defineStateMachine` used `find`, so a guarded general row shadowed a specific row and the `high → critical` escalation silently returned `high` | Independent reviewer, with a runnable reproduction | The test I wrote asserted the *intended* behaviour only after the fact; a test that enumerates `legalEvents` for duplicates catches shadowing generically |
| Moderation's authority gate checked for a non-null actor id, not for a human — a service holding a moderator-shaped id could suspend or ban | Cross-domain integration suite | A composition test per commitment; no single package's unit tests could see it |
| A restriction could strip `report` and `block` and publish the stripped set on a `public` event | Independent reviewer | Assert the unrestrictable floor in `capabilitiesFor` as well as at the intake valve |
| Any user could demand another user's re-verification, pulling a named victim out of discovery | Independent reviewer | Compare the requester against the subject as a first-class rule, not an implied one |
| `lift_restriction` required no moderator, so automation could reverse a human sanction | Independent reviewer | The `accountMachine` table was reviewed for symmetry, not for reversals |
| Nine of moderation's sixteen audit actions threw when appended to the platform sink; the router dropped every moderation event silently | Independent reviewer | Drive contract tests from the *other* package's union rather than a restated list |
| **`tsc` emitted compiled `.js` into `packages/core/src`, it was committed, and vitest resolved `../src/index.js` to the stale file** | A fix agent, mid-task, noticing a guard "read as absent" | `.gitignore` the artefact paths, and delete them in a clean clone before trusting a green run |
| A research agent reported writing a 68 KB file that was never created | `git add -A` did not stage it | Re-run what an agent claims to have delivered, at least the headline |
| A scout agent had no write tool and returned its document in its report instead of writing it | Its own explicit blocker report | Check the file exists before believing any agent delivery claim |

The stale-artefact defect is the most consequential finding of the session,
because it silently invalidates verification: a suite that runs compiled code
from an earlier build is green while the source it is supposed to be testing has
moved on. It also explains why two of the four safety holes read as "already
fixed" when they were not.

## 3. Assumptions taken on trust

- **Six domain agents' self-reports.** Re-ran each package's typecheck and tests
  independently before committing. All claims held up; the failures found later
  were in code the agents had verified correctly but whose *composition* nobody
  had checked.
- **The trust-safety and agent-workflow research.** 121 and 107 source URLs
  respectively; spot-checked the citation shape and the claim-tagging rather than
  every claim. The workflow-research document was delivered as agent output and
  written by hand, so its retrieval claims have not been independently
  re-verified.
- **A dated IC3 figure** (confidence/romance losses for 2025) that changes sizing
  materially. Worth re-checking before it is quoted in a funding or planning
  context, since annual reports are revised.

## 4. Divergence in parallel work

- **Profile vs. privacy settings** disagreed on whether `display_name` and `bio`
  are public by default, and on whether `occupation`/`education` are v0.1 fields.
  Resolved by the two agents directly over IRC: both documents now carry the
  same decision, and the ownership split (#10 owns the inventory and the maximum
  visibility, #17 owns the per-account default) is written down.
- **Discovery/matching spec vs. `packages/dating`** diverged on `match.ended`
  reason values and on invented `like` states. The spec agent reconciled the
  document to the implemented contract, which is the correct direction: the code
  is the contract.
- **Review findings were cross-cutting by design** — they exist because
  documents and code were written in parallel without sight of each other. That
  is the cost of the fan-out, paid once.

## 5. House rules

Enforced in the briefs and checked in review: no one-line wrapper functions, no
`Map`/`Set` for static string lookups, no `any` at a boundary, no stubs or
TODOs, files under 500 lines. Two slips were caught and corrected during the
session — a `Set` used for a static dedup in the kernel, and a `Date.now()`-free
`from` clause — both fixed at the source rather than in review comments.

## 6. What must not be lost

- `packages/integration` is the only place more than one domain package is
  imported, and it is the only place a cross-domain claim can be proven. Three
  of the four safety holes were invisible to every package's own tests.
- `assertMachineIsTotal` ignoring guards is deliberate and was a bug once. A
  guard is a runtime gate, not a structural edge; treating it as one made every
  guarded machine look terminal.
- The event `sensitivity` gate drops an event a consumer is not cleared for
  rather than filtering it after delivery. Filtering would let a consumer read
  what it may not hold.
- `data-sensitivity` filtering lives at the sink, not at call sites, so it fails
  toward under-exposure.

## 7. Next session

1. **`defineStateMachine` should throw on an exact-duplicate `(event, from)`
   pair.** Shadowing should be impossible rather than detectable. Currently a
   test catches it, which is weaker.
2. **Resolve the 30 Major doc/code divergences** in
   `docs/architecture/review-findings.md` §4. The largest is that 35 of 55
   declared analytics events do not exist. Pick one: implement them, or stop
   declaring them.
3. **Trust-safety's observation vocabulary has no producer** (finding B-5).
   Either something emits observations, or the ten `ObservationKind`s are
   speculative and should shrink.
4. **Re-verify the trust-safety research citations** that changed a design
   decision, particularly the Entrust retention policy and the Australian
   age-assurance statute, before either is used to make a procurement or
   compliance commitment.
5. **Issue #1 stays open.** No service, no clients, no database. The domain
   contracts are executable; the application is not built.
