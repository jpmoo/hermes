import pool from '../db/pool.js';

/**
 * Walk parent chain to thread root (same semantics as GET /notes/:id/thread-root).
 * @returns {string|null} thread root UUID
 */
export async function getThreadRootIdForNote(noteId, userId) {
  const r = await pool.query(
    `WITH RECURSIVE up AS (
       SELECT id, parent_id FROM notes WHERE id = $1::uuid AND user_id = $2
       UNION ALL
       SELECT n.id, n.parent_id FROM notes n JOIN up u ON n.id = u.parent_id WHERE n.user_id = $2
     )
     SELECT id AS thread_root_id FROM up WHERE parent_id IS NULL LIMIT 1`,
    [noteId, userId]
  );
  return r.rows.length ? r.rows[0].thread_root_id : null;
}

/**
 * Full Stream URL for opening a note, using HERMES_PUBLIC_APP_URL or HERMES_PUBLIC_API_URL as origin base.
 * @returns {string|null}
 */
export function buildHermesStreamUrl(noteId, threadRootId) {
  const base = (process.env.HERMES_PUBLIC_APP_URL || process.env.HERMES_PUBLIC_API_URL || '')
    .trim()
    .replace(/\/$/, '');
  if (!base) return null;
  try {
    const u = new URL(`${base}/stream`);
    u.searchParams.set('thread', String(threadRootId));
    u.searchParams.set('focus', String(noteId));
    return u.toString();
  } catch {
    return null;
  }
}

const NOTE_URL_MAX = 2048;

/**
 * Append a Hermes back-link line to Spaztick task notes. Prefers http(s) URL; falls back to hermes-note:// UUID.
 * @param {string|null|undefined} notes
 * @param {{ httpUrl?: string | null, noteId?: string | null }} opts
 * @returns {string}
 */
export function appendHermesLinkToNotes(notes, { httpUrl, noteId } = {}) {
  const n = notes == null ? '' : String(notes).trim();
  let line = '';
  const u = httpUrl != null ? String(httpUrl).trim() : '';
  if (u && /^https?:\/\//i.test(u) && u.length <= NOTE_URL_MAX) {
    line = `Hermes: ${u}`;
  } else if (noteId && /^[0-9a-f-]{36}$/i.test(String(noteId))) {
    const id = String(noteId).toLowerCase();
    line = `Hermes: hermes-note://${id}`;
  } else {
    return n;
  }
  return n ? `${n}\n\n${line}` : line;
}
