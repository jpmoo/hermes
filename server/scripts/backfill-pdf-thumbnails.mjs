#!/usr/bin/env node
/**
 * Generate and store first-page PNG thumbnails for PDF attachments that lack them.
 * Run from server/: npm run db:backfill-pdf-thumbnails
 *
 * Processes up to 200 rows per invocation (re-run until it reports fetched=0).
 * Requires: DATABASE_URL, migration 013 applied, pg_dump not needed — uses Node + pg.
 */
import 'dotenv/config';
import pg from 'pg';
import { buildPdfAttachmentThumbnail, isPdfAttachmentMime } from '../src/services/pdfAttachmentThumbnail.js';

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error('DATABASE_URL is not set (e.g. in server/.env).');
  process.exit(1);
}

const LIMIT = Math.min(500, Math.max(1, Number(process.env.HERMES_PDF_THUMB_BACKFILL_LIMIT) || 200));

async function main() {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query(
      `SELECT id, data, mime_type, filename
       FROM note_file_blobs
       WHERE (mime_type = 'application/pdf' OR lower(filename) LIKE '%.pdf')
         AND thumbnail_data IS NULL
       ORDER BY created_at ASC
       LIMIT $1`,
      [LIMIT]
    );
    let ok = 0;
    let skip = 0;
    let fail = 0;
    for (const row of r.rows) {
      if (!isPdfAttachmentMime(row.mime_type, row.filename)) {
        skip++;
        continue;
      }
      const raw = row.data;
      const pdfBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      const built = await buildPdfAttachmentThumbnail(pdfBuf);
      if (!built?.data?.length) {
        skip++;
        continue;
      }
      try {
        const u = await client.query(
          `UPDATE note_file_blobs
           SET thumbnail_mime = $1, thumbnail_data = $2
           WHERE id = $3::uuid AND thumbnail_data IS NULL`,
          [built.mime, built.data, row.id]
        );
        if (u.rowCount > 0) {
          ok++;
          console.log(`thumbnail ${row.id} ${row.filename || ''}`);
        } else {
          skip++;
        }
      } catch (e) {
        fail++;
        console.error(`FAIL ${row.id}`, e instanceof Error ? e.message : e);
      }
    }
    console.log(`Done. updated=${ok} skipped=${skip} failed=${fail} batch_size=${r.rows.length}`);
    if (r.rows.length === LIMIT) {
      console.log('More rows may remain — run again until batch_size < limit.');
    }
  } catch (e) {
    if (e.code === '42703') {
      console.error('Missing columns — apply migration 013_note_file_blobs_pdf_thumbnail.sql first.');
    } else {
      console.error(e);
    }
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
