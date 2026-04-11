const BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';

/**
 * Full URL to open a note on the Stream (matches in-app navigation: thread + focus).
 * @param {string} noteId
 * @param {string} threadRootId
 * @returns {string|null}
 */
export function buildHermesStreamNoteUrlClient(noteId, threadRootId) {
  if (typeof window === 'undefined' || noteId == null || threadRootId == null) return null;
  try {
    const base = String(BASE).replace(/\/$/, '');
    const u = new URL(`${window.location.origin}${base}/stream`);
    u.searchParams.set('thread', String(threadRootId));
    u.searchParams.set('focus', String(noteId));
    return u.toString();
  } catch {
    return null;
  }
}
