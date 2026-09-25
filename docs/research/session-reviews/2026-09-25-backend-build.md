# Session review — the v0.1 backend build

**Date:** 2026-09-25 · **Branch:** `build/service` · **Issues:** #33 in progress, #46 filed, #44/#45 awaiting a decision

## 1. Evidence — what was actually run

| Check | Result |
|---|---|
| `npx tsc --build` | Clean for the whole graph except one file owned by the OpenTelemetry agent |
| `npx vitest run` | 868 tests, 58 files; 6 failures, all in agents' in-flight files |
| `npx vitest run packages/database` | 97 tests, 6 suites, **none skipped**, three consecutive runs |
| Migrations | 002 applied to live Postgres; idempotent on re-run; verified from a dropped schema |
| `npx tsc -p packages/database/test/tsconfig.json` | Clean once every agent aligned |

## 2. Findings — what got wrong, and what it cost

| What | How it surfaced | Disposition |
|---|---|---|
| **`likes_live_pair` indexed the *unordered* pair**, so `A→B` and `B→A` collided. A match is exactly two reciprocal live likes, so the second like of every pair was unrepresentable and the entire matching flow was unreachable. | The service agent, trying to use the schema | **Test.** Both reciprocal likes must write; a duplicate in the *same* direction must fail |
| **`createTransaction` lost `const client = await pool.connect()`** in an earlier edit, so every transaction threw | An agent mid-task | **Check.** The type was still valid, so only running it caught it |
| **A nested `tx.run(...)` was `async () => undefined as never`** — it silently did nothing | The risk agent, who wrote the test and deleted it rather than pin behaviour I did not want | **Test.** Restored, plus a commit-side twin: "writes nothing" and "writes outside the outer transaction" are different bugs |
| **`blocks_pair` was unconditional**, so a released block could never be re-created | The interaction agent | **Test.** Partial index |
| **Nine schema tests silently skipped themselves** — the suite read `process.env.DATABASE_URL` before anything had exported it | The conversation agent, noticing the skip count | **Test.** Resolve the environment *before* deciding to skip |
| **`IdentityStore.insert` writes the state column directly**, while the port's comment claimed no such write existed | The users/identity agent | **Issue #46**, owned by the service |
| **My `messages.state` and `risk_signals.seq` were reported as missing by two agents** whose reports predated the migration | Their stale reads | **Message.** Told them the columns exist and to use them |
| A hardcoded `match:x|y` in my own test made a second run fail against its own leftover row | Running the suite twice | **Test.** Derive the id the way the domain does |

## 3. The lesson worth generalising

**Resolve the environment before deciding whether to skip; never after.**

Several agents had already written correct `.env` loading. Mine was also "loading `.env`" in spirit and still wrong, because it read `process.env.DATABASE_URL` and branched on `describe.skip` in the same top-of-file expression — so the branch was taken before anything could populate the variable.

A skip decision taken against an unassembled environment usually lands on "skip", and **a skipped suite is indistinguishable from a passing one in the output.** That is the whole class: it is the same shape as a suite running stale compiled code, and the same as the check that looks like it is doing its job.

## 4. What the parallel work actually bought

Eleven agents, disjoint files, one integration owner. Findings that only existed because the work was split:

- The **like-index defect** was found by an agent *using* the schema, not reading it. It made the product's central flow unreachable and no amount of reading would have surfaced it.
- The **audit idempotence key** was overruled by the agent implementing it. My first instinct was `(entity, action, actor)`; theirs was a caller-supplied `dedupe_key`, because no set of columns describing *what happened* can separate a retry from a genuine repeat — `evidence.read` legitimately repeats twice for a real moderator. Their reasoning was better than mine and became the design.
- The **`NULL` expectedGeneration trick** — one statement covering both the insert and update paths, with no branch to forget — replaced the conditional I would have written.
- The **match-id guessability** finding: once `match_id` became `match:{a}|{b}`, it was *more* derivable than a uuid, so `findByMatch` had to be participant-scoped. That was a consequence of my own type change, which is exactly what a port change should be checked for.

## 5. Process mistakes I made

- **`git add -A` while agents were writing** swept half-finished files into a commit in the previous session. Repeated here, and only caught because an agent reported its own files were stale.
- **Broadcasting to all eight agents** when three of the six items concerned three of them. One agent correctly told me none of it applied to its package, which is the right response and a reminder that addressing is part of the work.
- **Anchored edits corrupted files four times** in this session, each time silently clobbering adjacent code. This is now a measured fact rather than a hunch, and `skills/tool-craft` §1 says so.
- **Two agents were blocked by my botched edit** to `contracts` before they could start. They reported rather than working around it, which is the behaviour the working agreement asks for and the reason it cost minutes rather than an hour.

## 6. What must not be lost

- **`Transaction.client` and one `clientOf`.** Five stores each inventing a resolver is five places for the same mistake, and a store that opens its own transaction breaks atomicity *across* stores in a way nothing catches until production while looking identical in the type.
- **The one-bit `peerStanding` projection.** A capability set would let the transport distinguish a banned peer from a limited one — the profile-reachability leak arriving through a different door.
- **The canonical pair key**, defined once and backing four unique indexes. Two implementations of "sort a pair" is how a database ends up with two rows for one relationship.
- **The risk assessment's `NULL` insert semantics**, which make a racing writer's row survive rather than be clobbered.

## 7. Next

1. Wire `createStores(pool)` once the last two stores land, then the service's end-to-end test.
2. **#46** — the service must be the only writer of identity state, and the write must take the *machine's output* rather than a string, so skipping the machine is a signature change rather than a different value.
3. **#44** and **#45** still need a human decision. Both are product and privacy calls, not tuning.
4. Xcode, for the iOS half of #32–#43.
