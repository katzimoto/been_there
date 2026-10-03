#!/usr/bin/env node
/**
 * Fails when a test run leaves a per-suite database behind.
 *
 * ## Why this exists
 *
 * Suites get a database of their own so they cannot see each other's rows — see
 * `packages/service/test/support/isolation.ts`. Every suite drops it in
 * `afterAll`, and three of them did not: they start a *second* service of their
 * own, so nothing else is holding the database they prepared.
 *
 * The failure mode is the worst kind, because it does not look like one. The
 * development database reached **97** orphans, and the suite that failed was
 * whichever ran next, with `StoreError: the connection was terminated`. That
 * reads as a flaky test and gets re-run; it is actually a pool exhausted by
 * databases nobody dropped. It cost an hour to diagnose and would have cost the
 * same again next week.
 *
 * So the leak gets checked rather than remembered. This runs after the suites,
 * counts what is left, and names it.
 *
 *   node scripts/dev/check-no-leaked-databases.mjs
 *
 * Exits 0 and prints the count when it is zero; exits non-zero otherwise.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function envValue(name) {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  const envFile = resolve(REPO_ROOT, '.env');
  if (!existsSync(envFile)) {
    return undefined;
  }
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`).exec(line);
    if (match !== null) {
      return match[1];
    }
  }
  return undefined;
}

function query(sql) {
  const result = spawnSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      envValue('POSTGRES_USER') ?? 'been_there',
      '-d',
      envValue('POSTGRES_DB') ?? 'been_there',
      '-tAc',
      sql,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return (result.stdout ?? '').trim();
}

const rows = query("SELECT datname FROM pg_database WHERE datname LIKE 't\\_%' ORDER BY datname");
const leaked = rows === '' ? [] : rows.split('\n').filter((line) => line.trim().length > 0);

if (leaked.length === 0) {
  console.log('No leaked per-suite databases.');
  process.exit(0);
}

console.error(`Leaked per-suite databases: ${leaked.length}`);
for (const name of leaked) {
  console.error(`  - ${name}`);
}
console.error(
  '\nEach per-suite database is created for one test file and must be dropped in\n' +
    "that file's `afterAll`. A suite that starts its own service, builds its own\n" +
    'ServiceDependencies, or spawns child processes is the usual cause: nothing\n' +
    'outside the file is holding the database it prepared.',
);
process.exit(1);