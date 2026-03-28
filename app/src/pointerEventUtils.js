/**
 * `Event.target` for pointer/mouse/click can be a Text node when the hit is on raw text.
 * `Element#closest` / `contains` need an Element for reliable results.
 */
export function pointerEventTargetElement(event) {
  const t = event?.target;
  if (t == null) return null;
  if (typeof Element !== 'undefined' && t instanceof Element) return t;
  if (t.nodeType === 3 && t.parentElement) return t.parentElement;
  return null;
}
