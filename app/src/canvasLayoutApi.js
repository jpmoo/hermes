/** Merge canvas layout for one thread/focus context into settings patch payload (stored as `campusLayouts` in settings JSON). */

/** Settings key for Canvas at Stream root (no `thread=` in URL). */
export const CANVAS_LAYOUT_STREAM_ROOT = '__stream_root__';

export function canvasFocusKey(focusId) {
  return focusId ? String(focusId) : '__root__';
}

/** Layout blob key: real thread root id, or {@link CANVAS_LAYOUT_STREAM_ROOT} when showing all roots. */
export function canvasLayoutThreadKey(threadRootId) {
  return threadRootId ? String(threadRootId) : CANVAS_LAYOUT_STREAM_ROOT;
}

export function mergeCanvasLayoutPatch(prevLayouts, threadRootId, focusKey, partial) {
  const tid = String(threadRootId);
  const fk = String(focusKey);
  const prev = prevLayouts && typeof prevLayouts === 'object' ? prevLayouts : {};
  const threadBlock = { ...(prev[tid] && typeof prev[tid] === 'object' ? prev[tid] : {}) };
  const cur = threadBlock[fk] && typeof threadBlock[fk] === 'object' ? threadBlock[fk] : {};
  const next = {
    ...cur,
    ...partial,
    view: { ...(cur.view || {}), ...(partial.view || {}) },
    cards: { ...(cur.cards || {}), ...(partial.cards || {}) },
  };
  return {
    ...prev,
    [tid]: {
      ...threadBlock,
      [fk]: next,
    },
  };
}

/** Replace the entire layout block for one focus (e.g. clear all card positions without merging old keys). */
export function replaceCanvasLayoutFocusBlock(prevLayouts, layoutStorageKey, focusKey, block) {
  const tid = String(layoutStorageKey);
  const fk = String(focusKey);
  const prev = prevLayouts && typeof prevLayouts === 'object' ? prevLayouts : {};
  const threadBlock = { ...(prev[tid] && typeof prev[tid] === 'object' ? prev[tid] : {}) };
  return {
    ...prev,
    [tid]: {
      ...threadBlock,
      [fk]: block && typeof block === 'object' ? block : {},
    },
  };
}
