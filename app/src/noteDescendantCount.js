/**
 * Count all notes strictly below `node` using in-memory `children` (Stream/Canvas trees).
 * @param {{ children?: unknown[] }} node
 * @returns {number}
 */
export function countDescendantsFromChildrenTree(node) {
  const ch = node?.children;
  if (!Array.isArray(ch) || ch.length === 0) return 0;
  let n = 0;
  for (const c of ch) {
    n += 1 + countDescendantsFromChildrenTree(c);
  }
  return n;
}

/**
 * Prefer API `descendant_count` / `descendantCount`; else count from `children` when present.
 * @param {{ descendant_count?: unknown; descendantCount?: unknown; children?: unknown[] }} note
 * @returns {number}
 */
export function effectiveDescendantCount(note) {
  const raw = note?.descendant_count ?? note?.descendantCount;
  if (raw != null && raw !== '') {
    const n = typeof raw === 'string' ? parseInt(raw, 10) : Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
    if (Number.isFinite(n) && n === 0) return 0;
  }
  return countDescendantsFromChildrenTree(note);
}
