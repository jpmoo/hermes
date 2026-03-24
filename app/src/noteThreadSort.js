/**
 * Thread display order: oldest first (newest at bottom).
 * Events sort by event_start_at; other notes by updated_at (fallback created_at).
 */

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

function compareNotes(a, b) {
  const d = noteThreadSortKeyMs(a) - noteThreadSortKeyMs(b);
  if (d !== 0) return d;
  return String(a.id).localeCompare(String(b.id));
}

/** Recursively sort each node's children (immutable). */
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
