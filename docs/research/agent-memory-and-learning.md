# Agent Memory and Learning Across Sessions — what persists, what it is worth, and what a note cannot fix

> Supporting research for [`docs/architecture/00-overview.md`](../architecture/00-overview.md).
> Sibling document: [`agent-workflow-research.md`](./agent-workflow-research.md), which covers
> context engineering, verification escalation, tool selection, and multi-agent orchestration.
> **This document covers only what persists across sessions: memory architectures, self-improvement
> loops, skill libraries, and which failures a written note can actually fix.**
> All URLs retrieved **2026-09-25**. Evidence tags, matching the sibling document:
> **[P]** primary — peer-reviewed, preprint, specification, or first-party engineering documentation;
> **[V]** vendor claim — a model or tool vendor's own measurement or marketing;
> **[S]** secondary — practitioner blog, press, or commentary; a pointer, never load-bearing;
> **[?]** thin, contested, or unverifiable — read the caveat, do not propagate the claim.

## Method note

The built-in `web_search` is unreliable in this environment; most queries were refused by every
configured provider (https://code.claude.com/docs/en/skills is reachable, the search providers are
not). Research was done through the arXiv API, the OpenAlex API, Hacker News via Algolia, and
direct reads of primary vendor documentation. Every arXiv ID cited below was resolved and its
abstract or full text read; none is quoted from a search-result snippet. Citation counts are from
OpenAlex on the retrieval date and are noted where the record was found.

---

## TL;DR — ranked by expected value for this repository

Markers: **[E]** evidence strength for the change itself.

1. **A note does not stop a phantom deliverable; a filesystem check does. [E] strong. Cost: low.**
   A check that a claimed artefact exists is a two-line script. A lesson in a Markdown file that
   says "check the file exists" is a probabilistic mitigation at best. See §4.1.

2. **Self-authored lessons drift. Cap the store, force a field, prune on a fixed cadence. [E]
   strong. Cost: low.** The strongest available evidence: agents "rarely form robust reusable
   skills," and "writing more skills or larger resource libraries is not sufficient: additional
   updates can improve coverage while introducing episode-specific drift and procedural clutter"
   (SkillEvolBench, https://arxiv.org/abs/2605.24117 **[P]**). A skills directory without a cap
   and a required `Check` field becomes a graveyard.

3. **Rules in context are not enforced rules. Enforcement requires a hook or a check.
   [E] strong. Cost: low.** Claude Code's own documentation states that instruction files are
   "context, not enforced configuration" and that "there's no guarantee of strict compliance"
   (https://code.claude.com/docs/en/memory **[P]**). Independently, a 2026 systematization of
   agentic systems states the flat version: "scope and budget enforcement cannot be delegated to
   system prompts: prompts do not constrain what actually executes"
   (https://arxiv.org/abs/2608.21423 **[P]**).

4. **Write the check, not the note. This is the single most useful reframing in this document.
   [E] strong. Cost: low.** If a defect was caught by a person reading a diff, a deterministic
   check could have caught it. In that case the deliverable is a test or a lint rule, and the
   note is optional. Most of the six failures observed in this repository's session are in this
   class. §4 is the analysis.

5. **A skill that is available and not followed is a measured, reproducible failure. [E]
   strong. Cost: zero to accept.** OctoBench found that constraints sourced from `SKILL.md` are
   the **weakest** instruction category across eight frontier models and three real coding
   scaffolds, while memory and system-reminder constraints are among the strongest
   (https://arxiv.org/abs/2601.10343 **[P]**). Details in §3.3. Do not write a rule you intend to
   be advisory-only and place it only in a skill.

6. **Prefer shipped, dated, human-readable memory over a learned one. [E] moderate. Cost: zero.**
   The best-documented memory implementation for coding agents is deliberately simple: a Markdown
   index, a hard 200-line / 25KB cap, one file per note, and an ISO 8601 `modified` timestamp
   written on every write (https://code.claude.com/docs/en/memory **[P]**). Every more elaborate
   architecture in §1 is research code with a leaderboard number, not a repo convention.

7. **Do not build a memory system for this repository. [E] strong. Cost: zero.** The bottleneck
   is not recall; it is that the checks do not exist. §4 shows 4 of 6 observed failures are
   check-addressable and 2 are briefing-addressable. **Zero are memory-addressable.** The correct
   amount of persistent memory here is one capped Markdown file plus the checks.

---

## 1. Persistent memory architectures: what is deployed, and what is only proposed

### 1.1 The taxonomy the field actually uses

Two surveys define the space, and both classify by *object*, *form*, and *time* rather than by a
single memory/not-memory binary.

- Zhang et al., "A Survey on the Memory Mechanism of Large Language Model based Agents"
  (https://arxiv.org/abs/2404.13501 **[P]**, 11 citations in OpenAlex on 2026-09-25) reviews memory
  design and evaluation across LLM agents and states that prior mechanisms are scattered across
  papers without a systematic comparison.
- Wu et al., "From Human Memory to AI Memory" (https://arxiv.org/abs/2504.15965 **[P]**) maps
  human memory categories onto AI systems and organises the literature on three dimensions —
  object, form, time — into eight quadrants.
- Du, "Memory for Autonomous LLM Agents" (https://arxiv.org/abs/2603.07670 **[P]**) formalises
  agent memory as a **write–manage–read** loop and names five mechanism families:
  context-resident compression, retrieval-augmented stores, reflective self-improvement,
  hierarchical virtual context, and policy-learned management. It closes with the open problems
  relevant here: *continual consolidation, causally grounded retrieval, trustworthy reflection,
  and learned forgetting*. That is: forgetting is **not solved**, and the survey says so.

The practical mapping for a coding agent is four kinds, and only the first two are worth having:

| Kind | What it holds | Realistic in a repo |
|---|---|---|
| **Semantic** (facts) | Things derivable from code, docs, or config | Skip. Goes stale silently; the code is the source. |
| **Episodic** (what happened) | Session logs, incident records, review notes | Yes, as dated Markdown in `docs/research/session-reviews/`. |
| **Procedural** (how to do X) | Skills, runbooks, verification procedures | Yes, as `skills/*/SKILL.md` — but see §3.3 for the compliance cost. |
| **Working** (in-flight) | The current context window | Belongs in the harness, not on disk. |

### 1.2 Deployed: what a coding agent can actually use today

**Instruction files plus a capped auto-memory directory.** The best-documented implementation is
Claude Code's, and it is worth reading as a design reference because every decision is visible
(https://code.claude.com/docs/en/memory **[P]**, retrieved 2026-09-25):

- Two mechanisms, explicitly separated. `CLAUDE.md`/`AGENTS.md` is *written by you* and holds
  instructions; auto memory is *written by the agent* and holds learnings. The doc's own table
  says auto memory is for "your preferences, corrections you give Claude, project context Claude
  can't derive from the code."
- Four memory types in frontmatter: `user`, `feedback`, `project`, `reference`.
- **Write-path filtering:** "Claude skips anything it can derive from the codebase, such as
  architecture, file paths, or debugging fixes. It also skips anything your CLAUDE.md files
  already say." This is the single most important line in the document for a repository. It is
  the write filter that §5 says most systems lack.
- **A hard budget:** the index is "the first 200 lines of `MEMORY.md`, or the first 25KB,
  whichever comes first"; content past that is not loaded at session start. When the file nears
  the limit, the harness reminds the agent to shorten it: "keep one line per entry, move detail
  into topic files, and merge or drop stale entries."
- **A freshness signal:** "When Claude Code writes a memory file that begins with YAML
  frontmatter, Claude Code records the write time in a `modified` frontmatter field as an ISO 8601
  timestamp. The timestamp shows how current the fact is, both to you and to Claude when it reads
  the memory back."
- **A contradiction rule:** "if two rules contradict each other, Claude may pick one arbitrarily,"
  and the documented fix is to review the files "periodically to remove outdated or conflicting
  instructions."
- **A trim pass:** `/doctor` "cuts content Claude can derive from the codebase, such as directory
  layouts, dependency lists, and architecture overviews, and keeps pitfalls, rationale, and
  conventions that differ from tool defaults."

**Open instruction-file format.** `AGENTS.md` is now read by Claude Code, Codex, Cursor, VS Code,
GitHub Copilot, Gemini CLI, and others; Claude Code reads it directly when no `CLAUDE.md` exists
above the working directory (https://code.claude.com/docs/en/memory **[P]**). One file, many
harnesses. This repository does not yet have one at the root — that is recommendation R1 in the
sibling document, not a memory recommendation, and it is not repeated here.

**Open skill format.** Skills follow the Agent Skills standard, which Claude Code, Codex, Cursor,
Copilot, Gemini CLI, OpenHands, Goose, OpenCode, JetBrains Junie and roughly thirty others
implement (https://agentskills.io **[P]**, https://code.claude.com/docs/en/skills **[P]**). The
design point that matters for a repo: a skill body "loads only when it's used, so long reference
material costs almost nothing until you need it," and a skill is chosen either by the model from
its `description` or by explicit invocation (https://code.claude.com/docs/en/skills **[P]**).

**Commercial memory services.** Mem0 (https://arxiv.org/abs/2504.19413 **[V]**) reports 26%
relative improvement over OpenAI on an LLM-as-a-Judge metric on LOCOMO, 91% lower p95 latency
than full-context, and over 90% token savings. Zep/Graphiti (https://arxiv.org/abs/2501.13956
**[V]**) reports 94.8% versus MemGPT's 93.4% on the DMR benchmark, and on LongMemEval
"accuracy improvements of up to 18.5% while simultaneously reducing response latency by 90%."
Both are vendor numbers on the vendors' benchmarks. Neither is a repository convention.

### 1.3 Retrieval-augmented memory over a codebase, and what actually generalises

The most useful decomposition for a repo is LongMemEval's, because it is measured rather than
asserted (https://arxiv.org/abs/2410.10813 **[P]**, ICLR 2025). It frames long-term memory as a
key-value store with three stages — **indexing, retrieval, reading** — and four control points,
then measures each:

- **Value granularity.** Decomposing sessions into individual rounds beats storing whole sessions.
  Compressing further into extracted facts *hurts* overall performance through information loss,
  while helping the narrower multi-session-reasoning slice.
- **Key expansion.** Indexing values plus extracted facts raises recall@k by 9.4% and downstream
  question-answering accuracy by 5.4% over a flat index keyed on the value itself.
- **Time-aware querying.** Naive similarity search performs poorly on temporal questions;
  associating timestamps with facts and narrowing the search range raises temporal-reasoning
  recall by 6.8%–11.3%.
- **Reading.** Even with perfect recall, reading is not free: Chain-of-Note plus a structured
  output format is worth "as much as 10 absolute points" across three models.

The two results that should change behaviour in a repository:

1. **A memory system that beats "read the files" only when the corpus is large and heterogeneous.**
   The same paper's pilot found commercial memory systems losing badly to simply being handed the
   whole history: offline GPT-4o reading scored **0.9184** on a 3–6 session subset, ChatGPT with
   memory scored **0.5773**, and Coze **0.3299**. The mechanism is not retrieval failure — it is
   that "ChatGPT tended to overwrite crucial information as the chat continues, while Coze often
   failed to record indirectly provided user information."
2. **Knowledge updates are a distinct, harder ability than storage.** LongMemEval lists
   information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and
   abstention as five separate abilities precisely because storing an update is not the same as
   superseding what was stored. A note that says "use `X`" and a later note that says "use `Y`"
   are not merged; both are retrieved, and which wins is arbitrary. That is the mechanism behind
   a graveyard.

### 1.4 Proposed, not deployed: the research frontier, and why it is not a repo convention

- **MemGPT** (https://arxiv.org/abs/2310.08560 **[P]**) — hierarchical, OS-inspired virtual context
  management with interrupts. Shipped as Letta; the interesting idea for a repo is the
  hierarchy, not the implementation.
- **Generative Agents** (https://arxiv.org/abs/2304.03442 **[P]**) — store a complete record,
  synthesise reflections over it, retrieve dynamically, and plan from the result. Its ablation
  finding is the reason reflection is in this literature at all: observation, planning, and
  reflection "each contribute critically to the believability of agent behavior."
- **A-MEM** (https://arxiv.org/abs/2502.12110 **[P]**) — Zettelkasten-style dynamic indexing and
  linking, with new memories triggering updates to the attributes of existing ones. This is the
  closest published thing to a self-maintaining knowledge network, and it is a research codebase.
- **MemOS** (https://arxiv.org/abs/2505.22101 **[P]**) — elevates memory to "a first-class
  operational resource" across parametric, activation, and plaintext memory via a `MemCube`
  abstraction. Ambitious, and entirely infrastructure this repository would have to build.
- **Agentic memory taxonomies that admit the gap.** See §1.1's list of open problems.

**Read for this repository:** the shipped Markdown-with-a-cap design. Everything above it is a
research artefact whose advantage is measured on conversation benchmarks, not on a TypeScript
monorepo, and whose failure modes (§1.3's overwrite behaviour) are worse than not having one.

---

## 2. Self-improvement and reflection loops: what "the agent learns from its own session" means, and whether it works

### 2.1 The concrete meanings, from strongest to weakest

**Meaning A — write a durable note from the session's evidence.** The session produces a lesson
file, a skill edit, or a progress entry. This is the only meaning available to a stateless
harness session, and it is the only one this repository can act on.

**Meaning B — induce reusable procedures from trajectories.** ExpeL extracts natural-language
insights from past experience and recalls them at inference, reporting "a consistent enhancement
in its performance as it accumulates experiences" (https://arxiv.org/abs/2308.10144 **[P]**).
Agent Workflow Memory induces workflows and selectively supplies them, improving relative success
by 24.6% on Mind2Web and 51.1% on WebArena, with gains of 8.9–14.0 absolute points over baselines
as the train/test distribution gap widens (https://arxiv.org/abs/2409.07429 **[P]**). Voyager
maintains an ever-growing executable skill library and reports 3.3x more unique items and up to
15.3x faster tech-tree milestones, and explicitly notes the skills "alleviate catastrophic
forgetting" (https://arxiv.org/abs/2305.16291 **[P]**).

**Meaning C — redesign the agent itself.** ADAS/Meta Agent Search has a meta agent program agents
in code, over an archive of previous discoveries; the discovered agents "greatly outperform
state-of-the-art hand-designed agents" and, "importantly," transfer across domains and models
(https://arxiv.org/abs/2408.08435 **[P]**).

**Meaning D — update weights.** Not available to an API-driven agent. Out of scope, named only so
the list is complete.

### 2.2 The evidence that it works is real but narrow

The constructive results in §2.1 share one property: **each has a verifier in the loop.** ExpeL
learns from task outcomes. AWM is evaluated against task success. Voyager compiles and runs code.
Meta Agent Search scores candidate agents on benchmarks. None of them is "the model reflects and
gets better."

That matters because the negative result is robust. Two studies already in the sibling document
reach the same conclusion from opposite directions: intrinsic self-correction degrades
performance without external feedback (https://arxiv.org/abs/2310.01798 **[P]**, ICLR 2024), and
the critical survey concludes self-correction works "only on tasks that can use reliable external
feedback" (https://arxiv.org/abs/2406.01297 **[P]**). The most useful new data point for *this*
question is OctoBench's feedback-correction experiment (https://arxiv.org/abs/2601.10343
**[P]**): failed checklist items were converted into structured error feedback and injected as
explicit constraints. Feedback helped every model — ISR gains of **+16.79** (ChatGLM-4.6),
**+11.76** (Gemini-3-Pro), **+10.08** (MiniMax-M2.1), and **+7.20** (Claude-Opus-4.5). The paper's
own reading of the weakest gain is the important sentence: "remaining failures stem from deep
logical flaws rather than instructional oversights."

**Reading:** a session-derived lesson is worth having **when it is a restatement of a check's
output**, and nearly worthless when it is a restatement of the model's own opinion.

### 2.3 The two failure modes, both documented

**The agent records a lesson that is wrong.** Two red-team results show a memory store is an
attack surface, and that the attacker may not need write access at all.

- AgentPoison (https://arxiv.org/abs/2407.12784 **[P]**) poisons an agent's long-term memory or
  RAG knowledge base with optimised triggers, achieving "an average attack success rate higher
  than 80% with minimal impact on benign performance (less than 1%) with a poison rate less than
  0.1%." The paper's premise is exactly this document's concern: "the reliance on unverified
  knowledge bases raises significant concerns about their safety and trustworthiness."
- MINJA (https://arxiv.org/abs/2503.03704 **[P]**) is worse for a repository, because it needs no
  memory-write privilege: the attacker "injects malicious records into the memory bank by only
  interacting with the agent via queries and output observations." A system that writes memories
  from conversation inherits this by construction.

The non-malicious version of the same failure is documented in LongMemEval: ChatGPT "tended to
overwrite crucial information as the chat continues" (https://arxiv.org/abs/2410.10813 **[P]**).
A session that concludes "we should use `pnpm`" from one failed `npm` invocation will write that
lesson, and nothing in the write path will know it was one observation.

**The agent records a lesson and then does not follow it.** This is the most common case and it is
measured, not anecdotal — see §3.3. OctoBench's per-check CSR sits between **79.75% and 85.64%**
across eight models, while strict all-or-nothing instance success (ISR) falls to **9.66%–28.11%**
(https://arxiv.org/abs/2601.10343 **[P]**). The paper's term for the gap is apt: "This scissors gap
quantifies the long-horizon execution fragility." In other words: an agent follows nearly every
rule nearly every time, and therefore fails to follow all of them at least once, and the failure is
invisible unless you check.

### 2.4 Self-evolution without a verifier is a documented trap

The state of the field is surveyed by Gao et al., "A Survey of Self-Evolving Agents" (https://arxiv.org/abs/2507.21046
**[P]**), which organises the area on what, when, and how to evolve. The most useful admission in
adjacent work is Skill Self-Play's framing of the dilemma (https://arxiv.org/abs/2607.22529 **[P]**):
"environment-bound methods obtain precise feedback but confine learning to narrow domains, while
open-ended self-generation broadens the task space but lacks reliable verification, **allowing
misleading rewards to pollute the training loop**." Evo-Memory (https://arxiv.org/abs/2511.20857
**[P]**) reaches the compatible conclusion from the benchmark side: self-evolving memory can beat
static approaches, but "their effectiveness depends strongly on architecture choices."

**Operational rule for a repository:** an agent may only write a lesson when a deterministic signal
says the lesson is true. A test failed → the lesson is about the code. A review comment → the
lesson is about taste, and it belongs to a human. An agent's own opinion is not a signal.

---

## 3. Skill and procedure libraries

### 3.1 How skills are structured, and the one field that matters

The format is standardised and the structure is deliberately small (https://agentskills.io **[P]**,
https://code.claude.com/docs/en/skills **[P]**):

```yaml
---
name: verify-domain-contract
description: Verify a domain package, a safety invariant, or a change to a shared state machine before reporting it done. Use before claiming any package compiles, any invariant holds, or any issue is complete.
---
```

Two fields, and both are load-bearing:

- `description` is the *retrieval* surface. The harness or the model uses it to decide whether to
  load the body. A vague description means the skill is not consulted.
- The body is a *procedure*, not a fact. The documentation is explicit about the split: if "a
  section of CLAUDE.md has grown into a procedure rather than a fact," it should be a skill.
  Reference content "runs inline," procedure content "loads only when it's used."

The `description` field is a prompt. It is competing for attention with every other description in
the session, and the sibling document's IFScale result (https://arxiv.org/abs/2507.11538 **[P]**)
is the relevant constraint: instruction-following degrades *uniformly*, not selectively. A skill
with a vague description is not a free fallback — it is dead weight in a budget that is already
partly spent.

### 3.2 When a skill is consulted versus ignored

A skill is loaded in one of two ways, and only the second is under your control:

1. **The model decides** from the `description`. Unreliable, and the reliability degrades with
   session length — OctoBench measured "a dominant negative trend ... where instruction following
   effectiveness diminishes as interaction history accumulates," which it calls "context fatigue"
   (https://arxiv.org/abs/2601.10343 **[P]**).
2. **You or a hook invoke it.** Deterministic. Claude Code ships the distinction explicitly:
   "Claude invokes some bundled skills automatically when relevant; others, including `/verify`,
   run only when you invoke them, which keeps in your control of when these longer-running checks
   spend time and tokens" (https://code.claude.com/docs/en/skills **[P]**).

A third case, specific to subagents, is a structural omission: "The main conversation's auto memory
isn't loaded into subagents" (https://code.claude.com/docs/en/memory **[P]**). A subagent does not
inherit what the parent learned.

### 3.3 Evidence on skill non-compliance: having the procedure and not using it

This is the most directly load-bearing finding in the document for this repository, and it is
from a controlled benchmark rather than a practitioner's anecdote.

OctoBench (https://arxiv.org/abs/2601.10343 **[P]**) packages constraints from heterogeneous
instruction sources into 34 environments, 217 tasks, three real coding scaffolds (Claude Code,
Kilo, Droid), and 7,098 objectively decidable checklist items — an average of 32.7 per instance —
with a logged trajectory and an LLM judge. Two results matter:

- **Per-check compliance is high; per-instance compliance is catastrophic.** CSR 79.75%–85.64%
  against ISR 9.66%–28.11%. An agent is "correct" in isolation and "wrong" as a whole.
- **Skill constraints are the weakest category.** The paper reports "substantial variation across
  instruction categories, with a consistent gap between file types. Models perform strongly on
  constraints in the Memory category, while compliance drops noticeably for constraints specified
  in Skill.md." In the Skill category, Claude-Opus-4.5 reaches ISR 58.45% and MiniMax-M2.1 falls
  to 12.33%, "compared to the relatively high ISR band observed for System reminder and Memory
  categories."

Note the ordering. **Memory constraints outperform skill constraints.** A durable note in an
always-loaded file is followed more reliably than a procedure in a skill file that has to be
retrieved. The obvious inference is the uncomfortable one: a lesson that must be *consulted* is
worth less than the same lesson in a file that is always in context — which is why §5's advice is
to move a rule *up* the loading chain, not to keep adding skills.

Two corroborating primary sources:

- Claude Code's own troubleshooting entry: `CLAUDE.md` "is delivered as a user message after the
  system prompt, not as part of the system prompt itself. Claude reads it and tries to follow it,
  but there's no guarantee of strict compliance, especially for vague or conflicting instructions,"
  and the documented remedy is escalation, not repetition: "If the instruction is something that
  must run at a specific point, such as before every commit or after each file edit, write it as a
  hook instead. Hooks execute as shell commands at fixed lifecycle events and apply regardless of
  what Claude decides to do" (https://code.claude.com/docs/en/memory **[P]**).
- A 2026 agentic-systems systematization, stated flatly: "scope and budget enforcement cannot be
  delegated to system prompts: prompts do not constrain what actually execute" — and, in the same
  vein, "treating unevaluable outcomes as attack failures biases downstream measurements toward
  evasive and severe responses" (https://arxiv.org/abs/2608.21423 **[P]**). A measurement that
  cannot distinguish "the agent did not do the thing" from "the harness could not see the thing"
  is a measurement you cannot act on.

### 3.4 Self-generated skills: the strongest available negative result

SkillEvolBench (https://arxiv.org/abs/2605.24117 **[P]**) is the paper to read before writing any
"the agent maintains its own skills" proposal. It evaluates exactly that: 180 tasks across six
real agent environments, role-conditioned task families with shared latent procedures, agents that
learn from acquisition tasks and update an external skill library from compacted trajectories and
verifier feedback, then face frozen deployment tasks. Ten model configurations, three harnesses.
Controls separate procedural abstraction from base capability, curated prior knowledge, and raw
trajectory reuse. The findings:

- "Current agents often adapt locally but rarely form robust reusable skills."
- Gains "are unstable under frozen deployment."
- "**Raw-trajectory reuse frequently outperforms distilled skills**, suggesting that current
  abstraction procedures discard contextual and procedural cues that remain useful for future
  tasks."
- "Writing more skills or larger Tier-3 resource libraries is not sufficient: additional updates
  can improve coverage while introducing episode-specific drift and procedural clutter."

That last sentence is the graveyard mechanism, measured. Adding a skill per session improves
coverage and degrades the store. The corollary for a repository: **a skill must earn its place
against a measured defect, and the default action when a session ends is prune, not append.**

---

## 4. Failure taxonomy for coding agents: memory-addressable, check-addressable, or neither

This is the section the other documents do not have. Three verdicts are used:

- **MEMORY** — a persistent note plausibly reduces the recurrence rate.
- **CHECK** — a deterministic check (typecheck, test, script, hook, CI) catches it, and no amount
  of prose about it will.
- **BRIEF** — the failure is in how the task was specified. Only a contract fixes it.

The general finding across the literature is that **CHECK is the answer far more often than the
agent's instinct suggests.** "LLMs Cannot Self-Correct Reasoning Yet"
(https://arxiv.org/abs/2310.01798 **[P]**) and its critical survey
(https://arxiv.org/abs/2406.01297 **[P]**) say correction needs a reliable external signal. The
agentic-systems finding that "prompts do not constrain what actually executes"
(https://arxiv.org/abs/2608.21423 **[P]**) says the same for instructions. SWE-bench validity work
in the sibling document says a test that never was observed failing is not a correctness proof.
The bias is uniform: **reach for the check first.**

### 4.1 The six failures observed in this repository's session

| # | Failure | Verdict | What actually fixes it | Why the memory verdict is what it is |
|---|---|---|---|---|
| 1 | Agent reported writing a 68KB file that was never created; caught only because `git add -A` did not stage it | **CHECK** | A delivery assertion in the report template, mechanically verified: the file list plus `git status --short` output. | The failure is not ignorance. The report was *plausible and detailed*, and the surrounding context offered no signal. A lesson "verify your files exist" is already implied by "report evidence rather than asserting success," which is in `session-review`. It did not prevent the incident. A filesystem read does. |
| 2 | A research agent with `read`/`grep`/`glob`/`web_search` only returned a finished document as prose; nothing on disk | **BRIEF** | The brief must name the output artefact: "your only deliverable is the file at `docs/research/x.md`; a report containing the document is a failed task." A post-return existence check is the backstop. | Nothing in memory can help — the agent had no write tool and the failure was invisible in its report. This is a specification defect. The relevant evidence is Anthropic's documented failure mode that agents "duplicate work, leave gaps, or fail to find necessary information" when tasks are under-specified, and the countermeasure is an explicit output contract rather than a note. |
| 3 | Line-anchored `edit` calls repeatedly corrupted files — clobbered imports, deleted adjacent code, replaced rather than inserted; cost ~a dozen turns and one whole-file rewrite | **CHECK + partial MEMORY** | A read-after-write verification, and a `MEMORY`-grade lesson: *for multi-line or structural changes, rewrite the file; use anchored edits only for single-line changes.* | This is the one case where memory genuinely earns its place, because there is no check that catches a well-formed but wrong edit — the file still compiles. The lesson changes a *behaviour the agent chooses*, not an outcome the tool can verify. A `prettier --check` will not tell you an import line was eaten. Accept the partial credit. |
| 4 | Parallel agents conflicted on shared files (two editing one test file; one editing another's package to unblock it) | **BRIEF** (write ownership) | A file-ownership contract per agent and a single integration point. | A note saying "don't conflict" is the weakest possible intervention: the conflict arises from two agents both believing they own the file, and both are following the rules they were given. Cognition's argument (https://cognition.com/blog/dont-build-multi-agents **[V]**) is that actions carry implicit decisions and "the decision-making ends up being too dispersed." Only the contract fixes the ownership question. |
| 5 | Verification was local and green while CI failed on a lockfile predating a new workspace package | **CHECK** | `npm ci` in CI, plus running the *same* command CI runs before reporting done. | The local check was real and correct; it was checking a different state. A note saying "check the lockfile" is knowledge the agent already had — `add-domain-package` already says "Run `npm install` to create the `node_modules/@been-there/<name>` symlink." It was not consulted or not sufficient. The fix is that the verified command is the deployed command. |
| 6 | A cross-package test silently ran stale compiled code because a build artefact sat next to the source | **CHECK**, and the note already exists | Build inside the same command as the test: `npx tsc --build && npx vitest run`. | **This is the important row.** `skills/verify-domain-contract/SKILL.md` has a section titled "The stale-build trap" that describes this exact symptom, and `add-domain-package` repeats it under "Traps." The lesson was written down, and the failure happened anyway. That is a direct, in-house observation of §3.3's skill non-compliance, and it settles the argument: the note was not sufficient. |

**Summary of the split: 4 CHECK, 1 CHECK + partial MEMORY, 1 BRIEF, and 0 memory-addressable.**

Failure 6 deserves to be stated again on its own, because it is the strongest available argument
for this document's conclusion. This repository *wrote the lesson first*. It documented the stale
build trap in two separate skills, with the symptom and the fix. The failure then occurred. The
only thing that would have prevented it is a command where the ordering cannot be forgotten. **A
note that has already failed to prevent its own failure is not a mitigation; it is a comment.**

### 4.2 The general taxonomy

Beyond the six, these are the classes that recur, with the honest verdict for each.

| Failure class | Verdict | The fix |
|---|---|---|
| Hallucinated package or API | **CHECK** | Module resolution and `strict` types make it a build error. Already true here. |
| Test that cannot fail (mock echo, non-emptiness, wiring) | **CHECK** | A review rule, or a lint rule banning `toBeDefined()` on a just-constructed value. Not a memory problem. |
| Passing the existing suite while the bug remains | **CHECK** | Failing-before / passing-after. `verify-domain-contract` already requires it. |
| Silently narrowed scope | **BRIEF** + review against the acceptance list, not the diff | The failure is invisible in the output by construction. |
| Over-engineering, extra abstraction | **CHECK** (lint rule for the specific shape) or delete | House rules in a prompt are the weakest form; a lint rule for `Map`/`Set` over static lookups is a real gate. |
| Verifying a claim it could have read but did not | **MEMORY**, weak | One line: an unobserved claim is a defect. This is genuinely a behaviour the agent chooses and no tool can see it. |
| Cross-package invariant not covered by either package's tests | **CHECK** | A composition test in `packages/integration/`. |
| Violating a rule because the rule was ambiguous or contradicted by another rule | **CHECK** (remove the contradiction at authoring time) or **BRIEF** (set priority) | "If two rules contradict each other, Claude may pick one arbitrarily" (https://code.claude.com/docs/en/memory **[P]**). A note cannot fix ambiguity; deleting the contradiction can. |
| Forgetting a session's work, or re-deriving it | **MEMORY**, the one class memory is genuinely good at | Episodic records in `docs/research/session-reviews/` and dated commit messages. |
| Capability that is nominally disabled still being reachable by another route | **CHECK** (remove the route) | Not memory. Structural removal. |
| Scope or budget not respected because it was asked for politely in the prompt | **CHECK** (a gate that counts) | "Prompts do not constrain what actually executes" (https://arxiv.org/abs/2608.21423 **[P]**). |

### 4.3 The rule that follows

**Write the check. If a check is impossible, write the note. If both are possible, the check wins
and the note is optional.** The session-review skill already asks the right question — "which
check would have caught it earlier" — and the only missing step is the decision that follows from
the answer.

---

## 5. Verifying that a written lesson is still true

A skills directory becomes a graveyard by four documented mechanisms, each with a countermeasure.

**Mechanism 1 — the lesson was wrong when written.** Countermeasure: a required provenance field.
The lesson names the check that produced it, and the command that re-runs it. A lesson with no
re-runnable command is an opinion, and opinions do not go in this file. This is also the direct
answer to MINJA (https://arxiv.org/abs/2503.03704 **[P]**): a write path that filters on "did a
deterministic signal say this?" cannot be poisoned by conversation alone.

**Mechanism 2 — the lesson was true and has since stopped being true.** Two counters, both
shipped in Claude Code's memory design (https://code.claude.com/docs/en/memory **[P]**):

- A **timestamp on every entry.** The `modified` ISO 8601 frontmatter field exists precisely so
  that "the timestamp shows how current the fact is, both to you and to Claude when it reads the
  memory back." A lesson with no date cannot be triaged; a lesson dated six months ago is the
  first candidate for deletion.
- **Derive-ability as a write filter.** "Claude skips anything it can derive from the codebase,
  such as architecture, file paths, or debugging fixes." This is the highest-leverage rule in the
  whole document: a lesson the agent could have read from the code is a lesson that will rot the
  day the code changes. The `session-review` skill's stated scope is correct and should not be
  widened.

**Mechanism 3 — the lesson is superseded but still retrieved alongside its successor.** LongMemEval
treats knowledge updates as a distinct ability for exactly this reason, and observed that systems
"tended to overwrite crucial information as the chat continues" (https://arxiv.org/abs/2410.10813
**[P]**). Countermeasure: **edit in place, never append a replacement.** One location, one
authority. `write-feature-spec` already enforces the analogous rule for copy ("assign each string
one owner and cross-reference it"); the same discipline applies to lessons.

**Mechanism 4 — the store grew and the budget is spent.** Countermeasure: a hard cap plus a prune
pass. Claude Code caps the index at 200 lines / 25KB and, when the file nears the limit, instructs
the agent to "merge or drop stale entries" (https://code.claude.com/docs/en/memory **[P]**); its
`/doctor` trim cuts derivable content and keeps "pitfalls, rationale, and conventions that differ
from tool defaults." SkillEvolBench measured the failure of the uncapped alternative: additional
updates improve coverage while introducing "episode-specific drift and procedural clutter"
(https://arxiv.org/abs/2605.24117 **[P]**).

**Mechanism 5 — the lesson was correct and is still followed anyway, because the session was
long.** Nothing about the store fixes this. It is the CSR/ISR scissors gap
(https://arxiv.org/abs/2601.10343 **[P]**) and context fatigue. The countermeasure is to re-check
mechanically at the end, not to re-read the notes.

**The measurement model worth copying.** OctoBench's two-metric split is the right instrument for
this repository's own practice. Track, per session: *how many rules were followed* (the CSR
analogue) and *how many full contracts were satisfied end to end* (the ISR analogue). A session
with high CSR and low ISR is a session with many individually-correct steps and a broken outcome —
which is precisely the shape of all six observed failures. The `session-review` skill's existing
question ("how many were caught by verification and how many by luck") is the right question; the
proposal in §6 is to add the second number to it.

---

## Changes to make in this repository

Ordered by expected value. Every item names the exact file. Items M1–M7 map to the six observed
session failures; where an item prevents none, it is not proposed.

### M1. Fold the "stale build" ordering into the command, not the note

**File:** `package.json`, and the two traps sections in
`skills/verify-domain-contract/SKILL.md` and `skills/add-domain-package/SKILL.md`.

**Change:** add `"verify": "tsc --build && vitest run"` to `scripts`, and change the documented
verification command everywhere from `npx tsc --build && npx vitest run` (two commands a human or
agent can reorder or half-run) to `npm run verify` (one command where the ordering is not a
choice). Then **delete the "stale-build trap" prose from both skills** and replace it with one
line pointing at the script. The lesson is currently in two files and did not prevent the
failure; the ordering constraint is now in the only place that can enforce it.

**Prevents:** failure **6** directly, and failure **3** partially (a corrupted edit that breaks
the build is caught at the same moment as a correct one, so the agent learns the file is wrong
before it builds on it).

**Expected benefit:** eliminates the entire class. Cost: minutes.

### M2. Add a delivery assertion to the report contract, and check it

**File:** `skills/session-review/SKILL.md`, section 1 (Evidence), plus the report template.

**Change:** the evidence section gains a required "Files created or modified" list, and every
entry is accompanied by the output of `git status --short` and, for a claimed new file, a
`wc -c <path>` line. The rule to state: **a file is not created until `git status` shows it, and a
number in a report is a claim until a command prints it.** The skill currently says "Agent
reports are not evidence" and stops there; that is the right instinct applied one layer too high
up. The failure in this session was a file, not an assertion, and it escaped.

**Prevents:** failure **1** directly.

**Expected benefit:** the cheapest possible check for the most expensive observed failure. Cost:
one paragraph. Note the check is on the *reviewer*, not the agent — the reviewer re-runs
`git status` and compares. That is the right shape: a check performed by a different party than
the one making the claim, per the sibling document's second-opinion rule.

### M3. Make the research skill's deliverable a file, in the skill

**File:** `skills/research/SKILL.md`, new section "The deliverable is a file".

**Change:** state that for any research task assigned to a subagent, the task brief must name the
output path, and the acceptance condition is `test -s <path>` plus a line count. A subagent that
returns the document as prose **has failed the task**, regardless of how good the prose is. Add
the complementary rule for the briefing side: any task brief dispatched to an agent must begin
with the artefact path and the acceptance check, in that order.

**Prevents:** failure **2** directly.

**Expected benefit:** turns an invisible failure into a visible one. Cost: one section.

### M4. Convert every session-review finding into a check, and record the residue in one capped file

**File:** create `docs/lessons.md`. Single file, hard cap 200 lines, one entry per lesson.

**Change.** Each entry is exactly this shape:

```markdown
## L-003 — Run `npm ci`, not `npm install`, before claiming the lockfile is current

- **Observed:** 2026-09-25, session review. CI failed on a lockfile predating
  `packages/<new-pkg>`; local verification was green.
- **Check that now catches it:** `npm ci && npm run verify` in `.github/workflows/ci.yml`.
- **Provenance:** CI run output, 2026-09-25.
- **Supersedes:** — (edit in place; never append a replacement)
```

The rule the skill must then enforce, and the whole point of this item: **for each finding in a
session review, first ask whether a deterministic check would have caught it. If yes, write the
check. Only if no check is possible does a line go into `docs/lessons.md`.** Findings that
produce a check do not also produce a lesson — the check is the durable artefact, and the lesson
would be a second copy that can drift from it.

Two rules keep the file from becoming a graveyard, both taken from §5: every entry carries a
provenance date, and the default action when the file nears 200 lines is **prune, not append**
(SkillEvolBench's measured "procedural clutter", https://arxiv.org/abs/2605.24117 **[P]**).
Entries whose truth is derivable from the code are deleted on sight, matching Claude Code's
documented write filter (https://code.claude.com/docs/en/memory **[P]**).

**Prevents:** failure **5** (the lockfile lesson becomes a CI change, not a note). Prevents
failure **1** and **3** *recurrence* by forcing the "which check" question at review time rather
than at the next session.

**Expected benefit:** the highest-leverage single change, because it changes the default action.
Cost: ~1 hour. Ongoing: a prune decision per session, which is the cost that makes it work.

### M5. Add the file-ownership line to the two skills that dispatch subagents

**File:** `skills/add-domain-package/SKILL.md` and `skills/write-feature-spec/SKILL.md`, plus the
parallel-agent ADR if and when the sibling document's R4 is adopted.

**Change:** one line, identical in both: *a dispatched agent names the files it owns; it does not
edit a file it does not own, and an unblocking edit in another package is reported, not applied.*
The second half is the part that addresses the observed incident directly — the conflict was an
agent editing another package's manifest to unblock itself.

**Prevents:** failure **4** as far as a note can. Being honest about the ceiling: this is a BRIEF-
class failure and the contract in the ADR is the real fix. This line is the cheap version and
prevents the *silent* variant.

**Expected benefit:** small but real, and it costs two lines. Cost: minutes.

### M6. Add a failing-before requirement to the `verify-domain-contract` reconciliation step

**File:** `skills/verify-domain-contract/SKILL.md`, section "Before closing a GitHub issue".

**Change:** replace "Docs and code agree. Re-run the reconciliation in the `write-feature-spec`
skill" with a mechanical procedure: run the `rg` reconciliation the skill already prescribes, and
record the count of spec/code disagreements found. Zero is the only acceptable value to report as
"reconciled." "Re-run the reconciliation" is a BRIEF-shaped instruction — it is satisfiable by
running the command and not reading the output, which is the shape of failure **1**.

**Prevents:** reduces the recurrence of failure **1** and **5** by removing the one instruction in
the repo that can be satisfied without looking.

**Expected benefit:** small, and it removes an existing soft spot. Cost: minutes.

### M7. Record the retrieval reality, including that `web_search` partially works

**File:** `skills/research/SKILL.md`, the section "The built-in web search does not work here".

**Change:** the current text says the search tool "fails in this environment" and lists five
blocked providers. During this research, **Startpage intermittently returned usable results while
the other four consistently did not.** Correct the file to say what is actually true: the tool is
unreliable, retries are cheap and sometimes succeed, and a successful search result is a pointer
that must be resolved before citing — never a citation itself. Add the arXiv ID verification step
this document used on every source: resolve `https://arxiv.org/abs/<id>` and read the abstract
before citing the paper.

**Prevents:** none of the six. **It is included because the current file's claim is now
demonstrably false**, and a false constraint in a skill is worse than no constraint: it teaches
the agent to give up on a tool that sometimes works, and it makes the method note in
`docs/research/agent-workflow-research.md` inaccurate by extension.

**Expected benefit:** correctness, and it is the reason the sibling document's method note and this
one may disagree. Cost: one paragraph.

### Skills and systems explicitly **not** worth building

Stated bluntly, because the request asked for proposals that earn their place:

- **A `remember-lessons` skill, or any skill whose job is "write down what you learned."** It
  would prevent **none** of the six failures. Failure 6's lesson already existed in two skills
  and did not prevent failure 6. A skill that produces more prose about lessons does not change
  the mechanism, which is that prose is not enforced. M4 puts the material in a capped file with a
  required provenance field, where it is at least auditable.
- **A self-updating `AGENTS.md` or auto-generated skill directory.** Rejected on SkillEvolBench
  (https://arxiv.org/abs/2605.24117 **[P]**): "raw-trajectory reuse frequently outperforms
  distilled skills," and additional updates introduce "episode-specific drift and procedural
  clutter." Also rejected on the write-filter principle: anything the agent derives from the code
  is better read from the code.
- **Embedding or RAG over the docs.** Rejected on LongMemEval's own pilot
  (https://arxiv.org/abs/2410.10813 **[P]**): simply reading the whole corpus offline scored
  0.9184 while the memory-augmented commercial system scored 0.5773. This repository's docs total
  well under 200KB. Reading them is better than indexing them.
- **A dedicated memory agent or a vector store.** The best available evidence is that memory
  systems *lose* to full context at this scale, and the deployed reference implementation is
  Markdown with a line cap. `AGENTS.md` plus one capped `docs/lessons.md` is the whole design.
- **Anything that depends on a Stop hook this harness does not expose.** The sibling document
  lists this as an open question; M1 and M2 were designed to be effective without one.

### Priority order

M1, then M4, then M2 and M3, then M5, M6, M7. M1 and M4 are the two that change the *default
action* rather than adding an instruction, and they are the two with evidence behind them.

---

## Open questions

1. **What is the actual skill-consultation rate in this repository's sessions?** OctoBench measures
   it (https://arxiv.org/abs/2601.10343 **[P]**) and this repository has no equivalent
   measurement. Counting "which skills were loaded, per session" is feasible only if the harness
   exposes a hook; without one, the honest answer is unknown and M4's value rests on the general
   principle rather than on local data. **Resolving this needs local instrumentation, not more
   literature.**
2. **Does a note that a check cannot reproduce ever help?** §4.2 assigns "verifying a claim it
   could have read but did not" to MEMORY, weakly. That is an inference from the self-correction
   literature, not a measurement. No study of *whether* a session-derived note reduces the
   recurrence of unverified-claim failures was found — **this is the central gap in this
   document's evidence base, and it is the class MEMORY is supposed to own.**
3. **How large can `docs/lessons.md` get before the cap itself causes loss?** The 200-line figure
   is borrowed from a product with a different corpus and a different retention model. It is a
   starting point to be adjusted by observation, not a measured optimum.
4. **Is failure 3's MEMORY component real, or did the incident look memory-shaped because notes
   were the reflex?** Line-anchored edit corruption may be fully addressable by a
   read-after-write check plus a formatting-level diff gate, in which case no lesson is needed. The
   honest classification is CHECK + partial MEMORY, and the MEMORY half is untested.
5. **Would an `InstructionsLoaded`-style audit hook catch real cases?** Claude Code exposes one
   for exactly this purpose (https://code.claude.com/docs/en/memory **[P]**). Whether any hook in
   this harness's equivalent is available is unanswered here and in the sibling document.

---

## Sources

All retrieved **2026-09-25**. Every arXiv identifier was resolved and its abstract or full text
read directly; none is cited from a search-result snippet. Citation counts, where given, are from
the OpenAlex API on the retrieval date.

### Memory architectures and surveys
- Zhang, Bo, Ma, Li, Chen, Dai, Zhu, Dong & Wen, "A Survey on the Memory Mechanism of Large Language
  Model based Agents" — https://arxiv.org/abs/2404.13501 — OpenAlex: 11 citations
- Wu, Liang, Zhang, Wang, Zhang, Guo, Tang & Liu, "From Human Memory to AI Memory: A Survey on
  Memory Mechanisms in the Era of LLMs" — https://arxiv.org/abs/2504.15965
- Du, "Memory for Autonomous LLM Agents: Mechanisms, Evaluation, and Emerging Frontiers" —
  https://arxiv.org/abs/2603.07670
- Packer, Wooders, Lin, Fang, Patil, Stoica & Gonzalez, "MemGPT: Towards LLMs as Operating
  Systems" — https://arxiv.org/abs/2310.08560
- Park, O'Brien, Cai, Morris, Liang & Bernstein, "Generative Agents: Interactive Simulacra of
  Human Behavior" — https://arxiv.org/abs/2304.03442
- Xu, Liang, Mei, Gao, Tan & Zhang, "A-MEM: Agentic Memory for LLM Agents" —
  https://arxiv.org/abs/2502.12110
- Li, Song, Wang et al., "MemOS: An Operating System for Memory-Augmented Generation" —
  https://arxiv.org/abs/2505.22101
- Chhikara, Khant, Aryan, Singh & Yadav, "Mem0: Building Production-Ready AI Agents with Scalable
  Long-Term Memory" — https://arxiv.org/abs/2504.19413 — **[V]**, vendor benchmark numbers
- Rasmussen, Paliychuk, Beauvais, Ryan & Chalef, "Zep: A Temporal Knowledge Graph Architecture for
  Agent Memory" — https://arxiv.org/abs/2501.13956 — **[V]**
- Wu, Wang, Yu, Zhang, Chang & Yu, "LongMemEval: Benchmarking Chat Assistants on Long-Term
  Interactive Memory" (ICLR 2025) — https://arxiv.org/abs/2410.10813
- Wei, Sachdeva, Coleman et al., "Evo-Memory: Benchmarking LLM Agent Test-time Learning with
  Self-Evolving Memory" — https://arxiv.org/abs/2511.20857

### Self-improvement, reflection, and skill formation
- Zhao, Huang, Xu, Lin, Liu & Huang, "ExpeL: LLM Agents Are Experiential Learners" —
  https://arxiv.org/abs/2308.10144
- Wang, Mao, Fried & Neubig, "Agent Workflow Memory" — https://arxiv.org/abs/2409.07429
- Wang, Xie, Jiang, Mandlekar, Xiao, Zhu, Fan & Anandkumar, "Voyager: An Open-Ended Embodied
  Agent with Large Language Models" — https://arxiv.org/abs/2305.16291
- Hu, Lu & Clune, "Automated Design of Agentic Systems" — https://arxiv.org/abs/2408.08435
- Gao, Geng et al., "A Survey of Self-Evolving Agents" — https://arxiv.org/abs/2507.21046
- Huang, Cheng, Liu et al., "Skill Self-Play: Pushing the Frontier of LLM Capability with
  Co-Evolving Skills" — https://arxiv.org/abs/2607.22529
- Lei, Wan, Zhang et al., "SkillEvolBench: Benchmarking the Evolution from Episodic Experience to
  Procedural Skills" — https://arxiv.org/abs/2605.24117

### Instruction following, skill compliance, and failure taxonomies
- Ding, Liu, Yang, Lin, Chen, Dou, Guo, Cheng, Zhao, Xiao, Zeng, Zhang, Huang, Xu & Gui, "OctoBench:
  Benchmarking Scaffold-Aware Instruction Following in Repository-Grounded Agentic Coding" —
  https://arxiv.org/abs/2601.10343
- Cemri, Pan, Yang, Agrawal, Chopra, Tiwari, Keutzer, Parameswaran, Klein, Ramchandran, Zaharia,
  Gonzalez & Stoica, "Why Do Multi-Agent LLM Systems Fail?" — https://arxiv.org/abs/2503.13657
- Noumi, Nowshin, Nipu, Mahmood, Mridha & Hossain, "Agentic Security: A Systematization of Tools,
  Failure Modes, and Design Laws for LLM-Driven Penetration Testing" —
  https://arxiv.org/abs/2608.21423
- Cui, Yao, Tao, Shi, Li & Ding, "Enhancing Tool Learning in Large Language Models with
  Hierarchical Error Checklists" — https://arxiv.org/abs/2506.00042
- Li, Liu, Zhu, Yang, Deng, Jordan et al., "IDA-Bench: Evaluating LLMs on Interactive Guided Data
  Analysis" — https://arxiv.org/abs/2505.18223
- Jaroslawicz, Whiting, Shah & Maamari, "How Many Instructions Can LLMs Follow at Once?"
  (IFScale) — https://arxiv.org/abs/2507.11538 — cited for the instruction-budget mechanism;
  full treatment is in the sibling document
- Huang, Zhang, Zhang, Li & Kan, "Large Language Models Cannot Self-Correct Reasoning Yet" —
  https://arxiv.org/abs/2310.01798 — **cited from the sibling document, not re-read here**
- Kamoi, Zhang, Zhang, Han & Zhang, "When Can LLMs Actually Correct Their Own Mistakes?" —
  https://arxiv.org/abs/2406.01297 — **cited from the sibling document, not re-read here**

### Memory poisoning
- Chen, Xiang, Xiao, Song & Li, "AgentPoison: Red-teaming LLM Agents via Poisoning Memory or
  Knowledge Bases" — https://arxiv.org/abs/2407.12784
- Dong, Xu, He, Li, Tang, Liu, Liu & Xiang, "Memory Injection Attacks on LLM Agents via Query-Only
  Interaction" (MINJA) — https://arxiv.org/abs/2503.03704

### First-party vendor documentation used for the deployed-memory and skill-format claims
- Claude Code, "How Claude remembers your project" — https://code.claude.com/docs/en/memory
- Claude Code, "Extend Claude with skills" — https://code.claude.com/docs/en/skills
- Agent Skills open standard — https://agentskills.io
- Cognition, "Don't Build Multi-Agents" — https://cognition.com/blog/dont-build-multi-agents — **[V]**,
  cited only for the implicit-decisions argument behind failure 4

### Retrieval notes
- `web_search` returned results on some calls and refused all five providers on others. All five
  provider failure messages are recorded in the transcript; the pattern is a datacenter-egress
  block on DuckDuckGo, Ecosia, Google, and Mojeek, and intermittent refusal from Startpage. No
  claim in this document rests on a `web_search` snippet.
- The arXiv API returned HTTP 429 on several queries. Affected queries were re-issued or replaced
  with direct `arxiv.org/abs/<id>` reads, which were not rate-limited.
- The OpenAlex API returns 0 results for several individual arXiv DOIs (for example
  `10.48550/arxiv.2503.13657` and `10.48550/arxiv.2502.12110`) even though the papers resolve.
  Citation counts are therefore given only where a record was actually found, and their absence
  is not evidence of low impact.
````

---

### Verification I actually performed

- Read `docs/research/agent-workflow-research.md` in full structure (1,141 lines) and in detail at
  §6 (known failure modes), the recommendations (R1–R8), open questions, and sources, to avoid
  duplication. Two of its sources (self-correction papers) and one of its claims (IFScale) are
  referenced here rather than re-argued, and marked as such in the source list.
- Read all four existing `skills/*/SKILL.md` files and `package.json` and `docs/README.md` so
  every proposal names a file that exists and respects the repo's structure.
- Resolved and read every arXiv abstract cited: 2404.13501, 2504.15965, 2603.07670, 2310.08560,
  2304.03442, 2502.12110, 2505.22101, 2504.19413, 2501.13956, 2410.10813, 2511.20857, 2308.10144,
  2409.07429, 2305.16291, 2408.08435, 2507.21046, 2607.22529, 2605.24117, 2601.10343, 2503.13657,
  2608.21423, 2506.00042, 2505.18223, 2507.11538, 2407.12784, 2503.03704.
- Read OctoBench's full HTML (results tables, category analysis, conflict study, feedback
  experiment) rather than its abstract, because every load-bearing number in §3.3 and §5 comes
  from the body.
- Read Claude Code's `memory` and `skills` documentation directly for every claim about deployed
  memory behaviour, including the 200-line/25KB cap, the `modified` timestamp, the write filter,
  and the contradiction rule.
- Queried OpenAlex for citation counts where a record existed, and recorded where one did not.

### Gaps I could not close

- No controlled study of *whether a session-derived note reduces the recurrence of a failure* was
  found. This is the one class §4 assigns to MEMORY, so the document's central claim is
  supported by general principles rather than a direct measurement. It is recorded as open
  question 2 rather than papered over.
- No published measurement of skill-consultation rate in a non-annotated codebase, so M4's value
  cannot be quantified locally without harness instrumentation.
- The arXiv API rate-limited several searches; two planned queries (memory consolidation /
  forgetting, and a post-mortem on a deployed agent memory system) were replaced with the
  2603.07670 open-problems list and vendor documentation rather than left unsourced.
