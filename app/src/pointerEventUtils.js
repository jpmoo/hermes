/**
 * Stable element for hit-testing with `closest` / `contains`.
 * - `target` can be a Text node (no `closest`).
 * - `composedPath()` is more reliable with retargeting / nested paths than `target` alone.
 */
export function pointerEventTargetElement(event) {
  if (event && typeof event.composedPath === 'function') {
    const path = event.composedPath();
    for (let i = 0; i < path.length; i += 1) {
      const n = path[i];
      if (n && n.nodeType === 1 && typeof n.closest === 'function') return n;
    }
  }
  const t = event?.target;
  if (t == null) return null;
  if (typeof Element !== 'undefined' && t instanceof Element) return t;
  if (t.nodeType === 3 && t.parentElement) return t.parentElement;
  return null;
}

/**
 * While stream insight is active: return true if this click should not dismiss insight.
 * - Insight panels, connection stack, etc. (`[data-insight-ui]`)
 * - Stream / canvas compose
 * - Editing a note card
 * - The **selected** note card only (`.note-card--insight-selected`)
 *
 * Any other `.note-card` (another note) → false, so insight dismisses before the card sees the click.
 * True non-card targets (gaps, chrome) → false (dismiss).
 */
export function insightPointerPathShouldKeepOpen(event) {
  if (typeof event?.button === 'number' && event.button !== 0) return true;
  const t = pointerEventTargetElement(event);
  if (!t) return false;
  if (t.closest('[data-insight-ui]')) return true;
  if (t.closest('[data-stream-compose]') || t.closest('[data-canvas-compose]')) return true;
  if (t.closest('.note-card--editing')) return true;
  const card = t.closest?.('.note-card');
  if (card?.classList.contains('note-card--insight-selected')) return true;
  if (card) return false;
  return false;
}
