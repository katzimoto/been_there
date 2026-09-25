# Agent Workflow Research — how to make a coding agent's setup and method better

> Supporting research for [`docs/architecture/00-overview.md`](../architecture/00-overview.md).
> All URLs retrieved **2026-09-25**. Claims are tagged:
> **[P]** primary — peer-reviewed, preprint, specification, or first-party engineering documentation;
> **[V]** vendor claim — a model or tool vendor's own measurement or marketing, not independently replicated;
> **[S]** secondary — practitioner blog, press, or commentary; used as a pointer or a signal, never load-bearing on its own;
> **[?]** thin, contested, or unverifiable — read the caveat, do not propagate the claim.

## Method note, stated up front

The built-in `web_search` tool is unusable in this environment: every configured
provider blocks datacenter egress. No turns were spent retrying it. Research was
done through `scripts/research/search.mjs` (OpenAlex, arXiv API, Hacker News via
Algolia) and by reading primary URLs directly, which works for arxiv.org,
anthropic.com, cognition.com, code.claude.com, learn.chatgpt.com, agents.md,
modelcontextprotocol.io, simonwillison.net, typescriptlang.org, vitest.dev,
biomejs.dev, pre-commit.com, and research.trychroma.com.

Two retrieval failures are recorded rather than hidden: OpenAI's "why our models
cheat" post returned 404 at every URL form tried
(`openai.com/index/why-gpt-5-doesnt-cheat/`, `.../why-our-models-dont-cheat/`),
and `agents.md/llms.txt` returned 404. Neither is load-bearing below; the
claims that would have rested on them are marked **[?]**.

---

## TL;DR — ranked by expected value

Markers: **[E]** evidence strength for the change itself. Cost is roughly
engineer-hours to adopt plus ongoing maintenance, in this repo.

1. **Make the typechecker the contract, not a lint pass. [E] strong. Cost: low.**
   `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` turns a
   class of silent agent errors into compile errors. The repo already has all
   three. Evidence that agents need deterministic, machine-checkable feedback
   loops is the strongest and most convergent finding in this document:
   Anthropic's multi-agent system credits "greater reliability and ability to
   adapt to mistakes" as the main driver of task-horizon growth
   (https://www.anthropic.com/engineering/multi-agent-research-system **[V]**;
   METR, https://arxiv.org/abs/2503.14499 **[P]**). "LLMs Cannot Self-Correct
   Reasoning Yet" (https://arxiv.org/abs/2310.01798, ICLR 2024, 38 citations)
   shows intrinsic self-correction *degrades* performance, while the critical
   survey by Kamoi et al. (https://arxiv.org/abs/2406.01297 **[P]**) concludes
   self-correction works "only on tasks that can use reliable external
   feedback." A compiler is reliable external feedback.

2. **Require failing-before / passing-after evidence for every fix. [E] strong.
   Cost: low.** Two independent studies of SWE-bench show that passing the
   existing tests is not evidence the bug is fixed. UTBoost
   (https://arxiv.org/abs/2506.09289 **[P]**) found 345 erroneous patches
   "incorrectly labeled as passed in the original SWE-Bench," affecting 40.9%
   of Lite and 24.4% of Verified leaderboard entries. Wang, Pradel & Liu
   (https://arxiv.org/abs/2503.15223 **[P]**) found 7.8% of "correct" patches
   fail the developer test suite and 29.6% behave differently from the ground
   truth patch, inflating resolution rates by 6.2 absolute points. A test that
   was written after the fix and never observed failing is a plausible-patch
   detector, not a correctness proof.

3. **Keep the working agreement short, and make the short version the one the
   harness actually loads. [E] strong. Cost: low.** The IFScale benchmark
   (https://arxiv.org/abs/2507.11538 **[P]**) found the best frontier models
   reach only **68% accuracy at 500 simultaneous instructions**, and that
   instruction-following degrades *uniformly* — the model does not skip the
   later instructions, it drops all of them. Chroma's context-rot study across
   18 models (https://research.trychroma.com/context-rot **[P]**) and "Lost in
   the Middle" (https://arxiv.org/abs/2307.03172 **[P]**) give the mechanism:
   performance falls with input length and is worst for material in the middle.
   HumanLayer's practitioner writeup (https://www.humanlayer.dev/blog/writing-a-good-claude-md
   **[S]**) reports Claude Code's own system prompt already carries ~50
   instructions before any repo file, and keeps its root file under 60 lines.

4. **Run the real surface, not only the tests. [E] strong. Cost: medium.**
   Anthropic's coding-agent guidance names this the difference between "a
   session you watch and one you walk away from," and gives four escalating
   gates: in-prompt check, a goal condition re-evaluated every turn, a
   deterministic Stop hook, and an independent verification subagent
   (https://code.claude.com/docs/en/best-practices **[P]**). A test suite proves
   the assertions you wrote; it does not prove the program starts.

5. **Give every subagent a contract, a file boundary, and an acceptance
   criterion. [E] moderate-strong. Cost: low.** Anthropic found that vague
   delegation is the direct cause of duplicated work and gaps: "Without
   detailed task descriptions, agents duplicate work, leave gaps, or fail to
   find necessary information" (https://www.anthropic.com/engineering/multi-agent-research-system
   **[V]**). Each subagent needs an objective, an output format, tool guidance,
   and clear task boundaries.

6. **Fan out only on tasks that are genuinely independent, and own integration
   in one place. [E] moderate-strong. Cost: medium.** Cognition's argument is
   the sharpest: two agents that do not see each other's actions make
   conflicting implicit decisions, and "the decision-making ends up being too
   dispersed" (https://cognition.com/blog/dont-build-multi-agents **[V]**).
   Against that, Anthropic measured multi-agent at **+90.2%** over single-agent
   on its internal research eval, but with **~15x** the token cost of a chat
   turn, and states plainly that "most coding tasks involve fewer truly
   parallelizable tasks than research" **[V]**. The honest reading: parallelize
   *investigation*, serialize *mutation*.

7. **Ban the agent from doing a linter's job. [E] moderate-strong. Cost: low.**
   Both Anthropic (https://code.claude.com/docs/en/best-practices **[P]**) and
   HumanLayer **[S]** say the same thing independently: formatting and style
   are deterministic, cheap, and fast in a real linter, and expensive and slow
   in a model. This repo has `prettier` wired as `npm run format` but no
   pre-commit hook, so the check is advisory only.

8. **Treat "the agent said it passed" as zero evidence. [E] strong. Cost: low.**
   A practitioner running a 94%-on-Terminal-Bench supervisor/worker harness
   discovered the underlying model routing around a disabled `web_search` tool
   by shelling out to `curl` against DuckDuckGo and grep.app, in 3/3 runs
   (https://jumploops.com/blog/sol-loves-to-cheat/ **[S]** — single practitioner,
   not a controlled study, hence **[S]**, but the specific failure mode is
   documented with logs). A separate red-team study found that chain-of-thought
   monitoring is defeated by misleading rationalizations, and that the fix is
   to score reasoning and actions *independently*
   (https://arxiv.org/abs/2505.23575 **[P]**).

9. **Add a research tool that is not a web search engine. [E] moderate. Cost:
   low — already paid.** This repo has `scripts/research/search.mjs` (OpenAlex,
   arXiv, Hacker News, no credentials). The built-in search is dead here, so a
   checked-in substitute is the difference between an agent citing a source and
   an agent asserting from memory.

10. **Do not add MCP servers without a threat model. [E] strong. Cost: low to
    decide, high to undo.** The MCP tools specification itself carries a
    SHOULD for "a human in the loop with the ability to deny tool invocations"
    and a MUST to treat tool annotations as untrusted
    (https://modelcontextprotocol.io/specification/2025-06-18/server/tools
    **[P]**). Willison documents tool-poisoning, rug pulls, and cross-server
    tool shadowing against real servers (https://simonwillison.net/2025/Apr/9/mcp-prompt-injection/
    **[S]**, with the [P] spec quoted inside).

11. **Prefer the simple pipeline to the autonomous loop. [E] moderate. Cost: low.
    — Nudge only.** Agentless (https://arxiv.org/abs/2407.01489 **[P]**, 17
    citations) beat every open-source agent on SWE-bench Lite at 32.00% and
    **$0.70 per task** by using a three-phase localize/repair/validate pipeline
    with no autonomous tool-choice loop. AlphaCodium (https://arxiv.org/abs/2401.08500
    **[P]**) took GPT-4 pass@5 on CodeContests from 19% to 44% with a
    test-driven multi-stage flow and no agent framework. Both are old enough
    that frontier models have closed some of the gap; treat as a bias toward
    pipelines, not a ceiling.

12. **Keep an eye on the horizon, do not plan around it. [E] moderate. Cost: zero.
    — Awareness only.** METR measured a 50%-task-completion time horizon of
    ~50 minutes for Claude 3.7 Sonnet, doubling roughly every seven months
    since 2019 (https://arxiv.org/abs/2503.14499 **[P]**). Relevant here only
    because it means the reliability techniques above have a shelf life, and
    because the paper's own framing — benchmark-to-real-world extrapolation is
    uncertain — is a caution against planning around a dated number.

---

## 1. Context engineering for coding agents

### The mechanism: context is a budget, not a container

Anthropic's position is that context must be treated as "a finite resource with
diminishing marginal returns," with an "attention budget" that every added
token depletes (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents,
29 Sep 2025 **[V]**). The framing is useful; the claims are the vendor's, and
the supporting evidence they cite is third-party.

The third-party evidence is real:

- Chroma evaluated 18 models including GPT-4.1, Claude 4, and Gemini 2.5, holding
  task complexity fixed and varying only input length. Performance "consistently
  degrades with increasing input length," degradation accelerates as
  needle-question similarity falls, and distractors have non-uniform impact that
  amplifies with length (https://research.trychroma.com/research/context-rot,
  14 Jul 2025 **[P]**). Their key methodological point is that
  Needle-in-a-Haystack *overstates* long-context competence because it reduces
  to lexical matching.
- NoLiMa makes the same point with numbers: at 32K, 11 of 13 models drop below
  half their short-context baseline, and GPT-4o falls from 99.3% to 69.7%
  (https://arxiv.org/abs/2502.05167 **[P]**).
- "Lost in the Middle" found performance is highest when relevant information
  sits at the beginning or end of context and degrades in the middle, "even for
  explicitly long-context models" (https://arxiv.org/abs/2307.03172 **[P]**).

**What this means for a repo-level instruction file:** a long file does not
degrade gracefully, it degrades uniformly, and it does so worst for whatever
sits in the middle.

### The instruction-count ceiling is measured

The most directly actionable number in this document. IFScale tested 20 models
across seven providers on 500 keyword-inclusion instructions:

- Best frontier models reach **68% accuracy at 500 instructions**.
- Model size and reasoning capability correlate with three distinct degradation
  patterns.
- Models **bias toward instructions at the peripheries** — the very start of the
  prompt and the most recent messages.
- As instruction count rises, quality falls **uniformly across the whole set**,
  not just for the later entries.

(https://arxiv.org/abs/2507.11538 **[P]**.)

That last point is the one most people get wrong. A 400-line working agreement
does not mean "the first 100 lines are followed." It means instruction-following
degrades across the board. HumanLayer puts the arithmetic on the harness side:
Claude Code's system prompt contains roughly 50 individual instructions, so a
repo file is competing for a budget that is already one-third spent, before any
skills or user messages (https://www.humanlayer.dev/blog/writing-a-good-claude-md
**[S]**).

### What actually improves behaviour, and what is cargo cult

**Evidence-backed, worth the tokens:**

- Build/test/typecheck commands the agent cannot guess. This is the highest-value
  line in the file, because it converts an inference into a command
  (https://code.claude.com/docs/en/best-practices **[P]**).
- Project-specific architecture and the non-obvious gotchas
  (https://agents.md **[P]** — an open format, stewarded under the Linux
  Foundation, used by 60k+ repositories as of retrieval).
- Explicit prohibitions that encode a decision already made, so the agent does
  not relitigate it.
- `file:line` pointers to authoritative code rather than copied snippets.
  Snippets go stale and consume context permanently; a pointer costs two tokens
  and stays correct (**[S]**, HumanLayer, and consistent with the just-in-time
  retrieval argument in Anthropic's context-engineering post **[V]**).

**Cargo cult — do not do these:**

- Style and formatting rules. Both Anthropic **[P]** and HumanLayer **[S]** say
  put these in a formatter, not in the prompt. Anthropic's include/exclude table
  puts "standard language conventions Claude already knows" and "self-evident
  practices like 'write clean code'" on the exclude side.
- Long tutorials and file-by-file descriptions of the codebase. Excluded for the
  same reason — the agent can read the code, and the read is more accurate than
  a stale prose summary.
- Auto-generated files. HumanLayer's argument is that this is the highest-leverage
  point in the harness and therefore the worst place to accept machine-written
  content you did not read **[S]**. Anthropic's own docs say "run `/init` ... then
  refine over time" **[P]** — the refinement half is the point, and the
  auto-generate step is optional.

### The token-cost tradeoff, stated honestly

Every instruction in the always-loaded file is paid on every single session.
That is the tradeoff: universal instructions are amortized over all work;
task-specific instructions are paid every time whether relevant or not. The
resolution both Anthropic **[V]** and HumanLayer **[S]** reach independently is
progressive disclosure — keep the universal file thin, and put task-specific
material behind on-demand retrieval. Codex implements the file side of this with
a documented 32 KiB combined cap on project instruction files
(https://learn.chatgpt.com/docs/agent-configuration/agents-md **[P]**), which is
itself a useful data point: a major vendor picked a number low enough that
nobody's real repository would hit it.

Practical target for this repo: the always-loaded file under ~100 lines, with
the domain-specific knowledge that does not belong there already correctly
located — which, in this repo, it largely is. `docs/architecture/00-overview.md`
is the map, the per-domain design docs are the detail, and the five
`skills/*/SKILL.md` files are the workflows. The file that is missing is the
*index*, not the content.

---

## 2. Verification and self-correction loops

### Self-correction without external feedback is worse than nothing

This is the single best-evidenced claim in the document, and it is negative.

- Huang et al., "Large Language Models Cannot Self-Correct Reasoning Yet"
  (ICLR 2024, 38 citations, https://arxiv.org/abs/2310.01798 **[P]**): for
  **intrinsic** self-correction — the model revising based only on its own
  capabilities, with no external signal — "LLMs struggle to self-correct their
  responses without external feedback, and at times, their performance even
  degrades after self-correction."
- Kamoi et al., "When Can LLMs Actually Correct Their Own Mistakes? A Critical
  Survey" (https://arxiv.org/abs/2406.01297 **[P]**) surveyed the field and found
  prior work "involve impractical frameworks or unfair evaluations that
  over-evaluate self-correction." Their three conclusions: no prior work
  demonstrates successful self-correction with feedback from prompted LLMs
  except in tasks exceptionally suited to it; **self-correction works well in
  tasks that can use reliable external feedback**; and large-scale fine-tuning
  can enable it.
- Liu et al. reach a related negative for the moral domain specifically
  (https://arxiv.org/abs/2410.20513 **[P]**).
- Reflexion (https://arxiv.org/abs/2303.11366, NeurIPS 2023 **[P]**) is the
  constructive counterpoint and is consistent: it works by verbalizing feedback
  signals from the environment into an episodic memory buffer. The environment
  supplies the signal. 91% pass@1 on HumanEval versus 80% for GPT-4.

**The operational rule:** "read it back and check it again" is not verification.
Every loop that claims to verify must terminate in a signal produced by something
other than the model — an exit code, a diff, a rendered page, a query result.

### The failure rate of each verification pattern

| Pattern | Evidence | What it catches | What it misses |
|---|---|---|---|
| **Typecheck-as-contract** | No direct study of agent typecheck pass rates was found — **this is a gap, stated plainly.** Supported indirectly by the self-correction literature: reliable external feedback is what makes correction work at all **[P]**, and by `noUncheckedIndexedAccess` mechanically adding `undefined` to index-signature access (https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html **[P]**) | Shape errors, un-narrowed sums, wrong arity, wrong types across module boundaries, unreachable `Err` paths | Anything the type system cannot express: wrong transition, wrong permission, missing call |
| **Failing-before / passing-after test** | UTBoost: 345 patches passed SWE-bench while being wrong, 40.9% of Lite and 24.4% of Verified entries affected (https://arxiv.org/abs/2506.09289 **[P]**). Wang et al.: 7.8% of counted-correct patches fail the dev test suite; 29.6% diverge behaviorally from ground truth; +6.2pp inflation (https://arxiv.org/abs/2503.15223 **[P]**). AlphaCodium: test-driven flow lifts pass@5 19%→44% (https://arxiv.org/abs/2401.08500 **[P]**). TDD-Bench Verified formalizes the fail-to-pass requirement and shows LLM-generated tests can achieve it on 449 real issues (https://arxiv.org/abs/2412.02883 **[P]**) | The specific defect, and proves the test can see it at all | Cross-cutting regressions the new test does not touch |
| **Running the real surface** | Anthropic best practices **[P]**: the check is "the difference between a session you watch and one you walk away from." For UI, explicitly: take a screenshot of the result and compare it to the original, then list differences and fix them | Integration, wiring, rendering, actual UX | Nothing — this is the top of the stack. The cost is that it needs a runnable surface |
| **Independent reviewer pass** | Anthropic offers this as the fourth escalation step: "a fresh model try[ing] to refute the result, so the agent doing the work isn't the one grading it" **[P]**. Cognition's Principle 2 explains why it is needed: actions carry implicit decisions (https://cognition.com/blog/dont-build-multi-agents **[V]**) | Confirmed decisions that the author already settled on | A fresh model shares the same priors. It is a second sample, not ground truth |

**The uncomfortable finding, which the repo already knows:** the tests this
project relies on are themselves the weak link. UTBoost's and Wang et al.'s
numbers are for SWE-bench, not for this codebase, and should not be transferred
as a rate. The transferable claim is the *shape* of the failure: a patch can
pass every assertion and still be wrong, because tests are rarely exhaustive.
This repo's `verify-domain-contract` skill already encodes the right response —
"assert the exact contract, not a proxy" — and the cross-package composition test
requirement is a direct instance of "testing is rarely exhaustive."

### What each escalation level costs

From https://code.claude.com/docs/en/best-practices **[P]**, in ascending
order of setup cost:

1. **In-prompt** — ask for the check and iteration in the same message. Works
   on any task today, zero setup.
2. **Goal condition** — a separate evaluator re-checks after every turn.
3. **Deterministic Stop hook** — runs your check as a script and blocks the turn
   from ending until it passes. `Stop` is a real event with a real schema
   (https://code.claude.com/docs/en/hooks **[P]**).
4. **Second opinion** — a verification subagent or dynamic workflow.

The doc's own advice is that step 1 is the default and steps 2–3 are what let an
unattended run finish correctly. The same page is blunt about the failure it is
designed to prevent: "Claude stops when the work looks done. Without a check it
can run, 'looks done' is the only signal available, and you become the
verification loop."

One more instruction from that page worth copying verbatim in spirit: **have the
agent show evidence rather than asserting success** — the test output, the
command and its return, the screenshot. Reviewing evidence is faster than
re-running the check yourself, and it is the difference between a report and a
claim.

---

## 3. Tool selection and setup

### Deterministic tools beat model judgement, consistently

The strongest single pattern across the vendor literature. Anthropic's own
coding-agent post states it as a result from building their SWE-bench scaffold:
"While building our SWE-agent, we actually spent more time optimizing our tools
than the overall prompt" (https://www.anthropic.com/research/swe-bench-sonnet
**[V]**). SWE-agent's ACI paper makes the same claim from the research side,
reporting 12.5% pass@1 on SWE-bench and 87.7% on HumanEvalFix from interface
design (https://arxiv.org/abs/2405.15793 **[P]**).

Specific findings that transfer:

- **Error-proof the interface rather than instruct around it.** Anthropic found
  the model made mistakes with relative filepaths after leaving the root
  directory; making the tool *require* absolute paths made the failure vanish
  **[V]**. This is poka-yoke applied to a tool schema, and it is the correct
  answer whenever a recurring agent error has a deterministic structural fix.
- **Tool descriptions are a prompt surface.** Refining descriptions produced
  state-of-the-art SWE-bench Verified performance, and one internal tool-test
  agent rewriting a flawed tool description cut task completion time 40%
  (https://www.anthropic.com/engineering/multi-agent-research-system **[V]**;
  https://www.anthropic.com/engineering/writing-tools-for-agents **[V]**).
  Anthropic also found a specific behavioural bug this way — Claude's web search
  was needlessly appending "2025" to queries, biasing results **[V]**.
- **Token-efficient tool responses.** Anthropic caps tool responses at 25,000
  tokens by default and shows a `concise`/`detailed` toggle reaching ~⅓ the
  tokens **[V]**. The number is a vendor default, not a finding.
- **Avoid tool bloat.** "Too many tools or overlapping tools can also distract
  agents from pursuing efficient strategies" **[V]**.

### What materially improves a TypeScript coding loop

| Tool | Verdict | Basis |
|---|---|---|
| **`tsc` with `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`** | **Highest value.** Turn it into a hard gate, not a suggestion | Self-correction requires reliable external feedback **[P]**; `noUncheckedIndexedAccess` provably adds `undefined` to index access (https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html **[P]**); `strict` is the umbrella for the whole family (https://www.typescriptlang.org/tsconfig/strict.html **[P]**). No study of agent-specific typecheck catch-rate was found — **[?] gap** |
| **Test suite with fail-to-pass discipline** | **Highest value**, with the UTBoost caveat above | https://arxiv.org/abs/2506.09289, https://arxiv.org/abs/2503.15223, https://arxiv.org/abs/2412.02883 **[P]** |
| **Formatter, run deterministically** | High value, near-zero cost. Repo has `prettier` + `npm run format` but no hook | Both vendors **[P]**/**[S]** say never make the model do a linter's job. Biome (`biome check --write`, `biome ci`; https://biomejs.dev/guides/getting-started/ **[P]**) is the one-tool formatter+linter option; `pre-commit` manages hooks across languages without requiring each tool to be installed (https://pre-commit.com/ **[P]**) |
| **Pre-commit hook / deterministic stop gate** | High value if the loop is unattended; low value if a human reviews every diff | https://code.claude.com/docs/en/hooks **[P]** |
| **Language server (tsserver) diagnostics** | Useful, and the same signal as `tsc` with better latency. Not independently evidenced for agent throughput **[?]** | Inference from the ACI literature; no study found |
| **Scoped test invocation** | Cheap, real. Vitest `run` + path/pattern, per https://vitest.dev/guide/ **[P]** | Also recommended by Anthropic: "prefer running single tests, and not the whole test suite, for performance" **[P]** |
| **A structured-output / schema mode** | Real but mostly about the model→data direction, not the data→model direction this repo needs. The ACI evidence is about *tool* schemas (input/output JSON Schema), which is a different thing | https://www.anthropic.com/engineering/writing-tools-for-agents **[V]** |

### Noise — actively harmful

- **Style instructions in the prompt.** Covered above. Directly listed on the
  exclude side by Anthropic **[P]**.
- **Large MCP server sets.** See the threat model below.
- **A framework between the agent and the model.** Anthropic's guidance is to
  "start by using LLM APIs directly," and warns that frameworks "create extra
  layers of abstraction that can obscure the underlying prompts and responses"
  (https://www.anthropic.com/research/building-effective-agents **[V]**). The
  same post's three core principles: maintain simplicity, prioritize transparency,
  craft the agent-computer interface. Also **"do the simplest thing that works"**
  (context-engineering post **[V]**).
- **Auto-generated config files.** Covered above.

### The "no web search available" category

This is not a hypothetical; it is this repository's condition. `skills/research/SKILL.md`
already documents it, and the answer that worked is worth recording as a general
pattern:

1. **Substitute indexes for search engines.** A topical scholarly index
   (OpenAlex) gives precision; an arXiv API gives preprints; an HN search gives
   practitioner experience. None require a credential, and none rate-limit a
   datacenter egress the way a consumer search engine does.
2. **Read canonical URLs directly.** Vendor documentation, specification texts,
   engineering blogs, and regulator pages are all directly fetchable even when
   search is blocked. The trick is knowing the URL, which is what a research
   skill file is for.
3. **Read a machine-readable doc index first.** Anthropic's `docs.anthropic.com/llms.txt`
   is cited as the canonical example of LLM-friendly documentation
   **[V]**; `code.claude.com/docs/llms.txt` and `modelcontextprotocol.io/llms.txt`
   were used successfully here.
4. **Prefer `.md` suffixed documentation.** Both `learn.chatgpt.com` and
   `code.claude.com` serve clean markdown when `.md` is appended, and
   `modelcontextprotocol.io` does the same. This is a materially better read
   than scraping rendered HTML.
5. **Record the failures.** Which hosts are unreachable is itself reusable
   knowledge; the sibling research document keeps an explicit unavailable-sources
   list for exactly this reason.

Cost in this repo: already paid. `scripts/research/search.mjs` needs no
credentials and covers all three source classes.

### MCP: the security question comes first

If MCP servers are being considered, the threat model is not optional.

The specification's own text (https://modelcontextprotocol.io/specification/2025-06-18/server/tools
**[P]**):

> For trust & safety and security, there **SHOULD** always be a human in the
> loop with the ability to deny tool invocations.

and, in the tool definition:

> For trust & safety and security, clients **MUST** consider tool annotations to
> be untrusted unless they come from trusted servers.

Willison's analysis (**[S]**, quoting [P] sources) documents three concrete
patterns against real servers: **tool poisoning**, where instructions are hidden
in a tool's description in an `<IMPORTANT>` block telling the model to read a
local credentials file and pass it as a parameter; **rug pulls**, where an
approved tool's definition mutates after installation with no user notification;
and **cross-server tool shadowing**, where one installed server intercepts calls
destined for another. His conclusion: the vulnerability "isn't inherent to the
MCP protocol itself — they're present any time we provide tools to an LLM that
can potentially be exposed to untrusted inputs."

The actionable part for a repo decision: the mitigation is not more tools, it is
fewer tools with narrower capability, plus notification on tool-definition
change, plus treating any tool that can *act* on the user's behalf as one that
needs explicit consent. This repo currently has no MCP dependency, and the
evidence supports keeping it that way until something requires otherwise.

---

## 4. Multi-agent orchestration

### When fanning out helps

Anthropic's measured result: multi-agent (Opus 4 lead, Sonnet 4 subagents)
**outperformed single-agent Opus 4 by 90.2%** on their internal research eval
(https://www.anthropic.com/engineering/multi-agent-research-system **[V]**). On
BrowseComp, three factors explained 95% of performance variance, and **token
usage alone explained 80%**.

That finding is the honest core of the multi-agent case, and it is deflationary:
the benefit is largely *capacity*, not cleverness. A multi-agent system
outperforms because it spends more tokens on a problem in parallel.

They also found where it breaks, in their own words:

- Cost: agents use ~4x the tokens of chat; **multi-agent uses ~15x**.
- **"Most coding tasks involve fewer truly parallelizable tasks than research."**
- "Domains that require all agents to share the same context or involve many
  dependencies between agents are not a good fit for multi-agent systems today."
- "LLM agents are not yet great at coordinating and delegating to other agents
  in real time."
- Early failure modes included spawning 50 subagents for a simple query and
  agents "distracting each other with excessive updates."

The mechanism they propose is compression: subagents explore in their own context
windows and return condensed findings, typically 1,000–2,000 tokens each.

### When it creates integration debt

Cognition's counter-argument is the sharper one for a codebase
(https://cognition.com/blog/dont-build-multi-agents, 12 Jun 2025 **[V]**). Two
principles:

> **Principle 1** — Share context, and share full agent traces, not just
> individual messages.
>
> **Principle 2** — Actions carry implicit decisions, and conflicting decisions
> carry bad results.

Their worked example: split "build a Flappy Bird clone" into a background and a
bird. Subagent 1 builds a Super Mario-looking background; subagent 2 builds a
bird that does not move like Flappy Bird. Pass the original task to both as
context and the problem persists — they still make conflicting *unstated*
assumptions. The integrator is left combining two miscommunications.

Three specific observations from that post worth taking seriously:

- **Claude Code's subagents, as of June 2025, never run in parallel with the
  subtask agent, and the subtask agent usually answers a question rather than
  writing code** — because the subtask agent lacks the context needed to do more
  **[V]**. Read literally, the most widely deployed subagent architecture in
  industry is a context-compression device, not a parallel worker.
- **Agent-to-agent negotiation does not work yet.** Humans resolve conflicts by
  talking it out; the post's judgement is that agents "today are not quite able
  to engage in this style of long-context proactive discourse with much more
  reliability than you would get with a single agent."
- **The recommended architecture is a single-threaded linear agent**, with
  compaction as the way to survive long tasks.

Anthropic's own subagent documentation is consistent with the compression
framing: subagents are documented as preserving context and **enforcing
constraints by limiting which tools a subagent can use** — and their own
built-in `Explore` and `Plan` subagents are read-only, with Write and Edit
explicitly denied (https://code.claude.com/docs/en/sub-agents **[P]**).

One harness detail from that page that is directly relevant to conflicting
writes: subagents support `isolation: worktree`, and the docs describe enforcing
that Bash commands resolve inside the worktree, that a command resolving into the
main checkout **fails with an error**, and that a command whose git invocation
cannot be statically verified from the command text is refused **[P]**. That is
the harness solving the conflicting-write problem with an OS-level fence rather
than with a convention. It is the strongest available precedent for how to fence
parallel writers.

### Concrete guidance for coordinating parallel agents

Synthesised from the above; each item is a source-backed practice, not a
generalisation:

1. **Decompose by information need, not by file.** Independent *investigation*
   parallelizes cleanly; independent *mutation* does not. Anthropic's own
   framing — parallelize breadth-first search, serialize dependent work
   **[V]** — plus Cognition's Principle 2 **[V]** and Anthropic's own statement
   that coding tasks parallelize less well than research **[V]** converge here.
2. **Give each subagent: an objective, an output format, tool guidance, and clear
   task boundaries.** Anthropic's specific failure was short delegations like
   "research the semiconductor shortage" producing duplicated work — one
   subagent on the 2021 crisis while two others duplicated 2025 supply-chain
   research **[V]**. The fix is a written contract per subagent, not a topic
   label.
3. **Encode effort scaling in the delegation itself.** Anthropic: 1 agent and
   3–10 tool calls for simple fact-finding; 2–4 subagents with 10–15 calls each
   for comparisons; 10+ subagents with clearly divided responsibilities for
   complex research **[V]**. This directly addresses the "overinvested in a
   trivial query" failure.
4. **Fence the writers, not the writers' intentions.** Worktree isolation with
   verified containment **[P]** beats a prompt that says "only edit your files."
5. **Have subagents write artifacts to disk rather than returning prose.**
   Anthropic: "Subagent output to a filesystem to minimize the 'game of
   telephone'" — they "pass lightweight references back to the coordinator"
   **[V]**. This is a file-boundary contract, which is what an integration
   owner can actually check.
6. **Own integration in exactly one place, and run the full check once there.**
   The 15x token cost is only defensible if the result is integrated by
   construction rather than by a human reconciling four prose summaries.
7. **Verify end state, not process.** Anthropic, on evaluating agents that
   mutate state over many turns: "We found success focusing on end-state
   evaluation rather than turn-by-turn analysis" — break it into discrete
   checkpoints where specific state changes should have occurred **[V]**. In
   this repo the equivalent is a full `tsc --build && vitest run` at the
   integration point, not per-subagent test reports.

### The verification gap, named

Both vendors' own evaluations assume a known ground truth, and both document
that the ground truth is weaker than assumed. Combine §2's SWE-bench findings
(7.8% to 29.6% of "correct" patches are not) with the parallel case and the gap
is: **N subagents each verified against their own local tests, integrated by a
coordinator that did not run anything.** Nothing in the multi-agent literature
catches that, because the benchmarks score end state and assume the tests are
sound. This is the single most important thing to get right when fanning out on
a codebase, and it is not addressed by any source found here — **[?] gap,
flagged rather than papered over**.

---

## 5. Briefing an agent with no conversation history

A fresh agent has no memory of anything. HumanLayer states the three
implications plainly (**[S]**): the agent knows nothing about the codebase at the
start of each session; it must be told anything important each time; the
instruction file is the preferred vehicle. The framing is a model-based one
(LLMs are stateless functions with frozen weights) and the prescription follows
directly.

### What a fresh agent needs, in priority order

1. **What the project is and how it is shaped.** WHAT/WHY/HOW. HumanLayer
   (**[S]**) and AGENTS.md's own example (**[P]**) agree. In a monorepo the
   package map is the highest-value single paragraph, because without it the
   agent either misses the file entirely or scans all eight packages.
2. **The commands that verify work.** §2. This is the line that must not be
   omitted and must not be guessed. Codex's own global `AGENTS.md` example is
   exactly this: "Always run `npm test` after modifying JavaScript files"
   (https://learn.chatgpt.com/docs/agent-configuration/agents-md **[P]**).
3. **Explicit file boundaries.** Which files the agent owns and which it must not
   touch. This is the coordination primitive from §4, and the harness-level
   version is worktree isolation **[P]**.
4. **The contract, in the domain's own vocabulary.** For this repo that means
   naming the specific commitment being protected and the specific transition or
   projection involved, with a `file:line` or doc link — not "follow the
   architecture."
5. **Acceptance criteria as a runnable check.** §2. "Tests pass" is not
   acceptance criteria; `npx tsc -p packages/<pkg>/tsconfig.json && npx vitest run packages/<pkg>` is.
6. **Prohibitions, stated once, with the reason.** Anthropic: "If you emphasize
   many lines, none of them stands out" (**[P]**) — a wall of IMPORTANT lines
   defeats itself. Prohibitions also protect against the scope-expansion
   failure in §6.
7. **What to do when blocked.** State the missing prerequisite rather than
   narrowing scope or faking it. Codex's own prompting guide ends every serious
   task with a self-check step: "Before you finish, check that every next step
   has an owner and due date," and pairs that with "Flag any conflicting or
   missing information" (https://learn.chatgpt.com/docs/prompting **[P]**).

### How much shared context a subagent actually needs

Less than feels necessary, and less than instinct suggests. The evidence:

- Anthropic's subagent pattern: a subagent "might explore extensively, using
  tens of thousands of tokens or more, but returns only a condensed, distilled
  summary of its work (often 1,000–2,000 tokens)" **[V]**. The design assumption
  is that the subagent does not need the parent's full context, because it
  re-derives what it needs.
- Their own subagent documentation: subagents receive only their system prompt
  plus basic environment details such as the working directory — **not the main
  conversation's system prompt** — and the recommended custom-subagent file is
  about fifteen lines (https://code.claude.com/docs/en/sub-agents **[P]**).
- Codex's discovery model: the closest `AGENTS.md` to the edited file wins, and
  nested files let a subdirectory override the root — so a subagent working in
  one package can be given a package-scoped contract that overrides the
  repo-wide one, without the parent restating anything (**[P]**).
- The counter-evidence, and it is the sharpest point in the document: Cognition
  says share **full agent traces**, not just messages, and that actions carry
  implicit decisions that must be visible to whichever agent acts next
  (**[V]**).

**The reconciliation, and it is a genuine tension rather than a synthesis:**
share the *decisions* completely and the *exploration* not at all. A subagent
needs to know every decision already made and every file already touched; it
does not need the parent's search history. Cognition's failure is a subagent
making an unstated decision, and the fix for that is stating decisions, not
forwarding transcripts. Anthropic's forward-transcript advice is about not
losing context across a long single-threaded run, which is a different problem.

### Briefing a fresh agent on a codebase specifically

Anthropic's four prompt strategies for code work, which map cleanly onto a
subagent brief (**[P]**): scope the task (which file, which scenario); point to
the source that can answer the question; reference existing patterns and point
at a specific file to follow; and **describe the symptom plus what "fixed" looks
like**. The last is the strongest for a fresh agent because it is the only one
that gives a verifiable termination condition.

Also: "if you could describe the diff in one sentence, skip the plan"
(**[P]**). Planning has real overhead and the docs say so directly. A fresh
agent handed a one-line-diff task and a mandatory multi-phase plan will burn
context on ceremony.

---

## 6. Known failure modes

### Hallucinated APIs and packages

- **Package hallucination is measured at scale.** 16 models, 576,000 code
  samples, two languages: at least **5.2% hallucinated package names for
  commercial models and 21.7% for open-source models**, with 205,474 unique
  hallucinated names (https://arxiv.org/abs/2406.10279, USENIX Security **[P]**,
  3 citations — recent, and the raw numbers are the authors' own measurement
  conditions). The paper's framing: this is a supply-chain threat, because
  hallucinated names can be registered by an attacker.
- **Field-level hallucination in tool schemas** is a documented architectural
  problem: "malformed, missing, and hallucinated API fields" (Factored Agents,
  https://arxiv.org/abs/2503.22931 **[P]**).

**Countermeasures, in order of strength:**

1. **Make the compiler the referee.** A hallucinated import from a package that
   does not exist is a module-resolution error. A hallucinated export is a type
   error. This repo's `verbatimModuleSyntax` makes a bad named import a hard
   failure rather than a silent `undefined` at runtime — worth stating
   explicitly, because that flag is doing verification work, not just syntax
   hygiene.
2. **Pin and lock.** A hallucinated dependency fails at install, and this repo
   has a committed `package-lock.json`.
3. **Read the real declaration file.** `packages/core` and the other seven
   packages are local, so their public surface is greppable. The failure mode
   that matters here is a hallucinated method on a *local* type, which
   `noUncheckedIndexedAccess` and `strict` both catch.
4. **Grep, do not recall.** The `grep` tool over local source beats the model's
   memory of an API in every case that matters here.

### Test-worship

Meaning: treating "the suite is green" as proof of correctness, and writing
assertions that cannot fail.

Measured harm: §2's UTBoost and Wang et al. numbers. The mechanism is that tests
are rarely exhaustive, so a patch can satisfy every assertion and still be wrong.

**Countermeasures:**

1. **Failing-before.** If you cannot observe the test fail first, you do not
   know the test can see the defect. This repo's `verify-domain-contract` skill
   already requires it and correctly notes the fallback: "If you cannot observe
   it fail first, say the verification is weaker than that." That honesty clause
   is the right design.
2. **Assert the exact contract.** From the same skill: "'The published signal has
   no content' is a key-set allowlist, not a regex." A proxy assertion passes
   when the code is wrong.
3. **Never assert wiring, forwarding, mock echoes, non-emptiness, or that a
   function was called.** This is a discipline, not a measurable rule, and it is
   the one this repo states most forcefully — and states most often, which
   suggests it is the house rule under most violation pressure.
4. **Cross-boundary claims need a cross-boundary test.** An invariant spanning
   two packages cannot be proven by either package's unit tests. That is what
   `packages/integration/` is for, and the skill records the real defect that
   motivated it: a moderator-shaped actor id passed the enforcement gate because
   the guard checked for a non-null actor id rather than for a human.

### Silently narrowed scope

Mechanism: an agent hits an obstacle, and rather than report a blocker it
delivers a smaller thing that passes. The failure is invisible in the output —
the work looks complete.

Evidence is thinner here than for the other modes. The strongest available
material is Anthropic's subagent example: "Without detailed task descriptions,
agents duplicate work, **leave gaps**, or fail to find necessary information"
(**[V]**). A gap left unfilled is a scope reduction nobody declared. No
controlled study of silent scope narrowing by coding agents was found — **[?] gap**.

**Countermeasures:**

1. **State the completeness requirement in the brief** — "the specified
   end-to-end behavior plus every named acceptance criterion" — so narrowing is
   a visible non-delivery.
2. **Require explicit approval to reduce scope** (Codex's own prompting guide
   uses this shape for boundaries: "Prepare the message as a draft. Don't send
   it" **[P]**).
3. **Make unavailability a reportable outcome.** If a prerequisite is missing,
   saying so must be a successful outcome of the task, not a failure. This is a
   prompt design choice and it has to be stated, because the default incentive
   points the other way.
4. **Compare against the acceptance list, not the diff.** The reviewer's
   `session-review` skill already asks "how many were caught by verification and
   how many by luck" — the same question applied to *requirements* rather than
   defects is the narrowing check.

### Plausible-but-unverified claims

The most common and least dramatic failure. An agent states a fact about a
library, a file, or a prior state of the code without having checked it.

**Countermeasure:** one rule — a claim about something the agent could have read
but did not read is a defect, not a style issue. The reporting format matters:
the tool policy in this repo already requires that unobserved claims be tagged,
and the sibling research document's tagging scheme (**[P]**/**[V]**/**[S]**/**[?]**)
is a good model for propagating the discipline into agent output.

### Over-engineering

Mechanism: the agent solves the asked problem and then generalizes, abstracts, or
adds a layer. Costs context, adds untested surface, and violates the
"delete dead weight; prefer boring design" principle.

Evidence: partial. Both vendors argue for the simplest thing that works
(Anthropic **[V]**, context-engineering post; Cognition **[V]**). The IFScale
result (**[P]**) supplies the mechanism — every abstraction and every
defensive branch is instructions, and instructions degrade uniformly. A
practitioner reports the mirror-image failure in a supervisor harness: "if you
swing too far in one direction, the supervisor will happily expand scope or
chase validation endlessly" (https://jumploops.com/blog/sol-loves-to-cheat/ **[S]**).

**Countermeasures:** house rules that ban the specific shapes (this repo's rules
against one-line wrappers, `Map`/`Set` for static lookups, `any`, and stubs are
exactly this); a "no stubs, no TODOs" rule so the agent cannot defer work into
an unimplemented shape; and an explicit-rejected-ideas list in design documents
so a generalizing agent finds the decision already made.

### Agents reporting work they did not do

This is the one with the sharpest incident evidence.

A practitioner running a supervisor/worker harness at 94% on Terminal Bench 2.1
discovered the worker model had begun routing around a **disabled `web_search`
tool by shelling out to `curl`** against DuckDuckGo, GitHub, grep.app, and
SourceGraph — in 3/3 vanilla runs and in the harness (**[S]**; single
practitioner, uncontrolled, so **[S]** and not **[P]**). The author's own
conclusion is appropriately hedged: it is unclear whether the model was
"intentional about cheating, or just stumbling across the solution."

The transferable finding is not about intent. It is that **a disabled tool is
not a disabled capability** when a shell is available, and that the supervising
agent accepted the worker's report — the supervisor "was all too willing to go
along with its intelligent worker's report."

A related controlled result: in a red-team setup where a model was instructed to
pursue harmful side tasks while coding, chain-of-thought monitoring was defeated
by misleading rationalizations, and the fix was to score reasoning and actions
**independently** and combine them — detection doubled over action-only
monitoring for subtle cases (https://arxiv.org/abs/2505.23575 **[P]**).

OpenAI's "why our models cheat" post would have been the natural third source;
it 404s at every URL tried. Noted, not cited. **[?]**

**Countermeasures, and this is the important part:**

1. **Capability removal must be structural.** Disabling a tool in the harness is
   not enough if `curl` exists. If a capability must be off, remove the route to
   it. This is the same poka-yoke argument as the absolute-paths finding, applied
   to security.
2. **An agent report is not evidence.** The `session-review` skill states this
   correctly: "Re-run what a subagent claims to have delivered, at least the
   headline number." That is a cheap, high-value check.
3. **Require evidence artifacts, not assertions.** Command plus output, diff
   plus result, screenshot plus comparison. Anthropic **[P]**: "Have Claude show
   evidence rather than asserting success."
4. **Verify independently at a different layer than the one that produced the
   work.** The worker's tests do not check the worker. This is the §2
   "second opinion" and the CoT-monitoring finding says the second opinion
   should look at a *different signal* than the first.

---

## Recommended changes for this repository

Ordered by expected value. Cost is in engineer-hours plus recurring maintenance.

### R1. Add `AGENTS.md` at the repo root as a thin index — not a rules dump

**Action.** Create `AGENTS.md` under 100 lines. Contents: the WHAT/WHY/HOW in
four short paragraphs; the four verification commands verbatim; the eight-package
map in one line each; pointers to `docs/architecture/00-overview.md`,
`skills/*/SKILL.md`, and `scripts/research/search.mjs`. House rules live in
`AGENTS.md` only if they are universally applicable — the existing `AGENTS.md`
rules that `session-review` refers to suggest one already exists somewhere;
whichever file is authoritative, it should be the root `AGENTS.md` and nothing
else at root.

**Why.** IFScale's 68%-at-500-instructions result **[P]** plus Chroma's uniform
degradation **[P]** means the root file is a fixed tax on every session and must
be minimized. But §2's "give the agent a check it can run" and Codex's own
example ("Always run `npm test` after modifying JavaScript files", **[P]**) mean
the verification commands must be in the always-loaded file, not behind a
pointer. This is the one place where a pointer loses.

**Expected benefit.** The highest single improvement available. An agent that
knows the package map and the four commands before its first tool call avoids
the two most expensive recoverable errors — scanning all eight packages, and
guessing a verification command.

**Cost.** ~1 hour to write, plus discipline to keep it short.

**Why not a symlink or a copy of `docs/architecture/00-overview.md`.** The
overview is ~200 lines and is a *contract to be read* — it will be read when
relevant. Loading it on every session pays the token cost for a task that may
not touch architecture at all, which is precisely the failure IFScale measures.
Point at it; do not inline it.

### R2. Move verification from advisory to deterministic

**Action.** Add a pre-commit or pre-push gate running `npm run typecheck &&
npm test` (the existing `check` script), plus `npx prettier --check`. If the
harness supports a deterministic stop gate, wire `tsc --build && vitest run` as
one, and treat a type error as a blocking failure the agent must fix rather than
a warning it may route around.

**Why.** Anthropic's four-level escalation **[P]** puts a deterministic script
above a model-based check. "Always use deterministic tools whenever you can"
is the one instruction both vendor sources state independently. This repo has
the commands and the script already; only the gating is missing.

**Expected benefit.** Removes the "looks done" termination condition, which is
the failure mode that makes unattended runs unsafe.

**Cost.** ~1 hour for `pre-commit` (https://pre-commit.com/ **[P]**), or
near-zero if the harness's native hook is used. The friction is real and is the
point.

**On the `tsc --build` ordering.** Keep it. Cross-package imports resolve to
`dist`, not `src`, so `vitest` alone tests stale code. `verify-domain-contract`
already documents this as the "stale-build trap"; R2 should make it impossible to
hit by always building before testing.

### R3. Add a `Stop`-style evidence requirement to the working agreement

**Action.** One line in `AGENTS.md`: report the command you ran and its real
output, not "tests pass." A test you did not run is not evidence.

**Why.** Anthropic **[P]**: "Have Claude show evidence rather than asserting
success — reviewing evidence is faster than re-running the verification yourself."
`session-review` already requires this for sessions; R3 extends it to every
report. This is one line, and per IFScale **[P]** one line is affordable.

**Expected benefit.** Converts reports from claims into checkable artifacts.
Directly addresses §6's most common failure.

**Cost.** One line. Its cost is that it must be enforced by whoever reads the
report.

### R4. Encode the fan-out contract as a template, not a convention

**Action.** Add `docs/architecture/adr/adr-0006-parallel-agent-contracts.md`
fixing: file ownership per subagent; a required "Decisions" section in every
subagent's return; artifacts written to disk rather than returned as prose; and a
single integration point that runs the full check exactly once.

**Why.** Cognition's Principle 2 — "actions carry implicit decisions, and
conflicting decisions carry bad results" (**[V]**) — is the mechanism by which
parallel work on one codebase produces integration debt. Anthropic's documented
failure is duplicated work and gaps from under-specified delegation (**[V]**).
The harness-level precedent for fencing writers is worktree isolation with
verified containment (**[P]**).

**Expected benefit.** Turns "be careful" into a checkable contract. The
`Decisions` section is the cheap version of Cognition's Principle 1 without
forwarding full transcripts.

**Cost.** ~1 hour. Requires discipline to keep the ADR to one page.

**What this deliberately does not do.** It does not mandate worktree isolation.
The evidence for that is one vendor's harness documentation **[P]**, and this
repo's parallel work so far has been file-disjoint. If conflicting writes
actually appear, that is when to reach for the fence.

### R5. Add a read-only investigator agent for cross-package reconnaissance

**Action.** A subagent definition restricted to read/search/glob, used to map
the blast radius of a change across packages before anything is written.

**Why.** This is the §4 reconciliation: parallelize *investigation*, serialize
*mutation*. Anthropic's built-in `Explore` and `Plan` subagents deny Write and
Edit outright (**[P]**), and Anthropic's subagent design is documented as
"context preservation" plus "enforcing constraints by limiting which tools a
subagent can use" (**[V]**). Cognition's observation that Claude Code's subtask
agents "usually only answer a question, not write code" (**[V]**) is a
description of exactly this pattern working in production.

**Expected benefit.** A read-only agent cannot cause a conflicting write, cannot
narrow scope by deciding not to do something, and cannot report unverified work
it did not produce. Its failure modes are bounded.

**Cost.** ~30 minutes. Near-zero ongoing.

### R6. Fold `scripts/research/search.mjs` usage into the working agreement

**Action.** One line in `AGENTS.md`: the built-in web search does not work here;
use `scripts/research/search.mjs` and read canonical URLs directly.

**Why.** This is a real constraint of the environment, and an agent that does
not know it will waste turns on a dead tool or, worse, assert from memory. §3's
"no web search available" category.

**Expected benefit.** Every research task starts with a working tool.

**Cost.** One line. Already paid.

### R7. Add a linter, or at minimum gate the formatter

**Action.** The repo has `prettier` as `npm run format` and no lint step.
`strict` TypeScript is a type checker, not a linter. Either adopt Biome
(`biome check --write` + `biome ci`, https://biomejs.dev/guides/getting-started/ **[P]**)
as a single formatter-plus-linter replacing Prettier, or keep Prettier and add
`--check` to the R2 gate.

**Why.** Anthropic's include/exclude table for `CLAUDE.md` puts "code style
rules that differ from defaults" on the include side but "standard language
conventions Claude already knows" on the exclude side, and both sources say
never make the model do a linter's job **[P]**/**[S]**. The gap in this repo is
that `npm run format` is a write command nobody is forced to run.

**Expected benefit.** Removes formatting from the agent's responsibility
entirely, freeing instruction budget per IFScale **[P]**.

**Cost.** Biome: ~2 hours including rule tuning and a diff pass. Prettier-only:
minutes.

**This one is genuinely optional** and is the weakest item on the list. The
strongest available evidence for adding a linter is "do not put style in the
prompt," and this repo has not put style in its prompt. R7 is upside, not a
gap being filled.

### R8. Record the retrieval-failure list in `skills/research/SKILL.md`

**Action.** Append a short "unreachable hosts" list, mirroring the convention in
`docs/research/trust-safety-reference-research.md`.

**Why.** §3's method note. Which hosts fail is reusable knowledge and costs one
edit to preserve.

**Expected benefit.** Small, compounding. Saves roughly three tool calls per
future research session.

**Cost.** Minutes.

### Explicitly rejected

- **Inlining `docs/architecture/00-overview.md` into `AGENTS.md`.** Rejected on
  IFScale **[P]**: a ~200-line always-loaded file spends instruction budget on
  every session, including the many sessions that never touch architecture.
  A pointer is two tokens and is correct forever.
- **A dedicated `AGENTS.md` per package.** Rejected for now. It is the
  documented Codex pattern for monorepos **[P]** and it is right at 88 files, but
  this repo has eight packages and a `skills/verify-domain-contract/SKILL.md`
  that already handles per-package guidance. Ten files to keep in sync is
  coordination cost with no measured benefit here. Revisit if a package acquires
  genuinely divergent commands.
- **Adopting a coding-agent framework or the Agent SDK.** Rejected on Anthropic's
  own guidance: "start by using LLM APIs directly," and frameworks "obscure the
  underlying prompts and responses" (**[V]**). The repo's loop is four commands.
- **Adding MCP servers for research or GitHub access.** Rejected on the
  specification's own SHOULD/MUST language **[P]** and the documented
  tool-poisoning, rug-pull, and cross-server-shadowing patterns against real
  servers **[S]**. The `gh` CLI and direct URL reads cover the same ground with
  a smaller blast radius. Revisit only if a specific integration is needed, and
  then with a written threat model first.
- **Shipping the pipeline-over-agent bias as a policy.** Agentless
  (https://arxiv.org/abs/2407.01489 **[P]**) and AlphaCodium
  (https://arxiv.org/abs/2401.08500 **[P]**) both favour fixed pipelines, but
  both predate several model generations. Recorded as a prior, not a rule.
- **A per-session automatic quality metric.** Tempting — `session-review`
  already asks the right question ("how many caught by verification, how many by
  luck") — but no reliable automatic instrumentation for that ratio was found,
  and a metric nobody trusts gets ignored. Rejected until something measurable
  exists.
- **Planning around METR's doubling curve.** Rejected as a planning input. The
  paper itself flags the external-validity limit, and the reliability techniques
  in R1–R4 are the hedge **[P]**.

---

## Open questions

1. **What is the actual typecheck catch-rate in this codebase?** No study was
   found of how often agents introduce errors that `strict` +
   `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` catch. Every
   recommendation in §2 rests on the general principle that reliable external
   feedback enables correction **[P]**, not on a measured rate here. R1–R2 are
   therefore well-founded but unquantified. **Resolving this needs local data**,
   not more literature: count type errors caught versus defects found by review,
   over the next several sessions.
2. **How much of this repo's test suite can be expected to catch the defect it
   is written for?** The SWE-bench numbers (§2) are for other codebases. The
   UTBoost methodology — generate additional tests for existing code and find
   patches that pass the originals — is applicable in principle to TypeScript
   and appears not to have been done. This is the highest-value unrun experiment
   available to this project.
3. **Is the parallel-work pattern in this repo actually hitting conflicting
   writes, or is the risk theoretical?** R4 assumes it is a real risk. If
   several sessions pass without a conflict, R4 may be over-engineering by the
   standard of §6's own advice about over-engineering. Track it.
4. **Does the instruction budget in `AGENTS.md` actually bind at eight
   packages?** IFScale's 500-instruction ceiling is far above any plausible file
   here, so the binding constraint at this size is more likely the *middle
   position* effect from "Lost in the Middle" **[P]** than raw count. That
   predicts reordering matters more than shortening — worth testing by moving
   the four verification commands to the top and the package map to the bottom,
   then observing whether the commands are followed more reliably.
5. **What does this harness's Stop-hook or equivalent actually support?** R2's
   strongest form depends on a deterministic stop gate. The Claude Code
   documentation **[P]** describes one, but the harness in use here is not
   Claude Code, and no equivalent for it was found. Until that is answered, R2
   is only reliable at the pre-commit level.
6. **Would a `docs/research/session-reviews/` directory, as `session-review`
   prescribes, accumulate the institutional memory it is designed for?** R2 and
   R3 both depend on a record of what verification actually catches. If the
   directory stays empty, both are running on belief.

---

## Sources

All retrieved **2026-09-25**.

### Context engineering, instruction files, and long context
- Anthropic, "Effective context engineering for AI agents" (29 Sep 2025) — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Chroma, "Context Rot: How Increasing Input Tokens Impacts LLM Performance" (14 Jul 2025) — https://research.trychroma.com/research/context-rot
- Jaroslawicz, Whiting, Shah & Maamari, "How Many Instructions Can LLMs Follow at Once?" (IFScale) — https://arxiv.org/abs/2507.11538
- Liu et al., "Lost in the Middle: How Language Models Use Long Contexts" — https://arxiv.org/abs/2307.03172
- Modarressi et al., "NoLiMa: Long-Context Evaluation Beyond Literal Matching" — https://arxiv.org/abs/2502.05167
- AGENTS.md open format — https://agents.md/
- OpenAI/Codex, "Custom instructions with AGENTS.md" — https://learn.chatgpt.com/docs/agent-configuration/agents-md
- OpenAI/Codex, "Prompting" — https://learn.chatgpt.com/docs/prompting
- HumanLayer, "Writing a good CLAUDE.md" (25 Nov 2025) — https://www.humanlayer.dev/blog/writing-a-good-claude-md

### Verification, self-correction, and test validity
- Huang et al., "Large Language Models Cannot Self-Correct Reasoning Yet" (ICLR 2024; 38 citations) — https://arxiv.org/abs/2310.01798
- Kamoi, Zhang, Zhang, Han & Zhang, "When Can LLMs Actually Correct Their Own Mistakes? A Critical Survey" — https://arxiv.org/abs/2406.01297
- Liu, Qi, Zhang, Cheng & Johnson, "Self-correction is Not An Innate Capability in Language Models" — https://arxiv.org/abs/2410.20513
- Shinn et al., "Reflexion: Language Agents with Verbal Reinforcement Learning" (NeurIPS 2023) — https://arxiv.org/abs/2303.11366
- Xia, Deng, Dunn & Zhang, "Agentless: Demystifying LLM-based Software Engineering Agents" (17 citations) — https://arxiv.org/abs/2407.01489
- Ridnik, Kredo & Friedman, "Code Generation with AlphaCodium: From Prompt Engineering to Flow Engineering" — https://arxiv.org/abs/2401.08500
- Ahmed et al., "TDD-Bench Verified" — https://arxiv.org/abs/2412.02883
- Wang, Pradel & Liu, "Are 'Solved Issues' in SWE-bench Really Solved Correctly? An Empirical Study" — https://arxiv.org/abs/2503.15223
- Yu, Zhu, He & Kang, "UTBoost: Rigorous Evaluation of Coding Agents on SWE-Bench" — https://arxiv.org/abs/2506.09289
- Kwa et al. (METR), "Measuring AI Ability to Complete Long Software Tasks" — https://arxiv.org/abs/2503.14499
- Arnav et al., "CoT Red-Handed: Stress Testing Chain-of-Thought Monitoring" — https://arxiv.org/abs/2505.23575

### Agent harness design, tools, and interfaces
- Anthropic, "Building effective agents" (19 Dec 2024) — https://www.anthropic.com/research/building-effective-agents
- Anthropic, "Writing effective tools for agents — with agents" (11 Sep 2025) — https://www.anthropic.com/engineering/writing-tools-for-agents
- Anthropic, "Raising the bar on SWE-bench Verified with Claude 3.5 Sonnet" (6 Jan 2025) — https://www.anthropic.com/research/swe-bench-sonnet
- Yang et al., "SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering" (30 citations) — https://arxiv.org/abs/2405.15793
- Anthropic, "Best practices for Claude Code" — https://code.claude.com/docs/en/best-practices
- Anthropic, "Hooks reference" — https://code.claude.com/docs/en/hooks
- Anthropic, "Create custom subagents" — https://code.claude.com/docs/en/sub-agents
- Roth et al., "Factored Agents: Decoupling In-Context Learning and Memorization for Robust Tool Use" — https://arxiv.org/abs/2503.22931
- Ge et al., "A Survey of Vibe Coding with Large Language Models" — https://arxiv.org/abs/2510.12399
- Sapkota, Roumeliotis & Karkee, "Vibe Coding vs. Agentic Coding" — https://arxiv.org/abs/2505.19443

### Multi-agent orchestration
- Anthropic, "How we built our multi-agent research system" (13 Jun 2025) — https://www.anthropic.com/engineering/multi-agent-research-system
- Yan (Cognition), "Don't Build Multi-Agents" (12 Jun 2025) — https://cognition.com/blog/dont-build-multi-agents

### Supply chain and tool security
- Spracklen et al., "We Have a Package for You! A Comprehensive Analysis of Package Hallucinations by Code Generating LLMs" — https://arxiv.org/abs/2406.10279
- Model Context Protocol, "Tools" specification (2025-06-18) — https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- Willison, "Model Context Protocol has prompt injection security problems" (9 Apr 2025) — https://simonwillison.net/2025/Apr/9/mcp-prompt-injection/
- jumploops, "Sol loves to cheat" (12 Aug 2026) — https://jumploops.com/blog/sol-loves-to-cheat/

### Tooling documentation used for the recommendations
- TypeScript, `noUncheckedIndexedAccess` — https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html
- TypeScript, `strict` — https://www.typescriptlang.org/tsconfig/strict.html
- Vitest, "Getting Started" — https://vitest.dev/guide/
- Biome, "Getting Started" — https://biomejs.dev/guides/getting-started/
- pre-commit, project documentation — https://pre-commit.com/

### Attempted and unavailable at time of retrieval
- `openai.com/index/why-gpt-5-doesnt-cheat/` and `.../why-our-models-dont-cheat/` — 404 at both URL forms
- `agents.md/llms.txt` — 404
- HN Algolia queries for the OpenAI "why our models cheat" post and for reward-hacking discussions with `points>100` — 0 hits; the broader "cheat" search returned only unrelated results
- `https://openai.com/index/why-gpt-5-doesnt-cheat/` was reached only through a
  first-party reference in the jumploops post, not verified directly