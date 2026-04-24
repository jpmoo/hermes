/**
 * Thread display order helpers.
 * Stream: datetime (event start or last edit, tie-break last edit), full-note word order,
 * or manual order (`stream_sibling_index` on each note); optional starred-first groups (not used for manual).
 */

/** @typedef {'datetime_asc' | 'datetime_desc' | 'alpha_asc' | 'alpha_desc' | 'manual'} StreamThreadSortMode */

/** @typedef {{ sortMode: StreamThreadSortMode, starredFirst: boolean }} StreamThreadSortPrefs */

export const STREAM_THREAD_SORT_MODES = [
  'datetime_asc',
  'datetime_desc',
  'alpha_asc',
  'alpha_desc',
  'manual',
];

/** Matches prior default stream ordering (earliest primary time first; starred groups on). */
export const DEFAULT_STREAM_THREAD_SORT = /** @type {StreamThreadSortPrefs} */ ({
  sortMode: 'datetime_asc',
  starredFirst: true,
});

/** Map prefs saved under older mode names. */
export function migrateLegacySortMode(mode) {
  if (typeof mode !== 'string') return DEFAULT_STREAM_THREAD_SORT.sortMode;
  if (STREAM_THREAD_SORT_MODES.includes(mode)) return mode;
  if (mode === 'edit_asc' || mode === 'schedule_asc') return 'datetime_asc';
  if (mode === 'edit_desc' || mode === 'schedule_desc') return 'datetime_desc';
  if (mode === 'alpha_asc') return 'alpha_asc';
  if (mode === 'alpha_desc') return 'alpha_desc';
  if (mode === 'manual') return 'manual';
  return DEFAULT_STREAM_THREAD_SORT.sortMode;
}

function coerceStarredFirst(raw) {
  if (raw === false || raw === 'false') return false;
  if (raw === true || raw === 'true') return true;
  return DEFAULT_STREAM_THREAD_SORT.starredFirst;
}

export function noteThreadSortKeyMs(n) {
  if (n?.note_type === 'event' && n.event_start_at) {
    const t = new Date(n.event_start_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  const u = n?.updated_at ?? n?.created_at;
  if (!u) return 0;
  const t = new Date(u).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Last edit time only. */
export function lastEditKeyMs(n) {
  const u = n?.updated_at ?? n?.created_at;
  if (!u) return 0;
  const t = new Date(u).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Whitespace tokens from full note body (leading # on first line stripped). */
export function contentWordsForSort(n) {
  const raw = (n?.content || '').trim();
  if (!raw) return [];
  const lines = raw.split('\n');
  if (lines[0]) {
    lines[0] = lines[0].replace(/^\s*#+\s*/, '');
  }
  const s = lines.join('\n').trim();
  if (!s) return [];
  return s.split(/\s+/u).filter(Boolean);
}

/**
 * Primary: event start (if set) else last edit. Tie-break: last edit. Asc = earliest first.
 * @returns {number} negative if a before b in asc order
 */
function compareDatetimePrimary(a, b, desc) {
  const pa = noteThreadSortKeyMs(a);
  const pb = noteThreadSortKeyMs(b);
  if (pa !== pb) {
    const d = pa - pb;
    return desc ? -d : d;
  }
  const la = lastEditKeyMs(a);
  const lb = lastEditKeyMs(b);
  if (la !== lb) {
    const d = la - lb;
    return desc ? -d : d;
  }
  return String(a.id).localeCompare(String(b.id));
}

/**
 * Word-by-word through full note; if shared prefix, longer text sorts after shorter (asc).
 * @returns {number} negative if a before b in asc order
 */
function compareAlphabeticalFull(a, b, desc) {
  const wa = contentWordsForSort(a);
  const wb = contentWordsForSort(b);
  const len = Math.min(wa.length, wb.length);
  for (let i = 0; i < len; i++) {
    const c = wa[i].localeCompare(wb[i], undefined, { sensitivity: 'base' });
    if (c !== 0) return desc ? -c : c;
  }
  const lenDiff = wa.length - wb.length;
  if (lenDiff !== 0) return desc ? -lenDiff : lenDiff;
  return String(a.id).localeCompare(String(b.id));
}

function streamSiblingIndexKey(n) {
  const v = n?.stream_sibling_index;
  if (v == null || v === '') return null;
  const num = Number(v);
  if (!Number.isFinite(num)) return null;
  return num;
}

/**
 * Manual sibling order uses `stream_sibling_index` (integer); unset rows sort after set ones,
 * tie-break by primary datetime ascending (matches “natural” thread order until the user drags).
 */
function compareManualSiblings(a, b) {
  const ia = streamSiblingIndexKey(a);
  const ib = streamSiblingIndexKey(b);
  if (ia !== null && ib !== null && ia !== ib) return ia - ib;
  if (ia !== null && ib === null) return -1;
  if (ia === null && ib !== null) return 1;
  return compareDatetimePrimary(a, b, false);
}

function compareStreamPrefs(a, b, prefs) {
  const mode = prefs.sortMode;
  if (mode === 'manual') {
    return compareManualSiblings(a, b);
  }
  const desc = mode.endsWith('_desc');
  if (mode.startsWith('datetime_')) {
    return compareDatetimePrimary(a, b, desc);
  }
  if (mode.startsWith('alpha_')) {
    return compareAlphabeticalFull(a, b, desc);
  }
  return compareDatetimePrimary(a, b, false);
}

/**
 * Flat list: same stream sort mode as prefs, but starred-first grouping is disabled (for manual canvas layout).
 * @param {any[]} notes
 * @param {Partial<StreamThreadSortPrefs>|null|undefined} prefs
 */
export function sortNotesByStreamOrderNoStarBias(notes, prefs) {
  const p = { ...normalizeStreamThreadSortPrefs(prefs), starredFirst: false };
  return [...notes].sort((a, b) => compareStreamPrefs(a, b, p));
}

function isStarred(n) {
  return Boolean(n?.starred);
}

/**
 * @param {unknown} raw
 * @returns {StreamThreadSortPrefs}
 */
export function normalizeStreamThreadSortPrefs(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_STREAM_THREAD_SORT };
  const sortMode = migrateLegacySortMode(raw.sortMode);
  if (sortMode === 'manual') {
    return { sortMode: 'manual', starredFirst: false };
  }
  const starredFirst = coerceStarredFirst(raw.starredFirst);
  return { sortMode, starredFirst };
}

/**
 * Stream thread root prefs: when the focused head has no direct replies yet and nothing is stored
 * for this root, use {@link DEFAULT_STREAM_THREAD_SORT} (datetime / start time order + starred on).
 */
export function resolveStreamThreadSortPrefsForHead(storedRaw, headHasDirectReplies) {
  const missing = storedRaw === undefined || storedRaw === null;
  if (!headHasDirectReplies && missing) {
    return { ...DEFAULT_STREAM_THREAD_SORT };
  }
  return normalizeStreamThreadSortPrefs(storedRaw);
}

/**
 * Sort each sibling level using stream prefs (immutable).
 * @param {any[]|null|undefined} nodes
 * @param {Partial<StreamThreadSortPrefs>|null|undefined} prefs
 */
export function sortNoteTreeWithStreamPrefs(nodes, prefs) {
  const p = normalizeStreamThreadSortPrefs(prefs);
  if (!nodes?.length) return nodes;
  return sortLevelStream([...nodes], p);
}

function sortLevelStream(nodes, prefs) {
  const ordered = sortSiblingsStream(nodes, prefs);
  return ordered.map((n) => ({
    ...n,
    children:
      n.children?.length > 0 ? sortLevelStream(n.children, prefs) : n.children || [],
  }));
}

function sortSiblingsStream(nodes, prefs) {
  if (prefs.sortMode === 'manual') {
    return [...nodes].sort((a, b) => compareManualSiblings(a, b));
  }
  if (!prefs.starredFirst) {
    return [...nodes].sort((a, b) => compareStreamPrefs(a, b, prefs));
  }
  const starred = [];
  const rest = [];
  for (const n of nodes) {
    if (isStarred(n)) starred.push(n);
    else rest.push(n);
  }
  starred.sort((a, b) => compareStreamPrefs(a, b, prefs));
  rest.sort((a, b) => compareStreamPrefs(a, b, prefs));
  return [...starred, ...rest];
}

function compareNotes(a, b) {
  const d = noteThreadSortKeyMs(a) - noteThreadSortKeyMs(b);
  if (d !== 0) return d;
  return String(a.id).localeCompare(String(b.id));
}

/** Recursively sort each node's children (immutable). — legacy outline/canvas */
export function sortNoteTreeByThreadOrder(nodes) {
  if (!nodes?.length) return nodes;
  return [...nodes].sort(compareNotes).map((n) => ({
    ...n,
    children:
      n.children?.length > 0 ? sortNoteTreeByThreadOrder(n.children) : n.children || [],
  }));
}

/**
 * At each sibling level: starred notes first, then the rest (preserving each group’s prior order).
 * Among starred siblings, order by thread sort key ascending (oldest edit / earliest event first).
 */
export function sortStarredPinned(nodes) {
  if (!nodes?.length) return nodes || [];
  const starred = [];
  const rest = [];
  for (const n of nodes) {
    const withKids = {
      ...n,
      children: sortStarredPinned(n.children || []),
    };
    if (withKids.starred) starred.push(withKids);
    else rest.push(withKids);
  }
  starred.sort((a, b) => {
    const d = noteThreadSortKeyMs(a) - noteThreadSortKeyMs(b);
    if (d !== 0) return d;
    return String(a.id).localeCompare(String(b.id));
  });
  return [...starred, ...rest];
}

/**
 * Reorder only the top-level array: starred rows first, then the rest (by thread sort key).
 * Does not recurse; each node's `children` are unchanged. Matches Stream's multi-root list.
 */
export function sortStarredPinnedRootsOnly(nodes) {
  if (!nodes?.length) return nodes || [];
  const starred = [];
  const rest = [];
  for (const n of nodes) {
    if (n.starred) starred.push(n);
    else rest.push(n);
  }
  const cmp = (a, b) => {
    const d = noteThreadSortKeyMs(a) - noteThreadSortKeyMs(b);
    if (d !== 0) return d;
    return String(a.id).localeCompare(String(b.id));
  };
  starred.sort(cmp);
  rest.sort(cmp);
  return [...starred, ...rest];
}

/**
 * Move-note picker: top-level rows match Stream’s root list (starred first, then by thread sort key);
 * within each thread, sibling order matches that thread’s stream prefs (same as {@link sortNoteTreeWithStreamPrefs}).
 * @param {any[]|null|undefined} roots from buildTree (notes with no parent, each a thread root)
 * @param {Record<string, unknown>|null|undefined} streamThreadSortByRoot persisted map (keys = thread root ids)
 */
export function sortNoteForestForMoveModal(roots, streamThreadSortByRoot) {
  if (!roots?.length) return roots || [];
  const byRoot =
    streamThreadSortByRoot && typeof streamThreadSortByRoot === 'object' && !Array.isArray(streamThreadSortByRoot)
      ? streamThreadSortByRoot
      : {};
  const orderedRoots = sortStarredPinnedRootsOnly(roots);
  return orderedRoots.map((root) => {
    const rid = String(root.id).trim().toLowerCase();
    const stored = byRoot[rid];
    const headHasDirectReplies = Boolean((root.children || []).length);
    const prefs = resolveStreamThreadSortPrefsForHead(stored, headHasDirectReplies);
    const sorted = sortNoteTreeWithStreamPrefs([root], prefs);
    return sorted[0] ?? root;
  });
}
