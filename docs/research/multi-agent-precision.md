# Multi-Agent Precision — how to partition work, brief a fresh agent, and find out whether a subagent actually did what it said

> Companion to [`agent-workflow-research.md`](./agent-workflow-research.md). That document covers
> multi-agent orchestration at the level of *when to fan out and why*. This one goes one level
> down: how teams are partitioned so they do not corrupt each other's work, what a briefing to an
> agent with no conversation history must contain, and how to find out whether a subagent's report
> matches reality. Post-mortems are the primary evidence; generalities are secondary.
>
> All URLs retrieved **2026-09-25**. Tags: **[P]** primary — peer-reviewed, preprint, spec, or
> first-party engineering documentation; **[V]** vendor claim — a vendor's own measurement, not
> independently replicated; **[S]** secondary — practitioner blog or commentary, a signal not a
> result; **[?]** thin, contested, or unverifiable.

## Method note

The built-in `web_search` tool is unusable here — it was tried once and returned
`Path 'multi-agent LLM system postmortem parallel agents write conflicts' not found`, consistent
with the blocked-egress finding recorded in
[`agent-workflow-research.md`](./agent-workflow-research.md). All research below was done by
reading these endpoints directly, which do work:

- Hacker News via Algolia: `https://hn.algolia.com/api/v1/search?query=...&tags=story`
- arXiv API: `https://export.arxiv.org/api/query?search_query=ti:"..."&max_results=5`
- Vendor and practitioner URLs read directly.

One arXiv identifier was wrong on first attempt — `2503.13623` and `2502.08296` turned out to be
an LDA paper and a game-theory paper respectively, not the multi-agent papers recalled. Both were
re-resolved by title search and are cited here at their correct IDs
([2503.13657](https://arxiv.org/abs/2503.13657) **[P]**,
[2512.08296](https://arxiv.org/abs/2512.08296) **[P]**). Recorded rather than hidden, because
citing a remembered arXiv ID is exactly the habit this document is about.

---

## TL;DR — ranked by expected value for this repository

1. **One writer per file, decided before dispatch, not during. [E] strong. Cost: low.** Every
   independent source converges here and the strongest of them is measured. Cursor's old swarm had
   one file collect **7,771 merge conflicts touched by 1,173 different agents**; the redesigned swarm
   had **47** in its most contested file
   ([cursor.com/blog/agent-swarm-model-economics](https://cursor.com/blog/agent-swarm-model-economics)
   **[V]**). Zach Wills states the rule operationally: "Give every file one writer… If two pieces
   genuinely need the same file, they were never independent; run them in sequence"
   ([zachwills.net](https://zachwills.net/how-to-use-claude-code-subagents-to-parallelize-development/)
   **[S]**). Claude Code's own docs say the same
   ([code.claude.com/docs/en/agent-teams](https://code.claude.com/docs/en/agent-teams) **[P]**).
2. **An agent report is a hypothesis, not evidence — and it is a *hard* hypothesis to check by
   reading. [E] strong. Cost: low.** The best method in the literature identifies the
   *responsible agent* in a failed multi-agent run 53.5% of the time and the *responsible step*
   only 14.2%, with some methods below random ([Who&When, arXiv 2505.00212](https://arxiv.org/abs/2505.00212)
   **[P]**). Frontier reasoning models sit below 10%
   ([AgenTracer, arXiv 2509.03312](https://arxiv.org/abs/2509.03312) **[P]**). You cannot verify a
   subagent by asking a model. You verify it by re-running a mechanical check.
3. **Reserve shared counters and shared files before dispatch. [E] moderate. Cost: near zero.**
   Zach Wills lost real work to exactly this: "two of my lanes once claimed the same ADR numbers
   and needed an explicit renumber commit to untangle. Reserve shared counters and shared files
   before dispatch, not after the collision" **[S]**. This repository allocates ADR numbers — the
   collision is not hypothetical here.
4. **Partition investigation, serialize mutation. [E] strong. Cost: zero.** Kim et al. measured
   relative change vs a single agent ranging from **+80.8% on decomposable financial reasoning to
   −70.0% on sequential planning**, and found that "architectures without centralized verification
   tend to propagate errors more than those with centralized coordination"
   ([arXiv 2512.08296](https://arxiv.org/abs/2512.08296) **[P]**). Anthropic independently: "most
   coding tasks involve fewer truly parallelizable tasks than research"
   ([anthropic.com](https://www.anthropic.com/engineering/multi-agent-research-system) **[V]**).
5. **Centralize the merge. Exactly one integration owner, one full check.**
   Anthropic's "subagent output to a filesystem to minimize the *game of telephone*" — subagents
   persist artifacts directly and pass lightweight references back to the lead **[V]**. Cursor routes
   merge conflicts to a neutral third-party agent with no stake in either side **[V]**. Zach Wills:
   "Isolation covers the way out. The way back in, everything merging into one main, is where
   parallel work actually breaks" **[S]**.
6. **State the deliverable's medium in the brief. [E] moderate. Cost: zero.** One of the six
   observed failures was a research agent with no write tool returning a whole document as prose.
   Nothing in the brief said the deliverable had to be a file. A briefing that omits the medium
   will get prose when the agent has no way to write.
7. **Health-check workers before handing them real work. [E] practitioner, unreplicated. Cost:
   ~one minute.** "Before handing out real work, ping each agent with 'Reply with exactly:
   MODEL_OK.' On an early fan-out run of mine, two of three pings came back empty"
   **[S]**. Silent dead sessions are otherwise indistinguishable from slow ones until hours later.
8. **Do not build a blackboard for a team of twenty in a small repository.** Blackboard
   architectures are a real and well-evidenced primitive for *heterogeneous* specialists that
   cannot be partitioned statically ([CSI, arXiv 2605.28334](https://arxiv.org/abs/2605.28334)
   **[P]**), but their measured wins are on tasks where decomposition is not known in advance. For
   a monorepo with a known package map, a checked-in ownership table is the cheaper primitive.
9. **Expect the review gate to become ritual. Plan against it. [E] emerging. Cost: design time.**
   The "responsibility vacuum" paper ([arXiv 2601.15059](https://arxiv.org/abs/2601.15059) **[P]**,
   position paper, not an experiment) argues that once agent generation throughput exceeds bounded
   human verification capacity, approval stops being a decision criterion and becomes a rubber
   stamp on proxy signals — and that adding more automation *widens* the gap by raising proxy
   signal density without raising human capacity. Treat as a warning about fan-out scale, not a
   result.

---

## 1. Work partitioning that avoids write conflicts

### What actually goes wrong, with numbers

Cursor is the only source found that publishes a controlled before/after of a multi-agent swarm
running the same task with the same models. They rebuilt SQLite in Rust from its 835-page
documentation and compared their old swarm to a redesigned one
([cursor.com/blog/agent-swarm-model-economics](https://cursor.com/blog/agent-swarm-model-economics)
**[V]**; the output is public at
[github.com/cursor/minisqlite](https://github.com/cursor/minisqlite), so the claims are checkable
rather than merely asserted **[P]** for the artefact, **[V]** for the measurements). Their named
failure modes:

| Failure mode | Their description | Fix they shipped |
|---|---|---|
| **Split-brain design** | "Two planners, unaware of each other, implement the same concept in different ways in different parts of the codebase." | Fixed by prompting: planners make design decisions themselves rather than delegating them, and no two delegated subtrees may decide the same question. |
| **Contention between planners** | "Two pictures of reality, and merge tooling can't fix a disagreement." | Agents record decisions in shared design docs; code depending on a decision carries a compile-checked reference back to its doc; a reconciler merges the docs and the references propagate the resolution. |
| **Merge conflicts** | Workers "are bad at this and, in practice, either overwrite the other change or abandon their own." | A neutral third-party agent resolves conflicts on behalf of all parties, "similar to the way merge queues work in engineering teams." |
| **Megafiles** | "Some files are particularly popular places for agents to work… choke everything. They're expensive to transport, diff, and merge." | Workers can flag a bloated file; the flag blocks new commits to it; an outside agent decomposes it. |
| **Ossification** | "Agents have learned, from working in existing codebases with humans in the loop, not to touch core code even when it needs to change." | License intentional breakage: a focused out-of-scope patch with a comment explaining why; the compiler carries it and each dependent agent reads the comment. |

The measured difference, old swarm vs new swarm, same models and same four-hour budget:

- Merge conflicts: old run accumulated **more than 70,000 before being paused**, accelerating rather
  than stabilizing; new run logged **fewer than 1,000 over its full four hours**.
- Hottest file: old **7,771 conflicts, touched by 1,173 different agents**; new **47**.
- Structure: old sprawled to **54 crates including three separate SQL packages**; new settled on
  **nine crates early and never added another**. This is the split-brain failure made visible in
  the directory listing.
- Size for the same result: **64,305 lines → 9,908** (Fable mix, both 100% of the suite);
  **19,013 lines at 97% → 4,645 at 100%** (Opus mix).
- The old run's apparent productivity was churn: **68,000 commits in its first two hours**, roughly
  70× the new run's pace. Cursor's own reading: "most of those commits were busywork (thrash,
  contention, churn)."

**The transferable rule:** conflict *count* is a better diagnostic of partitioning quality than
commit count or lines written. If two agents are writing the same file, everything else you measure
is noise.

### When fan-out helps and when it actively destroys value

**Task structure predicts the sign of the effect.** Kim et al. ran 260 configurations across six
agentic benchmarks, five architectures (Single, Independent, Centralized, Decentralized,
Hybrid), and three model families, standardizing tools, prompts, and compute
([arXiv 2512.08296](https://arxiv.org/abs/2512.08296) **[P]**):

- Relative change vs a single-agent baseline ranges from **+80.8% on decomposable financial
  reasoning to −70.0% on sequential planning**. "Architecture-task alignment determines
  collaborative success… mismatched coordination degrades the performance."
- Coordination "yields diminishing returns once single-agent baselines exceed certain
  performance."
- "Tool-heavy tasks appear to incur multi-agent overhead."
- Their predictive model identifies the best architecture for **87% of held-out configurations**.

**The deflationary result.** Xu et al. asked whether homogeneous multi-agent workflows — the kind
every vendor ships — can be simulated by one agent
([arXiv 2601.12307](https://arxiv.org/abs/2601.12307) **[P]**). Across seven benchmarks spanning
coding, math, QA, domain reasoning, and tool use: **a single agent reaches the performance of
homogeneous workflows**, with an efficiency advantage from KV-cache reuse, "and can even match the
performance of an automatically optimized heterogeneous workflow." Their qualifier is fair —
single-LLM methods *cannot* capture genuinely heterogeneous workflows, because KV caches do not
share across different LLMs. The operational reading for this repository: if your "parallel
agents" are all the same model with different prompts, a single long-context agent is a strong
baseline you have not measured against.

**The vendor's own statement, which matches Kim et al.** Anthropic's multi-agent Research system
outperformed single-agent Opus 4 by **90.2%** on their internal eval, at ~15× the tokens of a chat
turn, and they state plainly that "most coding tasks involve fewer truly parallelizable tasks than
research" and that "domains which require all agents to share the same context or involve many
dependencies between agents are not a good fit for multi-agent systems today"
([anthropic.com](https://www.anthropic.com/engineering/multi-agent-research-system) **[V]**). Note
what their 90.2% was measured on: breadth-first research queries, decomposed by information need.
Not code.

**The baseline nobody runs.** MAST measured a **41% to 86.7% failure rate** across seven
state-of-the-art open-source multi-agent systems, and notes their "performance gains on popular
benchmarks are often minimal" versus single-agent frameworks "or simple baselines like best-of-N
sampling" ([arXiv 2503.13657](https://arxiv.org/abs/2503.13657) **[P]**).

**Practical partition test for a coding monorepo.** Fan out on a slice of work when *all* of these
hold:

1. No two slices touch the same file — not even the same barrel, the same fixture, or the same
   `tsconfig.json`.
2. Each slice's acceptance criterion is a command that runs *without* the other slices present.
3. No slice needs a decision that another slice also needs.
4. The integration point — a single `tsc --build` plus a single `vitest run` — is owned by one
   agent, explicitly, not implicitly by whoever finishes first.

If (1) fails, serialize. If (2) fails, the slices are not independent; you are fanning out on a
fiction.

---

## 2. Ownership models and integration ownership

### Four ownership models, and what each one is good for

| Model | Shape | Use when | Source |
|---|---|---|---|
| **Single writer per file** | Path ownership decided before dispatch; nobody else opens the file | Default for a codebase fan-out | Zach Wills **[S]**; Claude Code docs **[P]** |
| **Worktree isolation** | Each writer gets an OS-level sandbox; the harness verifies containment | Long-lived parallel workstreams, hours to days | Claude Code docs **[P]** |
| **Neutral resolver** | A third party with no stake resolves collisions, like a merge queue | Wide fan-out over a shared tree | Cursor **[V]** |
| **Read-only investigator** | The agent can `read`/`grep`/`glob` and cannot mutate | Blast-radius mapping before anyone writes | Claude Code's built-in `Explore` and `Plan` agents deny Write and Edit **[P]** |

**Worktree isolation is the harness solving the conflicting-write problem with an OS fence rather
than a convention.** Claude Code's `isolation: worktree` is documented to: run Bash and PowerShell
inside the worktree; **fail with an error** if a command's working directory resolves to the main
checkout; block a command that redirects git into the main checkout; and **refuse a command when it
cannot verify from the command text that any git the command runs stays inside the worktree** — for
example when the command name is computed at runtime
([code.claude.com/docs/en/sub-agents](https://code.claude.com/docs/en/sub-agents) **[P]**). The
coverage was widened over time: as of v2.1.210 the check covers the whole repository containing the
launch directory, not just the launch directory itself, and the main checkout a linked worktree
branches from. This is the strongest available precedent for fencing writers, and it is worth
copying the *shape* of even if the harness is different: the check is on what the command
*resolves to*, not on what the prompt *says*.

The human-scale version of the same fence, from Zach Wills: "every worker gets its own git
worktree outside the repo directory, its own ports, its own database, and commits early inside that
isolation. Two agents sharing a checkout will flip branches and git-clean each other's untracked
files; that mistake has cost me hours of an agent's in-progress work, once, which was enough"
**[S]**.

### The read-only investigator is the cheapest failure prevention available

Claude Code ships `Explore` and `Plan` as read-only subagents with **Write and Edit explicitly
denied**, and they "skip your CLAUDE.md files and the git status snapshot to keep research fast and
inexpensive" **[P]**. This matters for this repository specifically: one of the six observed
failures was a research agent that could not write and returned its whole deliverable as prose
instead. A read-only investigator is a *role*, not a *fallback* — and its inability to write is
exactly what forces its output somewhere checkable.

### Integration ownership

**Own the merge in exactly one place.** Three independent sources converge:

- **Anthropic:** "Subagent output to a filesystem to minimize the 'game of telephone.' Direct
  subagent outputs can bypass the main coordinator… specialized agents can create outputs that
  persist independently. Subagents call tools to store their work in external systems, then pass
  lightweight references back to the coordinator. This prevents information loss during
  multi-stage processing" ([anthropic.com](https://www.anthropic.com/engineering/multi-agent-research-system)
  **[V]**). A file-boundary contract is the only coordination primitive an integration owner can
  actually check.
- **Cursor:** a neutral third-party agent resolves merge conflicts "on behalf of all parties. Its
  only goal is to be impartial and efficient, similar to the way merge queues work in engineering
  teams." **[V]**
- **Zach Wills:** "Isolation covers the way out. The way back in, everything merging into one main,
  is where parallel work actually breaks. Anything globally sequential is a merge hazard… Reserve
  shared counters and shared files before dispatch, not after the collision." His observed
  collision was two lanes claiming the same ADR numbers. **[S]**

**Shared counters and globally-sequential resources are the ones nobody lists in the brief.** In
this repository the shared counters are: ADR numbers (`docs/architecture/adr/` runs 0001–0005),
package names, domain event names, and capability names. Two agents inventing an event name, or
taking ADR 0006 each, produce a conflict that is invisible until integration and expensive to
untangle.

**Verify end state, not process.** Anthropic, on evaluating agents that mutate persistent state
across many turns: "We found success focusing on end-state evaluation rather than turn-by-turn
analysis… break it into discrete checkpoints where specific state changes should have occurred,
rather than attempting to validate every intermediate step" **[V]**. This is a narrow claim about
*process* evaluation; it is not a licence to skip verifying the end state, and §4 is about exactly
that.

**The scale warning.** At some point the integration owner is the bottleneck and the gate becomes
decorative. The responsibility-vacuum argument ([arXiv 2601.15059](https://arxiv.org/abs/2601.15059)
**[P]**, position paper): decisions execute through formally correct approval processes while "no
entity possesses both the authority to approve those decisions and the epistemic capacity to
meaningfully understand their basis." Past a throughput threshold, "verification ceases to function
as a decision criterion and is replaced by ritualized approval based on proxy signals," and the
"CI amplification dynamic" means more automated validation raises proxy signal density *without*
restoring human capacity. Their conclusion is that the fix is organizational — reassign
responsibility from individual decisions to batch or system-level ownership. For a small repository
the actionable reading is simpler: **keep the fan-out small enough that the integration owner can
actually read every diff.** At twenty workers, the honest default is one that does not launch.

---

## 3. Briefing an agent with no conversation history

### What a fresh agent actually receives

- **Subagents** receive "only this system prompt plus basic environment details like the working
  directory, **not** the Claude Code system prompt" **[P]**.
- **Teammates** load `CLAUDE.md`, MCP servers, and skills, "but they don't inherit the lead's
  conversation history" **[P]**.
- **Explore and Plan** additionally skip `CLAUDE.md` and the git status snapshot **[P]**.

So: the briefing *is* the context. There is no parent to ask.

### The minimum viable contract

Anthropic's four elements, from their own production system **[V]**: **an objective, an output
format, guidance on the tools and sources to use, and clear task boundaries.** Their failure when
these were missing is the best-documented briefing failure available:

> We started by allowing the lead agent to give simple, short instructions like 'research the
> semiconductor shortage,' but found these instructions often were vague enough that subagents
> misinterpreted the task or performed the exact same searches as other agents. For instance, one
> subagent explored the 2021 automotive chip crisis while 2 others duplicated work investigating
> current 2025 supply chains, without an effective division of labor.

That is the same failure as two agents editing one test file: **duplicated, non-divergent work
because nobody drew the boundary.** Their fix is a written contract per subagent, not a topic label.
They also encode effort scaling in the prompt itself: 1 agent and 3–10 tool calls for simple
fact-finding; 2–4 subagents at 10–15 calls each for comparisons; 10+ subagents with "clearly
divided responsibilities" for complex research.

### The five things a brief in this repository must contain that a topic label does not

1. **The deliverable's medium.** A file at a named repo-relative path, or prose, stated
   explicitly. A brief that does not say this gets prose when the agent has no write tool — which
   is one of this session's six failures. Claude Code's agent teams make the same point
   structurally: a teammate that fails notifies the lead with the error text, but a teammate that
   *succeeds* is believed **[P]** — which is failure #1 and #2 in one paragraph of vendor docs.
2. **The artifact to read first.** "A subagent given a role but nothing to read will invent its
   review, and it arrives fast. Every dispatch names its inputs: the diff, the file paths, the
   screenshots, the ticket" **[S]**. Ungrounded opinions arrive fast and cost a rerun.
3. **Outcomes, not steps.** "A subagent is a delegate, not a macro. If I were delegating to a
   senior engineer I would not dictate keystrokes, and the same rule holds here: state the
   outcome, the constraints, the anti-goals, and what proof to bring back. Then hold the line on the
   proof" **[S]**.
4. **The decisions already made, and what *not* to assume.** MAST's inter-agent misalignment
   category is 2.20% unexpected conversation resets, 6.80% proceeding with wrong assumptions
   instead of seeking clarification, 7.40% task derailment, 0.85% withholding crucial information,
   1.90% ignoring other agents' input, 13.2% reasoning/action mismatch **[P]**. The paper's
   diagnosis is "the collapse of *theory of mind*, where agents fail to accurately model other
   agents' informational needs," and it notes these errors occur even when agents speak plain
   natural language within one framework. The countermeasure is structural: say what you have
   already decided, and say what the agent must not assume.
5. **What to do when blocked, and what "done" looks like as a command.** Interactive agents may
   ask; unattended agents must decide and record. "Mine make the reasonable call and log it to an
   assumptions file the reviewer reads later. Interactive runs may ask; autonomous runs record"
   **[S]**. "Hold the line on the proof. A report that ends with test output, a screenshot path, or
   a written file is checkable; a summary alone is a vibe" **[S]**.

### Role specifications measurably matter

ChatDev asked for a Wordle game with "randomly select a new 5-letter word each day" and produced a
fixed word bank. The authors re-ran it with a *more* explicit prompt and got a fixed word bank plus
new errors, concluding "failures stem from the MAS's design for interpreting specifications."
Their intervention — improving agent role specifications alone, same user prompt, same model
(GPT-4o) — yielded **+9.4% task success** **[P]**. A separate intervention, adding a high-level
task-objective verification step, yielded **+15.6%** on ProgramDev **[P]**.

The lesson is not "write longer prompts." Both interventions are *structural* — define the role's
authority, and add a check that the objective was met — and both are modest. The paper's own
summary of the field is that these are first steps: "not all failure modes are resolved, and task
completion rates still remain low."

---

## 4. Detecting and recovering from subagent failure

This is the section the rest of the literature does not cover, and it is where this repository's
failures live.

### 4.1 Why "ask another model" does not work

Failure attribution — identifying *which* agent and *which* step caused a failure — is the exact
task of "ask a model to tell you what went wrong with a subagent's work." It has been benchmarked
properly, and the answer is discouraging:

| Result | Figure | Source |
|---|---|---|
| Best method, identifying the **responsible agent** | **53.5%** | [Who&When, arXiv 2505.00212](https://arxiv.org/abs/2505.00212) **[P]** |
| Best method, pinpointing the **responsible step** | **14.2%** | same **[P]** |
| Some published methods | **below random** | same **[P]** |
| SOTA reasoning models (o1, DeepSeek R1) | "fail to achieve practical usability" | same **[P]** |
| Current SOTA reasoning LLMs, broader setting | "accuracy generally below 10%" | [AgenTracer, arXiv 2509.03312](https://arxiv.org/abs/2509.03312) **[P]** |
| Attribution gain from **full execution traces** vs partial observation | **up to +76%** | [TraceElephant, arXiv 2604.22708](https://arxiv.org/abs/2604.22708) **[P]**, ACL 2026 |
| Best causal-inference method, step-level | up to 36.2%, and it lifted task success 22.4% | [arXiv 2509.08682](https://arxiv.org/abs/2509.08682) **[P]** |
| Best *trained* tracer (AgenTracer-8B) vs Gemini-2.5-Pro / Claude-4-Sonnet | up to +18.18%; delivers 4.8–14.2% gains back to MetaGPT and MaAS | [arXiv 2509.03312](https://arxiv.org/abs/2509.03312) **[P]** |

Two conclusions, both load-bearing:

1. **A subagent's own report is close to worthless as verification, and so is a reviewer's read of
   it.** Under 15% at step level, worse than 10% for the frontier models, is not a starting point
   for a review gate.
2. **What *does* work is mechanical end-state checking plus full traces.** TraceElephant's +76%
   is the strongest single number here: the fix for "we cannot tell what happened" is better
   observability, not a smarter judge.

The counterpoint that keeps this honest: MAST's LLM-as-a-Judge annotator reaches **94% accuracy
and Cohen's κ = 0.77** against human expert annotations when classifying *failure modes* over full
traces ([arXiv 2503.13657](https://arxiv.org/abs/2503.13657) **[P]**). There is no contradiction.
**Classifying a category of failure from a full trace is easy; attributing a specific missing file
to a specific agent is not.** Use a model for the former, a command for the latter.

### 4.2 What the failure distribution says

MAST's 14 failure modes over 1,642 traces, clustered into three categories, with the prevalence of
each **[P]**:

| Category | Mode | Prevalence |
|---|---|---|
| FC1 system design | FM-1.3 step repetition | 15.7% |
| FC1 | FM-1.5 not recognizing task completion | 12.4% |
| FC1 | FM-1.1 disobeying task requirements | 11.8% |
| FC1 | FM-1.4 context loss | 2.80% |
| FC1 | FM-1.2 disobeying role specification | 1.5% |
| FC2 inter-agent misalignment | FM-2.6 reasoning/action mismatch | 13.2% |
| FC2 | FM-2.3 task derailment | 7.40% |
| FC2 | FM-2.2 wrong assumptions instead of clarifying | 6.80% |
| FC2 | FM-2.1 conversation resets | 2.20% |
| FC2 | FM-2.5 ignoring other agents' input | 1.90% |
| FC2 | FM-2.4 withholding crucial information | 0.85% |
| FC3 task verification | FM-3.3 incorrect verification | 9.10% |
| FC3 | FM-3.2 no or incomplete verification | 8.20% |
| FC3 | FM-3.1 premature termination | 6.20% |

**FC3 — verification failures — total 23.5% of observed failures.** MAST's observation is that
systems with explicit verifiers "generally show fewer total failures," but: "the presence of a
verifier is not a silver bullet… many existing verifiers perform only superficial checks, despite
being prompted to perform thorough verification, such as checking if the code compiles or if there
are leftover TODO comments." Their worked example: a ChatDev-generated chess program "passes
superficial checks (e.g., code compilation) but contains runtime bugs because it fails to validate
against actual game rules."

This is precisely the failure mode of "the suite is green." A verifier that checks the thing it
was asked to check, rather than the thing that was promised, is the same error one level up.

### 4.3 Cheap red flags: does this report match reality?

Each row is a check a coordinator can run in seconds. Ordered by cost.

| Red flag | Cheap check | Fails on |
|---|---|---|
| **The claimed file does not exist** | `test -f <path>` or read it | The 68 KB phantom file. Also: the no-write-tool agent that returned prose. |
| **The claimed file exists but is empty, or a stub** | `wc -c <path>` | A subagent that created a placeholder and reported completion. |
| **`git status` shows nothing for a claimed creation** | `git status --porcelain` | A report describing work that was never staged or committed. |
| **The claimed change is not in the diff** | `git diff --stat`, look for the path | A subagent that edited, then something reverted it — the line-anchored-edit corruption pattern. |
| **The acceptance command was never run** | Ask for the command *and its output*, not "tests pass" | Anthropic: "Have Claude show evidence rather than asserting success" **[P]**. |
| **The proof artifact does not show the claimed region** | Open the screenshot; look for the section named | Zach Wills: his reviewer "caught that the screenshots offered as proof never showed the section the work claimed to fix" **[S]**. |
| **The same file is claimed by two agents** | Path intersection of the ownership table | Observed failure #4, and Cursor's megafile problem. |
| **The agent's own tests are its only evidence** | Run the check at a different layer | Zach Wills: "An implementation once passed all 41 of its own tests while rendering against real data showed two visual defects; a second agent doing review caught what the green checkmarks missed" **[S]**. |

### 4.4 Detecting a *dead* subagent before it costs hours

Dead sessions fail silently, which makes them indistinguishable from slow ones. The cheapest
detection found: **ping before dispatch, ping again when quiet.** "Before handing out real work,
ping each agent with 'Reply with exactly: MODEL_OK.'… two of three pings came back empty, and each
dead session cost about a minute to catch instead of surfacing hours later as mysterious zero
progress" **[S]**. Mid-run, a forced-choice ping — *researching, blocked, or about to edit?* —
separates a busy agent from a wedged one in seconds; a healthy agent answers instantly **[S]**.
Same source: roughly a third of workers in an early coordinator experiment needed an interrupt at
some point.

### 4.5 Recovery

**Restart rather than resume.** The reasoning is not "restarts are cleaner" but "resumed context
loses to fresh context." Zach Wills' inverted rule: what rots is context, not session length — "a
session that has been compacting its memory for hours slowly forgets the intent it started with, and
a resumed context loses to a fresh one… Fresh, self-contained briefs beat resumed contexts every
time I've tested the trade" **[S]**. The test he proposes is the useful part: **if this session
dies, does any work die with it?** If yes, the state is in the wrong place. State belongs in the
tracker, the worktree, and the brief.

**Route by failure type, not by retry.** Trpevski's recovery decision tree **[S]**: transient
(timeout, rate limit) → retry with backoff, escalating after two attempts; permission or capability
error → different agent; multi-step complexity → decompose; anything else → escalate. Two
structural rules matter more than the tree: **never hand off to an agent that already handled this
message** (loop prevention), and **cap handoffs at two**.

**Preserve failed traces, not just successful ones.** STAR found that "retaining unsuccessful traces
during training enlarges the support of the routing policy on error states, enabling recovery
transitions that success-only training cannot represent"
([arXiv 2605.10057](https://arxiv.org/abs/2605.10057) **[P]**). The harness-level version:
Anthropic added full production tracing and it "immediately revealed" failures they could not
otherwise see — users reported agents "not finding obvious information" and the cause was
invisible without traces **[V]**.

---

## 5. Coordination primitives, and how each one fails

### Blackboard — a shared substrate agents read and write

A central agent posts a request; autonomous subordinates, each owning a partition, **volunteer**
based on their capabilities. The stated advantage over master-slave: it removes the need for a
central coordinator to know each sub-agent's expertise or internal knowledge, which "is not
possible in large-scale settings where the main agent lacks full observability over sub-agents'
knowledge and competencies" ([arXiv 2510.01285](https://arxiv.org/abs/2510.01285) **[P]**;
13–57% relative end-to-end success improvement, up to 9% relative data-discovery F1 over the best
baseline).

| Variant | Result | Source |
|---|---|---|
| Blackboard for LLM MAS, selection by blackboard content, repeated until consensus | Competitive with SOTA static and dynamic MAS at lower token spend | [arXiv 2507.01701](https://arxiv.org/abs/2507.01701) **[P]** |
| CSI: five heterogeneous scaffolds over a shared blackboard, parallel, exchanging intermediate findings | 19/33 (57.6%) vs best single scaffold 15/33 (45.5%) — **+27% relative, 25% faster, comparable cost**; no single scaffold is best | [arXiv 2605.28334](https://arxiv.org/abs/2605.28334) **[P]** |
| MACOG: shared-blackboard + finite-state orchestrator, eight specialised agents, IaC | GPT-5 54.90 → 74.02 on IaC-Eval; constrained decoding and deploy feedback are critical in ablation | [arXiv 2510.03902](https://arxiv.org/abs/2510.03902) **[P]** |
| MACC: blackboard + incentives for transparency and reproducibility | "Parallel exploration alone is insufficient for achieving reliable scientific inquiry" | [arXiv 2603.03780](https://arxiv.org/abs/2603.03780) **[P]**, AAMAS 2026 |
| STAR: extract–compute–deposit, agents deposit intermediate results on a shared blackboard for downstream fusion | Typed failure-aware routing, not specialist composition, drives the gain | [arXiv 2605.10057](https://arxiv.org/abs/2605.10057) **[P]** |

**How a blackboard fails.** Terrarium repurposes the blackboard as a security testbed and
identifies the attack vectors directly: **misalignment, malicious agents, compromised
communication, and data poisoning** ([arXiv 2510.14312](https://arxiv.org/abs/2510.14312) **[P]**).
Every one of those is a way the shared surface can be wrong in a way no participant is watching.
The practical read: a blackboard is a *trust* decision, not a *convenience* one. Anything written to
it is read by agents that will act on it.

**The cheaper cousin: stigmergy.** Cursor's version is a folder the agents own, whose `index.md` is
"automatically injected into every agent at start," constrained only by a line budget. Their
framing: "model weights are frozen, so it's precisely surprise encounters that are worth capturing
so the next agent trajectory is shorter" **[V]**. They also note retrospectively that earlier
"keep notes" and "document decisions" rules "were letting agents institutionalize knowledge for
their future selves and teammates" — stigmergy without the vocabulary.

**For this repository:** the blackboard is the *repo itself* — the ADR folder, the domain docs,
the ownership table. The reason to prefer it over an agent-to-agent message bus is that it is
checkable: `scripts/check-doc-links.mjs` already resolves links in it, and CI runs it.

### Explicit inter-agent messaging

Claude Code's agent teams implement this as a per-agent mailbox: a JSON file at
`~/.claude/teams/{team-name}/inboxes/{agent-name}.json` **[P]**. Three documented properties are
directly load-bearing for a design:

1. **Delivery is not assumed.** "Claude Code reports a message as sent only when the write to the
   recipient's mailbox file succeeds… When the write fails, for example because the disk is full or
   the mailbox directory isn't writable, the sending agent receives an error and nothing is sent."
2. **A message is not an authorisation.** The receiving agent is told the message came from another
   Claude session, **not from the user**. "A teammate can't approve a permission prompt or supply
   consent on its behalf, and a teammate that was denied an action can't relay it to another
   teammate to bypass the check." In auto mode, "an approval claim relayed from another agent" is
   treated as untrusted input rather than confirmation.
3. **Malformed entries are dropped, not merged.** The harness validates every mailbox entry;
   entries that do not match the message format are reported as errors and removed, and the valid
   messages are still delivered. (Before v2.1.207 a single malformed entry caused a repeated error
   every second and blocked delivery for that mailbox entirely.)

Zach Wills reaches the same conclusion from the other direction — his post is titled "You shouldn't
let agents talk to each other" and argues for one orchestrator, isolated agents, no handoffs, no
peer-to-peer ([trpevski.com](https://trpevski.com/blog/multi-agent-orchestration-routing-and-failure-recovery)
**[S]**). Read this alongside Anthropic's "LLM agents are not yet great at coordinating and
delegating to other agents in real time" **[V]** and Cognition's judgement that agents "today are
not quite able to engage in this style of long-context proactive discourse with much more
reliability than you would get with a single agent" **[V]** — the two vendors are arguing, and the
resolution for a repository this size is to not have the argument.

### Shared task list

Tasks have three states (pending, in progress, completed) and may declare dependencies; a pending
task with unresolved dependencies cannot be claimed. **Task claiming uses file locking** to prevent
race conditions when several agents claim the same task simultaneously **[P]**. Documented
limitations worth knowing before relying on it: "teammates sometimes fail to mark tasks as
completed, which blocks dependent tasks," and `/resume` does not restore in-process teammates, so
after resuming, "the lead may attempt to message teammates that no longer exist" **[P]**.

A stuck task list is a real failure mode, not a hypothetical: the blocking condition is an agent's
failure to update state, and the recovery is manual.

### File ownership contracts

The cheapest primitive and the one with the strongest evidence (§1, §2). Two documented
enforcement levels:

- **By convention:** a checked-in ownership table. Fails when an agent edits outside its set —
  which is silent.
- **By hook:** `TaskCompleted` and `TeammateIdle` hooks run when a teammate is about to go idle or
  a task is marked complete; **exit code 2 sends feedback and keeps the teammate working** **[P]**.
  This converts "verify the subagent" from an act of attention into a gate.

Hooks are the underused primitive. `TaskCreated` can block creation outright. The value is
proportional to how much the coordinator would otherwise have to remember to check.

### Decision ledger

Cursor's answer to two planners disagreeing: shared design docs, with **code that depends on a
decision carrying a compile-checked reference back to its doc**, and a reconciler that merges the
docs so "the references propagate the resolution downstream" **[V]**. Note the mechanism: the
reference is *compile-checked*, which is what makes it survive — a doc link nobody checks is
decoration. This repository has the raw material for the same thing: `docs/architecture/adr/` with
five ADRs and `scripts/check-doc-links.mjs` already running in CI.

---

## 6. Post-mortems: systems that went wrong, and what the authors changed

This is the section the rest of the literature does not have. Six of them, in descending order of
usefulness.

### 6.1 A multi-agent paper withdrawn after a code audit — the purest failure in this document

Philip Drammeh's *Multi-Agent LLM Orchestration Achieves Deterministic, High-Quality Decision
Support for Incident Response* ([arXiv 2511.15755](https://arxiv.org/abs/2511.15755) **[P]**)
reported, across 348 controlled trials, that multi-agent orchestration achieved a **100% actionable
recommendation rate versus 1.7%** for single-agent, 80× better action specificity, 140× better
solution correctness, and **zero quality variance** — a result framed as a production-readiness
requirement. The arXiv page now reads "This paper has been withdrawn by Phiip Drammeh." The
withdrawal note, verbatim:

> A code audit found the multi-agent arm's action list is a source constant, not model output, and
> the scorer reads only that field. All Decision Quality results, and the zero-variance and
> actionability claims derived from them, are withdrawn. The implementation also differs from
> Sec. III. Latency data are unaffected. A redesigned study is in preparation.

**Why this is the single most useful source in the document.** The multi-agent arm did not
disagree with the single-agent arm. It did not do anything at all. The measurement apparatus read
a field that was a compile-time constant, and every headline number — including the "zero
variance" that was the paper's most quotable claim — was an artifact of the harness. The number
was not wrong because an agent lied. It was wrong because **nothing in the pipeline could have
produced a different answer.**

The transfer to this repository is direct and uncomfortable. Observed failure #1 — an agent
reporting a 68 KB file that was never created — is a small version of the same shape: a report
describing an artifact, and a verification step that would have caught it had anyone run one. The
withdrawn paper's authors ran a code audit and withdrew everything that did not survive it. The
bar is: **read the harness before quoting the number.**

### 6.2 Eight rules for a 20-agent swarm, revised after a year — including one the author retracted

Zach Wills spent a week running 20 agents, ~800 commits and 100+ PRs in seven days, and wrote down
eight rules. A year of near-daily use later, he revised them
([zachwills.net](https://zachwills.net/i-managed-a-swarm-of-20-ai-agents-for-a-week-here-are-the-8-rules-i-learned/)
**[S]**). The revision table, verbatim, is more useful than either version of the rules:

| 2025 rule | Verdict after a year |
|---|---|
| 1. Align on the plan, not just the goal | Held — grew into a ticket a stranger could execute |
| 2. A long-running agent is a bug | **Retired.** The real problem is context rot |
| 3. Actively manage the AI's memory | Absorbed — durable state outside the session replaced checkpoint babysitting |
| 4. Manage context with sub-agents | Held — now native to every serious harness |
| 5. Trust the autonomous loop | Held, with a verification contract bolted onto the exit |
| 6. Automate the system, not just the code | Held best of all — grew into skills |
| 7. Be ruthless about restarting | Held — restarts near-free and partly automated |
| 8. Commit early and often | Absorbed into worktree isolation |
| *(new)* | **The swarm amplifies your scope creep** |

The author's own summary of the retired rule: "the one I'd take back is the rule that called a
long-running agent a bug." What he learned instead, in his framing: "a session that has been
compacting its memory for hours slowly forgets the intent it started with, and a resumed context
loses to a fresh one… Fresh, self-contained briefs beat resumed contexts every time I've tested the
trade."

The new rule 8 is the one most relevant to a repository rather than a product. "Agents pattern-match
to enterprise checklists by default… One agent doing that is a code review comment. Twenty doing it
in parallel is a codebase you don't recognize by Friday." His conclusion: "None of the twenty will
tell you a ticket is too ambitious for the stage the product is in. That call stays human."

### 6.3 An old swarm versus a new swarm, on the same task with the same models

Cursor's SQLite experiment, covered in §1. The full shape of the post-mortem: they did not discard
the old system, they **re-ran it**. Same task, same models, same time budget, measured against a
held-out suite the swarm was never told existed, then manually reviewed for cheating and for
coverage of areas the tests do not reach. What changed is in §1's table. What the author changed
afterwards, in their own summary: they built a version control system from scratch, because "every
change in the system passes through the VCS, so it is where collisions first become visible, and
several of the coordination mechanisms in the next section are implemented directly inside of it."

The methodological point generalises: **a coordination failure is invisible in the output product
and visible in the process metrics.** Their 68,000 commits in two hours read as productivity and was
churn. The diagnostic was conflicts, not output.

### 6.4 Anthropic's early multi-agent failures, and the four prompts that fixed them

From their own production research system **[V]**. Early agents: "spawning 50 subagents for simple
queries, scouring the web endlessly for nonexistent sources, and distracting each other with
excessive updates." Four shipped changes, all of which are prompt-level and none of which are
architecture:

1. **Think like your agents** — build simulations with the exact prompts and tools, watch step by
   step. "This immediately revealed failure modes: agents continuing when they already had
   sufficient results, using overly verbose search queries, or selecting incorrect tools."
2. **Teach the orchestrator how to delegate** — the four-element contract (§3).
3. **Scale effort to query complexity** — the 1 / 2–4 / 10+ agent-count rules.
4. **Let agents improve themselves** — a tool-testing agent that rewrites tool descriptions; the
   rewrite cut task completion time **40%** for future agents.

Their honest closing note: "the best prompts for these agents are not just strict instructions, but
frameworks for collaboration that define the division of labor, problem-solving approaches, and
effort budgets."

### 6.5 Four common multi-agent failure modes, with prevention

Trpevski's post **[S]**, which reads as a post-mortem of bolt-together-without-an-orchestrator:

1. **Infinite handoff loop** — "Agent A says 'this is a refund question' → Agent B says 'this is a
   technical issue' → Agent C says 'this is a support question' → routes to Agent A." Prevention:
   track agents already tried; never re-route to one; escalate instead of looping back.
2. **Context loss on handoff** — Agent B re-asks what Agent A already established. Prevention: pass
   full context, what was tried, and why the handoff happened. "What NOT to do: pass partial
   context… lose information in translation… have agent re-ask questions."
3. **Agent explosion** — twenty agents because someone said modular, and now every message matches
   several. Prevention: start with 3–5, one clear responsibility each, "add agents only when you
   have concrete evidence of need."
4. **Trusting agent self-assessment** — "Agent decides 'I handled this' when it clearly didn't."
   Prevention, verbatim: "**Don't ask agent if it succeeded. Look at actual outcomes** — did we call
   the right tool? did the tool return success? did the user get what they asked for?"

Number 4 is this document's thesis, stated by a practitioner two years before Who&When was
published.

### 6.6 A vendor's own list of what their team coordination does not yet do

Claude Code's agent teams are experimental, disabled by default, and documented with an explicit
limitations section **[P]**. Worth reading as a list of what a production team has not solved:
no session resumption with in-process teammates (`/resume` and `/rewind` do not restore them, so the
lead "may attempt to message teammates that no longer exist"); task status can lag and block
dependents; shutdown is slow; one team per session; no nested teams; no background subagents from
in-process teammates; the lead is fixed for the session's lifetime; permissions cannot be set per
teammate at spawn time. And the one that is a partition rule rather than a bug: "**Avoid file
conflicts** — Two teammates editing the same file leads to overwrites. Break the work so each
teammate owns a different set of files." Their guidance on when *not* to use teams at all is
equally direct: "For sequential tasks, same-file edits, or work with many dependencies, a single
session or subagents are more effective."

---

## 7. What the evidence does not settle

Stated rather than papered over.

- **No study measures multi-agent versus single-agent on maintaining a TypeScript monorepo.** Every
  quantitative result here is on research benchmarks, math, GAIA, or a from-scratch SQLite. The
  +80.8%/−70.0% spread in [2512.08296](https://arxiv.org/abs/2512.08296) **[P]** is the best
  available proxy and is not a measurement of this workload.
- **No source quantifies the cost of a write conflict.** Cursor reports conflict counts and lines
  of code; nobody reports "hours lost per shared-file collision" in a controlled setting. The
  rules in §1 and §2 are strongly directional and unquantified in the currency that matters.
- **The health-check ping has one practitioner and no controlled replication.** It is cheap, it is
  free to try, and it is **[S]**.
- **The "responsibility vacuum" paper is a position paper**, with a scaling argument and no
  experiment. It is a warning about where fan-out goes wrong at scale, not evidence about a
  threshold.
- **Nothing addresses the line-anchored-edit corruption mode directly.** No source found studies
  structured-edit tool failure rates in parallel settings. Cursor's megafile work is the closest
  analogue — high-traffic files degrade under many writers — and it is at file granularity, not
  edit-granularity.
- **AgenTracer-8B's 4.8–14.2% gains on MetaGPT and MaAS are the most promising mitigation found**,
  and the blocker is practical: it is a trained 8B tracer on a published dataset, not a prompt. A
  repository cannot adopt it this quarter.

---

## Changes to make in this repository

Each item names the exact file, what goes in it, and which of the six observed session failures it
would have prevented. The six, for reference:

1. An agent reported writing a 68 KB file that was never created.
2. A research agent with no write tool returned a finished document as prose instead of writing it.
3. Line-anchored `edit` calls repeatedly corrupted files.
4. Parallel agents conflicted on shared files — two editing one test file, one editing another's
   package to unblock it.
5. Local verification was green while CI failed on a lockfile predating a new workspace package.
6. A cross-package test silently ran stale compiled code sitting next to the source.

### M1. Create `scripts/dev/check-agent-claims.mjs` — a mechanical verifier for subagent claims

**What it is.** A zero-dependency Node script that reads a claims file and fails non-zero on any
unverifiable claim. Claims are one per line:

```
file   packages/foo/src/bar.ts
symbol packages/foo/src/bar.ts:42 verifyDomainContract
command npx vitest run packages/foo
```

Behaviour, in order of cost: for `file`, `stat` the path and fail if it is absent or zero bytes; for
`symbol`, read the line and fail if it is shorter than the line number or does not contain the
symbol; for `command`, run it and fail on non-zero exit. Add `--from-report <path>` to extract
`path:line` references from an agent's final report automatically, so the coordinator can run the
script on a report without transcribing it.

**Why a script and not a skill.** §4.1 is the whole argument: asking a model whether a subagent's
work exists is the one task the literature measures at 14.2%, below the threshold of a coin flip
in the worst published results. The check has to be a command.

**Expected benefit.** Catches failures **1** and **2** at the point of receipt, in under a second
each, instead of at `git add` or in the next session. Also gives the `session-review` skill §3
("re-run what a subagent claims to have delivered") something mechanical to point at instead of an
instruction.

**Cost.** Roughly 100 lines. Add `make agent-claims` and a line in the `help` block; do **not** add
it to `check`, because it needs input.

### M2. Create `scripts/dev/check-workspace-lockfile.mjs` — a check for failure 5

**What it is.** Read every `packages/*/package.json`, collect each `name`, and assert each appears
as a key in `package-lock.json`'s `packages` map. Also assert the reverse for
`packages/node_modules/*` entries that no longer have a manifest. Exit non-zero listing the drift.

**Why it is worth a script.** Failure 5 already cost this repository a CI run: `npm ci` failed
because the lockfile predated `packages/integration`, and every local run passed because local
verification does not run `npm ci`. The class of defect is *the lockfile is stale*, which is exactly
what a script can see and a reviewer skims past. Adding `npm ci` to the local `check` target would
fix it too, but `npm ci` deletes `node_modules` — wrong as an inner loop. This is a 200ms read of
two files.

**Add** `lockfile: ## Assert the lockfile covers every workspace package` to the `Makefile`, and add
it as a step in `.github/workflows/ci.yml` before `npm ci`. `scripts/dev/check-ci-parity.mjs`
asserts CI and the Makefile run the same commands, so both files must change together or
`make parity` fails.

**Expected benefit.** Prevents **5**, deterministically, before the lock is pushed rather than in
CI after it.

**Cost.** About 60 lines. `make parity` must agree — that is the point of the parity script.

### M3. Extend the stale-artefact guard to the repository root — a check for failure 6

**What it is.** `.gitignore` currently ends with four `packages/*/src/**/*` patterns and the
comment "Compiled output must never sit next to the TypeScript it is built from." That guard does
not cover the root — and at the repository root right now there are `vitest.config.js`,
`vitest.config.d.ts`, and `vitest.config.js.map` sitting next to `vitest.config.ts`. The identical
hazard is already documented and already bit this repository once; it is currently only half-fixed.

Two changes:

- Add `scripts/dev/check-stale-artifacts.mjs`: walk the tree (skipping `node_modules`, `dist`,
  `.git`) and fail if any `.js`, `.d.ts`, or `.map` file exists beside a same-stem `.ts` file, or
  if a file matching `*.tsbuildinfo` is tracked. Add `make stale-artifacts` and a CI step.
- Extend the four `.gitignore` patterns to cover the root (`/vitest.config.js`,
  `/vitest.config.d.ts`, `/vitest.config.js.map`) so the artefacts stop being written into the
  working tree in the first place, and delete the three files currently present.

**Expected benefit.** Prevents **6** from recurring at the root, and converts a one-time fix into a
standing check. This is the highest ratio of durability to effort in this list: the comment proving
the failure mode was understood is already in the repository; only the mechanical half is missing.

**Cost.** About 50 lines. Change the `.gitignore` and CI workflow in the same commit as M2 so
`make parity` stays green.

### M4. Create `skills/dispatch-parallel-agents/SKILL.md` — the partitioning and briefing contract

**What it is.** Under 200 lines, following the shape of the existing skills. Contents, in order:

1. **The partition test** from §1, as four yes/no questions. If question one fails, stop and
   serialize — stated as an instruction, not a preference.
2. **The ownership table** as a template. Per agent: `owns` (a path list), `must not touch`, the
   acceptance command, and the shared resources consumed (ADR numbers, event names, capability
   names). The rule from Zach Wills: "Reserve shared counters and shared files before dispatch, not
   after the collision."
3. **The brief template**, with the five required elements from §3 — deliverable medium, artifact to
   read first, outcome and anti-goals rather than steps, decisions already made and what not to
   assume, and the blocking protocol (interactive may ask; unattended records an assumption).
4. **The pre-dispatch health check** — the `MODEL_OK` ping, and the forced-choice ping for a quiet
   worker.
5. **The receipt checklist** — the eight red flags from §4.3 as a runnable list, ending at
   `node scripts/dev/check-agent-claims.mjs <claims>` from M1.
6. **One integration owner, named explicitly**, who runs `make check` once at the end. Not whoever
   finishes first.

**Why a skill and not an ADR.** An ADR records a decision; a skill is consulted at the moment
someone is about to fan out. Failure 4 (two agents on one test file) happened at dispatch time. A
document that is correct but not loaded is not consulted — this is the same
context-budget argument the existing `research` skill makes. If M4 proves insufficient, the
companion ADR is `docs/architecture/adr/0006-parallel-agent-contracts.md`; note that
`agent-workflow-research.md` R4 proposes the same path, and the main agent should pick one file
rather than two.

**Expected benefit.** Prevents **4** directly (one writer per file, decided before dispatch),
**1** and **2** (the brief requires a deliverable medium, and the receipt checklist runs M1), and
reduces **3** by preventing a second agent from editing a file that a first agent's line-anchored
edits have already corrupted.

**Cost.** About 200 lines of skill text, plus the M1 script it depends on.

### M5. Amend `skills/session-review/SKILL.md` — a subagent ledger, and a numbering fix

Two concrete edits.

**Add a §0 "Subagent ledger"** before the existing §1. Four columns: agent, what it claimed to
deliver, the path it delivered it to, and the command that was re-run to confirm. Every row is
filled by running `node scripts/dev/check-agent-claims.mjs` on that agent's report; a row whose
last column is empty means the claim was believed, not verified. The existing §3 already says
"Agent reports are not evidence. Re-run what a subagent claims to have delivered, at least the
headline number" — this makes it a table with a mechanical entry point rather than a sentence.

**Fix the section numbering.** The file runs §1–§6, then §7, then **§9**. There is no §8. Renumber
§9 to §8.

**Expected benefit.** Prevents **1** and **2** recurring across sessions, since a session that ends
without a ledger entry is visibly incomplete. Also removes a dangling reference: §7's disposition
table cites "`tool-craft` §1" as the destination for the anchored-edit lesson, and **no such skill
exists** in `skills/` — the anchor-corruption lesson from failure 3 currently has no home. Either
create `skills/tool-craft/SKILL.md` or repoint the table; leaving a citation to a nonexistent file is
the failure mode the table is trying to prevent.

**Cost.** About 30 added lines, one renumber.

### M6. Amend `skills/research/SKILL.md` — declare the deliverable's medium

**What it is.** Add a section, "Delivering the output," between the evidence rules and the
"what to search for" section. Three lines of substance: the deliverable is a **file at a named
repo-relative path**, not a report; a research agent that has no write tool must say so in its first
tool call rather than returning the document as prose; and the coordinator checks the file with M1
before reading the report.

The same section applies to any read-only subagent, and it is the one-line version of
`M4.3.1`. Note the interaction: the current `research` skill lists primary sources to read with
`read <url>` but never says where the answer goes, which is why an agent that followed it perfectly
could still return prose.

**Expected benefit.** Prevents **2**.

**Cost.** About 10 lines.

### M7. Amend `AGENTS.md` (proposed in `agent-workflow-research.md` R1) — three lines on fan-out

**This is an amendment to a file the companion document proposes creating, not a new file.** When
R1 lands, add:

- One line: parallel writers get one file each; a conflict is a serialization signal, not a
  negotiation.
- One line: a subagent's report is a claim; verify it with `node scripts/dev/check-agent-claims.mjs`
  before acting on it.
- One line: the full check runs once, at the integration point, by a named owner.

**Why it is in this document and not only in the skill.** The skill is loaded on demand. These three
lines are the ones that must be true even when the skill is not consulted, because the failure mode
is a dispatch decision made in one turn.

**Expected benefit.** Prevents **4**, **1**, and **5** (a single named integration check is what
would have caught the lockfile drift before push).

**Cost.** Three lines. Keep the file under 100 lines as R1 requires.

### M8. Create `docs/architecture/adr/0006-parallel-agent-contracts.md` — the decision record

**What it is.** Under 100 lines. Records: fan-out is for information need, not for file count;
one writer per file decided before dispatch; the integration owner is named per fan-out; subagent
reports are claims verified by script, not by reading; worktree isolation is the only accepted
fence, and a prompt saying "only edit your files" is not a fence. Links to M1–M7 and to
`agent-workflow-research.md` §4.

Coordinate with `agent-workflow-research.md` R4, which proposes the same path. **One file, not two.**

**Expected benefit.** None of the six directly — it prevents the conventions from being
rediscovered and re-drift. It is the only item in this list whose justification is durability rather
than prevention, and it is listed last deliberately.

**Cost.** About 100 lines.

### Explicitly rejected

- **A shared blackboard directory for parallel agents.** Blackboard architectures are well-evidenced
  (§5) for *heterogeneous specialists that cannot be statically partitioned*. This repository has a
  known package map and a stable set of decisions; the cheaper primitive is a checked-in ownership
  table, which is checkable by `scripts/check-doc-links.mjs` and diffable in review. A blackboard
  adds a write surface every agent can corrupt, and none of the six failures would have been
  prevented by it.
- **Adopting an LLM-as-judge reviewer as the subagent verification gate.** MAST's LLM annotator
  reaches 94% accuracy — but on *classifying failure modes over full traces*, which is a different
  task from confirming a specific file exists. Who&When measures the latter at 14.2% (§4.1). This
  would add cost and a false sense of coverage.
- **Enabling Claude Code agent teams for this repository.** The vendor's own documentation says
  teams are for "research and review" and that for "sequential tasks, same-file edits, or work with
  many dependencies, a single session or subagents are more effective" — which describes most of
  this repository's work. It is also experimental, with a documented list of unsolved behaviours
  (no teammate resumption, lagging task status, no nested teams). Sixteen simultaneous sessions in
  a monorepo whose `node_modules` is shared would collide at the package-manager level, which no
  ownership table fixes.
- **A "multi-agent playbook" section appended to `agent-workflow-research.md`.** That document
  already covers when to fan out. Appending would create two places to maintain, and the two would
  disagree — the same defect `skills/session-review/SKILL.md` §8 warns about when it says "prefer one
  document that is right over three that are compatible."
- **Worktree-per-agent for this repository.** It is the right primitive for a large fan-out and the
  wrong one here. `npm ci` at the repository root is cheap, worktree setup per agent is not, and
  the eight-package monorepo has a `tsc --build` graph that a worktree must rebuild to verify
  anything. Cursor's work was at ~1,000 commits per second, two orders of magnitude above this
  repository's rate. M3's cheap check covers the actual observed failure; a worktree would be
  solving a problem this repo does not have.

---

## Sources

All retrieved **2026-09-25**.

### Multi-agent failure, verification, and attribution
- Cemri, Pan, Yang, Agrawal, Chopra, Tiwari, Keutzer, Parameswaran, Klein, Ramchandran, Zaharia,
  Gonzalez, Stoica, "Why Do Multi-Agent LLM Systems Fail?" (v3, 26 Oct 2025) — https://arxiv.org/abs/2503.13657
- Kim et al., "Towards a Science of Scaling Agent Systems" (v3) — https://arxiv.org/abs/2512.08296
- Xu, Koesdwiady et al., "Rethinking the Value of Multi-Agent Workflow: A Strong Single Agent
  Baseline" — https://arxiv.org/abs/2601.12307
- Zhang, Yin, Zhang, Liu et al., "Which Agent Causes Task Failures and When? On Automated Failure
  Attribution of LLM Multi-Agent Systems" (Who&When) — https://arxiv.org/abs/2505.00212
- Zhang, Wang, Chen et al., "AgenTracer: Who Is Inducing Failure in the LLM Agentic Systems?" —
  https://arxiv.org/abs/2509.03312
- Chen, Wang, Mu et al., "Seeing the Whole Elephant: A Benchmark for Failure Attribution in LLM-based
  Multi-Agent Systems" (ACL 2026) — https://arxiv.org/abs/2604.22708
- Ma, Zhu, Guo et al., "Automatic Failure Attribution and Critical Step Prediction … Based on
  Causal Inference" — https://arxiv.org/abs/2509.08682
- Liu, Xi, Zhang et al., "Who&When Pro: Can LLMs Really Attribute Failures in AI Agents?" —
  https://arxiv.org/abs/2607.09996
- In, Tanjim, Subramanian et al., "Rethinking Failure Attribution in Multi-Agent Systems" (MP-Bench) —
  https://arxiv.org/abs/2603.25001
- Yeh, Zhu, Deep, Li, "Tracing Agentic Failure from the Flow of Success" (OAT) — https://arxiv.org/abs/2607.12747
- Qiao, Tong, Lim, Liu, Pang, "VerifyMAS: Hypothesis Verification for Failure Attribution" — https://arxiv.org/abs/2605.17467
- Zhu, Wu, Jin, Li, Huang, "StepFinder" (KDD 2026) — https://arxiv.org/abs/2606.03467
- Romanchuk, Bondar, "The Responsibility Vacuum: Organizational Failure in Scaled Agent Systems" —
  https://arxiv.org/abs/2601.15059
- Drammeh, Philip, "Multi-Agent LLM Orchestration Achieves Deterministic, High-Quality Decision Support
  for Incident Response" — **withdrawn** — https://arxiv.org/abs/2511.15755

### Coordination primitives
- Salemi et al., "LLM-Based Multi-Agent Blackboard System for Information Discovery in Data Science" —
  https://arxiv.org/abs/2510.01285
- Han, Zhang, "Exploring Advanced LLM Multi-Agent Systems Based on Blackboard Architecture" —
  https://arxiv.org/abs/2507.01701
- Nakamura et al., "Terrarium: Revisiting the Blackboard for Multi-Agent Safety, Privacy, and
  Security Studies" — https://arxiv.org/abs/2510.14312
- Mayoral-Vilches et al., "Towards Cybersecurity SuperIntelligence (CSI): What's the best harness?" —
  https://arxiv.org/abs/2605.28334
- Khan, Wasif, Cho, Butt, "MACOG: Multi-Agent Code-Orchestrated Generation for Reliable
  Infrastructure-as-Code" — https://arxiv.org/abs/2510.03902
- Oyama, Sakurai, Kashima, "MACC: Multi-Agent Collaborative Competition" (AAMAS 2026) —
  https://arxiv.org/abs/2603.03780
- Yang, Li, Xue, Salim, "STAR: Failure-Aware Markovian Routing" — https://arxiv.org/abs/2605.10057
- Yao, Tang, Zhang, Chen, "MAVEN: Multi-Agent Verification-Elaboration Network" — https://arxiv.org/abs/2605.07646

### Vendor engineering documentation
- Anthropic, "How we built our multi-agent research system" (13 Jun 2025) — https://www.anthropic.com/engineering/multi-agent-research-system
- Anthropic / Claude Code, "Create custom subagents" — https://code.claude.com/docs/en/sub-agents
- Anthropic / Claude Code, "Orchestrate teams of Claude Code sessions" (agent teams, experimental) —
  https://code.claude.com/docs/en/agent-teams
- Cognition, "Don't Build Multi-Agents" (12 Jun 2025) — https://cognition.com/blog/dont-build-multi-agents
- Cursor, "Agent swarms and the new model economics" (20 Jul 2026) — https://cursor.com/blog/agent-swarm-model-economics
- Cursor, `minisqlite` (swarm output, public) — https://github.com/cursor/minisqlite

### Practitioner post-mortems
- Wills, Zach, "How to Use Claude Code Subagents to Parallelize Development" (9 Sep 2025, updated
  10 Jul 2026) — https://zachwills.net/how-to-use-claude-code-subagents-to-parallelize-development/
- Wills, Zach, "The 8 Rules for Managing an AI Agent Swarm, Revised After a Year of Daily Practice"
  (27 Aug 2025, updated 10 Jul 2026) — https://zachwills.net/i-managed-a-swarm-of-20-ai-agents-for-a-week-here-are-the-8-rules-i-learned/
- Trpevski, Darko, "Multi-Agent Orchestration: Routing and Failure Recovery" (10 Aug 2026) —
  https://trpevski.com/blog/multi-agent-orchestration-routing-and-failure-recovery

### Repository documents used as evidence for the proposals
- `docs/research/agent-workflow-research.md` — companion; §4 and §5 are the general treatment this
  document goes deeper on
- `docs/research/session-reviews/2026-09-25-architecture-baseline.md` — the session whose six
  failures M1–M8 address, including the 68 KB phantom file, the scout with no write tool, the
  `packages/core/src` stale artefact, and the `npm ci` lockfile failure
- `.gitignore` — the existing stale-artefact guard that M3 extends to the repository root
- `Makefile`, `.github/workflows/ci.yml`, `scripts/dev/check-ci-parity.mjs` — the parity constraint
  M2 and M3 must both respect

### Attempted and unavailable at time of retrieval
- Built-in `web_search` — returned `Path not found`; consistent with the blocked-egress finding in
  `agent-workflow-research.md`. No turns spent retrying.
- Hacker News Algolia query `"agent teams" OR orchestrator lessons` with `points>60` — 0 hits. The
  broadened queries `"agent swarm"` and `coding agents parallel conflicts` were used instead.
- arXiv IDs `2503.13623` and `2502.08296` were recalled incorrectly from memory and resolve to an
  unrelated LDA paper and an unrelated game-theory paper respectively. Re-resolved by title search.
  Neither is cited.
