#!/usr/bin/env node
/**
 * Applies the SQL migrations in `migrations/`, in filename order, inside one
 * transaction each, and records what it applied.
 *
 * Deliberately boring: no ORM, no framework. The schema is the contract, the
 * files are the history, and a developer can read exactly what ran by looking in
 * one directory.
 *
 *   node packages/database/scripts/migrate.mjs
 *
 * A second run is a no-op and exits 0. A migration that fails rolls itself back
 * and exits non-zero without recording it, so a half-applied schema cannot be
 * mistaken for a complete one.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit } from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(HERE, '..', 'migrations');
const REPO_ROOT = resolve(HERE, '..', '..', '..');

// Read the connection from the environment, and from `.env` when it is there,
// so the credentials the developer set up are the ones used. A hard-coded
// fallback that does not match `.env.example` produces a confusing auth error
// rather than an obvious one.
const ENV_FILE = join(REPO_ROOT, '.env');
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match !== null && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}

const connectionString = process.env.DATABASE_URL;
if (connectionString === undefined) {
  console.error('DATABASE_URL is not set. Run `cp .env.example .env`, then `make up`.');
  exit(1);
}

const { Pool } = await import('pg').catch(() => ({ Pool: null }));
if (Pool === null) {
  console.error('The `pg` package is not installed. Run `npm install`.');
  exit(1);
}

const pool = new Pool({ connectionString });
const applied = new Map();

try {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  if (files.length === 0) {
    console.error(`No migrations found in ${MIGRATIONS_DIR}.`);
    process.exitCode = 1;
  } else {
    await pool.query(`
      CREATE SCHEMA IF NOT EXISTS app;
      CREATE TABLE IF NOT EXISTS app.schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    for (const filename of files) {
      const existing = await pool.query(
        'SELECT filename FROM app.schema_migrations WHERE filename = $1',
        [filename],
      );
      if (existing.rowCount > 0) {
        applied.set(filename, 'already applied');
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO app.schema_migrations (filename) VALUES ($1)', [filename]);
        await client.query('COMMIT');
        applied.set(filename, 'applied');
      } catch (error) {
        await client.query('ROLLBACK');
        console.error(`\n${filename} failed and was rolled back.\n`);
        console.error(error.message);
        process.exitCode = 1;
      } finally {
        client.release();
      }
      if (process.exitCode === 1) {
        break;
      }
    }
  }
} finally {
  await pool.end();
}

for (const [filename, state] of applied) {
  console.log(`  ${state.padEnd(16)} ${filename}`);
}
if (applied.size > 0) {
  console.log(`\n${applied.size} migration(s) processed.`);
}
exit(process.exitCode ?? 0);
