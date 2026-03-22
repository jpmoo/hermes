/** Persist Stream URL search (?thread=&focus=) so the Stream nav control can return to the last in-thread level. */

export const STREAM_NAV_LS_KEY = 'hermes.lastStreamSearch';

export function getLastStreamSearch() {
  try {
    return localStorage.getItem(STREAM_NAV_LS_KEY) || '';
  } catch {
    return '';
  }
}

/** @param {URLSearchParams} searchParams */
export function setLastStreamSearchFromParams(searchParams) {
  const thread = searchParams.get('thread')?.trim();
  const focus = searchParams.get('focus')?.trim();
  const parts = [];
  if (thread) parts.push(`thread=${encodeURIComponent(thread)}`);
  if (focus) parts.push(`focus=${encodeURIComponent(focus)}`);
  const value = parts.join('&');
  try {
    if (value) localStorage.setItem(STREAM_NAV_LS_KEY, value);
    else localStorage.removeItem(STREAM_NAV_LS_KEY);
  } catch {
    /* ignore */
  }
}

export function clearStreamNavMemory() {
  try {
    localStorage.removeItem(STREAM_NAV_LS_KEY);
  } catch {
    /* ignore */
  }
}
