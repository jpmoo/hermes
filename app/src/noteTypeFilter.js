/** Logical order for filtering (e.g. Stream tree). */
export const NOTE_TYPE_FILTER_ORDER = ['note', 'organization', 'person', 'event'];

/** Header row: Notes → Events → People → Organizations (matches user-facing labels). */
export const NOTE_TYPE_HEADER_ORDER = ['note', 'event', 'person', 'organization'];

export const ALL_NOTE_TYPES = new Set(NOTE_TYPE_FILTER_ORDER);

/**
 * Drop nodes whose type is hidden; splice their children up to the parent level.
 */
export function filterTreeByVisibleNoteTypes(nodes, visibleTypes) {
  if (!nodes?.length) return [];
  const result = [];
  for (const n of nodes) {
    const t = n.note_type || 'note';
    const kids = filterTreeByVisibleNoteTypes(n.children || [], visibleTypes);
    if (visibleTypes.has(t)) {
      result.push({ ...n, children: kids });
    } else {
      result.push(...kids);
    }
  }
  return result;
}

export function filterRootsByVisibleNoteTypes(roots, visibleTypes) {
  return (roots || []).filter((r) => visibleTypes.has(r.note_type || 'note'));
}

/** Flat list (search, tag results, etc.). */
export function filterNotesByVisibleNoteTypes(notes, visibleTypes) {
  return (notes || []).filter((n) => visibleTypes.has(n.note_type || 'note'));
}
