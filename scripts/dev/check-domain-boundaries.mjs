#!/usr/bin/env node
/**
 * Fails when one domain package reaches into another.
 *
 * Commitment 6 — "domains never import each other's internals" — was the one
 * commitment with no gate of any kind. It was not a tooling nicety: it is the
 * rule that decides whether this codebase stays seven domains or collapses into
 * one, and nothing in the repository would have noticed it being broken.
 *
 * ## What the rest of the build already catches, and what it does not
 *
 * A *deep* import — `@been-there/moderation/dist/case.js` — is already a
 * compile error, because every `package.json` here publishes a single `"."`
 * export and the resolver honours it. So the internals half of the commitment
 * was never the hole.
 *
 * The hole was the public entry point. This was measured, not assumed: adding
 * `import { caseMachine } from '@been-there/moderation'` to
 * `packages/dating/src/profile.ts`, adding `@been-there/moderation` to
 * `packages/dating/package.json`, and rebuilding produced
 *
 *     npx tsc --build    exit 0
 *     npx vitest run packages/dating    9 files, 176 tests, all passing
 *     node scripts/dev/check-stale-artifacts.mjs       passed
 *     node scripts/dev/check-workspace-lockfile.mjs     passed
 *     node scripts/dev/check-ci-parity.mjs             passed
 *
 * — a direct dating-to-moderation call that `tsc` accepts because both packages
 * typecheck, that no test fails because the import is additive, and that every
 * existing check in `make check` waves through. A reviewer was the only thing
 * standing between this repository and that coupling.
 *
 * ## What this asserts
 *
 * The layering is stated here rather than derived from the current imports. A
 * rule computed from the code it governs passes by construction and would make
 * the commitment look enforced while enforcing nothing, which is the exact
 * shape of the gap this script exists to close. Widening the policy is
 * therefore a visible edit to a named list — a review conversation rather than
 * a silent refactor.
 *
 * Source and tests are checked against different lists, because two real edges
 * exist only in tests and both are deliberate:
 *
 *   - A suite imports its own package by name to reach the public entry point.
 *   - `packages/service/test` builds real stores through `@been-there/database`.
 *     The harness says outright that there is no in-memory double anywhere in
 *     it, so the adapter is a legitimate test dependency. `database` is an
 *     adapter implementing `contracts`, not a domain, so this is not a
 *     commitment-6 relaxation — and it stays out of `src`, where the service
 *     takes its stores as injected dependencies.
 *
 * Two failures, because they are two separate mistakes:
 *
 *   1. An import the layering does not permit. This is commitment 6 itself.
 *   2. A dependency declared in `package.json` that the layering does not
 *      permit. Declaring the dep is the setup step of the exploit above, so
 *      failing here means the error arrives before there is an import to be
 *      tempted by.
 *
 * The reverse omission — an import no manifest declares, resolving through the
 * symlink npm hoists to the repository root — is deliberately not checked
 * here. It is a real one: `packages/service/test` reaches
 * `@been-there/database` in seven files and `packages/service/package.json` does
 * not declare it. It is also not commitment 6, and closing it means editing a
 * manifest and the lockfile, which is a different piece of work. Reported,
 * rather than silently fixed or silently folded in.
 *
 * Type-only imports and re-exports count. `import type { X } from '...'` is the
 * cheapest way to couple two domains and the hardest to spot in review, because
 * it produces no runtime edge at all.
 *
 * Usage: node scripts/dev/check-domain-boundaries.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { exit } from 'node:process';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PACKAGES_DIR = join(ROOT, 'packages');
const SELF_PATH = relative(ROOT, resolve(import.meta.dirname, 'check-domain-boundaries.mjs'));
// A Record rather than a Set: these names are written down here and never
// mutated, so a Set would be a second answer to "which directories do we skip".
const SKIP_DIRS = {
  node_modules: true,
  dist: true,
  '.git': true,
  coverage: true,
  '.build': true,
};

/** The domain packages, in one place, so the tables and messages agree. */
const DOMAINS = ['identity', 'dating', 'communication', 'trust-safety', 'moderation', 'platform'];

/**
 * What each package's `src/` may import.
 *
 * A domain may reach `core`, the shared kernel every domain is built on, and
 * nothing else. `core` is listed for completeness and reaches nothing: it is the
 * kernel rather than a domain, so there is no edge it holds that some other
 * package does not hold too.
 */
const SOURCE_LAYERING = {
  core: [],
  contracts: ['core'],
  identity: ['core'],
  dating: ['core'],
  communication: ['core'],
  'trust-safety': ['core'],
  moderation: ['core'],
  platform: ['core'],
  // An adapter that implements `contracts`. It knows how rows are stored and
  // nothing about what a domain means, so it reaches the kernel and the port
  // definitions and stops there.
  database: ['core', 'contracts'],
  // The composition root: the HTTP edge that wires every domain into a running
  // product. Knowing that the domains exist is its entire job, and it is handed
  // its stores rather than building them, which is why `database` is absent.
  service: ['core', 'contracts', ...DOMAINS],
  // Test-only, and deliberately not a domain. `packages/integration` exists so
  // the cross-domain claims have somewhere to live; a domain asserting about
  // another domain would be the coupling commitment 6 forbids.
  integration: ['core', 'contracts', ...DOMAINS],
};

/**
 * What each package's `test/` may import: the source layering, plus its own
 * package by name, plus the persistence adapter.
 */
function testLayering(name, source) {
  return [...new Set([...source, name, 'database'])];
}

const problems = [];

function permitted(allowed) {
  return allowed.length === 0 ? '(nothing)' : allowed.join(', ');
}

/**
 * Every workspace package name, mapped to its directory.
 *
 * Read from the manifests rather than from the directory names, so a package
 * whose name and its directory disagree is handled correctly instead of quietly
 * escaping the check as an unknown.
 */
const packagesByName = new Map();
for (const entry of readdirSync(PACKAGES_DIR)) {
  const manifest = join(PACKAGES_DIR, entry, 'package.json');
  if (!existsSync(manifest)) {
    continue;
  }
  const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  packagesByName.set(parsed.name.replace('@been-there/', ''), entry);
}

// A package the layering does not describe cannot be governed by it. Failing
// here is deliberate: skipping it would let a new domain be added with no
// boundary at all, which is the gap this script was written to close.
for (const [name, entry] of packagesByName) {
  if (!(name in SOURCE_LAYERING)) {
    problems.push(
      `packages/${entry} (${name}): no source layer declared in ${SELF_PATH}. A package with no ` +
        'declared layer has no boundary, so add it deliberately.',
    );
  }
}

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS[entry] === true) {
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

/**
 * Strips comments before the specifier scan.
 *
 * Without this a doc comment showing the right way to import, or merely naming
 * a package, reads as an import of it. The false positive would land on the one
 * kind of file most likely to discuss the boundary.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Module specifiers in every position that creates a dependency edge:
 * `from '...'`, a bare `import '...'`, `import('...')`, and `require('...')`.
 */
function specifiersIn(source) {
  const found = [];
  const pattern = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
  let match = pattern.exec(source);
  while (match !== null) {
    found.push({ specifier: match[1], index: match.index });
    match = pattern.exec(source);
  }
  return found;
}

/** The line a character offset falls on, 1-based, so the error points somewhere. */
function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * The workspace package a path belongs to, or undefined if it belongs to none.
 *
 * Matched by containment rather than equality, because the path handed in is
 * the directory of the file a relative specifier resolved to — usually
 * `packages/moderation/src`, not the package root. An equality test passes on
 * the one input nobody writes and misses every real one.
 */
function owningPackage(path) {
  for (const [name, entry] of packagesByName) {
    const packageDir = join(PACKAGES_DIR, entry);
    if (path === packageDir || path.startsWith(`${packageDir}/`)) {
      return name;
    }
  }
  return undefined;
}

for (const [name, entry] of packagesByName) {
  const packageDir = join(PACKAGES_DIR, entry);
  const sourceAllowed = SOURCE_LAYERING[name];
  if (sourceAllowed === undefined) {
    continue;
  }

  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const declared = Object.keys(manifest.dependencies ?? {}).filter((dependency) =>
    dependency.startsWith('@been-there/'),
  );

  // 2. A declared dependency the layering forbids. Checked before the imports so
  // the error arrives when the door is opened rather than when somebody walks
  // through it. Judged against the union of both lists, because `database` is a
  // legal test-only dependency and a manifest cannot say which half it is for.
  const declaredAllowed = new Set([...sourceAllowed, name, 'database']);
  for (const dependency of declared) {
    const target = dependency.replace('@been-there/', '');
    if (!declaredAllowed.has(target)) {
      problems.push(
        `packages/${entry}/package.json: declares ${dependency}, which the layering does not ` +
          `permit ${name} to depend on. Permitted: ${permitted(sourceAllowed)}.`,
      );
    }
  }

  for (const area of ['src', 'test']) {
    const dir = join(packageDir, area);
    if (!existsSync(dir)) {
      continue;
    }
    const allowed = area === 'src' ? sourceAllowed : testLayering(name, sourceAllowed);
    for (const file of walk(dir)) {
      if (!file.endsWith('.ts') && !file.endsWith('.mjs')) {
        continue;
      }
      const raw = readFileSync(file, 'utf8');
      for (const { specifier, index } of specifiersIn(stripComments(raw))) {
        const shown = relative(ROOT, file);
        const at = lineOf(raw, index);

        // A relative specifier that climbs out of this package is a boundary
        // crossing by another route, and the one most likely to survive review,
        // because it does not look like a package name.
        if (specifier.startsWith('..')) {
          const escaped = owningPackage(dirname(resolve(dirname(file), specifier)));
          if (escaped !== undefined && escaped !== name) {
            problems.push(
              `${shown}:${at}: imports '${specifier}', which resolves inside the ${escaped} ` +
                'package. A boundary is a boundary whichever way the path points.',
            );
          }
          continue;
        }

        if (!specifier.startsWith('@been-there/')) {
          continue;
        }
        const target = specifier.slice('@been-there/'.length);
        const slash = target.indexOf('/');
        const packageName = slash === -1 ? target : target.slice(0, slash);

        // A deep import is already a compile error, because every manifest
        // publishes only `"."`. Naming it here costs nothing and states the
        // rule instead of relying on a resolver to keep implying it.
        if (slash !== -1) {
          problems.push(
            `${shown}:${at}: imports '${specifier}'. That is another package's internal module; ` +
              'a cross-package import names the public entry point or nothing.',
          );
          continue;
        }

        if (!allowed.includes(packageName)) {
          problems.push(
            `${shown}:${at}: imports '${specifier}', which the layering does not permit ${name} ` +
              `to import from its ${area}/. Permitted: ${permitted(allowed)}. A domain publishes ` +
              'events and reads public read-models; it does not call across.',
          );
        }
      }
    }
  }
}

if (problems.length > 0) {
  console.error(`Domain boundary check failed (${problems.length}):\n`);
  for (const problem of problems) {
    console.error(`  - ${problem}`);
  }
  console.error(
    '\nA domain may import core, and nothing else. service and integration are composition\n' +
      'roots and may reach every public entry point; database is an adapter and reaches\n' +
      'core and contracts, from tests only. If an edge here is genuinely wanted, it is a\n' +
      `change to SOURCE_LAYERING in ${SELF_PATH} and to docs/architecture/00-overview.md —\n` +
      'both, so the code and the stated design move together.',
  );
  exit(1);
}

console.log(
  `Domain boundary check passed: ${packagesByName.size} workspace packages, no domain imports ` +
    'another.',
);