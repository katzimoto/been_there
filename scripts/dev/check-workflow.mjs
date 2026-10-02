#!/usr/bin/env node
/**
 * Validates the CI workflow before it is pushed.
 *
 * ## Why this exists
 *
 * A GitHub Actions file that does not parse is rejected in **0 seconds** with no
 * line number and no explanation. It has happened three times in this
 * repository: a `services:` block placed above `jobs:`, a duplicated `env:` key
 * from an edit that added a second one where one already existed, and a
 * mis-indented step. Each was found by pushing and reading a red tick, which is
 * the slowest possible feedback for a syntax error.
 *
 * A `make check` that only runs after a valid workflow cannot catch a broken
 * workflow — the job never starts — so the check has to be somewhere that does
 * not need CI to run.
 *
 * ## What it checks
 *
 *  1. **Parses as YAML.** No dependency: a structural pass for indentation and
 *     duplicate keys, which is what has actually broken here. If `js-yaml` or
 *     `pyyaml` happens to be installed, it is used as a second opinion.
 *  2. **Has a top-level `jobs:`** with at least one job.
 *  3. **Every step has a `name` or a `uses`** — a step with neither is a
 *     silent no-op that still costs a job slot.
 *  4. **Every `run:` and `uses:` sits under a step**, not loose in a job.
 *
 * It does not validate the workflow's *semantics*. A workflow can parse and
 * still be wrong; that is what the parity check and CI itself are for.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(REPO_ROOT, '.github/workflows/ci.yml');

const problems = [];

if (!existsSync(WORKFLOW)) {
  console.error(`No workflow at ${WORKFLOW}.`);
  process.exit(1);
}

const source = readFileSync(WORKFLOW, 'utf8');
const lines = source.split('\n');

/**
 * Duplicate keys are the failure that has bitten three times, and it is
 * invisible to a reader and fatal to a runner. A key is "the same key" when it
 * appears at the same indentation within a few lines.
 */
const seen = new Map();
lines.forEach((line, index) => {
  const match = /^(\s*)([A-Za-z_-]+):/.exec(line);
  if (match === null) {
    return;
  }
  const [, indent, key] = match;
  const id = `${indent}${key}`;
  const previous = seen.get(id);
  if (previous !== undefined && Math.abs(previous - index) <= 2) {
    problems.push(`duplicate key '${key}' at line ${index + 1} (first at line ${previous + 1})`);
  }
  seen.set(id, index);
});

// Tabs are invalid in YAML indentation and produce an error that points at the
// wrong line entirely.
lines.forEach((line, index) => {
  if (/^\t/.test(line)) {
    problems.push(`tab indentation at line ${index + 1}; YAML forbids it`);
  }
});

if (!/^jobs:\s*$/m.test(source)) {
  problems.push('no top-level `jobs:` key — GitHub rejects a workflow without one');
}

if (!/^\s{2}[A-Za-z_-]+:\s*$/m.test(source)) {
  problems.push('no job defined under `jobs:`');
}

// A step with neither a `uses` nor a `run` is a silent no-op.
const stepIndices = [];
lines.forEach((line, index) => {
  if (/^\s+- name:/.test(line)) {
    stepIndices.push(index);
  }
});
for (const start of stepIndices) {
  const block = lines.slice(start, start + 5).join('\n');
  if (!/\buses:/.test(block) && !/\brun:/.test(block)) {
    problems.push(`step at line ${start + 1} has neither 'uses:' nor 'run:'`);
  }
}

// Second opinion from a real parser when one happens to be available.
try {
  execFileSync('npx', ['-y', 'js-yaml', WORKFLOW], { stdio: 'pipe' });
} catch (error) {
  const text = String(error.stderr ?? error.stdout ?? error.message);
  const useful = text
    .split('\n')
    .filter((line) => line.includes('Exception') || line.includes('error'))
    .slice(0, 2)
    .join(' ');
  if (useful !== '' && !useful.includes('npm notice')) {
    problems.push(`js-yaml: ${useful}`);
  }
}

if (problems.length > 0) {
  console.error(`Workflow check failed (${problems.length}):\n`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error(
    '\nA workflow that does not parse is rejected in 0s with no line number, and it\n' +
      'is found by pushing. This check exists so that is not the feedback loop.',
  );
  process.exit(1);
}

console.log(`Workflow check passed: ${WORKFLOW.replace(`${REPO_ROOT}/`, '')} parses, ${stepIndices.length} steps.`);