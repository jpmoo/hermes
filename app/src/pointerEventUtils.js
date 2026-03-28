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
