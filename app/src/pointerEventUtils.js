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

function elementKeepsInsightOpen(el) {
  if (!el || el.nodeType !== 1 || typeof el.closest !== 'function') return false;
  if (el.closest?.('[data-insight-ui]')) return true;
  if (el.closest?.('[data-stream-compose]') || el.closest?.('[data-canvas-compose]')) return true;
  if (el.classList?.contains('note-card--editing') || el.closest?.('.note-card--editing')) return true;
  if (el.matches?.(INTERACTIVE_FIELD)) return true;
  if (el.classList?.contains('note-card') || el.closest?.('.note-card')) return true;
  return false;
}

/**
 * True if this event should not dismiss hover-insight (hit on card, panel, compose, etc.).
 * Walks composedPath when available; uses pointerEventTargetElement as fallback.
 * Do not gate on `pointerType` — MouseEvent (mousedown/click) has no pointerType.
 */
export function insightPointerPathShouldKeepOpen(event) {
  if (typeof event?.button === 'number' && event.button !== 0) return true;
  if (typeof event?.composedPath === 'function') {
    const path = event.composedPath();
    for (let i = 0; i < path.length; i += 1) {
      const n = path[i];
      if (n && n.nodeType === 1 && elementKeepsInsightOpen(n)) return true;
    }
  }
  const t = pointerEventTargetElement(event);
  if (!t) return false;
  return elementKeepsInsightOpen(t);
}
