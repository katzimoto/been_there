/**
 * Per-suite database isolation.
 *
 * Every suite used to share one database, and nothing truncated between runs. It
 * accumulated 741 cases, 597 of them open, and two correct suites started
 * failing: a moderation-queue test asked for 500 rows and did not get its own,
 * and a service test found 50 cases where it expected one. Both passed alone. A
 * suite whose result depends on what else ran is not a test.
 *
 * ## Why a database and not a schema
 *
 * The first attempt used a per-suite Postgres schema with `search_path`, which
 * is the obvious cheap answer and does not work here. Every store query is
 * schema-qualified — `FROM app.users`, `INSERT INTO app.identity_state` — so a
 * `search_path` is bypassed entirely and every suite still reads and writes the
 * one `app` schema. It was verified and it did not isolate:
 *
 *     A sees its own row : true
 *     B sees A's row     : true
 *
 * Rewriting ~40 queries to be schema-relative would work, but the queries are
 * qualified *on purpose*: an unqualified table resolves to whatever happens to be
 * first on the path, which is how a query silently reads the wrong schema.
 * Per-suite databases keep that guarantee and isolate honestly.
 *
 * The cost is a `CREATE DATABASE` per suite, which is fast on a local Postgres
 * and is dropped afterwards.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Client } from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const MIGRATIONS = join(REPO_ROOT, 'packages/database/migrations');

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

export function baseDatabaseUrl() {
  const configured = readEnv('DATABASE_URL');
  if (configured === undefined) {
    throw new Error(
      'DATABASE_URL is not set. Every database suite in this repository runs against real ' +
        'Postgres and will not silently pass without it. Run `cp .env.example .env` then `make up`.',
    );
  }
  // `localhost` resolves to ::1 first on macOS, and the compose file publishes
  // Postgres on IPv4 only — so an untouched `.env` yields
  // `ECONNREFUSED ::1:5432`. Pinning the literal IP is the fix; the alternative
  // is publishing on both stacks, which is worse for no benefit locally.
  return configured.replace('@localhost:', '@127.0.0.1:');
}

/**
 * A database of this suite's own, migrated and ready.
 *
 * `create()` returns the connection string to hand to a `Pool`; `drop()` removes
 * the database. **Call `drop` in `afterAll`.** A leaked database is invisible
 * until someone runs out of connections or disk, which is a bad afternoon to
 * discover it.
 */
export interface IsolatedDatabase {
  readonly database: string;
  readonly connectionString: string;
  create(): Promise<string>;
  drop(): Promise<void>;
}

export function isolatedDatabase(label = 'suite'): IsolatedDatabase {
  const base = new URL(baseDatabaseUrl());
  // Per **process**, not per suite: vitest runs files in parallel processes, and
  // two of them creating and dropping the same name race — one drops the
  // database the other is still migrating into. The pid keeps them apart, and
  // the random suffix keeps two runs of the same process from colliding.
  const pid = String(process.pid);
  const name = `t_${label.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase().slice(0, 12)}_${pid}_${randomBytes(4).toString('hex')}`;

  const url = new URL(base);
  url.pathname = `/${name}`;
  const connectionString = url.toString();

  let dropped = false;

  const withAdmin = async (fn: (admin: Client) => Promise<void>): Promise<void> => {
    const admin = new pg.Client({ connectionString: baseDatabaseUrl() });
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
        // A database cannot be dropped while a connection is open to it, so any
        // left over from a crashed run goes now rather than failing later.
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        await admin.query(`CREATE DATABASE ${name}`);
      });

      const pool = new pg.Pool({ connectionString });
      try {
        for (const file of readdirSync(MIGRATIONS)
          .filter((file: string) => file.endsWith('.sql'))
          .sort()) {
          // Verbatim, against the fresh database. The migrations qualify
          // `app.` themselves, which is why a separate database works and a
          // per-suite schema did not.
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
