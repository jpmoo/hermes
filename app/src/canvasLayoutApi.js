/** Merge canvas layout for one thread/focus context into settings patch payload (stored as `campusLayouts` in settings JSON). */

/**
 * Narrow UI: portrait phones, or phone landscape (short viewport) so iOS landscape keeps mobile layout.
 * Also drives Canvas viewMobile vs view and Stream insight sheet vs side panels.
 */
export const HERMES_COMPACT_VIEWPORT_QUERY =
  '(max-width: 767px), screen and (max-height: 480px) and (orientation: landscape) and (max-width: 932px)';

/** Same as HERMES_COMPACT_VIEWPORT_QUERY — Canvas view vs viewMobile. */
export const CANVAS_MOBILE_MEDIA_QUERY = HERMES_COMPACT_VIEWPORT_QUERY;

/** Settings key for Canvas at Stream root (no `thread=` in URL). */
export const CANVAS_LAYOUT_STREAM_ROOT = '__stream_root__';

export function canvasFocusKey(focusId) {
  return focusId ? String(focusId) : '__root__';
}

/** Layout blob key: real thread root id, or {@link CANVAS_LAYOUT_STREAM_ROOT} when showing all roots. */
export function canvasLayoutThreadKey(threadRootId) {
  return threadRootId ? String(threadRootId) : CANVAS_LAYOUT_STREAM_ROOT;
}

/**
 * Resolve pan/zoom (+ sequence lines) for the current viewport.
 * Uses `view` for wide, `viewMobile` for narrow; if the active bucket has no saved zoom/pan, falls back to the other.
 * Legacy layouts only have `view` — mobile will adopt it until a mobile-specific save exists.
 */
export function resolveCanvasView(block, isMobile) {
  const wide = block?.view;
  const mobile = block?.viewMobile;
  const primary = isMobile ? mobile : wide;
  const fallback = isMobile ? wide : mobile;

  function pickPanZoom(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const sc = obj.scale;
    if (typeof sc !== 'number' || sc < 0.1 || sc > 10) return null;
    return {
      scale: sc,
      tx: typeof obj.tx === 'number' ? obj.tx : 0,
      ty: typeof obj.ty === 'number' ? obj.ty : 0,
    };
  }

  const panZoom = pickPanZoom(primary) ?? pickPanZoom(fallback) ?? { scale: 1, tx: 0, ty: 0 };
  const seqPrimary = primary?.showSequenceLines;
  const seqFallback = fallback?.showSequenceLines;
  const showSequenceLines =
    seqPrimary !== undefined ? seqPrimary !== false : seqFallback !== undefined ? seqFallback !== false : true;

  return { ...panZoom, showSequenceLines };
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
    view:
      partial.view !== undefined ? { ...(cur.view || {}), ...partial.view } : cur.view || {},
    viewMobile:
      partial.viewMobile !== undefined
        ? { ...(cur.viewMobile || {}), ...partial.viewMobile }
        : cur.viewMobile || {},
    cards: { ...(cur.cards || {}), ...(partial.cards || {}) },
    starredDock:
      partial.starredDock !== undefined
        ? partial.starredDock && typeof partial.starredDock === 'object'
          ? { ...(cur.starredDock || {}), ...partial.starredDock }
          : cur.starredDock
        : cur.starredDock,
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
