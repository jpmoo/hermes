#!/usr/bin/env node
/**
 * Logical backup via pg_dump (custom format, compressed).
 * Run from server/: npm run db:backup
 * Requires: DATABASE_URL in env (e.g. server/.env), pg_dump on PATH.
 *
 * Schedule on the host (recommended), e.g. daily cron:
 *   0 3 * * * cd /path/to/hermes/server && /usr/bin/npm run db:backup
 *
 * HERMES_DB_BACKUP_DIR — output directory (default: server/backups)
 * HERMES_DB_BACKUP_RETENTION_DAYS — if set and > 0, delete hermes-*.dump older than this many days
 */
import 'dotenv/config';
import { spawnSync } from 'child_process';
import { mkdirSync, readdirSync, unlinkSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error('DATABASE_URL is not set (e.g. in server/.env).');
  process.exit(1);
}

const backupRoot = (process.env.HERMES_DB_BACKUP_DIR || path.join(__dirname, '..', 'backups')).trim();
const retentionRaw = process.env.HERMES_DB_BACKUP_RETENTION_DAYS?.trim();
const retentionDays = retentionRaw ? Number(retentionRaw) : NaN;

mkdirSync(backupRoot, { recursive: true });

const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const outFile = path.join(backupRoot, `hermes-${ts}.dump`);

const r = spawnSync('pg_dump', [url, '-Fc', '-f', outFile], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('pg_dump failed.');
  process.exit(r.status || 1);
}
console.log(`Wrote ${outFile}`);

if (!Number.isNaN(retentionDays) && retentionDays > 0) {
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const name of readdirSync(backupRoot)) {
    if (!name.startsWith('hermes-') || !name.endsWith('.dump')) continue;
    const fp = path.join(backupRoot, name);
    try {
      const st = statSync(fp);
      if (now - st.mtimeMs > maxAgeMs) {
        unlinkSync(fp);
        console.log(`Removed old backup: ${name}`);
      }
    } catch {
      /* ignore per-file errors */
    }
  }
}
