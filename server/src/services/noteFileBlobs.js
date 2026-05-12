import pool from '../db/pool.js';
import { buildPdfAttachmentThumbnail, isPdfAttachmentMime } from './pdfAttachmentThumbnail.js';

const MAX_BYTES = Number(process.env.HERMES_MAX_ATTACHMENT_BYTES) || 20 * 1024 * 1024;

export { MAX_BYTES };

/**
 * Insert a note_file_blobs row; PDFs get a first-page PNG thumbnail when generation succeeds.
 * @param {{ noteId: string, userId: string, filename: string, mime: string, buf: Buffer, sortIndex: number }} p
 */
export async function insertNoteFileBlobRow({ noteId, userId, filename, mime, buf, sortIndex }) {
  let thumbMime = null;
  let thumbData = null;
  if (isPdfAttachmentMime(mime, filename)) {
    const t = await buildPdfAttachmentThumbnail(buf);
    if (t?.data?.length) {
      thumbMime = t.mime;
      thumbData = t.data;
    }
  }
  const ins = await pool.query(
    `INSERT INTO note_file_blobs (note_id, user_id, filename, mime_type, byte_size, data, sort_index, thumbnail_mime, thumbnail_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, filename, mime_type, byte_size`,
    [noteId, userId, filename, mime, buf.length, buf, sortIndex, thumbMime, thumbData]
  );
  return ins.rows[0];
}

export async function attachBlobListToNotes(notes, userId) {
  if (!notes?.length) return;
  const ids = [...new Set(notes.map((n) => n.id))];
  try {
    const ar = await pool.query(
      `SELECT id, note_id, filename, mime_type, byte_size, sort_index, is_banner
       FROM note_file_blobs WHERE note_id = ANY($1::uuid[]) AND user_id = $2
       ORDER BY sort_index ASC, created_at ASC, id ASC`,
      [ids, userId]
    );
    const by = {};
    for (const row of ar.rows) {
      if (!by[row.note_id]) by[row.note_id] = [];
      by[row.note_id].push({
        id: row.id,
        filename: row.filename,
        mime_type: row.mime_type,
        byte_size: Number(row.byte_size),
        sort_index: row.sort_index != null ? Number(row.sort_index) : 0,
        is_banner: row.is_banner === true,
      });
    }
    for (const n of notes) {
      n.attachments = by[n.id] || [];
    }
  } catch (e) {
    // Missing migration 003 → roots/thread/search all 500 and UI shows no notes
    if (e.code === '42P01') {
      console.warn(
        'Hermes: table note_file_blobs missing — run server/src/db/migrations/003_note_file_blobs.sql (notes work; attachments disabled).'
      );
    } else {
      console.error('attachBlobListToNotes:', e.message);
    }
    for (const n of notes) {
      n.attachments = [];
    }
  }
}
