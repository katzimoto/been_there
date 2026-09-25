#!/usr/bin/env node
/**
 * Asserts that the local command set is exactly what CI runs.
 *
 * A green `make check` is only worth something if it runs the same commands CI
 * does. The two lists are written down in two different files, which is the
 * standard way they drift: someone adds a step to the workflow, forgets the
 * Makefile, and local runs keep passing on a command CI stopped running (or the
 * other way round — a check everybody runs locally and nobody runs in CI).
 *
 * This script reads both files and fails when they disagree. It compares
 * *commands*, not target names, so renaming a target is free and adding a
 * command is not.
 *
 *   node scripts/dev/check-ci-parity.mjs
 *
 * Normalisation, stated in full because a normaliser is where this kind of check
 * hides its own blind spots. These are shell scaffolding, not verification, and
 * are ignored on both sides:
 *
 *   - `for`/`while`/`do`/`done`/`then`/`fi`/`esac` headers and closers, so a
 *     one-line loop in a Make recipe matches a multi-line one in YAML;
 *   - `set -e` and friends, so the local loop may fail on the first error while
 *     CI's continues to the next package;
 *   - `exit N`, which is how that loop stops;
 *   - `echo`/`printf`, which produce output and assert nothing;
 *   - comments, blank lines, and runs of whitespace.
 *
 * Everything else must match exactly, including redirections, `npx`, quoting
 * and the `$$`/`$` difference between a Makefile and a shell.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exit } from 'node:process';

const ROOT = resolve(import.meta.dirname, '..', '..');
const WORKFLOW = '.github/workflows/ci.yml';
const MAKEFILE = 'Makefile';

/**
 * CI step name -> local Make target. Adding a CI step means adding a line here
 * and a target; forgetting this file is itself a failure, which is the point.
 */
const MAPPING = [
  { step: 'Install', target: 'install' },
  { step: 'Typecheck', target: 'typecheck' },
  { step: 'Typecheck tests', target: 'typecheck-tests' },
  { step: 'Test', target: 'test' },
  { step: 'Check documentation links', target: 'docs' },
  { step: 'Check research tool', target: 'research-check' },
  { step: 'Check for stale artefacts', target: 'stale-artifacts' },
  { step: 'Check the lockfile covers every workspace package', target: 'lockfile' },
];

/** The target that must run every mapped target, in CI order. */
const AGGREGATE = 'check';

/** The target that additionally installs, as the CI workflow does. */
const AGGREGATE_WITH_INSTALL = 'ci';

const SCAFFOLDING = /^(for|while|until|do|done|then|elif|else|fi|esac|in|\{|\}|;)$|^(for|while|until)\s/;
// Any `set` invocation: shell configuration such as `set -e` or
// `set -euo pipefail` is never a verification, and its exact flags are the
// local side's business, not the comparison's.
const SET_COMMAND = /^set(\s|$)/;
const OUTPUT_COMMAND = /^(echo|printf)\b/;
const EXIT_COMMAND = /^(exit|return)\s+\d*$/;

function commandAtoms(text) {
  const joined = text.replace(/\\\r?\n/g, '\n');
  return joined
    .split(/[;\n]|&&|\|\|/)
    .map((segment) => segment.replace(/\$\$/g, '$').replace(/\s+/g, ' ').trim())
    .filter(
      (segment) =>
        segment !== '' &&
        !segment.startsWith('#') &&
        !SCAFFOLDING.test(segment) &&
        !SET_COMMAND.test(segment) &&
        !OUTPUT_COMMAND.test(segment) &&
        !EXIT_COMMAND.test(segment),
    )
    .sort();
}

function ciSteps(workflow) {
  const lines = workflow.split('\n');
  const steps = [];
  let name = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    // Step names are written `- name: Install`; the workflow's own `name: CI`
    // must not leak into an unnamed step.
    const named = /^\s*(?:-\s+)?name:\s*(.+?)\s*$/.exec(line);
    if (named !== null) {
      name = named[1].replace(/^["']|["']$/g, '');
      continue;
    }
    const run = /^\s*run:\s*(.*?)\s*$/.exec(line);
    if (run === null) {
      continue;
    }
    const inline = run[1].replace(/^["']|["']$/g, '');
    if (inline !== '' && !/^[|>][-+]?\d*$/.test(inline)) {
      steps.push({ name, body: inline });
      continue;
    }
    // A block scalar: every following line indented past this one is the body.
    const indent = /^\s*/.exec(line)[0].length;
    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor++) {
      const candidate = lines[cursor];
      if (candidate.trim() === '') {
        body.push('');
        continue;
      }
      if (/^\s*/.exec(candidate)[0].length <= indent) {
        break;
      }
      body.push(candidate);
    }
    const dedent = Math.min(
      ...body.filter((entry) => entry.trim() !== '').map((entry) => /^\s*/.exec(entry)[0].length),
    );
    steps.push({ name, body: body.map((entry) => entry.slice(dedent)).join('\n') });
  }
  return steps;
}

function makeTargets(makefile) {
  const targets = new Map();
  let current = null;
  for (const line of makefile.split('\n')) {
    if (line === '') {
      continue;
    }
    if (line.startsWith('\t')) {
      if (current !== null) {
        // A leading `@`/`-` is make telling the shell not to echo, not part of
        // the command itself.
        current.recipe.push(line.replace(/^\t+/, '').replace(/^[-@]\s*/, ''));
      }
      continue;
    }
    if (line.startsWith('#')) {
      continue;
    }
    const declared = /^([A-Za-z0-9_.-]+):(?!=)(.*)$/.exec(line);
    if (declared === null) {
      current = null;
      continue;
    }
    // The `## ...` tail is this file's own documentation, not a prerequisite.
    current = { name: declared[1], prerequisites: declared[2].split('##')[0].trim(), recipe: [] };
    targets.set(current.name, current);
  }
  return targets;
}

function difference(left, right) {
  const remaining = [...right];
  const missing = [];
  for (const atom of left) {
    const at = remaining.indexOf(atom);
    if (at === -1) {
      missing.push(atom);
    } else {
      remaining.splice(at, 1);
    }
  }
  return { missing, extra: remaining };
}

function describe(atomList) {
  return atomList.length === 0 ? '(no commands)' : atomList.map((atom) => `      ${atom}`).join('\n');
}

const steps = ciSteps(readFileSync(resolve(ROOT, WORKFLOW), 'utf8'));
const targets = makeTargets(readFileSync(resolve(ROOT, MAKEFILE), 'utf8'));
const problems = [];
const rows = [];

for (const step of steps) {
  if (step.name === null) {
    problems.push(`a CI step runs commands but has no \`name:\`, so it cannot be mapped to a target`);
    continue;
  }
  const mapping = MAPPING.find((entry) => entry.step === step.name);
  if (mapping === undefined) {
    problems.push(
      `CI step "${step.name}" is not covered by ${MAKEFILE}: add it to MAPPING in scripts/dev/check-ci-parity.mjs with the target that runs the same commands`,
    );
    continue;
  }
  const target = targets.get(mapping.target);
  if (target === undefined) {
    problems.push(`${MAKEFILE} has no target "${mapping.target}" for CI step "${step.name}"`);
    continue;
  }
  const ciAtoms = commandAtoms(step.body);
  const localAtoms = commandAtoms(target.recipe.join('\n'));
  const { missing, extra } = difference(ciAtoms, localAtoms);
  if (missing.length > 0) {
    problems.push(
      `CI step "${step.name}" runs commands that "make ${mapping.target}" does not:\n${describe(missing)}`,
    );
  }
  if (extra.length > 0) {
    problems.push(
      `"make ${mapping.target}" runs commands CI step "${step.name}" does not:\n${describe(extra)}`,
    );
  }
  rows.push({ ciStep: step.name, target: mapping.target, atoms: ciAtoms });
}

const mappedTargets = new Set(MAPPING.map((entry) => entry.target));
for (const [name, target] of targets) {
  if (mappedTargets.has(name)) {
    continue;
  }
  const cliAtoms = commandAtoms(target.recipe.join('\n'));
  // A variant counts: `npm test -- --coverage` is still the CI test command
  // with flags, and a second target that runs it is exactly the duplicate this
  // check exists to notice. A target that runs a genuinely different command
  // is not flagged.
  const repeats = cliAtoms.filter((atom) =>
    rows.some((row) => row.atoms.some((ciAtom) => atom === ciAtom || atom.startsWith(`${ciAtom} `))),
  );
  if (repeats.length > 0) {
    problems.push(
      `"make ${name}" runs a command CI runs, but is not the target mapped to it:\n${describe(repeats)}`,
    );
  }
}

// `make check` and `make ci` must walk the mapped targets in the order CI runs
// them, so a local run fails in the same place a CI run does, and `make ci`
// must start with the install the workflow starts with. Prerequisites are
// expanded transitively, so factoring `ci` through `check` is fine but
// reordering is not. LOCAL_ONLY is the single step a local run adds: the drift
// check itself, which cannot be a CI step because it reads the CI workflow.
const LOCAL_ONLY = ['parity'];
const allTargets = MAPPING.map((entry) => entry.target);
const expectations = [
  { target: AGGREGATE, expected: [...allTargets.filter((entry) => entry !== 'install'), ...LOCAL_ONLY] },
  { target: AGGREGATE_WITH_INSTALL, expected: [...allTargets, ...LOCAL_ONLY] },
];

function expand(name, seen = new Set()) {
  const target = targets.get(name);
  if (target === undefined) {
    problems.push(`${MAKEFILE} has no "${name}" target to run the CI command set`);
    return [];
  }
  const expanded = [];
  for (const prerequisite of target.prerequisites.split(/\s+/).filter((entry) => entry !== '')) {
    if (targets.has(prerequisite) && !seen.has(prerequisite)) {
      seen.add(prerequisite);
      // A target that only forwards to others is a level of indirection, not a
      // step; a leaf is a step and keeps its place in the order.
      const inner = expand(prerequisite, seen);
      if (inner.length > 0) {
        expanded.push(...inner);
        continue;
      }
    }
    expanded.push(prerequisite);
  }
  return expanded;
}

for (const { target: name, expected } of expectations) {
  const actual = expand(name);
  if (actual.join(' ') !== expected.join(' ')) {
    problems.push(
      `"make ${name}" runs [${actual.join(', ')}] but CI order is [${expected.join(', ')}]`,
    );
  }
}

if (problems.length > 0) {
  console.error(`CI parity check failed (${problems.length} problem(s)):\n`);
  for (const problem of problems) {
    console.error(`  - ${problem}\n`);
  }
  exit(1);
}

console.log(`CI parity check passed: ${rows.length} CI steps, ${rows.length} make targets, one command each.`);
for (const row of rows) {
  console.log(`  ${row.ciStep} -> make ${row.target}: ${row.atoms.join(' ; ')}`);
}
console.log(`  "make ${AGGREGATE}" runs them in CI order; "make ${AGGREGATE_WITH_INSTALL}" also installs.`);
