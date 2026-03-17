import pool from '../db/pool.js';

const MAX_BYTES = Number(process.env.HERMES_MAX_ATTACHMENT_BYTES) || 20 * 1024 * 1024;

export { MAX_BYTES };

export async function attachBlobListToNotes(notes, userId) {
  if (!notes?.length) return;
  const ids = [...new Set(notes.map((n) => n.id))];
  const ar = await pool.query(
    `SELECT id, note_id, filename, mime_type, byte_size
     FROM note_file_blobs WHERE note_id = ANY($1::uuid[]) AND user_id = $2
     ORDER BY created_at ASC`,
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
    });
  }
  for (const n of notes) {
    n.attachments = by[n.id] || [];
  }
}
