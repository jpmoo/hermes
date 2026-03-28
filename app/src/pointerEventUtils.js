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
 * True if `el` (e.g. from document.elementFromPoint) is inside insight UI, a note card, compose, etc.
 * Used for deferred “click outside to close” so we never race React’s delegated click handlers.
 */
export function insightElementKeepsHoverOpen(el) {
  if (!el || el.nodeType !== 1 || typeof el.closest !== 'function') return false;
  if (el.closest('[data-insight-ui]')) return true;
  if (el.closest('[data-stream-compose]') || el.closest('[data-canvas-compose]')) return true;
  if (el.closest('.note-card--editing')) return true;
  if (el.matches?.(INTERACTIVE_FIELD)) return true;
  if (el.closest('.note-card')) return true;
  return false;
}
