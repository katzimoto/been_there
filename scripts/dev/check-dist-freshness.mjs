#!/usr/bin/env node
/**
 * Fails when a package's compiled output is not what its source compiles to.
 *
 * The hazard this closes was measured here, not hypothesised.
 *
 * `tsc --build` is incremental, and it decides what to rebuild from a *content
 * hash*, not from a timestamp. Two consequences, both reproduced:
 *
 *   1. A `dist` file edited by hand is never repaired. No source changed, so
 *      the project is up to date and the build skips it. The suite then loads
 *      the edited file and passes: hand-editing `packages/core/dist/result.js`
 *      so that `ok()` returned a constant instead of `{ ok: true, value }` left
 *      the source untouched, `tsc --build` exited 0, and the suite loaded the
 *      edited file. A green run then reports as correct code which does not
 *      exist in `src` at all.
 *
 *   2. A source file newer than its output is skipped for the same reason, so a
 *      touched-but-unbuilt tree serves the previous build's code.
 *
 * `check-stale-artifacts.mjs` catches neither: it looks for compiled output
 * *beside* its source and skips `dist` outright, which is the one directory
 * this failure lives in.
 *
 * Two independent layers, because each catches what the other cannot:
 *
 *   mtime    A source whose output is older is stale. Cheap, and it names the
 *            file and both times. This is the layer that catches
 *            `touch src/result.ts` followed by no rebuild.
 *
 *   rebuild  Each package is rebuilt into a scratch directory beside its own
 *            `dist` and compared byte for byte. This is the layer that catches
 *            the hand-edited output, which is *newer* than its source and so
 *            satisfies every timestamp comparison while being wrong. Presence
 *            cannot catch it and neither can freshness: to a test run a
 *            hand-edited `dist` and a stale `dist` are the same failure.
 *
 * The scratch directory sits beside `dist` rather than in the system temp
 * directory deliberately. Sourcemaps record their sources as a path relative to
 * the output, so a build under /tmp emits maps differing from `dist` in the
 * `sources` field alone and every package would read as corrupt. Built beside
 * `dist`, the two are byte-identical, `.js.map` and `.d.ts.map` included.
 *
 * One condition from the original report was measured and then dropped:
 * "dist older than its own tsbuildinfo". After an incremental rebuild that
 * re-emits two of forty files, the other thirty-eight outputs are legitimately
 * seconds older than the tsbuildinfo that same build wrote, and `tsc --build`
 * leaves that file's mtime alone when nothing needs doing. Failing on it would
 * fail a correct tree on every incremental build. Freshness is therefore
 * measured against the source that produced the output, which is the relation
 * that carries the meaning.
 *
 * A tree with no `dist` and no tsbuildinfo — a cold checkout, or one where
 * nothing has been built — is reported as not built and passes. There is no
 * output here to be stale or to disagree with anything, and a check that failed
 * there would fail every fresh clone for a condition that cannot exist.
 *
 * Usage: node scripts/dev/check-dist-freshness.mjs
 * Exits 0 when every built package's output matches its source, 1 otherwise,
 * naming each offending package, file and reason.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { exit } from 'node:process';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PACKAGES = join(ROOT, 'packages');
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');

/** Built beside `dist`, because that is the only placement that keeps the
 *  sourcemaps byte-identical. Removed after each package; see `scratchFor`. */
const SCRATCH = '.dist-freshness';

/**
 * Filesystem timestamps are coarse on some platforms, and a build that reads a
 * source and writes its output within the same tick leaves them equal. Only an
 * output older than its source by more than this is treated as stale, so an
 * equal-timestamp rebuild cannot read as a stale one.
 */
const TOLERANCE_MS = 1000;

/** tsconfig is JSON with comments, and the shared base config uses them. */
function readTsConfig(path) {
  const stripped = readFileSync(path, 'utf8')
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/g, (match, string) => string ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return JSON.parse(stripped);
}

/** Every file under `dir`, keyed by path relative to `dir`. */
function tree(dir) {
  const found = new Map();
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) found.set(relative(dir, absolute), absolute);
    }
  };
  walk(dir);
  return found;
}

/** `.ts` sources, excluding `.d.ts`, which compiles to no output of its own. */
function sources(srcDir) {
  return [...tree(srcDir)]
    .filter(([name]) => name.endsWith('.ts') && !name.endsWith('.d.ts'))
    .map(([, absolute]) => absolute)
    .sort();
}

/**
 * The package's own tsconfig decides whether it emits and where. A package
 * with `noEmit` — the test projects — and one with no tsconfig at all have no
 * output to be stale, so both are skipped rather than guessed at.
 */
function buildablePackages() {
  const packages = [];
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(PACKAGES, entry.name);
    const configPath = join(dir, 'tsconfig.json');
    if (!existsSync(configPath)) continue;

    const { compilerOptions = {} } = readTsConfig(configPath);
    if (compilerOptions.noEmit === true) continue;
    if (compilerOptions.outDir === undefined) continue;

    const outDir = resolve(dir, compilerOptions.outDir);
    const rootDir = resolve(dir, compilerOptions.rootDir ?? 'src');
    if (!existsSync(rootDir)) continue;

    packages.push({ name: `packages/${entry.name}`, dir, configPath, outDir, rootDir });
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

/** First differing byte, so a mismatch names something a reader can act on. */
function firstDifference(expected, actual) {
  const limit = Math.min(expected.length, actual.length);
  for (let index = 0; index < limit; index += 1) {
    if (expected[index] !== actual[index]) {
      const from = Math.max(0, index - 30);
      return {
        at: index,
        expected: expected.subarray(from, index + 30).toString('utf8'),
        actual: actual.subarray(from, index + 30).toString('utf8'),
      };
    }
  }
  return {
    at: limit,
    expected: `${expected.length} bytes`,
    actual: `${actual.length} bytes`,
  };
}

/**
 * Rebuilds `pkg` into a scratch directory beside its `dist` and compares the
 * two byte for byte. Returns the missing, extra and differing outputs, or a
 * failure to build at all — which is reported rather than passed over, since a
 * build that cannot run leaves the output unverified and passing quietly would
 * be the very thing this check exists to prevent.
 */
function compareAgainstRebuild(pkg) {
  const scratch = join(pkg.dir, SCRATCH);
  rmSync(scratch, { recursive: true, force: true });
  try {
    try {
      execFileSync(TSC, [
        '-p', pkg.configPath,
        '--outDir', scratch,
        '--tsBuildInfoFile', join(scratch, 'tsconfig.tsbuildinfo'),
      ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      // tsc reports diagnostics on stdout, not stderr, so reading stderr alone
      // yields only "Command failed" and hides the type error that stopped the
      // comparison. Both streams, or the reason for the failure is lost.
      const output = [error.stdout, error.stderr].filter(Boolean).join('\n').trim();
      return { buildFailed: output.length > 0 ? output : error.message };
    }

    const emitted = tree(scratch);
    const actual = tree(pkg.outDir);
    const missing = [];
    const extra = [];
    const differing = [];

    for (const [name, path] of emitted) {
      // The scratch build's own tsbuildinfo is the rebuild's bookkeeping, not
      // an output `dist` is expected to contain.
      if (name.endsWith('.tsbuildinfo')) continue;
      if (!actual.has(name)) {
        missing.push(name);
        continue;
      }
      const expectedBytes = readFileSync(path);
      const actualBytes = readFileSync(actual.get(name));
      if (!expectedBytes.equals(actualBytes)) {
        differing.push({ name, ...firstDifference(expectedBytes, actualBytes) });
      }
    }

    for (const name of actual.keys()) {
      if (!emitted.has(name)) extra.push(name);
    }

    return { missing, extra, differing };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (!existsSync(TSC)) {
  console.error(
    `dist freshness check could not run: ${relative(ROOT, TSC)} is missing.\n` +
      'Install dependencies first (`make install`); the rebuild this check compares against needs tsc.',
  );
  exit(1);
}

const problems = [];
const notBuilt = [];
let verified = 0;
let outputs = 0;

for (const pkg of buildablePackages()) {
  // Nothing built, so nothing to be stale. A cold checkout takes this path and
  // passes; so does a tree whose build has not run since the last clone.
  if (!existsSync(pkg.outDir)) {
    notBuilt.push(pkg.name);
    continue;
  }

  const onDisk = tree(pkg.outDir);
  if (onDisk.size === 0) {
    notBuilt.push(pkg.name);
    continue;
  }
  outputs += onDisk.size;

  const findings = [];

  // Layer one: freshness against the source that produced each output.
  for (const source of sources(pkg.rootDir)) {
    const name = relative(pkg.rootDir, source);
    const output = join(pkg.outDir, name.replace(/\.ts$/, '.js'));
    if (!existsSync(output)) continue; // The rebuild layer reports this precisely.
    const sourceTime = statSync(source).mtimeMs;
    const outputTime = statSync(output).mtimeMs;
    if (outputTime + TOLERANCE_MS < sourceTime) {
      findings.push(
        `stale output: ${relative(pkg.outDir, output)} is older than the source it was built ` +
          `from, ${relative(pkg.dir, source)} (${Math.round((sourceTime - outputTime) / 1000)}s). ` +
          'Rebuild with `npm run build`.',
      );
    }
  }

  // Layer two: the output must equal what the source compiles to now.
  const rebuild = compareAgainstRebuild(pkg);
  if (rebuild.buildFailed !== undefined) {
    findings.push(`could not rebuild for comparison, so its output is unverified:\n${rebuild.buildFailed}`);
  } else {
    for (const name of rebuild.missing) {
      findings.push(`missing output: ${name} is what the source compiles to but is not in dist.`);
    }
    for (const name of rebuild.extra) {
      findings.push(
        `orphaned output: ${name} is in dist but no source compiles to it. ` +
          'Output for a source that has been renamed or deleted survives until a clean build.',
      );
    }
    for (const entry of rebuild.differing) {
      findings.push(
        `dist disagrees with its source: ${entry.name} differs from the rebuild at byte ${entry.at}.\n` +
          `      from source: ...${entry.expected}\n` +
          `      in dist:     ...${entry.actual}`,
      );
    }
  }

  verified += 1;
  if (findings.length > 0) problems.push({ package: pkg.name, findings });
}

if (problems.length > 0) {
  console.error(
    `dist freshness check FAILED: ${problems.length} package(s) whose compiled output does not match its source.\n` +
      'A test run against this tree executes code that is not in src, and passes anyway. Rebuild:\n' +
      '  rm -rf packages/*/dist packages/*/tsconfig.tsbuildinfo && npm run build\n',
  );
  for (const { package: name, findings } of problems) {
    console.error(`  ${name}`);
    for (const finding of findings) console.error(`    - ${finding}`);
    console.error('');
  }
  exit(1);
}

const skipped = notBuilt.length > 0 ? `, ${notBuilt.length} not built (${notBuilt.join(', ')})` : '';
console.log(
  `dist freshness check passed: ${verified} package(s), ${outputs} output file(s) byte-identical to a ` +
    `rebuild of their sources, no stale or orphaned output${skipped}.`,
);