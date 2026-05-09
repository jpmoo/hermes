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
  let autoArrangementWrapAfter = 0;
  const wa = block?.autoArrangementWrapAfter;
  if (typeof wa === 'number' && Number.isFinite(wa)) {
    const n = Math.floor(wa);
    if (n >= 1 && n <= 500) autoArrangementWrapAfter = n;
  } else if (typeof wa === 'string' && /^\d+$/.test(wa.trim())) {
    const n = parseInt(wa.trim(), 10);
    if (n >= 1 && n <= 500) autoArrangementWrapAfter = n;
  }
  const manualConnections = normalizeManualConnections(block?.manualConnections);
  return {
    canvasArrangement,
    connectorMode,
    manualNewNoteAnchor,
    autoFocusAlign,
    autoArrangementWrapAfter,
    manualConnections,
  };
}

/** Max perpendicular bend (world px) for curved manual connectors. */
export const MANUAL_EDGE_BEND_LIMIT = 6000;

/**
 * Stable key for a directed manual edge (endpoints only; sides come from geometry).
 * Legacy rows with fromSide/toSide migrate to the same key.
 */
export function manualConnectionKey(edge) {
  const fromId = String(edge?.fromId ?? '').trim();
  const toId = String(edge?.toId ?? '').trim();
  return `${fromId}->${toId}`;
}

function clampManualBend(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.min(MANUAL_EDGE_BEND_LIMIT, Math.max(-MANUAL_EDGE_BEND_LIMIT, v));
}

/**
 * Chord-local bend: tangent (along the connector) and normal (perpendicular) from chord midpoint
 * toward the quadratic control point. Legacy `bend` only sets the normal component.
 */
export function resolveManualEdgeBends(edge) {
  if (!edge || typeof edge !== 'object') return { bendT: 0, bendN: 0 };
  let bendT = 0;
  let bendN = 0;
  let hasT = false;
  let hasN = false;
  if (edge.bendT != null && edge.bendT !== '') {
    const b = typeof edge.bendT === 'number' ? edge.bendT : parseFloat(String(edge.bendT));
    if (Number.isFinite(b)) {
      bendT = clampManualBend(b);
      hasT = true;
    }
  }
  if (edge.bendN != null && edge.bendN !== '') {
    const b = typeof edge.bendN === 'number' ? edge.bendN : parseFloat(String(edge.bendN));
    if (Number.isFinite(b)) {
      bendN = clampManualBend(b);
      hasN = true;
    }
  }
  if (!hasT && !hasN && edge.bend != null && edge.bend !== '') {
    const b = typeof edge.bend === 'number' ? edge.bend : parseFloat(String(edge.bend));
    if (Number.isFinite(b)) bendN = clampManualBend(b);
  }
  return { bendT, bendN };
}

/**
 * Directed arrow between two notes. Endpoints follow card geometry (closest sides).
 * `bendT` / `bendN`: chord-local control offset (world px). Legacy `bend` = `bendN` only.
 */
export function normalizeManualConnections(raw) {
  if (!Array.isArray(raw)) return [];
  /** Last occurrence wins (merge duplicates). */
  const map = new Map();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const fromId = String(item.fromId ?? item.from ?? '').trim();
    const toId = String(item.toId ?? item.to ?? '').trim();
    if (!fromId || !toId || fromId === toId || fromId.length > 96 || toId.length > 96) continue;
    const { bendT, bendN } = resolveManualEdgeBends(item);
    const key = `${fromId}->${toId}`;
    map.set(key, { fromId, toId, bendT, bendN, bend: bendN });
    if (map.size >= 120) break;
  }
  return Array.from(map.values());
}

export function normalizeCanvasLinkSide(s) {
  if (s === 'top' || s === 'right' || s === 'bottom' || s === 'left') return s;
  return null;
}

/** Drop edges whose endpoints are not both in `visibleNoteIds` (Set or iterable of strings). */
export function filterManualConnectionsForVisibleNotes(edges, visibleNoteIds) {
  if (!edges?.length) return [];
  const set = visibleNoteIds instanceof Set ? visibleNoteIds : new Set(Array.from(visibleNoteIds, String));
  return edges.filter((e) => set.has(String(e.fromId)) && set.has(String(e.toId)));
}

/** 0 = unlimited (single column / single row). Otherwise max children per column (vertical) or per row (horizontal). */
export function normalizeAutoArrangementWrapAfter(raw) {
  if (raw == null || raw === '') return 0;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw).trim(), 10);
  if (!Number.isFinite(n)) return 0;
  const f = Math.floor(n);
  if (f < 1) return 0;
  return Math.min(f, 500);
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

function cardRectDimsForLayout(note, getSize, minHFloor) {
  let w = LAYOUT_DEFAULT_W;
  let h = LAYOUT_DEFAULT_H;
  const ex = getSize(String(note.id));
  const floor = minHFloor(String(note.id));
  if (ex && Number.isFinite(ex.w) && Number.isFinite(ex.h)) {
    w = ex.w;
    h = Math.max(ex.h, floor);
  } else {
    h = Math.max(h, floor);
  }
  return { w, h };
}

/**
 * @param {{ id: string }[]} sequenceOrderedNotes lead first, then stream order
 * @param {(id: string) => { w: number, h: number } | null} getSize existing card sizes
 * @param {string} [focusAlign] {@link CANVAS_AUTO_FOCUS_ALIGN}
 * @param {{ minHeightForNoteId?: (id: string) => number, focusPeerSpacing?: 'wide' | 'compact', wrapAfter?: number }} [opts]
 * @returns {Record<string, { x: number, y: number, w: number, h: number }>}
 */
export function computeCanvasVerticalArrangementRects(sequenceOrderedNotes, getSize, focusAlign, opts) {
  if (!sequenceOrderedNotes?.length) return {};
  const focusToColumnGap = resolveFocusToColumnGap(opts);
  const minHFloor =
    typeof opts?.minHeightForNoteId === 'function' ? opts.minHeightForNoteId : () => 0;
  const wrapAfter = normalizeAutoArrangementWrapAfter(opts?.wrapAfter);
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
  const baseX = LAYOUT_START_X + leadW + focusToColumnGap;

  if (!children.length) {
    rects[String(lead.id)] = { x: LAYOUT_START_X, y: LAYOUT_START_Y, w: leadW, h: leadH };
    return rects;
  }

  const chunks = [];
  if (wrapAfter <= 0) {
    chunks.push(children);
  } else {
    for (let i = 0; i < children.length; i += wrapAfter) {
      chunks.push(children.slice(i, i + wrapAfter));
    }
  }

  const columnHeights = [];
  let xCol = baseX;
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    let y = LAYOUT_START_Y;
    let colMaxW = 0;
    for (const n of chunk) {
      const { w, h } = cardRectDimsForLayout(n, getSize, minHFloor);
      rects[String(n.id)] = { x: xCol, y, w, h };
      colMaxW = Math.max(colMaxW, w);
      y += h + LAYOUT_VERTICAL_GAP;
    }
    const colH = chunk.length ? y - LAYOUT_START_Y - LAYOUT_VERTICAL_GAP : 0;
    columnHeights.push(colH);
    xCol += colMaxW;
    if (ci < chunks.length - 1) xCol += LAYOUT_COL_GAP;
  }

  const totalH = columnHeights.length ? Math.max(...columnHeights) : 0;
  let leadY = LAYOUT_START_Y;
  if (align === CANVAS_AUTO_FOCUS_ALIGN.START) {
    leadY = LAYOUT_START_Y;
  } else if (align === CANVAS_AUTO_FOCUS_ALIGN.END) {
    leadY = LAYOUT_START_Y + totalH - leadH;
  } else {
    leadY = LAYOUT_START_Y + totalH / 2 - leadH / 2;
  }
  rects[String(lead.id)] = { x: LAYOUT_START_X, y: leadY, w: leadW, h: leadH };
  return rects;
}

/**
 * @param {{ id: string }[]} sequenceOrderedNotes lead first, then stream order
 * @param {(id: string) => { w: number, h: number } | null} getSize
 * @param {string} [focusAlign] {@link CANVAS_AUTO_FOCUS_ALIGN}
 * @param {{ minHeightForNoteId?: (id: string) => number, focusPeerSpacing?: 'wide' | 'compact', wrapAfter?: number }} [opts]
 */
export function computeCanvasHorizontalArrangementRects(sequenceOrderedNotes, getSize, focusAlign, opts) {
  if (!sequenceOrderedNotes?.length) return {};
  const focusToRowGap = resolveFocusToRowGap(opts);
  const minHFloor =
    typeof opts?.minHeightForNoteId === 'function' ? opts.minHeightForNoteId : () => 0;
  const wrapAfter = normalizeAutoArrangementWrapAfter(opts?.wrapAfter);
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
  const rowBaseY = LAYOUT_START_Y + leadH + focusToRowGap;

  if (!children.length) {
    rects[String(lead.id)] = { x: LAYOUT_START_X, y: LAYOUT_START_Y, w: leadW, h: leadH };
    return rects;
  }

  const chunks = [];
  if (wrapAfter <= 0) {
    chunks.push(children);
  } else {
    for (let i = 0; i < children.length; i += wrapAfter) {
      chunks.push(children.slice(i, i + wrapAfter));
    }
  }

  const rowWidths = [];
  let yRow = rowBaseY;
  for (let ri = 0; ri < chunks.length; ri++) {
    const chunk = chunks[ri];
    let x = LAYOUT_START_X;
    let rowMaxH = 0;
    for (const n of chunk) {
      const { w, h } = cardRectDimsForLayout(n, getSize, minHFloor);
      rects[String(n.id)] = { x, y: yRow, w, h };
      rowMaxH = Math.max(rowMaxH, h);
      x += w + LAYOUT_ROW_GAP;
    }
    const rowW = chunk.length ? x - LAYOUT_START_X - LAYOUT_ROW_GAP : 0;
    rowWidths.push(rowW);
    yRow += rowMaxH;
    if (ri < chunks.length - 1) yRow += LAYOUT_VERTICAL_GAP;
  }

  const maxRowWidth = rowWidths.length ? Math.max(...rowWidths) : 0;
  let leadX = LAYOUT_START_X;
  if (align === CANVAS_AUTO_FOCUS_ALIGN.START) {
    leadX = LAYOUT_START_X;
  } else if (align === CANVAS_AUTO_FOCUS_ALIGN.END) {
    leadX = LAYOUT_START_X + maxRowWidth - leadW;
  } else {
    leadX = LAYOUT_START_X + maxRowWidth / 2 - leadW / 2;
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
