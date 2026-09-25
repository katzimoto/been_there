#!/usr/bin/env node
/**
 * Fails if compiled output sits next to the TypeScript it was built from.
 *
 * This hazard is not hypothetical. `tsc` emitted `.js`/`.d.ts` beside the
 * sources in `packages/core/src`, they were committed, and vitest resolves
 * `../src/index.js` to a real file before it ever reaches the `.ts` — so the
 * test suite ran compiled code from an earlier build. A guard that had been
 * added to the source still read as absent, which produced a confident and
 * entirely wrong "already fixed".
 *
 * The same applies to a config file: a stale `vitest.config.js` is preferred by
 * the loader over `vitest.config.ts`, and four of them sat at the repository
 * root for a while.
 *
 * Usage: node scripts/dev/check-stale-artifacts.mjs
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { exit } from 'node:process';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);
const COMPILED_EXTENSIONS = new Set(['.js', '.map']);

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full));
    } else {
      found.push(full);
    }
  }
  return found;
}

const files = walk(ROOT);
const paths = new Set(files);
const problems = [];

// A compiled artefact beside a same-stem TypeScript file. Present on disk is
// enough here: the loader prefers the .js whether or not it is committed, so an
// untracked stale artefact is still a stale artefact.
for (const file of files) {
  const name = basename(file);
  if (name.endsWith('.d.ts') || !COMPILED_EXTENSIONS.has(extname(name))) {
    continue;
  }
  const stem = name.replace(/\.(js|map)$/, '');
  const source = join(dirname(file), `${stem}.ts`);
  if (paths.has(source)) {
    problems.push(
      `${relative(ROOT, file)}: compiled artefact beside ${relative(ROOT, source)} — ` +
        'the loader prefers the .js, so the suite runs stale code',
    );
  }
}

// Build metadata matters only when it is committed. An untracked
// `*.tsbuildinfo` in the working tree is normal and gitignored; a tracked one
// is not.
let tracked;
try {
  tracked = new Set(
    execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 })
      .split('\n')
      .filter((line) => line !== ''),
  );
} catch {
  console.error('Could not read the git index. Is this a git repository?');
  exit(1);
}

for (const file of files) {
  if (!file.endsWith('.tsbuildinfo')) {
    continue;
  }
  const rel = relative(ROOT, file);
  if (tracked.has(rel)) {
    problems.push(`${rel}: build metadata is tracked; add it to .gitignore`);
  }
}

if (problems.length > 0) {
  console.error(`Stale artefact check failed (${problems.length}):\n`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error('\nDelete the artefacts and add the paths to .gitignore.');
  exit(1);
}

console.log(
  `Stale artefact check passed: ${files.length} files scanned, no compiled output beside source, ` +
    'no tracked build metadata.',
);
