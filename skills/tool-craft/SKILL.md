---
name: tool-craft
description: Edit files without corrupting them, verify an agent actually did what it claimed, and keep parallel agents off each other's files. Use whenever editing an existing file, trusting a subagent's report, or running more than one agent at a time.
---

# Tool craft

Three failure modes that each cost more than the work they were trying to do.

## 1. Anchored edits corrupt files

Range-anchored patches are for small, surgical changes inside a region you have
just read. They fail in a specific and predictable way when the range is
approximate: the patch lands on the wrong lines and **silently clobbers adjacent
code** — an import line, a closing brace, the line you meant to insert *next to*
rather than *instead of*.

Observed in one session: an import list lost `caseMachine`; a function signature
was overwritten by a call; a deleted range took a neighbour with it; one file
needed a full rewrite to recover.

The rules that follow:

- **Check the anchor first.** The tool tells you when the lines you targeted were
  never displayed. That is a rejection, not a suggestion — re-read and retry
  rather than forcing the tag.
- **For an insertion, use the gap form** (`>N` after a line you have actually
  seen), not a replacement over a guessed range.
- **Whole-file `write` for structural changes.** Adding a file, restructuring a
  function, or anything where I have rewritten the same lines three times is
  cheaper to write out again than to keep patching. Switching to `write` midway
  through a mangled file is the correct recovery, not a defeat.
- **After any edit that reports a syntax warning, re-read before editing again.**
  The tool auto-repairs some boundaries and the repair is not always what you
  intended.
- **Re-run the typecheck after edits to a file with imports.** A clobbered import
  is a compile error, which is cheap — but only if you actually compile.

## 2. An agent's report is a hypothesis

Two agents in one session reported deliverables that did not exist: one claimed
a 68KB research file, one had no write tool at all and returned the document as
prose instead. Both reports were detailed and plausible.

Before believing any delivery claim:

- **Check the file exists** — `ls`, or a search. Not the report's word for it.
- **Re-run the headline number.** If an agent says "613 tests pass", run the
  suite. Agent-reported verification is the single most common unverified claim,
  and it is cheap to check.
- **Check the agent's tool inventory** when the task required writing. A
  read-only agent asked to produce a file will otherwise return its work as
  prose, which reads like a blocked report but is really a task that was never
  executable. Brief it to declare that up front.
- **When an agent cannot write, take the artefact from its report and write it
  yourself.** The research is still good; only the filesystem write was missing.

The inverse also holds: an agent reporting *failure* is usually right. When one
said it had no write tool, the file genuinely did not exist. Check failures more
sceptically than successes.

## 3. Parallel agents need disjoint file ownership

Agents working separate packages conflicted anyway, because the contracts between
packages are exactly where the edges are.

- **In every brief, list the files the agent owns and the files it must not
  touch**, naming the other agent that owns them. "Stay in your own files" is not
  enough; name the neighbours.
- **Own the shared files yourself.** Root config, the solution file, the
  integration suite, and the shared kernel are integration-owner territory.
  Delegating them invites conflicting writes to files nobody coordinates.
- **When an agent needs a file I own, make the change and reply with the
  reasoning, not just the diff.** The reasoning is what lets them design around
  it correctly — the last time I replied to a core-state question with *why*,
  the agent came back with a better proposal than the one I would have given.
- **Have agents message each other** for the contracts they must agree on
  (event names, payload shapes). Two agents reconciling directly beat the parent
  relaying.

## 4. Local green is not CI green

- **Run the full suite after every wave**, not just each agent's scoped scope.
  A change in package A silently breaks package B's test until `tsc --build`
  runs, because cross-package imports resolve to `dist`.
- **Let CI be the oracle for the things local runs cannot see.** It caught a
  lockfile that predated a new workspace package, which every local run had
  happily ignored.
- **Never let compiled output sit next to its source.** vitest resolves
  `../src/index.js` to a real file before the `.ts`, so a committed artefact
  makes the suite run stale code and report a fix that was never applied. This
  cost a full round of confused debugging.
