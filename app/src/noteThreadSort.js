/**
 * Thread display order helpers.
 * Default stream behavior: schedule-style key (events by start; others by updated_at), oldest first;
 * starred siblings first, sorted within each group.
 */

/** @typedef {'edit_asc' | 'edit_desc' | 'schedule_asc' | 'schedule_desc' | 'alpha_asc' | 'alpha_desc'} StreamThreadSortMode */

/** @typedef {{ sortMode: StreamThreadSortMode, starredFirst: boolean }} StreamThreadSortPrefs */

export const STREAM_THREAD_SORT_MODES = [
  'edit_asc',
  'edit_desc',
  'schedule_asc',
  'schedule_desc',
  'alpha_asc',
  'alpha_desc',
];

/** Matches legacy Stream ordering before user prefs. */
export const DEFAULT_STREAM_THREAD_SORT = /** @type {StreamThreadSortPrefs} */ ({
  sortMode: 'schedule_asc',
  starredFirst: true,
});

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

/** Last edit time only (for sort-by-edit). */
export function lastEditKeyMs(n) {
  const u = n?.updated_at ?? n?.created_at;
  if (!u) return 0;
  const t = new Date(u).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** First “word” on the first line (after optional markdown # heading markers). */
export function firstWordSortKey(n) {
  const line = (n?.content || '').split('\n')[0] || '';
  const cleaned = line.replace(/^\s*#+\s*/, '').trim();
  const m = cleaned.match(/[^\s]+/u);
  return m ? m[0] : '';
}

function compareNotes(a, b) {
  const d = noteThreadSortKeyMs(a) - noteThreadSortKeyMs(b);
  if (d !== 0) return d;
  return String(a.id).localeCompare(String(b.id));
}

function compareStreamPrefs(a, b, prefs) {
  const mode = prefs.sortMode;
  const desc = mode.endsWith('_desc');
  const kind = mode.replace(/_asc$|_desc$/, '');

  let cmp = 0;
  if (kind === 'edit') {
    cmp = lastEditKeyMs(a) - lastEditKeyMs(b);
  } else if (kind === 'schedule') {
    cmp = noteThreadSortKeyMs(a) - noteThreadSortKeyMs(b);
  } else if (kind === 'alpha') {
    cmp = firstWordSortKey(a).localeCompare(firstWordSortKey(b), undefined, { sensitivity: 'base' });
  }
  if (cmp !== 0) return desc ? -cmp : cmp;
  return String(a.id).localeCompare(String(b.id));
}

/**
 * @param {unknown} raw
 * @returns {StreamThreadSortPrefs}
 */
export function normalizeStreamThreadSortPrefs(raw) {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_STREAM_THREAD_SORT };
  const sortMode =
    typeof raw.sortMode === 'string' && STREAM_THREAD_SORT_MODES.includes(raw.sortMode)
      ? raw.sortMode
      : DEFAULT_STREAM_THREAD_SORT.sortMode;
  const starredFirst =
    typeof raw.starredFirst === 'boolean' ? raw.starredFirst : DEFAULT_STREAM_THREAD_SORT.starredFirst;
  return { sortMode, starredFirst };
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
  if (!prefs.starredFirst) {
    return [...nodes].sort((a, b) => compareStreamPrefs(a, b, prefs));
  }
  const starred = [];
  const rest = [];
  for (const n of nodes) {
    if (n.starred) starred.push(n);
    else rest.push(n);
  }
  starred.sort((a, b) => compareStreamPrefs(a, b, prefs));
  rest.sort((a, b) => compareStreamPrefs(a, b, prefs));
  return [...starred, ...rest];
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
