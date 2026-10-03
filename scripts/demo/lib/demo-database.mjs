/**
 * The database the demo runs against.
 *
 * A database of the walk's own, created and migrated for the run and dropped
 * afterwards. It exists for the same reason `packages/service/test/support/isolation.ts`
 * gives every suite one: a shared database accumulates rows between runs, and a
 * step whose outcome depends on what else ran is not a demonstration. The
 * difference is only the ownership — the suites drop theirs in `afterAll`, this
 * one drops its own in a `finally` in `journey.mjs`, and both leak loudly enough
 * that `scripts/dev/check-no-leaked-databases.mjs` counts them.
 *
 * The name carries the `t_` prefix on purpose. That check looks for `t\_%`, so a
 * demo database left behind by a killed run is reported by the same rule as a
 * leaked suite database rather than becoming invisible.
 *
 * `DATABASE_URL` is read the way `packages/database/scripts/migrate.mjs` reads
 * it: from the environment, and from `.env` when there is one. Nothing here is a
 * fallback connection string — a demo that quietly connected to the wrong
 * database would be worse than one that refuses.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'packages/database/migrations');

/**
 * Fills `process.env` from `.env`, and from `.env.example` when there is no
 * `.env`, never overwriting a value already set.
 *
 * The fallback is what makes `npm run demo:journey` work on a clean checkout.
 * The Makefile carries its own defaults, but a bare `npm` script runs without
 * them, and a newcomer who has never seen this repository should not have to
 * create a `.env` before the demo answers. `.env.example` is not a second copy
 * of those values — it is the tracked file they are written in, it ships in the
 * bundle, and its own header says every value in it is a local-only
 * placeholder. A real deployment sets `DATABASE_URL` in the environment and
 * wins, because the environment is checked first.
 */
export function loadDotEnv() {
  for (const name of ['.env', '.env.example']) {
    const file = join(REPO_ROOT, name);
    if (!existsSync(file)) {
      continue;
    }
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      const key = match?.[1];
      const value = match?.[2];
      if (key !== undefined && value !== undefined && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

/**
 * The connection string for the server, with the loopback address pinned.
 *
 * `localhost` resolves to ::1 first on macOS and the compose file publishes
 * IPv4 only, so an untouched `.env` yields `ECONNREFUSED ::1:55432`. The suites
 * make the same substitution; it belongs to every client of this URL, not to one
 * of them.
 */
export function baseDatabaseUrl() {
  const configured = process.env['DATABASE_URL'];
  if (configured === undefined) {
    throw new Error(
      'DATABASE_URL is not set. The demo runs against real Postgres and will not run ' +
        'against something else. Run `cp .env.example .env` then `make up`.',
    );
  }
  return configured.replace('@localhost:', '@127.0.0.1:');
}

/**
 * Creates a database, applies every migration to it verbatim, and hands back the
 * connection string. `drop()` is what makes the run repeatable.
 *
 * @param {import('pg').default} pg
 * @param {string} label
 */
export function demoDatabase(pg, label) {
  const base = baseDatabaseUrl();
  const pid = String(process.pid);
  const name = `t_${label.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase().slice(0, 12)}_${pid}_${randomBytes(4).toString('hex')}`;
  const url = new URL(base);
  url.pathname = `/${name}`;
  const connectionString = url.toString();
  let dropped = false;

  const withAdmin = async (fn) => {
    const admin = new pg.Client({ connectionString: base });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  };

  return {
    database: name,
    connectionString,

    async create() {
      if (!existsSync(MIGRATIONS)) {
        throw new Error(`No migrations directory at ${MIGRATIONS}.`);
      }
      await withAdmin(async (admin) => {
        // A database cannot be dropped while a connection is open to it, so a
        // leftover from a killed run goes now rather than failing later.
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${name}`);
      });
      const pool = new pg.Pool({ connectionString });
      try {
        for (const file of readdirSync(MIGRATIONS)
          .filter((name_) => name_.endsWith('.sql'))
          .sort()) {
          await pool.query(readFileSync(join(MIGRATIONS, file), 'utf8'));
        }
      } finally {
        await pool.end();
      }
      return connectionString;
    },

    async drop() {
      if (dropped) {
        return;
      }
      dropped = true;
      await withAdmin(async (admin) => {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      });
    },
  };
}