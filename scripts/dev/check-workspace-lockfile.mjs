#!/usr/bin/env node
/**
 * Fails if `package-lock.json` has drifted from the workspace manifests.
 *
 * This already cost one CI run: `packages/integration` was added, every local
 * verification passed, and CI failed at `npm ci` because the lockfile predated
 * it. Local verification does not run `npm ci`, so nothing local saw the drift.
 *
 * `npm ci` itself cannot be the local check — it deletes `node_modules`, which
 * is wrong for an inner loop. This is a 200ms read of the manifests and the
 * lockfile instead.
 *
 * Usage: node scripts/dev/check-workspace-lockfile.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { exit } from 'node:process';

const ROOT = resolve(import.meta.dirname, '..', '..');
const LOCKFILE = join(ROOT, 'package-lock.json');

if (!existsSync(LOCKFILE)) {
  console.error('package-lock.json is missing. Run `npm install` and commit the result.');
  exit(1);
}

const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8'));
const lockPackages = lock.packages ?? {};
const problems = [];

const declared = new Map();
const packagesDir = join(ROOT, 'packages');
if (existsSync(packagesDir)) {
  for (const entry of readdirSync(packagesDir)) {
    const manifest = join(packagesDir, entry, 'package.json');
    if (!existsSync(manifest)) {
      continue;
    }
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    declared.set(parsed.name, { dir: entry, dependencies: Object.keys(parsed.dependencies ?? {}) });
  }
}

for (const [name, { dir }] of declared) {
  if (!Object.keys(lockPackages).includes(`packages/${dir}`)) {
    problems.push(`${name}: present in packages/${dir} but absent from the lockfile`);
  }
}

// A workspace dependency must be declared, or a non-hoisting install resolves
// it to nothing. Three packages imported core without declaring it and every
// build passed, because npm workspaces hoists a symlink to the repository root
// that made the omission invisible. Checked after every name is known, so the
// order of readdir does not decide the outcome.
for (const [name, { dependencies }] of declared) {
  for (const dependency of dependencies) {
    if (dependency.startsWith('@been-there/') && !declared.has(dependency)) {
      problems.push(`${name}: depends on ${dependency}, which is not a workspace package`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Lockfile check failed (${problems.length}):\n`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error('\nRun `npm install` and commit the updated package-lock.json.');
  exit(1);
}

console.log(
  `Lockfile check passed: ${declared.size} workspace package(s) present in the manifest and the lockfile.`,
);
