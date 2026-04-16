import { MAX_BYTES } from './services/noteFileBlobs.js';

const MAX_ATTACHMENTS_PER_CALL = 20;

/**
 * Shared fetch wrapper for Hermes REST from MCP (stdio + HTTP).
 * Throws on non-OK with err.status for clear 401 handling in callTool.
 */
export function hermesApiFetcher(baseUrl, getToken) {
  return async function api(path, options = {}) {
    const url = `${String(baseUrl).replace(/\/$/, '')}/api${path}`;
    const token = typeof getToken === 'function' ? getToken() : getToken;
    const headers = { ...options.headers, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(url, { ...options, headers });
    if (r.status === 204) return {};
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(data.error || r.statusText || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return data;
  };
}

/**
 * Multipart upload to POST /api/notes/:id/attachments (MCP: base64-encoded files).
 * Resolves to the full JSON body: `{ inserted: [...] }`, and when the note had empty text,
 * `{ inserted, ocr }` with per-file OCR outcomes (same as curl).
 * @param {string} baseUrl e.g. http://127.0.0.1:3000
 * @param {string | (() => string)} getToken JWT
 * @param {string} noteId
 * @param {Array<{ filename?: string, mime_type?: string, base64?: string, data?: string }>} files
 */
export async function uploadNoteAttachmentsMultipart(baseUrl, getToken, noteId, files) {
  const token = typeof getToken === 'function' ? getToken() : getToken;
  if (!files?.length) {
    const e = new Error('files array required');
    e.status = 400;
    throw e;
  }
  if (files.length > MAX_ATTACHMENTS_PER_CALL) {
    const e = new Error(`At most ${MAX_ATTACHMENTS_PER_CALL} files per call`);
    e.status = 400;
    throw e;
  }
  const fd = new FormData();
  for (const f of files) {
    const b64 = String(f.base64 || f.data || '').replace(/\s/g, '');
    let buf;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch {
      buf = Buffer.alloc(0);
    }
    if (!buf.length) {
      const e = new Error(`Invalid or empty base64 for ${f.filename || 'file'}`);
      e.status = 400;
      throw e;
    }
    if (buf.length > MAX_BYTES) {
      const e = new Error(`File exceeds ${MAX_BYTES} bytes (${f.filename || 'file'})`);
      e.status = 413;
      throw e;
    }
    const blob = new Blob([buf], { type: f.mime_type || 'application/octet-stream' });
    fd.append('files', blob, (f.filename || 'upload').slice(0, 512));
  }
  const url = `${String(baseUrl).replace(/\/$/, '')}/api/notes/${noteId}/attachments`;
  // Web UI does not send this header; OCR + note fill only run when it is set (API/MCP/scripts).
  const headers = { 'X-Hermes-Attachment-Ocr': '1' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(url, { method: 'POST', headers, body: fd });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(data.error || r.statusText || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}
