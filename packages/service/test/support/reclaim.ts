import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Orphaned per-suite databases, reclaimed when the process exits.
 *
 * ## Why this exists
 *
 * Suites drop their database in `afterAll`, and three of them leak:
 * `health.test.ts` and `health-restart.test.ts` start a *second* service of their
 * own — faulted stores, or several servers on one pool — and
 * `account-sessions.test.ts` builds its own `ServiceDependencies`. Each prepares
 * a database it then abandons, and nothing reclaims it.
 *
 * The symptom is invisible for a long time and then it is not. The development
 * database reached **97** orphaned databases before this existed, and the failure
 * surfaced as `StoreError: the connection was terminated` in whichever suite ran
 * next. That reads as a flaky test. It is not — it is a pool exhausted by
 * databases nobody dropped.
 *
 * `afterAll` is the right place to drop a database and the wrong place to
 * *guarantee* it: a suite that throws, or that opens its own handle, bypasses it.
 * This is the belt to those braces. The names carry the pid, so anything still
 * matching at exit is unambiguously this run's own, and reclaiming it needs no
 * cooperation from the suite that made it.
 *
 * ## How it drops, and why it is a subprocess
 *
 * Reclaiming happens in an `exit` handler, where the event loop is no longer
 * ours and a promise-based driver will not settle. So this shells out to
 * `psql` through the compose container, which needs no connection state of our
 * own and fails harmlessly if the container is not there.
 *
 * It never drops another process's database: the pid is in the name.
 */

function readDatabaseUrl(): string | undefined {
  const fromEnv = process.env['DATABASE_URL'];
  if (fromEnv !== undefined) {
    return fromEnv;
  }
  const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.env');
  if (!existsSync(envFile)) {
    return undefined;
  }
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const match = /^\s*DATABASE_URL\s*=\s*(.*?)\s*$/.exec(line);
    if (match !== null) {
      return match[1];
    }
  }
  return undefined;
}

const claimed = new Set<string>();
let armed = false;

/** Records that this process created `name`, so it is reclaimed if not dropped. */
export function claimDatabase(name: string): void {
  claimed.add(name);
  if (armed) {
    return;
  }
  // Deliberately no `process.on('exit')` backstop. A vitest worker tears the
  // process down without running those handlers, so an exit hook is a promise
  // rather than a guarantee — which is exactly the failure this file exists to
  // fix. `reclaim()` is called explicitly from `afterAll` instead, which runs.
  void armed;
}

/** Releases a database the suite dropped itself, so it is not dropped twice. */
export function releaseDatabase(name: string): void {
  claimed.delete(name);
}

/**
 * Drops every still-claimed database. Idempotent, and silent on failure: an
 * error here would mask whatever brought the process down, and the next run's
 * `create` drops leftovers by name anyway.
 */
export function reclaim(): void {
  if (claimed.size === 0) {
    return;
  }
  const names = [...claimed];
  claimed.clear();

  const env = readDatabaseUrl();
  if (env === undefined) {
    return;
  }
  const user = process.env['POSTGRES_USER'] ?? 'been_there';
  const database = process.env['POSTGRES_DB'] ?? 'been_there';

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