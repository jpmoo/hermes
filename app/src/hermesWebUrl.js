const BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/';

/**
 * Stream deep link with a single `note` param (no `&`), so pasted links are not truncated at `&focus=…`
 * when copied into Spaztick or other tools. Stream resolves this to thread + focus.
 * @param {string} noteId
 * @returns {string|null}
 */
export function buildHermesStreamNoteUrlClient(noteId) {
  if (typeof window === 'undefined' || noteId == null) return null;
  try {
    const base = String(BASE).replace(/\/$/, '');
    const u = new URL(`${window.location.origin}${base}/stream`);
    u.searchParams.set('note', String(noteId));
    return u.toString();
  } catch {
    return null;
  }
}
