#!/usr/bin/env node
/**
 * Asserts that `check-dist-freshness.mjs` still catches the two failures it
 * exists to catch, by planting each one and watching the real check go red.
 *
 * The check's rebuild layer has two independent justifications, and neither is
 * enforced by anything:
 *
 *   1. A hand-edited `dist` is *newer* than its source, so every timestamp
 *      comparison calls it fresh. An implementation reduced to mtime would pass
 *      it silently -- and the failure it hides is the one measured in that
 *      file's header: the suite then executes code that is not in `src`.
 *   2. An orphaned output has no source at all, so it is consistent with its
 *      own absence and satisfies every comparison it is asked to make.
 *
 * Case 1 is load-bearing. A self-test that planted only an orphan would pass
 * against an mtime-only implementation, because mtime cannot see an orphan in
 * either direction -- so the orphan assertion proves the rebuild layer exists,
 * and only the hand-edit assertion pins down *which* check it is. Both are
 * planted, and each is asserted green again after its restore.
 *
 * Fixture strategy: a scratch root containing a copy of the real script and one
 * throwaway package, built in the system temp directory. The check resolves its
 * root from `import.meta.dirname`, so running the copied file verbatim makes it
 * verify the scratch tree and nothing else. The real `packages` trees -- the ones
 * this check exists to protect -- are never opened, written or read.
 *
 * The copy is compared byte for byte with the original before it is run, so this
 * cannot drift into testing a stale or edited version of the check: if the two
 * ever differ, the self-test fails rather than reporting on something else.
 *
 * One `tsc` invocation builds the throwaway package's `dist`. That is not
 * `npm run build` and it is unavoidable -- a `dist` has to exist before there
 * is anything for the check to be fresh *against*. It compiles one file.
 *
 * Usage: node scripts/dev/check-dist-freshness-selftest.mjs
 * Exits 0 when the check catches both planted failures, 1 otherwise.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { exit } from 'node:process';

const ROOT = resolve(import.meta.dirname, '..', '..');
const CHECK = join(ROOT, 'scripts', 'dev', 'check-dist-freshness.mjs');
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');

/** Where the copy of the check and the throwaway package live, per run. */
const SCRATCH_ROOT = mkdtempSync(join(tmpdir(), 'dist-freshness-selftest-'));

/** The same `TOLERANCE_MS` the check uses: below this, a pair reads as fresh. */
const TOLERANCE_MS = 1000;

/** How far past the source's mtime the hand-edited output is stamped. */
const NEWER_BY_MS = 5000;

/** sha256 of a file, or of a buffer that has not been written yet. */
function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every file under `dir` as `relative path -> sha256`. */
function snapshot(dir) {
  const found = new Map();
  if (!existsSync(dir)) return found;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) found.set(relative(dir, absolute), hash(readFileSync(absolute)));
    }
  };
  walk(dir);
  return found;
}

/** Names present in one snapshot and not the other, for a message a reader can act on. */
function drift(before, after) {
  const changed = [];
  for (const [name, digest] of before) {
    if (!after.has(name)) changed.push(`missing: ${name}`);
    else if (after.get(name) !== digest) changed.push(`modified: ${name}`);
  }
  for (const name of after.keys()) if (!before.has(name)) changed.push(`added: ${name}`);
  return changed;
}

/**
 * Runs the copy of the check in the scratch root.
 *
 * `spawnSync` rather than `execFileSync` because a failing check is the case
 * most of this script is about, and its exit status is the assertion -- it has
 * to be read, not thrown. Both streams come back either way: the check prints
 * its findings to stderr, which is where the messages being asserted live.
 */
function runCheck() {
  const script = join(SCRATCH_ROOT, 'scripts', 'dev', 'check-dist-freshness.mjs');
  const result = spawnSync(process.execPath, [script], {
    cwd: SCRATCH_ROOT,
    encoding: 'utf8',
    // The check writes its own rebuild to a scratch directory beside the
    // throwaway package's dist, so nothing outside the scratch root is touched.
    env: process.env,
  });
  if (result.error !== undefined) throw result.error;
  return {
    status: result.status,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

const failures = [];

function expectRun(label, { exitCode, includes = [], excludes = [] }) {
  const run = runCheck();
  const problems = [];
  if (run.status !== exitCode) {
    problems.push(`expected exit ${exitCode}, got ${run.status}`);
  }
  for (const text of includes) {
    if (!run.output.includes(text)) problems.push(`expected the output to contain: ${text}`);
  }
  for (const text of excludes) {
    if (run.output.includes(text)) problems.push(`expected the output NOT to contain: ${text}`);
  }
  if (problems.length === 0) {
    console.log(`  ok   ${label}`);
    return;
  }
  failures.push({ label, problems, output: run.output });
  console.log(`  FAIL ${label}`);
  for (const problem of problems) console.log(`         ${problem}`);
}

/**
 * The scratch package, and the file the two planted failures act on.
 *
 * `index.js` is compiled from `index.ts`, so the check maps one to the other on
 * its own: hand-editing the output makes it disagree with a rebuild of its
 * source, and `orphan.js` is in `dist` with no source that compiles to it.
 */
const PACKAGE = join(SCRATCH_ROOT, 'packages', 'selftest');
const SOURCE = join(PACKAGE, 'src', 'index.ts');
const OUTPUT = join(PACKAGE, 'dist', 'index.js');
const ORPHAN = join(PACKAGE, 'dist', 'orphan.js');

/** Self-contained so the package compiles without this repository's tsconfigs. */
const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2024"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "composite": true,
    "declaration": true,
    "sourceMap": true,
    "strict": true,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"]
}
`;

const SOURCE_TEXT = `export const answer: number = 42;

export function double(value: number): number {
  return value * 2;
}
`;

/** What a hand edit looks like: output that no source in the tree compiles to. */
const HAND_EDIT = { from: 'value * 2', to: 'value * 3' };

const problems = [];

try {
  if (!existsSync(TSC)) {
    console.error(
      `dist freshness self-test could not run: ${relative(ROOT, TSC)} is missing.\n` +
        'Install dependencies first (`make install`); the check under test rebuilds with tsc.',
    );
    exit(1);
  }

  // The scratch root is a copy of the check and nothing else, so that running it
  // verbatim makes it verify this fixture instead of this repository. Verified
  // byte for byte rather than trusted: an edited copy here would report on
  // something other than the check `make check` runs.
  const checkScript = join(SCRATCH_ROOT, 'scripts', 'dev', 'check-dist-freshness.mjs');
  mkdirSync(dirname(checkScript), { recursive: true });
  copyFileSync(CHECK, checkScript);
  if (!readFileSync(checkScript).equals(readFileSync(CHECK))) {
    throw new Error(`${relative(ROOT, checkScript)} is not byte-identical to ${relative(ROOT, CHECK)}`);
  }
  // `ROOT/node_modules/.bin/tsc`, resolved from the scratch root by the check.
  symlinkSync(join(ROOT, 'node_modules'), join(SCRATCH_ROOT, 'node_modules'));

  mkdirSync(dirname(SOURCE), { recursive: true });
  writeFileSync(join(PACKAGE, 'tsconfig.json'), TSCONFIG);
  writeFileSync(SOURCE, SOURCE_TEXT);

  // The one `tsc` run this self-test performs: it creates the `dist` the check
  // compares against, from one file, in the temp directory.
  const built = spawnSync(
    TSC,
    ['-p', join(PACKAGE, 'tsconfig.json'), '--tsBuildInfoFile', join(PACKAGE, 'tsconfig.tsbuildinfo')],
    { cwd: SCRATCH_ROOT, encoding: 'utf8' },
  );
  if (built.status !== 0) {
    throw new Error(`the throwaway package did not compile: ${built.stdout ?? ''}${built.stderr ?? ''}`);
  }

  const baseline = snapshot(PACKAGE);

  console.log('dist freshness self-test: the check must catch both failures it exists for');
  // Before anything is planted. If this is red the fixture is wrong, and every
  // red after it would be evidence of nothing.
  expectRun('passes on an unmodified scratch package', {
    exitCode: 0,
    includes: ['dist freshness check passed:'],
  });

  // --- The load-bearing case. ------------------------------------------------
  // A hand-edited `dist` is newer than its source, so no comparison of
  // timestamps can see it: an mtime-only check passes this tree. The assertion
  // that it goes red here is what makes the rebuild layer part of the design
  // rather than an implementation detail a later cleanup may drop.
  const original = readFileSync(OUTPUT);
  const compiled = original.toString('utf8');
  if (!compiled.includes(HAND_EDIT.from)) {
    throw new Error(
      `the throwaway package compiled to output without \`${HAND_EDIT.from}\`, so the hand edit would be a ` +
        'no-op and this self-test would assert nothing. The fixture source and this constant have to change together.',
    );
  }

  let handEditRestored = false;
  try {
    writeFileSync(OUTPUT, compiled.replace(HAND_EDIT.from, HAND_EDIT.to));
    // Stamped newer than its source rather than left to the write order, so the
    // blind spot being tested is the real one and does not depend on how coarse
    // this filesystem's timestamps are.
    const sourceTime = statSync(SOURCE).mtimeMs;
    utimesSync(OUTPUT, (sourceTime + NEWER_BY_MS) / 1000, (sourceTime + NEWER_BY_MS) / 1000);

    // The precondition, checked rather than assumed: the planted output is
    // newer than the source it was built from, which is exactly why comparing
    // timestamps calls it fresh.
    const outputTime = statSync(OUTPUT).mtimeMs;
    if (outputTime + TOLERANCE_MS < sourceTime) {
      throw new Error(
        'the hand-edited output is older than its source, so this run would be testing the mtime layer, not the rebuild one',
      );
    }

    expectRun('fails on a hand-edited dist that is newer than its source', {
      exitCode: 1,
      includes: [
        'dist freshness check FAILED:',
        `dist disagrees with its source: ${relative(join(PACKAGE, 'dist'), OUTPUT)}`,
      ],
      // Asserted absent as well as present: a red naming the mtime layer would
      // be the wrong red. This failure has to be caught by the rebuild.
      excludes: ['is older than the source it was built from'],
    });
  } finally {
    writeFileSync(OUTPUT, original);
    handEditRestored = true;
  }

  const afterHandEdit = drift(baseline, snapshot(PACKAGE));
  if (afterHandEdit.length > 0) {
    problems.push(`the restore after the hand edit left: ${afterHandEdit.join(', ')}`);
  }
  if (!handEditRestored) problems.push('the hand edit was never restored');
  expectRun('passes again once the hand edit is restored', {
    exitCode: 0,
    includes: ['dist freshness check passed:'],
  });

  // --- The independent case. -------------------------------------------------
  // An orphan has no source, so it agrees with its own absence and no timestamp
  // comparison involves it. This proves the rebuild layer compares the whole
  // tree rather than only walking sources to their outputs.
  let orphanRemoved = false;
  try {
    writeFileSync(ORPHAN, 'export const leftBehind = true;\n');
    expectRun('fails on an output no source compiles to', {
      exitCode: 1,
      includes: [
        'dist freshness check FAILED:',
        `orphaned output: ${relative(join(PACKAGE, 'dist'), ORPHAN)} is in dist but no source compiles to it.`,
      ],
    });
  } finally {
    rmSync(ORPHAN, { force: true });
    orphanRemoved = true;
  }

  const afterOrphan = drift(baseline, snapshot(PACKAGE));
  if (afterOrphan.length > 0) {
    problems.push(`the cleanup after the orphan left: ${afterOrphan.join(', ')}`);
  }
  if (!orphanRemoved) problems.push('the orphaned output was never removed');
  expectRun('passes again once the orphan is removed', {
    exitCode: 0,
    includes: ['dist freshness check passed:'],
  });

  // The scratch package is byte-identical to what it was before anything was
  // planted, checked against the hashes taken on the way in rather than assumed
  // from the restores above.
  const finalDrift = drift(baseline, snapshot(PACKAGE));
  if (finalDrift.length > 0) {
    problems.push(`the scratch package is not what it started as: ${finalDrift.join(', ')}`);
  }
} catch (error) {
  problems.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  // Every exit path, including an assertion that threw above. The planted file
  // is restored or removed in its own `finally` first; this is the backstop for
  // the whole run, so a crash cannot leave the temp directory behind either.
  rmSync(SCRATCH_ROOT, { recursive: true, force: true });
}

for (const { label, problems: why, output } of failures) {
  console.error(`\n${label}\n${output}`);
}
for (const problem of problems) console.error(`\n${problem}`);

if (failures.length > 0 || problems.length > 0) {
  console.error(
    '\ndist freshness self-test FAILED: the check does not catch every failure it exists for.\n' +
      'A self-test that passes against the implementation it constrains is read as coverage, and is not.\n',
  );
  exit(1);
}

console.log(
  'dist freshness self-test passed: a hand-edited dist newer than its source and an orphaned output each turn the check ' +
    'red, with the rebuild layer named in both, and each returns it to green.',
);
