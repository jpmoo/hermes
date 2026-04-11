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
 * Public web base for the Hermes app (no trailing slash), e.g. https://host/hermes
 * @param {import('express').Request|null} req
 * @returns {string|null}
 */
export function getHermesPublicWebBase(req) {
  const env = (process.env.HERMES_PUBLIC_APP_URL || process.env.HERMES_PUBLIC_API_URL || '')
    .trim()
    .replace(/\/$/, '');
  if (env) return env;
  if (!req) return null;
  const host = req.get('x-forwarded-host') || req.get('host');
  if (!host) return null;
  let proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  proto = String(proto).split(',')[0].trim();
  if (proto !== 'http' && proto !== 'https') proto = 'http';
  const basePath = (process.env.HERMES_WEB_BASE_PATH || '/hermes').replace(/\/$/, '');
  return `${proto}://${host}${basePath}`;
}

/**
 * Stream deep link with a single query param (avoids & being stripped when pasted into plain text).
 * Stream resolves ?note= to thread + focus on load.
 * @param {string} noteId
 * @param {import('express').Request|null} [req]
 * @returns {string|null}
 */
export function buildHermesStreamUrl(noteId, req = null) {
  const base = getHermesPublicWebBase(req);
  if (!base) return null;
  try {
    const u = new URL(`${base}/stream`);
    u.searchParams.set('note', String(noteId));
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
