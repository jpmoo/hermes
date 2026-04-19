/** Merge canvas layout for one thread/focus context into settings patch payload (`canvasLayouts` in settings JSON). */

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

/** How auto-layout stacks cards relative to the focus note. */
export const CANVAS_ARRANGEMENT = {
  /** @deprecated use MANUAL; still accepted from stored settings */
  KEEP: 'keep',
  MANUAL: 'manual',
  VERTICAL: 'vertical',
  HORIZONTAL: 'horizontal',
};

/** Where new cards are placed in manual layout (stream sort order ignores starring). */
export const CANVAS_MANUAL_NEW_NOTE_ANCHOR = {
  FOCUS: 'focus',
  LAST: 'last',
};

/** How dashed connectors are drawn between cards. */
export const CANVAS_CONNECTOR_MODE = {
  /** Consecutive pairs in stream sort order (focus → … → last). */
  THREAD_CHAIN: 'thread_chain',
  /** Hub: one line from focus note to each other card. */
  FOCUS_TO_CHILDREN: 'focus_to_children',
};

/**
 * Arrangement + connector prefs stored on each canvas layout focus block (alongside view/cards).
 */
export function resolveCanvasBlockPrefs(block) {
  const a = block?.canvasArrangement;
  let canvasArrangement = CANVAS_ARRANGEMENT.MANUAL;
  if (a === CANVAS_ARRANGEMENT.VERTICAL) canvasArrangement = CANVAS_ARRANGEMENT.VERTICAL;
  else if (a === CANVAS_ARRANGEMENT.HORIZONTAL) canvasArrangement = CANVAS_ARRANGEMENT.HORIZONTAL;
  else if (a === CANVAS_ARRANGEMENT.KEEP || a === CANVAS_ARRANGEMENT.MANUAL) {
    canvasArrangement = CANVAS_ARRANGEMENT.MANUAL;
  }
  const c = block?.connectorMode;
  const connectorMode =
    c === CANVAS_CONNECTOR_MODE.FOCUS_TO_CHILDREN || c === CANVAS_CONNECTOR_MODE.THREAD_CHAIN
      ? c
      : CANVAS_CONNECTOR_MODE.THREAD_CHAIN;
  const anchor = block?.manualNewNoteAnchor;
  const manualNewNoteAnchor =
    anchor === CANVAS_MANUAL_NEW_NOTE_ANCHOR.LAST
      ? CANVAS_MANUAL_NEW_NOTE_ANCHOR.LAST
      : CANVAS_MANUAL_NEW_NOTE_ANCHOR.FOCUS;
  return { canvasArrangement, connectorMode, manualNewNoteAnchor };
}

const LAYOUT_DEFAULT_W = 340;
const LAYOUT_DEFAULT_H = 220;
const LAYOUT_COL_GAP = 48;
const LAYOUT_ROW_GAP = 28;
const LAYOUT_VERTICAL_GAP = 36;
const LAYOUT_LEAD_CHILD_GAP = 40;
const LAYOUT_START_X = 48;
const LAYOUT_START_Y = 48;

/**
 * @param {{ id: string }[]} sequenceOrderedNotes lead first, then stream order
 * @param {(id: string) => { w: number, h: number } | null} getSize existing card sizes
 * @returns {Record<string, { x: number, y: number, w: number, h: number }>}
 */
export function computeCanvasVerticalArrangementRects(sequenceOrderedNotes, getSize) {
  if (!sequenceOrderedNotes?.length) return {};
  const lead = sequenceOrderedNotes[0];
  const children = sequenceOrderedNotes.slice(1);
  let leadW = LAYOUT_DEFAULT_W;
  let leadH = LAYOUT_DEFAULT_H;
  const ls = getSize(String(lead.id));
  if (ls && Number.isFinite(ls.w) && Number.isFinite(ls.h)) {
    leadW = ls.w;
    leadH = ls.h;
  }
  const rects = {};
  let y = LAYOUT_START_Y;
  children.forEach((n) => {
    let w = LAYOUT_DEFAULT_W;
    let h = LAYOUT_DEFAULT_H;
    const ex = getSize(String(n.id));
    if (ex && Number.isFinite(ex.w) && Number.isFinite(ex.h)) {
      w = ex.w;
      h = ex.h;
    }
    rects[String(n.id)] = { x: LAYOUT_START_X + leadW + LAYOUT_COL_GAP, y, w, h };
    y += h + LAYOUT_VERTICAL_GAP;
  });
  const totalH = children.length ? y - LAYOUT_START_Y - LAYOUT_VERTICAL_GAP : 0;
  const leadY = children.length ? LAYOUT_START_Y + totalH / 2 - leadH / 2 : LAYOUT_START_Y;
  rects[String(lead.id)] = { x: LAYOUT_START_X, y: leadY, w: leadW, h: leadH };
  return rects;
}

/**
 * @param {{ id: string }[]} sequenceOrderedNotes lead first, then stream order
 * @param {(id: string) => { w: number, h: number } | null} getSize
 */
export function computeCanvasHorizontalArrangementRects(sequenceOrderedNotes, getSize) {
  if (!sequenceOrderedNotes?.length) return {};
  const lead = sequenceOrderedNotes[0];
  const children = sequenceOrderedNotes.slice(1);
  let leadW = LAYOUT_DEFAULT_W;
  let leadH = LAYOUT_DEFAULT_H;
  const ls = getSize(String(lead.id));
  if (ls && Number.isFinite(ls.w) && Number.isFinite(ls.h)) {
    leadW = ls.w;
    leadH = ls.h;
  }
  const rects = {};
  let x = LAYOUT_START_X;
  let maxChildH = 0;
  children.forEach((n) => {
    let w = LAYOUT_DEFAULT_W;
    let h = LAYOUT_DEFAULT_H;
    const ex = getSize(String(n.id));
    if (ex && Number.isFinite(ex.w) && Number.isFinite(ex.h)) {
      w = ex.w;
      h = ex.h;
    }
    rects[String(n.id)] = { x, y: LAYOUT_START_Y + leadH + LAYOUT_LEAD_CHILD_GAP, w, h };
    maxChildH = Math.max(maxChildH, h);
    x += w + LAYOUT_ROW_GAP;
  });
  const rowWidth = children.length ? x - LAYOUT_START_X - LAYOUT_ROW_GAP : 0;
  const leadX = children.length ? LAYOUT_START_X + rowWidth / 2 - leadW / 2 : LAYOUT_START_X;
  rects[String(lead.id)] = { x: leadX, y: LAYOUT_START_Y, w: leadW, h: leadH };
  return rects;
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
