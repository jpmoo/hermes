/** Order of type toggles in the header (matches NoteTypeIcon). */
export const NOTE_TYPE_FILTER_ORDER = ['note', 'organization', 'person', 'event'];

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
