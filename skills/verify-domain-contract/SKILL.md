---
name: verify-domain-contract
description: Verify a domain package, a safety invariant, or a change to a shared state machine before reporting it done. Use before claiming any package compiles, any invariant holds, or any issue is complete.
---

# Verifying a domain contract

## The four checks

```bash
npx tsc -p packages/<pkg>/tsconfig.json          # source
npx tsc -p packages/<pkg>/test/tsconfig.json     # test types
npx vitest run packages/<pkg>                    # that package's tests
npx tsc --build && npx vitest run                # the solution, before calling it done
```

Report the actual output. A test you did not run is not evidence.

## The stale-build trap

Cross-package imports resolve to `dist`, not `src`. After changing package A,
anything importing A is still testing A's previous build until `npx tsc --build`
runs. Symptom: a new guard appears not to fire, and a test asserting it fails.
Fix the build, not the test.

## What a test must assert

Tests are the only things making the eight commitments in
`docs/architecture/00-overview.md` real, so they have to bite.

- Assert **behaviour at a boundary**: an illegal transition is rejected, a
  restricted capability is gone, a clearance boundary hides an event.
- Assert **the exact contract**, not a proxy. "The published signal has no
  content" is a key-set allowlist, not a regex — `bodyLength` is metadata and
  `body` is content, and a loose regex catches the wrong one.
- Never assert wiring, forwarding, mock echoes, non-emptiness, or that a
  function was called. Those pass when the code is wrong.
- Prefer a **failing-before / passing-after** test for anything you fixed. If you
  cannot observe it fail first, say the verification is weaker than that.

## Reading a `Result`

`Result` is a sum type and reading `.value` without narrowing is a compile
error by design. In tests, use the local seam idiom:

```ts
function succeeded<T, E extends { code: string }>(result: Result<T, E>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.error.code}`);
  return result.value;
}
```

A test that calls `.value` on an `Err` should not compile. If you are casting
to get around it, the production code is ignoring an error path.

## Cross-package claims need a composition test

An invariant that spans two packages cannot be proven by either package's unit
tests. `packages/integration/` exists for exactly this: the end-to-end safety
chain from issue #1, each commitment exercised across domain boundaries.

This is how the real defect was found: a moderator-shaped actor id from a
service passed the enforcement gate, because the guard checked for a non-null
actor id rather than for a human. Neither moderation's tests nor any other
package's tests could see it.

When you add a commitment or a cross-domain rule, add the composition test with
it.

## Before closing a GitHub issue

- The issue's "Done when" criterion is satisfied by something inspectable, and
  the document or code that satisfies it is named.
- Docs and code agree. Re-run the reconciliation in the `write-feature-spec`
  skill.
- Every internal link in the touched documents resolves.
- Anything undecided is in an "Open questions" section, not silently resolved.
