#!/usr/bin/env node
/**
 * Packages this repository into a single archive a stranger can unpack and run.
 *
 *   npm run demo:bundle
 *
 * ## Why this exists
 *
 * "Clone it and read the Makefile" is not a deliverable. Somebody who has never
 * seen this project has to be able to take one file, unpack it somewhere empty,
 * and get to a running system with commands they could have guessed. That means
 * the archive carries its own README, its own env template and its own
 * migrations — and carries *nothing* of the developer's machine.
 *
 * So the exclusion list below is the interesting half of this file. An archive
 * that carries a stale `node_modules`, a `.env` with somebody's port in it, or a
 * leaked per-suite test database is not a demo; it is a bug report with extra
 * steps. Each exclusion says why, because the next person to add a build
 * directory will otherwise add it right back.
 *
 * ## How it is built
 *
 * Files are copied into a staging directory under their archive-relative paths,
 * the archive is written from that staging directory, and the archive is then
 * unpacked into a second temporary directory and compared against the staging
 * directory file by file. Staging rather than passing a file list to `tar`
 * exists so that what gets verified is what `tar` was pointed at, with no
 * dependence on how `tar` orders `-C` against `-T`.
 *
 * A bundle that does not unpack to what it claims is a failure, not a warning.
 * The point is that the recipient never finds out the hard way.
 *
 * Usage:
 *   node scripts/demo/bundle.mjs              # build, verify, report
 *   node scripts/demo/bundle.mjs --keep       # keep the unpacked copy for inspection
 *   node scripts/demo/bundle.mjs --out DIR    # write the archive somewhere else
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Directory names excluded at any depth, with the reason. Keyed by name so a
 * `node_modules` ten packages deep is caught by the same rule as the root one.
 */
const EXCLUDED_DIRECTORIES = new Map([
  ['node_modules', 'installed dependencies; `npm ci` rebuilds them exactly from the lockfile'],
  ['dist', 'compiled output; `npm run build` regenerates it and a stale one runs old code'],
  ['.build', 'Swift build output'],
  ['.git', 'history is not needed to run the demo and is large'],
  ['coverage', 'test coverage report for this machine'],
  ['.demo', 'demo runtime state (pid files, logs) written by `make demo`'],
  ['.turbo', 'task runner cache'],
  ['.cache', 'tool cache'],
]);

/**
 * File names excluded at any depth, with the reason. Matching is on the exact
 * basename, so `packages/x/.env` is caught the same as the root one.
 */
const EXCLUDED_FILES = new Map([['.DS_Store', 'macOS directory metadata']]);

/**
 * Every `.env*` file except the template. Enumerating `.env` and `.env.local`
 * was not enough and this is the proof: a canary named `.env.canary-probe`
 * shipped in the archive, because the rule matched a list rather than a shape.
 * An env file is named by the thing that reads it, and nobody agrees on which
 * suffixes exist, so the rule has to be "starts with `.env`, except the one file
 * that is a template of local-only placeholders".
 */
const ENV_TEMPLATE = '.env.example';

function isEnvFile(name) {
  return name.startsWith('.env') && name !== ENV_TEMPLATE;
}

/**
 * Basename patterns excluded at any depth. These are the shapes a build or a run
 * leaves behind, rather than things a person chose to name.
 */
const EXCLUDED_PATTERNS = [
  { pattern: /\.tsbuildinfo$/, reason: 'TypeScript build metadata; rebuilt by `npm run build`' },
  { pattern: /\.log$/, reason: 'run output from this machine' },
  // Per-suite test databases are named `t_<suite>` and must be dropped by the
  // suite that created them. One that survives is a leak — see
  // scripts/dev/check-no-leaked-databases.mjs. If a dump of one is ever written
  // to disk, it must not travel in an archive.
  { pattern: /^t_/, reason: 'a leaked per-suite test database, or a dump of one' },
  { pattern: /\.(dump|backup)$/, reason: 'a dump of a local throwaway database' },
];

/**
 * Paths excluded relative to the repository root, with the reason. Only for
 * things whose exclusion is a decision rather than a shape.
 */
const EXCLUDED_PATHS = new Map([
  ['README.md', 'replaced by scripts/demo/DEMO-README.md, which ships as the archive root README'],
  ['tsconfig.tsbuildinfo', 'build metadata'],
]);

/**
 * Repository path -> path inside the archive. Everything else keeps its own.
 * The README is renamed rather than dropped, because the person who unpacks this
 * needs the bundle's README and not the repository's, and because an archive
 * whose root has no README reads as an accident.
 */
const RENAMES = new Map([['scripts/demo/DEMO-README.md', 'README.md']]);

/**
 * Files the archive must carry to be runnable by a stranger, checked rather than
 * assumed. A missing one means the walk or the exclusion list is wrong, and the
 * archive would have shipped broken.
 */
const REQUIRED = [
  'Makefile',
  'docker-compose.yml',
  '.env.example',
  'package.json',
  'package-lock.json',
  'tsconfig.base.json',
  'tsconfig.json',
  'vitest.config.ts',
  'packages/database/scripts/migrate.mjs',
  'scripts/demo/DEMO-README.md',
  // The demo entry points. Without these the archive is a repository someone
  // has to set up rather than a demo someone can run, and the README would be
  // describing commands that do not exist in it.
  'scripts/demo/journey.mjs',
  'scripts/demo/server.mjs',
  'scripts/demo/lib/client.mjs',
  'scripts/demo/lib/demo-database.mjs',
  'scripts/demo/lib/narrative.mjs',
  'scripts/demo/lib/people.mjs',
  'scripts/demo/lib/steps.mjs',
];

function exclusionReason(relPath, name, isDirectory) {
  if (EXCLUDED_PATHS.has(relPath)) {
    return EXCLUDED_PATHS.get(relPath);
  }
  if (isDirectory && EXCLUDED_DIRECTORIES.has(name)) {
    return `a ${name}/ directory: ${EXCLUDED_DIRECTORIES.get(name)}`;
  }
  if (isDirectory) {
    return null;
  }
  if (isEnvFile(name)) {
    return `a ${name} file: local configuration; ${ENV_TEMPLATE} is the template that ships instead`;
  }
  if (EXCLUDED_FILES.has(name)) {
    return `a ${name} file: ${EXCLUDED_FILES.get(name)}`;
  }
  for (const { pattern, reason } of EXCLUDED_PATTERNS) {
    if (pattern.test(name)) {
      return `matches ${pattern}: ${reason}`;
    }
  }
  return null;
}

/**
 * Proves the `.env` rule is still a shape rather than a list.
 *
 * This rule once enumerated `.env` and `.env.local`, and a file named
 * `.env.canary-probe` shipped in a distributed archive — a secret-shaped file
 * leaving the machine, found only by planting one and looking. The fix was to
 * match the shape, but a shape that silently reverts to a list on the next edit
 * would fail the same way and equally quietly. So the rule is checked against
 * names nobody would enumerate, every run, before anything is packed.
 */
function assertEnvRuleIsShapeBased() {
  const mustBeExcluded = [
    '.env',
    '.env.local',
    '.env.production',
    '.env.canary-probe',
    '.env.test.local',
    '.envrc.development',
    '.env.staging',
  ];
  const regressions = [];
  for (const name of mustBeExcluded) {
    if (!isEnvFile(name)) {
      regressions.push(name);
    }
  }
  if (isEnvFile(ENV_TEMPLATE)) {
    regressions.push(`${ENV_TEMPLATE} (the template must still ship)`);
  }

  // The same rule, applied the way the packer applies it: on the basename of a
  // nested path. A `.env` ten packages down must be caught by the same line.
  const nestedExcluded = [
    'packages/service/.env.staging',
    'packages/core/.env.canary-probe',
    'scripts/demo/lib/.env.local',
  ];
  for (const path of nestedExcluded) {
    const basename = path.split('/').pop();
    if (!isEnvFile(basename) || exclusionReason(path, basename, false) === null) {
      regressions.push(path);
    }
  }

  // And the one name that must still ship. Losing it breaks every command.
  if (exclusionReason(ENV_TEMPLATE, ENV_TEMPLATE, false) !== null) {
    regressions.push(`${ENV_TEMPLATE} (excluded, but the template must ship)`);
  }
  if (regressions.length > 0) {
    console.error(
      'The .env exclusion rule no longer matches the shape of an env file. ' +
        `It would let these through: ${regressions.join(', ')}.`,
    );
    console.error(
      `A .env* file leaving this machine in an archive is a leak, not a cosmetic ` +
        `oversight. Fix isEnvFile() to test the prefix, keeping ${ENV_TEMPLATE}.`,
    );
    process.exit(1);
  }
}

/**
 * Every file that goes in, relative to ROOT and sorted, plus the reasons for
 * everything that does not.
 *
 * Symlinks are skipped rather than followed: a link that escapes the repository
 * turns "one self-contained archive" into a claim about someone else's disk.
 * An excluded directory is not walked, because counting the 30 000 files inside
 * a `node_modules` would say nothing about the bundle.
 */
function collect() {
  const included = [];
  const excluded = [];

  function walk(dir) {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const relPath = relative(ROOT, full).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        excluded.push({
          path: relPath,
          directory: false,
          reason: 'a symlink, which may point outside this repository',
        });
        continue;
      }
      const reason = exclusionReason(relPath, entry.name, entry.isDirectory());
      if (reason !== null) {
        excluded.push({ path: relPath, directory: entry.isDirectory(), reason });
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        included.push({ path: relPath, bytes: statSync(full).size });
      }
    }
  }

  walk(ROOT);
  included.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { included, excluded };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) {
    throw new Error(`${command} could not run: ${result.error.message}`);
  }
  return result;
}

function mustRun(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}\n${result.stderr ?? ''}${result.stdout ?? ''}`,
    );
  }
  return result;
}

function parseArgs(argv) {
  const options = { keep: false, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--keep') {
      options.keep = true;
    } else if (argv[i] === '--out') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error('--out needs a directory');
      }
      options.out = resolve(value);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return options;
}

/** Every regular file under `dir`, as sorted paths relative to `dir`. */
function listFiles(dir) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        found.push(relative(dir, full).split(sep).join('/'));
      }
    }
  };
  walk(dir);
  return found.sort();
}

function manifestText(included, excluded, version) {
  const totalBytes = included.reduce((sum, file) => sum + file.bytes, 0);
  return [
    'Been There - demo bundle manifest',
    '',
    `Version:    ${version}`,
    `Files:      ${included.length}`,
    `Total size: ${(totalBytes / 1024).toFixed(0)} KiB`,
    '',
    'Included files, relative to the archive root:',
    ...included.map((file) => `  ${file.path}  (${file.bytes} bytes)`),
    '',
    'Deliberately excluded from this archive:',
    '  node_modules/        npm ci rebuilds them from package-lock.json',
    '  dist/, .build/       compiled output; a stale one runs old code',
    '  .git/                not needed to run the demo',
    "  .env*                 this machine's configuration; .env.example ships instead",
    '  *.tsbuildinfo        TypeScript build metadata',
    '  t_*                  a leaked per-suite test database, or a dump of one',
    '  *.log, *.dump        run output and database dumps',
    '  symlinks             may point outside this repository',
    '  README.md            replaced by the bundle README shipped at the archive root',
    '',
    `That is ${excluded.length} excluded path(s) in the source tree.`,
    '',
  ].join('\n');
}

function summariseExclusions(excluded) {
  const directories = new Set();
  let files = 0;
  for (const entry of excluded) {
    if (entry.directory) {
      directories.add(entry.path);
    } else {
      files += 1;
    }
  }
  const names = [...directories].sort();
  const summary = `${names.length} directories, ${files} files`;
  return names.length <= 8 ? `${summary} (${names.join(', ')})` : summary;
}

function stage(included, stageDir) {
  for (const file of included) {
    const destination = join(stageDir, RENAMES.get(file.path) ?? file.path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(ROOT, file.path), destination);
  }
}

/**
 * Unpacks the archive and compares it to the staging directory it was built from.
 *
 * Three things are checked, because each has bitten a bundle before: that the
 * unpacked file list equals the staged one, that nothing matching an exclusion
 * pattern survived those rules, and that the archive has a README at its root
 * rather than only in `scripts/demo/`.
 */
function verify(archivePath, unpackDir, expected, manifestBody) {
  mustRun('tar', ['-xzf', archivePath, '-C', unpackDir]);

  const actual = listFiles(unpackDir);
  const missing = expected.filter((path) => !actual.includes(path));
  const unexpected = actual.filter((path) => !expected.includes(path));
  if (missing.length > 0 || unexpected.length > 0) {
    const detail = [
      missing.length > 0 ? `missing: ${missing.slice(0, 10).join(', ')}` : null,
      unexpected.length > 0 ? `unexpected: ${unexpected.slice(0, 10).join(', ')}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    throw new Error(`the unpacked tree differs from the staged one (${detail})`);
  }

  // The exclusion rules must hold against the result, not only against intent.
  const survivors = actual.filter((path) => {
    const segments = path.split('/');
    const name = segments[segments.length - 1];
    return (
      segments.some((segment) => EXCLUDED_DIRECTORIES.has(segment)) ||
      EXCLUDED_FILES.has(name) ||
      isEnvFile(name) ||
      EXCLUDED_PATTERNS.some(({ pattern }) => pattern.test(name))
    );
  });
  if (survivors.length > 0) {
    throw new Error(`the archive contains excluded paths: ${survivors.slice(0, 10).join(', ')}`);
  }

  for (const required of [
    'README.md',
    'Makefile',
    'docker-compose.yml',
    '.env.example',
    'BUNDLE-MANIFEST.txt',
  ]) {
    if (!existsSync(join(unpackDir, required))) {
      throw new Error(`the unpacked archive has no ${required}`);
    }
  }
  if (readFileSync(join(unpackDir, 'BUNDLE-MANIFEST.txt'), 'utf8') !== manifestBody) {
    throw new Error('the manifest inside the archive differs from the one written beside it');
  }
  for (const required of REQUIRED) {
    const archived = RENAMES.get(required) ?? required;
    if (!existsSync(join(unpackDir, archived))) {
      throw new Error(`the unpacked archive is missing ${archived}, so it cannot be run`);
    }
  }

  return actual;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    // A bad flag is a typo, not a bug in the repository, so it gets one line
    // rather than a stack trace through the whole build.
    console.error(`${error instanceof Error ? error.message : String(error)}`);
    console.error('Usage: node scripts/demo/bundle.mjs [--out DIR] [--keep]');
    process.exit(1);
  }

  if (run('tar', ['--version']).status !== 0) {
    console.error('This script needs `tar` on PATH (GNU tar or bsdtar). Install it and try again.');
    process.exit(1);
  }

  assertEnvRuleIsShapeBased();
  const { included, excluded } = collect();

  const present = new Set(included.map((file) => file.path));
  const missing = REQUIRED.filter((path) => !present.has(path));
  if (missing.length > 0) {
    console.error('Refusing to build an archive that cannot be run. Missing:');
    for (const path of missing) {
      console.error(`  - ${path}`);
    }
    process.exit(1);
  }

  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const manifestBody = manifestText(included, excluded, version);
  const outDir = options.out ?? join(ROOT, 'dist', 'demo');
  const archivePath = join(outDir, `been-there-demo-${version}.tar.gz`);
  const manifestPath = join(outDir, 'been-there-demo-manifest.txt');

  const stageDir = mkdtempSync(join(tmpdir(), 'been-there-stage-'));
  let unpackDir = null;
  try {
    stage(included, stageDir);
    writeFileSync(join(stageDir, 'BUNDLE-MANIFEST.txt'), manifestBody);

    mkdirSync(outDir, { recursive: true });
    mustRun('tar', ['-czf', archivePath, '-C', stageDir, '.']);
    writeFileSync(manifestPath, manifestBody);

    console.log(`Built ${relative(ROOT, archivePath)} from ${included.length} files.`);
    console.log(`Manifest beside it at ${relative(ROOT, manifestPath)}.`);

    unpackDir = mkdtempSync(join(tmpdir(), 'been-there-verify-'));
    const unpacked = verify(archivePath, unpackDir, listFiles(stageDir), manifestBody);
    console.log(
      `Verified by unpacking to a temporary directory: ${unpacked.length} files, ` +
        'file list matches the staged tree exactly, no excluded path survived, ' +
        'README and every file needed to run are present.',
    );
    console.log(
      `Excluded ${excluded.length} paths from the source tree: ${summariseExclusions(excluded)}.`,
    );
    if (options.keep) {
      console.log(`The unpacked copy was kept at ${unpackDir} (--keep).`);
      unpackDir = null;
    }
  } catch (error) {
    console.error(`Bundle failed: ${error instanceof Error ? error.message : String(error)}`);
    if (unpackDir !== null) {
      console.error(`The unpacked tree was left at ${unpackDir} for inspection.`);
      unpackDir = null;
    }
    process.exitCode = 1;
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
    if (unpackDir !== null) {
      rmSync(unpackDir, { recursive: true, force: true });
    }
  }
}

main();
