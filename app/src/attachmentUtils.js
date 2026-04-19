const BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '';

export function noteFileUrl(id) {
  return `${BASE.replace(/\/$/, '')}/api/note-files/${id}`;
}

/**
 * Authenticated GET for the account default background image (no id).
 * Pass `revision` (e.g. timestamp from account settings) to bust caches after upload/replace.
 */
export function userBackgroundFileUrl(revision) {
  const base = `${BASE.replace(/\/$/, '')}/api/user/background`;
  if (revision != null && revision !== 0) {
    return `${base}?v=${encodeURIComponent(String(revision))}`;
  }
  return base;
}

export function isImageMime(m, filename) {
  if (typeof m === 'string' && m.startsWith('image/')) return true;
  if (typeof filename === 'string' && /\.(jpe?g|png|gif|webp|avif|bmp|svg|heic)$/i.test(filename)) {
    return true;
  }
  return false;
}

/** First image attachment on a note (stream order), or null. */
export function firstImageAttachment(note) {
  const list = note?.attachments;
  if (!Array.isArray(list)) return null;
  for (const a of list) {
    if (!a || typeof a.id !== 'string') continue;
    if (isImageMime(a.mime_type, a.filename)) return a;
  }
  return null;
}
