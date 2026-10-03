import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Per-suite databases, reclaimed on request.
 *
 * ## Why this exists
 *
 * Every suite gets a database of its own so it cannot see another's rows — see
 * `isolation.ts`. Suites drop theirs in `afterAll`, and three of them did not:
 * they start a *second* service of their own, or build their own
 * `ServiceDependencies`, so nothing outside the file is holding the database
 * they prepared.
 *
 * The failure mode is the worst kind, because it does not look like one. The
 * development database reached **97** orphans, and the suite that failed was
 * whichever ran next, with `StoreError: the connection was terminated`. That
 * reads as a flake and gets re-run; it is a pool exhausted by databases nobody
 * dropped.
 *
 * ## How a suite uses it
 *
 * ```ts
 * import { reclaimPrepared } from './support/reclaim.js';
 *
 * afterAll(async () => {
 *   await pool.end();
 *   reclaimPrepared();
 * });
 * ```
 *
 * `reclaimPrepared()` drops everything `requireDatabaseReady()` handed out this
 * process and nothing else. That precision is the point: an earlier blanket
 * `reclaim()` in one suite dropped a sibling database mid-run and broke it, so
 * the name says what it touches.
 *
 * It shells out to `psql` through the compose container rather than using the
 * driver, because this also runs at a point where a promise-based pool will not
 * settle. It never touches a database belonging to another process — the names
 * carry the pid.
 */

function readEnv(name: string) {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');
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

const prepared = new Set<string>();

/** Records a database `requireDatabaseReady()` created for this process. */
export function notePrepared(name: string): void {
  prepared.add(name);
}

/** Drops every database this process prepared and has not released. */
export function reclaimPrepared(): void {
  const names = [...prepared];
  prepared.clear();

  const user = readEnv('POSTGRES_USER') ?? 'been_there';
  const database = readEnv('POSTGRES_DB') ?? 'been_there';
  if (readEnv('DATABASE_URL') === undefined) {
    return;
  }

  for (const name of names) {
    spawnSync(
      'docker',
      [
        'compose',
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        user,
        '-d',
        database,
        '-q',
        '-c',
        `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`,
      ],
      { stdio: 'ignore', cwd: process.cwd() },
    );
  }
}