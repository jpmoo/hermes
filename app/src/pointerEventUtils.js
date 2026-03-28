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

const INTERACTIVE_FIELD =
  'textarea, input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]), select';

/**
 * True if this pointer event should not dismiss hover-insight (hit on card, panel, compose, etc.).
 * Uses `pointerEventTargetElement` + `closest()` instead of only `composedPath()`: capture-phase
 * listeners and some browsers can expose an incomplete path or a Text node target, which made
 * stream single-clicks feel flaky next to the global dismiss handler.
 */
export function insightPointerPathShouldKeepOpen(event) {
  if (event?.pointerType === 'mouse' && event.button !== 0) return true;
  const t = pointerEventTargetElement(event);
  if (!t || typeof t.closest !== 'function') return false;
  if (t.closest('[data-insight-ui]')) return true;
  if (t.closest('[data-stream-compose]') || t.closest('[data-canvas-compose]')) return true;
  if (t.closest('.note-card--editing')) return true;
  if (t.matches?.(INTERACTIVE_FIELD)) return true;
  if (t.closest('.note-card')) return true;
  return false;
}
