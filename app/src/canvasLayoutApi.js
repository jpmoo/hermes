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

/** Where the focus (lead) note sits relative to the auto column or row. */
export const CANVAS_AUTO_FOCUS_ALIGN = {
  /** Vertical: top; horizontal: left */
  START: 'start',
  CENTER: 'center',
  /** Vertical: bottom; horizontal: right */
  END: 'end',
};

/** How dashed connectors are drawn between cards. */
export const CANVAS_CONNECTOR_MODE = {
  /** Consecutive pairs in stream sort order (focus → … → last). */
  THREAD_CHAIN: 'thread_chain',
  /** Hub: one line from focus note to each other card. */
  FOCUS_TO_CHILDREN: 'focus_to_children',
  /** No connector lines; vertical/horizontal card modes place new notes near focus instead of a line-shaped stack. */
  NONE: 'none',
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
    c === CANVAS_CONNECTOR_MODE.FOCUS_TO_CHILDREN ||
    c === CANVAS_CONNECTOR_MODE.THREAD_CHAIN ||
    c === CANVAS_CONNECTOR_MODE.NONE
      ? c
      : CANVAS_CONNECTOR_MODE.THREAD_CHAIN;
  const anchor = block?.manualNewNoteAnchor;
  const manualNewNoteAnchor =
    anchor === CANVAS_MANUAL_NEW_NOTE_ANCHOR.LAST
      ? CANVAS_MANUAL_NEW_NOTE_ANCHOR.LAST
      : CANVAS_MANUAL_NEW_NOTE_ANCHOR.FOCUS;
  const fa = block?.autoFocusAlign;
  const autoFocusAlign =
    fa === CANVAS_AUTO_FOCUS_ALIGN.START ||
    fa === CANVAS_AUTO_FOCUS_ALIGN.CENTER ||
    fa === CANVAS_AUTO_FOCUS_ALIGN.END
      ? fa
      : CANVAS_AUTO_FOCUS_ALIGN.CENTER;
  return { canvasArrangement, connectorMode, manualNewNoteAnchor, autoFocusAlign };
}

const LAYOUT_DEFAULT_W = 340;
const LAYOUT_DEFAULT_H = 220;
const LAYOUT_COL_GAP = 48;
const LAYOUT_ROW_GAP = 28;
const LAYOUT_VERTICAL_GAP = 36;
const LAYOUT_LEAD_CHILD_GAP = 40;
const LAYOUT_START_X = 48;
const LAYOUT_START_Y = 48;

/** Horizontal space between focus card and reply column (vertical arrangement). 5× base column gap, +50%. */
const LAYOUT_FOCUS_TO_COLUMN_GAP = LAYOUT_COL_GAP * 5 * 1.5;
/** Vertical space between focus card and reply row (horizontal arrangement). 5× base lead/row gap, +50%. */
const LAYOUT_FOCUS_TO_ROW_GAP = LAYOUT_LEAD_CHILD_GAP * 5 * 1.5;

/** Tighter spacing when no hub spokes are drawn (no lines or chain links — no corridor needed). */
const LAYOUT_FOCUS_TO_COLUMN_GAP_COMPACT = LAYOUT_COL_GAP * 2;
const LAYOUT_FOCUS_TO_ROW_GAP_COMPACT = LAYOUT_LEAD_CHILD_GAP * 2;

/**
 * Hub lines (`focus_to_children`) use a wide corridor; chain/no lines situate the focus closer to the stack.
 * @param {{ focusPeerSpacing?: 'wide' | 'compact' }} [opts]
 */
function resolveFocusToColumnGap(opts) {
  return opts?.focusPeerSpacing === 'compact'
    ? LAYOUT_FOCUS_TO_COLUMN_GAP_COMPACT
    : LAYOUT_FOCUS_TO_COLUMN_GAP;
}

function resolveFocusToRowGap(opts) {
  return opts?.focusPeerSpacing === 'compact'
    ? LAYOUT_FOCUS_TO_ROW_GAP_COMPACT
    : LAYOUT_FOCUS_TO_ROW_GAP;
}

/**
 * @param {{ id: string }[]} sequenceOrderedNotes lead first, then stream order
 * @param {(id: string) => { w: number, h: number } | null} getSize existing card sizes
 * @param {string} [focusAlign] {@link CANVAS_AUTO_FOCUS_ALIGN}
 * @param {{ minHeightForNoteId?: (id: string) => number, focusPeerSpacing?: 'wide' | 'compact' }} [opts]
 * @returns {Record<string, { x: number, y: number, w: number, h: number }>}
 */
export function computeCanvasVerticalArrangementRects(sequenceOrderedNotes, getSize, focusAlign, opts) {
  if (!sequenceOrderedNotes?.length) return {};
  const focusToColumnGap = resolveFocusToColumnGap(opts);
  const minHFloor =
    typeof opts?.minHeightForNoteId === 'function' ? opts.minHeightForNoteId : () => 0;
  const align =
    focusAlign === CANVAS_AUTO_FOCUS_ALIGN.START || focusAlign === CANVAS_AUTO_FOCUS_ALIGN.END
      ? focusAlign
      : CANVAS_AUTO_FOCUS_ALIGN.CENTER;
  const lead = sequenceOrderedNotes[0];
  const children = sequenceOrderedNotes.slice(1);
  let leadW = LAYOUT_DEFAULT_W;
  let leadH = LAYOUT_DEFAULT_H;
  const ls = getSize(String(lead.id));
  const leadFloor = minHFloor(String(lead.id));
  if (ls && Number.isFinite(ls.w) && Number.isFinite(ls.h)) {
    leadW = ls.w;
    leadH = Math.max(ls.h, leadFloor);
  } else {
    leadH = Math.max(leadH, leadFloor);
  }
  const rects = {};
  let y = LAYOUT_START_Y;
  children.forEach((n) => {
    let w = LAYOUT_DEFAULT_W;
    let h = LAYOUT_DEFAULT_H;
    const ex = getSize(String(n.id));
    const floor = minHFloor(String(n.id));
    if (ex && Number.isFinite(ex.w) && Number.isFinite(ex.h)) {
      w = ex.w;
      h = Math.max(ex.h, floor);
    } else {
      h = Math.max(h, floor);
    }
    rects[String(n.id)] = { x: LAYOUT_START_X + leadW + focusToColumnGap, y, w, h };
    y += h + LAYOUT_VERTICAL_GAP;
  });
  const totalH = children.length ? y - LAYOUT_START_Y - LAYOUT_VERTICAL_GAP : 0;
  let leadY = LAYOUT_START_Y;
  if (children.length) {
    if (align === CANVAS_AUTO_FOCUS_ALIGN.START) {
      leadY = LAYOUT_START_Y;
    } else if (align === CANVAS_AUTO_FOCUS_ALIGN.END) {
      leadY = LAYOUT_START_Y + totalH - leadH;
    } else {
      leadY = LAYOUT_START_Y + totalH / 2 - leadH / 2;
    }
  }
  rects[String(lead.id)] = { x: LAYOUT_START_X, y: leadY, w: leadW, h: leadH };
  return rects;
}

/**
 * @param {{ id: string }[]} sequenceOrderedNotes lead first, then stream order
 * @param {(id: string) => { w: number, h: number } | null} getSize
 * @param {string} [focusAlign] {@link CANVAS_AUTO_FOCUS_ALIGN}
 * @param {{ minHeightForNoteId?: (id: string) => number, focusPeerSpacing?: 'wide' | 'compact' }} [opts]
 */
export function computeCanvasHorizontalArrangementRects(sequenceOrderedNotes, getSize, focusAlign, opts) {
  if (!sequenceOrderedNotes?.length) return {};
  const focusToRowGap = resolveFocusToRowGap(opts);
  const minHFloor =
    typeof opts?.minHeightForNoteId === 'function' ? opts.minHeightForNoteId : () => 0;
  const align =
    focusAlign === CANVAS_AUTO_FOCUS_ALIGN.START || focusAlign === CANVAS_AUTO_FOCUS_ALIGN.END
      ? focusAlign
      : CANVAS_AUTO_FOCUS_ALIGN.CENTER;
  const lead = sequenceOrderedNotes[0];
  const children = sequenceOrderedNotes.slice(1);
  let leadW = LAYOUT_DEFAULT_W;
  let leadH = LAYOUT_DEFAULT_H;
  const ls = getSize(String(lead.id));
  const leadFloor = minHFloor(String(lead.id));
  if (ls && Number.isFinite(ls.w) && Number.isFinite(ls.h)) {
    leadW = ls.w;
    leadH = Math.max(ls.h, leadFloor);
  } else {
    leadH = Math.max(leadH, leadFloor);
  }
  const rects = {};
  let x = LAYOUT_START_X;
  children.forEach((n) => {
    let w = LAYOUT_DEFAULT_W;
    let h = LAYOUT_DEFAULT_H;
    const ex = getSize(String(n.id));
    const floor = minHFloor(String(n.id));
    if (ex && Number.isFinite(ex.w) && Number.isFinite(ex.h)) {
      w = ex.w;
      h = Math.max(ex.h, floor);
    } else {
      h = Math.max(h, floor);
    }
    rects[String(n.id)] = { x, y: LAYOUT_START_Y + leadH + focusToRowGap, w, h };
    x += w + LAYOUT_ROW_GAP;
  });
  const rowWidth = children.length ? x - LAYOUT_START_X - LAYOUT_ROW_GAP : 0;
  let leadX = LAYOUT_START_X;
  if (children.length) {
    if (align === CANVAS_AUTO_FOCUS_ALIGN.START) {
      leadX = LAYOUT_START_X;
    } else if (align === CANVAS_AUTO_FOCUS_ALIGN.END) {
      leadX = LAYOUT_START_X + rowWidth - leadW;
    } else {
      leadX = LAYOUT_START_X + rowWidth / 2 - leadW / 2;
    }
  }
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
