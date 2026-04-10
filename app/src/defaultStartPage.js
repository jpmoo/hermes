/** User setting + routes for the app entry path (`/` → one of these). */

export const DEFAULT_START_PAGE_IDS = ['stream', 'canvas', 'outline', 'calendar', 'search'];

export const DEFAULT_START_PAGE_OPTIONS = [
  { id: 'stream', label: 'Stream' },
  { id: 'canvas', label: 'Canvas' },
  { id: 'outline', label: 'Outline' },
  { id: 'calendar', label: 'Calendar' },
  { id: 'search', label: 'Search' },
];

/** @param {unknown} v */
export function normalizeDefaultStartPage(v) {
  if (typeof v !== 'string') return 'stream';
  const s = v.trim().toLowerCase();
  return DEFAULT_START_PAGE_IDS.includes(s) ? s : 'stream';
}

export const DEFAULT_START_PAGE_PATH = {
  stream: '/stream',
  canvas: '/canvas',
  outline: '/outline',
  calendar: '/calendar',
  search: '/search',
};
