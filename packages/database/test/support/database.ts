import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * The one place a store suite touches the database.
 *
 * ## Why this exists
 *
 * Eight store suites used to read `DATABASE_URL` themselves and share the
 * development database, and nothing truncated between runs. It reached 741 cases,
 * 597 of them open. Two correct suites then started failing for reasons that had
 * nothing to do with the code under test: a moderation-queue test asked for
 * `limit: 500` and did not get its own rows back, because other suites' cases
 * filled the page. Both passed alone.
 *
 * A suite whose result depends on what else ran is not a test, and the failure
 * mode is worse than a red assertion — a growing database looks like a data
 * problem rather than an isolation one.
 *
 * ## A database per suite, not a schema
 *
 * Every store query is qualified — `FROM app.cases` — so `search_path` is
 * bypassed and cannot isolate. That was tried and measured:
 *
 *     A sees its own row : true
 *     B sees A's row     : true
 *
 * The qualification is deliberate, so it stays and the isolation moves up a
 * level. Each suite gets a migrated database of its own.
 *
 * ## Using it
 *
 * ```ts
 * import { describeDatabase, databasePool } from './support/database.js';
 *
 * describeDatabase('ModerationStore', () => {
 *   let pool: pg.Pool;
 *   beforeAll(async () => { pool = await databasePool('moderation'); });
 *   afterAll(async () => { await pool.end(); await dropDatabase(); });
 * });
 * ```
 *
 * `describeDatabase` fails loudly rather than skipping. A skipped suite reads as
 * a passing one in CI, and a store that cannot reach its database is exactly the
 * situation where a green tick is most damaging.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function readEnv(name: string): string | undefined {
  if (process.env[name] !== undefined) {
    return process.env[name];
  }
  const envFile = join(REPO_ROOT, '.env');
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

/**
 * `localhost` resolves to ::1 first on macOS and the compose file publishes
 * Postgres on IPv4 only, so an untouched `.env` yields
 * `ECONNREFUSED ::1:5432`. Pinning the literal IP is the fix; publishing on both
 * stacks would be worse for no local benefit.
 */
function baseUrl(): string {
  const configured = readEnv('DATABASE_URL');
  if (configured === undefined) {
    throw new Error(
      'DATABASE_URL is not set. Every store suite in this repository runs against real Postgres ' +
        'and will not silently pass without it. Run `cp .env.example .env` then `make up`.',
    );
  }
  return configured.replace('@localhost:', '@127.0.0.1:');
}

interface Isolation {
  readonly database: string;
  readonly connectionString: string;
  create(): Promise<string>;
  drop(): Promise<void>;
}

let isolation: Isolation | undefined;
let created = false;

/**
 * One database per **process**, not per suite: vitest runs files in parallel
 * processes, and two of them creating and dropping the same name race — one
 * drops the database the other is still migrating into. The pid keeps them
 * apart, and the label keeps the leftovers identifiable.
 */
function isolationFor(label: string): Isolation {
  const name = `t_${label.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase().slice(0, 12)}_${process.pid}`;
  const url = new URL(baseUrl());
  url.pathname = `/${name}`;
  const connectionString = url.toString();

  return {
    database: name,
    connectionString,
    async create(): Promise<string> {
      const admin = new pg.Client({ connectionString: baseUrl() });
      await admin.connect();
      try {
        // A database cannot be dropped while connected to, so anything a
        // crashed run left behind goes now rather than failing later.
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${name}`);
      } finally {
        await admin.end();
      }
      const migrator = new pg.Pool({ connectionString });
      try {
        const migrations = join(REPO_ROOT, 'packages/database/migrations');
        for (const file of readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort()) {
          // Verbatim, against the fresh database. The migrations qualify `app.`
          // themselves, which is why a per-suite database works and a per-suite
          // schema did not.
          await migrator.query(readFileSync(join(migrations, file), 'utf8'));
        }
      } finally {
        await migrator.end();
      }
      return connectionString;
    },
    async drop(): Promise<void> {
      const admin = new pg.Client({ connectionString: baseUrl() });
      await admin.connect();
      try {
        // FORCE because a suite that failed mid-run may still hold a pool.
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
}

/** A migrated pool for this suite. Call `dropDatabase()` in `afterAll`. */
export async function databasePool(label: string): Promise<pg.Pool> {
  isolation ??= isolationFor(label);
  if (!created) {
    await isolation.create();
    created = true;
  }
  return new pg.Pool({ connectionString: isolation.connectionString });
}

/**
 * Drops this process's database. **Always call it.** A leaked database is
 * invisible until someone runs out of connections or disk, and it still holds
 * its rows, so a later run against it would quietly see old data.
 */
export async function dropDatabase(): Promise<void> {
  if (isolation !== undefined) {
    const dropping = isolation;
    isolation = undefined;
    created = false;
    await dropping.drop();
  }
}

/** The un-isolated base URL, for a suite that deliberately wants the shared database. */
export function baseDatabaseUrl(): string {
  return baseUrl();
}
