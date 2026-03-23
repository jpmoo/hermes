/**
 * Ordering key: events use event_start_at; otherwise updated_at (fallback created_at).
 * Matches app/src/noteThreadSort.js for thread display.
 */
export function noteSortAtMs(row) {
  if (row.note_type === 'event' && row.event_start_at) {
    const t = new Date(row.event_start_at).getTime();
    if (!Number.isNaN(t)) return t;
  }
  const u = row.updated_at || row.created_at;
  if (!u) return 0;
  const t = new Date(u).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/** Search / recency lists: newest first */
export function compareNotesSortDesc(a, b) {
  const d = noteSortAtMs(b) - noteSortAtMs(a);
  if (d !== 0) return d;
  return String(a.id).localeCompare(String(b.id));
}
