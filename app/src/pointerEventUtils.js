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
 * Walk composedPath so we never mis-detect "outside" when `target` is odd (text, retargeting).
 * Used for hover-insight dismiss: only clear when no note card / panel / compose is in the path.
 */
export function insightPointerPathShouldKeepOpen(event) {
  if (event?.pointerType === 'mouse' && event.button !== 0) return true;
  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (let i = 0; i < path.length; i += 1) {
    const n = path[i];
    if (!n || n.nodeType !== 1) continue;
    const el = n;
    if (el.hasAttribute?.('data-insight-ui')) return true;
    if (el.hasAttribute?.('data-stream-compose') || el.hasAttribute?.('data-canvas-compose')) return true;
    if (el.classList?.contains('note-card--editing') || el.closest?.('.note-card--editing')) return true;
    if (
      el.matches?.(
        'textarea, input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]), select'
      )
    ) {
      return true;
    }
    if (el.classList?.contains('note-card')) return true;
  }
  return false;
}
