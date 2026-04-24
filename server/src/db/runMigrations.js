/**
 * Apply incremental SQL migrations from server/src/db/migrations/.
 *
 * - Loads DATABASE_URL from process.env (dotenv: cwd, then server/.env).
 * - Records applied files in schema_migrations (never re-runs them).
 * - Invokes `psql` so each file can contain multiple statements and $$…$$ bodies.
 *
 * Usage (from repo root or server/):
 *   cd server && npm run db:apply-migrations
 *
 * Requires: psql on PATH, DATABASE_URL (e.g. postgresql://user:pass@host:5432/dbname)
 */
import { readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../.env') });

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function assertPsqlAvailable() {
  const r = spawnSync('psql', ['--version'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(
      'psql not found on PATH. Install PostgreSQL client tools, or run the .sql files manually with psql.'
    );
    process.exit(1);
  }
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedSet(client) {
  const r = await client.query('SELECT filename FROM schema_migrations');
  return new Set(r.rows.map((row) => row.filename));
}

function listMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

function runPsqlFile(databaseUrl, filePath) {
  const r = spawnSync('psql', [databaseUrl, '-v', 'ON_ERROR_STOP=1', '-f', filePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return r.status === 0;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.error(
      'DATABASE_URL is not set. Add it to server/.env (see .env.example), e.g.\n' +
        '  DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DBNAME\n' +
        'Then from the server directory: npm run db:apply-migrations'
    );
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');

  assertPsqlAvailable();

  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await ensureMigrationsTable(client);
    const done = await appliedSet(client);

    const files = listMigrationFiles();
    const pending = files.filter((f) => !done.has(f));

    if (pending.length === 0) {
      console.log('No pending migrations.');
      return;
    }

    console.log(`Pending migrations (${pending.length}):`);
    for (const f of pending) console.log(`  - ${f}`);
    if (dryRun) {
      console.log('Dry run: not applying.');
      return;
    }

    for (const filename of pending) {
      const full = path.join(MIGRATIONS_DIR, filename);
      console.log(`Applying ${filename} …`);
      const ok = runPsqlFile(databaseUrl, full);
      if (!ok) {
        console.error(`Migration failed: ${filename}`);
        process.exit(1);
      }
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
      console.log(`Recorded ${filename}`);
    }

    console.log('All pending migrations applied.');
  } catch (err) {
    console.error(err.message || err);
    process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main();
