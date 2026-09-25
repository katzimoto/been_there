# AGENTS.md — working agreement for Been There

How to work in this repository. What the system *is* lives in `docs/`; this file
describes how to change it, and is short on purpose: a working agreement nobody
reads is not an agreement.
>
> The user's standing working preferences — team decomposition, session review,
> skill and memory hygiene, parallel work, and research — are recorded at
> `~/.omp/memory/working-preferences.md`. They outlast this repository; read
> them at the start of a session and check whether what happened last time
> should change them.

## Before you touch anything

1. **Read `docs/architecture/00-overview.md`.** It is the contract. Where a
   feature document and the overview disagree, the overview is right and the
   feature document is a bug.
2. **Find the owning package.** Dependencies point inward: feature → domain →
   `packages/core`. No domain package imports another domain package.
3. **Read the matching skill** in `skills/`:
   adding or changing a package → `add-domain-package`; writing or reconciling a
   spec → `write-feature-spec`; asserting a change works → `verify-domain-contract`;
   editing files or trusting an agent → `tool-craft`; gathering external evidence
   → `research`; ending a session → `session-review`.

## Non-negotiable

1. **A target is only a target when a human supplies it.** Never infer scope
   from a branch name, a prior campaign, or an issue you found.
2. **Selecting work does not authorise destructive action.** Ask before deleting
   code you did not write, force-pushing, or changing configuration.
3. **Unknown stays unknown.** Null with a reason, never a plausible guess.
4. **Schema validity is not correctness.** Passing a validator proves structure.
5. **Do not change the configured provider, model, or unrelated settings.**
6. **Preserve permission denials** rather than working around them.

## The eight commitments

These are what the product is. Every one is enforced by a type, a
transition-table guard, or a test — and a change that weakens one must break a
test, or it is wrong.

1. `verified` is the only discoverable identity state.
2. Automation never enforces, and never reverses, a human's decision.
3. Risk decays, at most one step.
4. Unmatch never destroys the right to report.
5. Exact location is never exposed.
6. Domains never import each other's internals.
7. Sensitive data is classified per field, and redacted at the sink.
8. Every lifecycle is a transition table, not scattered status assignment.

## House style

- **No one-line wrapper functions.** No pure renames, no single-expression
  pass-throughs. Allowed: a type guard that narrows, a function called from 3+
  sites needing lockstep behaviour, an exported name that is a stable domain
  concept, a callback-identity-sensitive function, or a genuine test seam.
- **No `Map`/`Set` for static string-keyed lookups.** Use a `Record<K,V>`
  literal. `Map`/`Set` are for dynamic keys, runtime insertion or deletion, or
  when you need insertion order or `.size`.
- **Never `any` or `as any`.** `unknown` for unvalidated input, a type guard for
  a small checkable surface, or an unchecked cast assigned to a named const with a
  one-line reason.
- **No stubs, TODOs, mocks, or placeholders.** If something cannot be built, say
  what is missing instead of faking it.
- **Prefer editing to creating.** Files under 500 lines. Repository-relative
  paths only; no absolute paths in committed files. No emojis.

## Verifying before you say done

```bash
npx tsc --build                              # the whole package graph
npx tsc -p packages/<pkg>/test/tsconfig.json # test types
npx vitest run                                # everything
npm run docs                                  # documentation links
```

Run these and report the real output. A test you did not run is not evidence, and
neither is an agent's report that it ran one.

Three traps that have each cost real time here:

- **Compiled output must never sit next to its source.** vitest resolves
  `../src/index.js` to a real file before the `.ts`, so a stray build artefact
  makes the suite run stale code and report a fix that was never applied.
- **Cross-package imports resolve to `dist`, not `src`.** Run `npx tsc --build`
  after changing a package another package imports, before running its
  consumers' tests.
- **Local green is not CI green.** CI runs `npm ci` against the lockfile, which
  catches drift no local run sees.

## Working with other agents

- **Check the file exists before believing a delivery.** An agent reporting a
  finished file, a passing suite, or a written document is a hypothesis.
- **Name the files you own and the neighbours you must not touch.** Separate
  packages are not automatically separate edits.
- **Own the shared files yourself**: root config, `tsconfig.json`,
  `packages/core`, and `packages/integration`.
- **When someone needs a file you own, change it and explain why.** The
  reasoning is what lets them design around it.
- **Fan out only what is genuinely independent**, and keep the integration to a
  single owner. Six packages can go in parallel; the contract between them
  cannot.

## Writing

- A document states what its subject **owns** and what it **never owns**.
- Cross-domain references use the shared state model, not ad-hoc synonyms.
- Anything undecided goes in an **Open questions** section. It does not get
  guessed in the body.
- A rule justified by an incoherent argument will drift back. Fix the reasoning,
  not only the sentence.
