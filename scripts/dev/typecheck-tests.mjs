#!/usr/bin/env node
/**
 * Typechecks every package's test project.
 *
 * ## Why this exists as its own script
 *
 * `npm run typecheck` is `tsc --build`, which walks the *package* project
 * graph. The test projects are not in that graph: each one is a separate
 * `tsconfig.json` that nothing references, so the solution build never opens
 * them and a test file that does not compile is invisible to `tsc --build`.
 *
 * That is not hypothetical. Seven errors lived in test projects for a session
 * while `npm run typecheck` reported zero, because the gate being quoted did
 * not cover the files being edited. The CI step and the Makefile target both
 * ran this loop; `package.json`'s `check` script did not, and `npm run check`
 * is what gets run by hand.
 *
 * So the loop is written once here and called from all three — `npm run
 * typecheck-tests`, `make typecheck-tests`, and the CI step — rather than
 * copied into each. `scripts/dev/check-ci-parity.mjs` compares the CI step
 * against the Makefile target and fails if they stop running the same command;
 * pointing both at this file makes that comparison exact by construction and
 * removes the third copy that parity does not cover.
 *
 * It is a Node script and not a shell loop so the "every project is visited"
 * property is checkable: a glob that matches nothing is a silent pass, and
 * `packages/<pkg>/test/tsconfig.json` matching zero projects would leave this
 * green while typechecking nothing. Here that is an error.
 *
 *   node scripts/dev/typecheck-tests.mjs
 *
 * Exits non-zero on the first failing project, and reports which one.
 */
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { exit } from 'node:process';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PACKAGES = resolve(ROOT, 'packages');

/**
 * Every package that ships a test project, found by reading the directory
 * rather than by expanding a glob in the shell.
 */
function testProjects() {
  const found = [];
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const project = resolve(PACKAGES, entry.name, 'test', 'tsconfig.json');
    try {
      readdirSync(resolve(PACKAGES, entry.name, 'test'));
    } catch {
      continue;
    }
    found.push(project);
  }
  return found.sort();
}

const projects = testProjects();

if (projects.length === 0) {
  // The loop's failure mode when it is a shell glob is exactly this: no
  // packages, no work, exit 0. A gate that checks nothing is not a gate.
  console.error('typecheck-tests: found no packages/*/test/tsconfig.json, so this would pass while checking nothing.');
  exit(1);
}

// `--build` is deliberately absent: these projects are not in the solution
// graph, so there is nothing to build from, and `tsc -p` is what CI runs.
const tsc = resolve(ROOT, 'node_modules', '.bin', 'tsc');

for (const project of projects) {
  const relative = project.slice(ROOT.length + 1);
  console.log(`typecheck-tests: ${relative}`);
  const result = spawnSync(tsc, ['-p', project], { stdio: 'inherit', cwd: ROOT });
  if (result.error !== undefined) {
    console.error(`typecheck-tests: could not run tsc: ${result.error.message}`);
    exit(1);
  }
  if (result.status !== 0) {
    console.error(`typecheck-tests: ${relative} failed.`);
    exit(result.status ?? 1);
  }
}

console.log(`typecheck-tests: ${projects.length} test project(s), all clean.`);