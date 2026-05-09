import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { flushSync } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from './AuthContext';
import Layout from './Layout';
import NoteCard from './NoteCard';
import ThreadSummaryModal, { collectVisibleNoteIds } from './ThreadSummaryModal';
import MoveNoteModal from './MoveNoteModal';
import { HoverInsightProvider } from './HoverInsightContext';
import { setLastStreamSearchFromParams } from './streamNavMemory';
import { filterTreeByVisibleNoteTypes, filterRootsByVisibleNoteTypes } from './noteTypeFilter';
import {
  sortNoteTreeByThreadOrder,
  sortNoteTreeWithStreamPrefsMap,
  normalizeStreamThreadSortPrefs,
  noteThreadSortKeyMs,
  resolveStreamThreadSortPrefsForHead,
  sortNotesByStreamOrderNoStarBias,
} from './noteThreadSort';
import { mergeIntoAboveSiblingIdFromSortedChildren, mergeNoteIntoSiblingAbove } from './noteMerge';
import { useNoteTypeFilter } from './NoteTypeFilterContext';
import { useNoteTypeColors } from './NoteTypeColorContext';
import StreamThreadImageBackground from './StreamThreadImageBackground';
import { userBackgroundFileUrl, bannerImageAttachment, noteFileUrl } from './attachmentUtils';
import {
  getThread,
  getRoots,
  getNote,
  getNoteThreadPath,
  createNote,
  uploadNoteFiles,
  fetchUserSettings,
  patchUserSettings,
  unstarNote,
} from './api';
import { firstLinePreview, historyPrimaryLabel } from './noteHistoryUtils';
import NoteTypeEventFields from './NoteTypeEventFields';
import MentionsTextarea from './MentionsTextarea';
import NoteTypeIcon from './NoteTypeIcon';
import ComposeCalendarPills from './ComposeCalendarPills';
import ComposeExpandableField from './ComposeExpandableField';
import {
  eventFieldsToPayload,
  NOTE_TYPE_OPTIONS,
  calendarFeedPickToComposeFields,
  buildCalendarEventDetailNoteContent,
} from './noteEventUtils';
import { syncTagsFromContent, syncConnectionsFromContent } from './noteBodySync';
import { pointerEventTargetElement } from './pointerEventUtils';
import {
  CANVAS_MOBILE_MEDIA_QUERY,
  CANVAS_ARRANGEMENT,
  CANVAS_AUTO_FOCUS_ALIGN,
  CANVAS_CONNECTOR_MODE,
  CANVAS_MANUAL_NEW_NOTE_ANCHOR,
  canvasFocusKey,
  canvasLayoutThreadKey,
  computeCanvasHorizontalArrangementRects,
  computeCanvasVerticalArrangementRects,
  filterManualConnectionsForVisibleNotes,
  MANUAL_EDGE_BEND_LIMIT,
  manualConnectionKey,
  mergeCanvasLayoutPatch,
  normalizeManualConnections,
  resolveManualEdgeBends,
  replaceCanvasLayoutFocusBlock,
  resolveCanvasBlockPrefs,
  resolveCanvasView,
} from './canvasLayoutApi';
import CanvasSequenceMenu from './CanvasSequenceMenu';
import { useMediaQuery } from './useMediaQuery';
import {
  NavIconAttach,
  NavIconHistory,
  NavIconUpOneLevel,
  NavIconRootLevel,
  NavIconRefresh,
  NavIconBrain,
  NavIconSequenceLines,
} from './icons/NavIcons';
import './StreamPage.css';
import './CanvasPage.css';

function buildTree(flat) {
  const byId = new Map(flat.map((n) => [n.id, { ...n, children: [] }]));
  const roots = [];
  for (const n of flat) {
    const node = byId.get(n.id);
    if (n.parent_id) {
      const parent = byId.get(n.parent_id);
      if (parent) parent.children.push(node);
      else roots.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function noteIdEq(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function findNode(nodes, id) {
  for (const n of nodes) {
    if (noteIdEq(n.id, id)) return n;
    const f = findNode(n.children || [], id);
    if (f) return f;
  }
  return null;
}

function parentInFilteredTree(nodes, targetId) {
  for (const n of nodes) {
    for (const c of n.children || []) {
      if (noteIdEq(c.id, targetId)) return n.id;
    }
    const p = parentInFilteredTree(n.children || [], targetId);
    if (p != null) return p;
  }
  return null;
}

/** Visible notes in stream order: head row(s) then direct replies only (same as StreamList). */
function flattenCanvasNotes(displayTree) {
  const out = [];
  for (const root of displayTree) {
    out.push(root);
    for (const c of root.children || []) out.push(c);
  }
  return out;
}

const DEFAULT_CARD_W = 340;
const DEFAULT_CARD_H = 220;
const DEFAULT_CARD_H_WITH_BANNER = 320;
const DEFAULT_CARD_GAP_Y = 36;
const DEFAULT_CARD_START_X = 48;
const DEFAULT_CARD_START_Y = 48;

/** Thread root, focused note (subtree), or first stream root — always first in sequence / default stack. */
function canvasLeadNoteId(displayTree, focusId, threadRootId) {
  const flat = flattenCanvasNotes(displayTree);
  if (flat.length === 0) return null;
  if (threadRootId && focusId && !noteIdEq(focusId, threadRootId)) {
    return String(focusId);
  }
  if (threadRootId) {
    return String(threadRootId);
  }
  return String(flat[0].id);
}

/** Vertical timeline: older notes higher, newer lower. */
function defaultCardHeightForNote(note) {
  return bannerImageAttachment(note) ? DEFAULT_CARD_H_WITH_BANNER : DEFAULT_CARD_H;
}

function defaultRectForRank(rank, note = null) {
  const h = defaultCardHeightForNote(note);
  return {
    x: DEFAULT_CARD_START_X,
    y: DEFAULT_CARD_START_Y + rank * (h + DEFAULT_CARD_GAP_Y),
    w: DEFAULT_CARD_W,
    h,
  };
}

/** New card centered in the current viewport (world coords). `transform` is translate(tx,ty) then scale(scale) at origin 0,0. */
function defaultRectForNewNoteInViewport(scale, tx, ty, vw, vh) {
  const w = DEFAULT_CARD_W;
  const h = DEFAULT_CARD_H;
  const cx = (vw / 2 - tx) / scale;
  const cy = (vh / 2 - ty) / scale;
  return {
    x: cx - w / 2,
    y: cy - h / 2,
    w,
    h,
  };
}

const NEW_CARD_GAP = 12;

function rectsOverlap(a, b, gap = 0) {
  return !(
    a.x + a.w + gap <= b.x ||
    b.x + b.w + gap <= a.x ||
    a.y + a.h + gap <= b.y ||
    b.y + b.h + gap <= a.y
  );
}

function rectOverlapsAny(rect, rects, gap) {
  for (const r of rects) {
    if (!r || typeof r.x !== 'number') continue;
    if (rectsOverlap(rect, r, gap)) return true;
  }
  return false;
}

/**
 * Prefer a spot that does not overlap existing cards; overlap only as a last resort (viewport center).
 * Viewport-relative positions must be tried first: when the user has panned/zoomed, saved cards sit far
 * from DEFAULT_CARD_START_* — the old order picked the fixed corner when it didn’t overlap anything,
 * so new notes appeared off-screen.
 */
function rectForNewNoteAvoidOverlap(scale, tx, ty, vw, vh, rank, existingRects, note = null) {
  const w = DEFAULT_CARD_W;
  const h = DEFAULT_CARD_H;
  const gap = NEW_CARD_GAP;
  const others = existingRects.filter(
    (r) => r && typeof r.x === 'number' && typeof r.w === 'number' && typeof r.h === 'number'
  );

  const candidates = [];

  const cx = (vw / 2 - tx) / scale;
  const cy = (vh / 2 - ty) / scale;
  const stepX = w + gap;
  const stepY = h + gap;
  for (let ring = 0; ring <= 8; ring += 1) {
    if (ring === 0) {
      candidates.push({ x: cx - w / 2, y: cy - h / 2, w, h });
      continue;
    }
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        candidates.push({
          x: cx - w / 2 + dx * stepX,
          y: cy - h / 2 + dy * stepY,
          w,
          h,
        });
      }
    }
  }

  candidates.push(defaultRectForRank(rank, note));

  let maxBottom = DEFAULT_CARD_START_Y;
  let maxRight = DEFAULT_CARD_START_X;
  for (const r of others) {
    maxBottom = Math.max(maxBottom, r.y + r.h);
    maxRight = Math.max(maxRight, r.x + r.w);
  }
  candidates.push({ x: DEFAULT_CARD_START_X, y: maxBottom + gap, w, h });
  candidates.push({ x: maxRight + gap, y: DEFAULT_CARD_START_Y, w, h });

  for (const c of candidates) {
    if (!rectOverlapsAny(c, others, gap)) return c;
  }
  return defaultRectForNewNoteInViewport(scale, tx, ty, vw, vh);
}

/** Place a new card adjacent to an anchor (manual layout). */
function rectForNewNoteNearAnchor(anchorRect, existingRects, scale, tx, ty, vw, vh) {
  const w = DEFAULT_CARD_W;
  const h = DEFAULT_CARD_H;
  const gap = NEW_CARD_GAP;
  const others = existingRects.filter(
    (r) => r && typeof r.x === 'number' && typeof r.w === 'number' && typeof r.h === 'number'
  );
  if (!anchorRect || typeof anchorRect.x !== 'number') {
    return defaultRectForNewNoteInViewport(scale, tx, ty, vw, vh);
  }
  const candidates = [
    { x: anchorRect.x + anchorRect.w + gap, y: anchorRect.y, w, h },
    { x: anchorRect.x, y: anchorRect.y + anchorRect.h + gap, w, h },
    { x: anchorRect.x + anchorRect.w + gap, y: anchorRect.y + anchorRect.h + gap, w, h },
    { x: anchorRect.x - w - gap, y: anchorRect.y, w, h },
    { x: anchorRect.x, y: anchorRect.y - h - gap, w, h },
    { x: anchorRect.x + anchorRect.w + gap, y: anchorRect.y - h - gap, w, h },
  ];
  for (const c of candidates) {
    if (!rectOverlapsAny(c, others, gap)) return c;
  }
  return rectForNewNoteAvoidOverlap(scale, tx, ty, vw, vh, 0, others);
}

/** Midpoint of a rectangle side (top | right | bottom | left). */
function sideMidpoint(rect, side) {
  const { x, y, w, h } = rect;
  switch (side) {
    case 'top':
      return { x: x + w / 2, y };
    case 'bottom':
      return { x: x + w / 2, y: y + h };
    case 'left':
      return { x, y: y + h / 2 };
    case 'right':
      return { x: x + w, y: y + h / 2 };
    default:
      return { x: x + w / 2, y: y + h / 2 };
  }
}

const RECT_SIDES = ['top', 'right', 'bottom', 'left'];

/** Side of `rect` whose midpoint is closest to `pt` (world coordinates). */
function closestSideToPoint(rect, pt) {
  let best = RECT_SIDES[0];
  let bestD = Infinity;
  for (const side of RECT_SIDES) {
    const p = sideMidpoint(rect, side);
    const d = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = side;
    }
  }
  return best;
}

/** Connect consecutive cards via midpoints of the sides that face each other. */
function connectorBetweenRects(a, b) {
  const cax = a.x + a.w / 2;
  const cay = a.y + a.h / 2;
  const cbx = b.x + b.w / 2;
  const cby = b.y + b.h / 2;
  const dx = cbx - cax;
  const dy = cby - cay;
  let sideA;
  let sideB;
  if (Math.abs(dx) >= Math.abs(dy)) {
    sideA = dx >= 0 ? 'right' : 'left';
    sideB = dx >= 0 ? 'left' : 'right';
  } else {
    sideA = dy >= 0 ? 'bottom' : 'top';
    sideB = dy >= 0 ? 'top' : 'bottom';
  }
  const p1 = sideMidpoint(a, sideA);
  const p2 = sideMidpoint(b, sideB);
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

/** Hub mode + horizontal layout: bottom of focus to top of each child. */
function connectorFocusToChildHorizontal(a, b) {
  const p1 = sideMidpoint(a, 'bottom');
  const p2 = sideMidpoint(b, 'top');
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

/** Hub mode + vertical layout: right of focus to left of each child. */
function connectorFocusToChildVertical(a, b) {
  const p1 = sideMidpoint(a, 'right');
  const p2 = sideMidpoint(b, 'left');
  return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
}

/** Unit tangent (chord direction) and left normal at chord midpoint; midpoint for control construction. */
function chordBasisWorld(p0, p2) {
  const vx = p2.x - p0.x;
  const vy = p2.y - p0.y;
  const len = Math.hypot(vx, vy);
  const mx = (p0.x + p2.x) / 2;
  const my = (p0.y + p2.y) / 2;
  if (len < 1e-9) return { mx, my, tx: 1, ty: 0, nx: 0, ny: 1 };
  const tx = vx / len;
  const ty = vy / len;
  const nx = -vy / len;
  const ny = vx / len;
  return { mx, my, tx, ty, nx, ny };
}

/** Quadratic control from chord-local bends (see resolveManualEdgeBends). Q = M + 2*(bendT*t + bendN*n). */
function quadControlFromChordBends(p0, p2, bendT, bendN) {
  const b = chordBasisWorld(p0, p2);
  const bt = Number.isFinite(bendT) ? bendT : 0;
  const bn = Number.isFinite(bendN) ? bendN : 0;
  return {
    x: b.mx + 2 * (b.tx * bt + b.nx * bn),
    y: b.my + 2 * (b.ty * bt + b.ny * bn),
  };
}

function quadCurveMidpoint(p0, qc, p2) {
  return {
    x: 0.25 * p0.x + 0.5 * qc.x + 0.25 * p2.x,
    y: 0.25 * p0.y + 0.5 * qc.y + 0.25 * p2.y,
  };
}

function quadBezierPoint(p0, qc, p2, t) {
  const u = 1 - t;
  const a = u * u;
  const b = 2 * u * t;
  const c = t * t;
  return {
    x: a * p0.x + b * qc.x + c * p2.x,
    y: a * p0.y + b * qc.y + c * p2.y,
  };
}

/** Curve samples used to pick which card edge the wire “approaches” from — avoids biasing both sides toward t=½. */
const MANUAL_EDGE_NEAR_FROM_T = 0.25;
const MANUAL_EDGE_NEAR_TO_T = 0.75;

/**
 * Manual arrows: each endpoint uses the note side whose midpoint is closest to the curve near that end
 * (not center-to-center facing). Source uses a point near the start of the quadratic, target near the end.
 */
function manualConnectorChord(ra, rb, bendT, bendN) {
  const cax = ra.x + ra.w / 2;
  const cay = ra.y + ra.h / 2;
  const cbx = rb.x + rb.w / 2;
  const cby = rb.y + rb.h / 2;
  let mid = { x: (cax + cbx) / 2, y: (cay + cby) / 2 };

  const bt = Number.isFinite(bendT) ? bendT : 0;
  const bn = Number.isFinite(bendN) ? bendN : 0;

  let p0 = sideMidpoint(ra, closestSideToPoint(ra, mid));
  let p2 = sideMidpoint(rb, closestSideToPoint(rb, mid));

  let prevSideA;
  let prevSideB;

  for (let i = 0; i < 16; i++) {
    const q = quadControlFromChordBends(p0, p2, bt, bn);
    const nearFrom = quadBezierPoint(p0, q, p2, MANUAL_EDGE_NEAR_FROM_T);
    const nearTo = quadBezierPoint(p0, q, p2, MANUAL_EDGE_NEAR_TO_T);
    const sideA = closestSideToPoint(ra, nearFrom);
    const sideB = closestSideToPoint(rb, nearTo);

    const nextP0 = sideMidpoint(ra, sideA);
    const nextP2 = sideMidpoint(rb, sideB);
    const qn = quadControlFromChordBends(nextP0, nextP2, bt, bn);
    const midNext = quadCurveMidpoint(nextP0, qn, nextP2);

    const shift = Math.hypot(midNext.x - mid.x, midNext.y - mid.y);
    mid = midNext;
    p0 = nextP0;
    p2 = nextP2;

    const stable =
      i > 0 &&
      sideA === prevSideA &&
      sideB === prevSideB &&
      shift < 0.25;
    prevSideA = sideA;
    prevSideB = sideB;
    if (stable) break;
  }

  return { x1: p0.x, y1: p0.y, x2: p2.x, y2: p2.y };
}

function notePreview(content, max = 72) {
  if (!content || typeof content !== 'string') return '—';
  const line = content.split('\n')[0].trim().replace(/^#+\s*/, '');
  const t = line.length ? line : '—';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** True if the event target should not start a canvas drag (controls, links, editing). */
function isCanvasDragInteractiveTarget(target) {
  if (!target || typeof target.closest !== 'function') return true;
  return Boolean(
    target.closest(
      [
        '.canvas-card-resize',
        'button',
        'a[href]',
        'textarea',
        'input',
        'select',
        '[contenteditable="true"]',
        '.note-card--editing',
        '.note-card-actions',
        '.note-rich-task-checkbox',
        '.note-card-tag-dropdown',
        '[data-insight-ui]',
        'label',
        '.canvas-sequence-menu',
        '.canvas-sequence-menu__panel',
        '.canvas-card-link-handle-zone',
        '.canvas-card-link-handle',
        '.canvas-manual-bend-handle',
      ].join(', ')
    )
  );
}

/**
 * Nested scrollports (long note body, textarea, etc.): let the browser handle wheel/trackpad so we do not
 * steal the gesture for canvas pan.
 * Canvas note scroll body (`.canvas-card-body .note-card-body-main`): never chain to canvas pan at edges —
 * cursor stays over that region; overscroll-behavior:contain keeps the gesture local.
 */
function wheelEventShouldScrollNestedTarget(target, rootViewport, deltaX, deltaY) {
  if (!(target instanceof Node) || !rootViewport?.contains(target)) return false;
  let node = target;
  while (node && rootViewport.contains(node)) {
    if (node === rootViewport) break;
    if (!(node instanceof Element)) {
      node = node.parentNode;
      continue;
    }
    const cs = window.getComputedStyle(node);
    const oy = cs.overflowY;
    const ox = cs.overflowX;
    const canY =
      (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && node.scrollHeight > node.clientHeight + 1;
    const canX =
      (ox === 'auto' || ox === 'scroll' || ox === 'overlay') && node.scrollWidth > node.clientWidth + 1;
    const canvasNoteScrollBody =
      typeof node.closest === 'function'
        ? node.closest('.canvas-card-body .note-card-body-main')
        : null;
    if (canY && Math.abs(deltaY) > 0.5) {
      const atTop = node.scrollTop <= 0;
      const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
      if (
        canvasNoteScrollBody != null ||
        (deltaY < 0 && !atTop) ||
        (deltaY > 0 && !atBottom)
      ) {
        return true;
      }
    }
    if (canX && Math.abs(deltaX) > 0.5) {
      const atLeft = node.scrollLeft <= 0;
      const atRight = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1;
      if (
        canvasNoteScrollBody != null ||
        (deltaX < 0 && !atLeft) ||
        (deltaX > 0 && !atRight)
      ) {
        return true;
      }
    }
    node = node.parentElement;
  }
  return false;
}

const SAVE_DEBOUNCE_MS = 200;
/** Room for Edit / Delete / + Tag / star without wrapping at narrow widths. */
const MIN_W = 280;
const MIN_H = 120;

/** Screen px — converted to world using canvas zoom so snap distance feels consistent. */
const SNAP_GUIDE_SCREEN_PX = 8;
/** Minimum snap threshold in world px (avoid tiny thresholds when zoomed in). */
const SNAP_GUIDE_WORLD_MIN = 3;

function uniqSnapLines(values, eps = 0.5) {
  const out = [];
  for (const v of values) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    if (!out.some((u) => Math.abs(u - v) < eps)) out.push(v);
  }
  return out;
}

/**
 * @param {'x' | 'y'} axis
 * @param {number} pos left or top of dragged rect
 * @param {number} size width or height
 * @param {{ x: number, y: number, w: number, h: number }[]} others
 * @param {number} thresholdWorld snap tolerance in canvas world px (from screen px / zoom)
 */
function snapCanvasAxis(axis, pos, size, others, thresholdWorld) {
  const th = Math.max(thresholdWorld, SNAP_GUIDE_WORLD_MIN);
  let best = pos;
  let bestD = th + 1;
  /** @type {number | null} */
  let guide = null;
  /** @type {{ x: number, y: number, w: number, h: number } | null} */
  let winning = null;
  for (const o of others) {
    if (!o || typeof o.x !== 'number') continue;
    const cx = o.x + o.w / 2;
    const cy = o.y + o.h / 2;
    const candidates =
      axis === 'x'
        ? [
            { pos: o.x, guide: o.x },
            { pos: o.x + o.w - size, guide: o.x + o.w },
            { pos: cx - size / 2, guide: cx },
            { pos: cx, guide: cx },
            { pos: cx - size, guide: cx },
          ]
        : [
            { pos: o.y, guide: o.y },
            { pos: o.y + o.h - size, guide: o.y + o.h },
            { pos: cy - size / 2, guide: cy },
            { pos: cy, guide: cy },
            { pos: cy - size, guide: cy },
          ];
    for (const c of candidates) {
      const d = Math.abs(pos - c.pos);
      if (d <= th && d < bestD) {
        bestD = d;
        best = c.pos;
        guide = c.guide;
        winning = o;
      }
    }
  }
  /** @type {number[]} */
  let vx = [];
  /** @type {number[]} */
  let hy = [];
  if (guide != null && winning) {
    if (axis === 'x') vx.push(guide);
    else hy.push(guide);
    vx.push(winning.x + winning.w / 2);
    hy.push(winning.y + winning.h / 2);
    vx = uniqSnapLines(vx);
    hy = uniqSnapLines(hy);
  }
  return { pos: best, vx, hy };
}

/**
 * Bottom-right resize: snap moving right/bottom edges to other rects’ left/right/center-x and top/bottom/center-y.
 * @param {{ x: number, y: number, w: number, h: number }} base rect at resize start (fixed top-left)
 * @param {number} dw width delta (world px)
 * @param {number} dh height delta
 * @param {{ x: number, y: number, w: number, h: number }[]} others
 */
function snapResizeBottomRight(base, dw, dh, others, minW, minH, thresholdWorld) {
  const th = Math.max(thresholdWorld, SNAP_GUIDE_WORLD_MIN);
  const rawW = Math.max(minW, base.w + dw);
  const rawH = Math.max(minH, base.h + dh);
  const rightEdge = base.x + rawW;
  const bottomEdge = base.y + rawH;
  let bestRx = rightEdge;
  let bestRd = th + 1;
  /** @type {number | null} */
  let gx = null;
  /** @type {{ x: number, y: number, w: number, h: number } | null} */
  let winOx = null;
  for (const o of others) {
    if (!o || typeof o.x !== 'number') continue;
    for (const t of [o.x, o.x + o.w, o.x + o.w / 2]) {
      const d = Math.abs(rightEdge - t);
      if (d <= th && d < bestRd) {
        bestRd = d;
        bestRx = t;
        gx = t;
        winOx = o;
      }
    }
  }
  let bestBy = bottomEdge;
  let bestBd = th + 1;
  /** @type {number | null} */
  let gy = null;
  /** @type {{ x: number, y: number, w: number, h: number } | null} */
  let winOy = null;
  for (const o of others) {
    if (!o || typeof o.x !== 'number') continue;
    for (const t of [o.y, o.y + o.h, o.y + o.h / 2]) {
      const d = Math.abs(bottomEdge - t);
      if (d <= th && d < bestBd) {
        bestBd = d;
        bestBy = t;
        gy = t;
        winOy = o;
      }
    }
  }
  const w = Math.max(minW, bestRx - base.x);
  const h = Math.max(minH, bestBy - base.y);
  /** Snap line plus full center cross on each reference card that contributed a snap. */
  let vx = [];
  let hy = [];
  if (gx != null && winOx) {
    vx.push(gx);
    vx.push(winOx.x + winOx.w / 2);
    hy.push(winOx.y + winOx.h / 2);
  }
  if (gy != null && winOy) {
    hy.push(gy);
    vx.push(winOy.x + winOy.w / 2);
    hy.push(winOy.y + winOy.h / 2);
  }
  return {
    w,
    h,
    guides: {
      vx: uniqSnapLines(vx),
      hy: uniqSnapLines(hy),
    },
  };
}

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;
/**
 * When fitting cards into the viewport (first layout, reset, or zoom-to-card), do not zoom in past this —
 * small stacks otherwise hit the old 2.5× cap and feel jarring when opening a thread for the first time.
 */
const FIT_CONTENT_VIEW_MAX_SCALE = 1.25;
/** Each +/- applies a 5% multiplicative step (×1.05 / ÷1.05). */
const ZOOM_STEP_FACTOR = 1.05;
/** Trackpad ctrl/meta + wheel zoom sensitivity (higher = faster). */
const WHEEL_ZOOM_SENS = 0.009;
/** Pinch exponent >1 makes pinch-zoom respond faster. */
const PINCH_ZOOM_EXP = 1.22;

export default function CanvasPage() {
  const { logout, user } = useAuth();
  const {
    streamRootBackgroundPresent,
    streamRootBackgroundOpacity,
    canvasUseStreamRootBackground,
    userBackgroundFetchRevision,
    streamBackgroundDriftAllPlatforms,
    streamBackgroundDriftDisableMobile,
    streamBackgroundCrtEffect,
    streamThreadImageBgEnabled,
    streamThreadImageBgOpacity,
  } = useNoteTypeColors();
  const [searchParams, setSearchParams] = useSearchParams();
  const threadRootId = searchParams.get('thread')?.trim() || null;
  const focusParam = searchParams.get('focus')?.trim() || null;

  const [thread, setThread] = useState([]);
  const [loadingThread, setLoadingThread] = useState(true);
  const [focusId, setFocusId] = useState(null);
  /**
   * Pin saved-canvas bucket while `focus=` catches up after drill navigation.
   * `undefined` = use URL only; `null` = thread-root bucket (`__root__`); string = focused note id.
   */
  const [canvasLayoutFkOverride, setCanvasLayoutFkOverride] = useState(
    /** @type {undefined | string | null} */ (undefined)
  );
  const [canvasLayouts, setCanvasLayouts] = useState({});
  const [noteHistory, setNoteHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [moveNoteTarget, setMoveNoteTarget] = useState(null);
  /** `streamThreadSort` map (thread root + per drill head), same as Stream. */
  const [streamThreadSortByRoot, setStreamThreadSortByRoot] = useState({});
  const [sequenceMenuOpen, setSequenceMenuOpen] = useState(false);
  const [draftArrangement, setDraftArrangement] = useState(CANVAS_ARRANGEMENT.MANUAL);
  const [draftConnector, setDraftConnector] = useState(CANVAS_CONNECTOR_MODE.THREAD_CHAIN);
  const [draftManualNewNoteAnchor, setDraftManualNewNoteAnchor] = useState(
    CANVAS_MANUAL_NEW_NOTE_ANCHOR.FOCUS
  );
  const [draftAutoFocusAlign, setDraftAutoFocusAlign] = useState(CANVAS_AUTO_FOCUS_ALIGN.CENTER);
  /** 0 = single column (vertical) or single row (horizontal); ≥1 wraps after that many child notes. */
  const [draftAutoArrangementWrapAfter, setDraftAutoArrangementWrapAfter] = useState(0);
  const [canvasArrangement, setCanvasArrangement] = useState(CANVAS_ARRANGEMENT.MANUAL);
  const [connectorMode, setConnectorMode] = useState(CANVAS_CONNECTOR_MODE.THREAD_CHAIN);
  const [manualNewNoteAnchor, setManualNewNoteAnchor] = useState(CANVAS_MANUAL_NEW_NOTE_ANCHOR.FOCUS);
  const [autoFocusAlign, setAutoFocusAlign] = useState(CANVAS_AUTO_FOCUS_ALIGN.CENTER);
  const [autoArrangementWrapAfter, setAutoArrangementWrapAfter] = useState(0);
  /** Directed arrows drawn between cards in manual layout (persisted). */
  const [manualConnections, setManualConnections] = useState([]);
  /** Rubber-band line while dragging from a link handle (world coords). */
  const [manualLinkRubber, setManualLinkRubber] = useState(null);
  const [starredDockExpanded, setStarredDockExpanded] = useState(false);
  /** Fixed px position; null = use CSS default placement */
  const [starredDockPos, setStarredDockPos] = useState(null);

  const [composeNoteType, setComposeNoteType] = useState('note');
  const [composeStartDate, setComposeStartDate] = useState('');
  const [composeStartTime, setComposeStartTime] = useState('');
  const [composeEndDate, setComposeEndDate] = useState('');
  const [composeEndTime, setComposeEndTime] = useState('');
  const [replyContent, setReplyContent] = useState('');
  const [newRootContent, setNewRootContent] = useState('');
  const [pendingReplyFiles, setPendingReplyFiles] = useState([]);
  const [pendingRootFiles, setPendingRootFiles] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [composeExpanded, setComposeExpanded] = useState(false);

  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [zoomPercentStr, setZoomPercentStr] = useState('100');
  const [zoomFieldFocused, setZoomFieldFocused] = useState(false);
  const [cardRects, setCardRects] = useState({});
  /** Alignment guides (canvas world coords) while dragging a card. */
  const [snapGuides, setSnapGuides] = useState({ vx: [], hy: [] });

  const cardRectsRef = useRef(cardRects);
  const canvasLayoutsRef = useRef(canvasLayouts);
  const canvasArrangementRef = useRef(CANVAS_ARRANGEMENT.MANUAL);
  const connectorModeRef = useRef(CANVAS_CONNECTOR_MODE.THREAD_CHAIN);
  const manualNewNoteAnchorRef = useRef(CANVAS_MANUAL_NEW_NOTE_ANCHOR.FOCUS);
  const autoFocusAlignRef = useRef(CANVAS_AUTO_FOCUS_ALIGN.CENTER);
  const autoArrangementWrapAfterRef = useRef(0);
  const manualConnectionsRef = useRef([]);
  const manualLinkDragSessionRef = useRef(null);
  /** Keep bend dot visible while dragging (group :hover can drop mid-drag). */
  const [bendDragEdgeKey, setBendDragEdgeKey] = useState(null);
  cardRectsRef.current = cardRects;
  canvasLayoutsRef.current = canvasLayouts;
  canvasArrangementRef.current = canvasArrangement;
  connectorModeRef.current = connectorMode;
  manualNewNoteAnchorRef.current = manualNewNoteAnchor;
  autoFocusAlignRef.current = autoFocusAlign;
  autoArrangementWrapAfterRef.current = autoArrangementWrapAfter;
  manualConnectionsRef.current = manualConnections;

  /** Sort-order / hub lines — disabled in manual layout (only user-drawn arrows). */
  const automaticSequenceLinesVisible =
    canvasArrangement !== CANVAS_ARRANGEMENT.MANUAL &&
    connectorMode !== CANVAS_CONNECTOR_MODE.NONE;
  /** Toolbar icon: auto lines on vs manual arrows drawn. */
  const sequenceMenuLinesActive =
    canvasArrangement === CANVAS_ARRANGEMENT.MANUAL
      ? manualConnections.length > 0
      : automaticSequenceLinesVisible;

  const viewportRef = useRef(null);
  const viewportPointersRef = useRef(new Map());
  const pinchSessionRef = useRef(null);
  const panSessionRef = useRef(null);
  const viewportPointerTrackingRef = useRef(false);
  const scaleRef = useRef(1);
  const txRef = useRef(0);
  const tyRef = useRef(0);
  const scheduleSaveRef = useRef(() => {});
  const pointerMoveInnerRef = useRef(() => {});
  const pointerUpInnerRef = useRef(() => {});
  const saveTimerRef = useRef(null);
  const canvasReplyFileRef = useRef(null);
  const canvasRootFileRef = useRef(null);
  const canvasComposeWrapRef = useRef(null);
  const focusFromUrl = useRef('');
  const historyBtnRef = useRef(null);
  const historyMenuRef = useRef(null);
  const historySaveTimer = useRef(null);
  const historyInitRef = useRef(false);
  const lastVisitedNoteRef = useRef(null);
  /** After layout reset: always fit all cards in view. */
  const pendingFitAllRef = useRef(false);
  /** Avoid repeated fit while saved layout is still empty (e.g. before first save completes). */
  const fitAppliedForEmptyRef = useRef(false);
  const canvasViewKeyRef = useRef('');
  const starredDockPosRef = useRef(null);
  const isCanvasMobileViewportRef = useRef(false);
  const { visibleNoteTypes } = useNoteTypeFilter();
  const isCanvasMobileViewport = useMediaQuery(CANVAS_MOBILE_MEDIA_QUERY);
  const streamBackgroundAnimate =
    (streamBackgroundDriftAllPlatforms || streamBackgroundDriftDisableMobile) &&
    !(streamBackgroundDriftDisableMobile && isCanvasMobileViewport);

  useEffect(() => {
    setLastStreamSearchFromParams(searchParams);
  }, [searchParams]);

  useEffect(() => {
    if (!threadRootId) {
      setLoadingThread(true);
      getRoots(false)
        .then(setThread)
        .catch(() => setThread([]))
        .finally(() => setLoadingThread(false));
      return;
    }
    setLoadingThread(true);
    getThread(threadRootId, false)
      .then((rows) => {
        setThread(rows);
        if (rows.length === 0) setSearchParams({});
      })
      .catch(() => {
        setThread([]);
        setSearchParams({});
      })
      .finally(() => setLoadingThread(false));
  }, [threadRootId, setSearchParams]);

  useEffect(() => {
    if (!user?.id) {
      setNoteHistory([]);
      historyInitRef.current = false;
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const s = await fetchUserSettings();
        if (cancelled) return;
        const rawLayouts = s?.canvasLayouts ?? s?.campusLayouts;
        if (rawLayouts && typeof rawLayouts === 'object') setCanvasLayouts(rawLayouts);
        setStreamThreadSortByRoot(
          s.streamThreadSort && typeof s.streamThreadSort === 'object' && !Array.isArray(s.streamThreadSort)
            ? s.streamThreadSort
            : {}
        );
        setNoteHistory(Array.isArray(s.noteHistory) ? s.noteHistory : []);
      } catch (e) {
        console.error(e);
        if (!cancelled) setNoteHistory([]);
      } finally {
        if (!cancelled) historyInitRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id || !historyInitRef.current) return;
    if (historySaveTimer.current) clearTimeout(historySaveTimer.current);
    historySaveTimer.current = setTimeout(() => {
      historySaveTimer.current = null;
      patchUserSettings({ noteHistory }).catch((e) => console.error(e));
    }, 450);
    return () => {
      if (historySaveTimer.current) clearTimeout(historySaveTimer.current);
    };
  }, [noteHistory, user?.id]);

  const treeFull = useMemo(() => {
    if (!threadRootId) {
      const roots = filterRootsByVisibleNoteTypes(thread, visibleNoteTypes);
      return sortNoteTreeByThreadOrder(roots.map((r) => ({ ...r, children: [] })));
    }
    return buildTree(thread);
  }, [thread, threadRootId, visibleNoteTypes]);

  const focusForSortHead = focusId ?? focusParam;
  const headNodeForStreamSort = useMemo(() => {
    if (!threadRootId || !treeFull.length) return null;
    const targetId =
      focusForSortHead && !noteIdEq(focusForSortHead, threadRootId)
        ? focusForSortHead
        : treeFull[0]?.id;
    if (targetId == null) return null;
    return findNode(treeFull, targetId);
  }, [treeFull, threadRootId, focusForSortHead]);

  const streamSortPrefsHeadId = useMemo(() => {
    if (!threadRootId) return null;
    const fh = focusId ?? focusParam;
    if (fh && !noteIdEq(fh, threadRootId)) return String(fh).trim().toLowerCase();
    return threadRootId.trim().toLowerCase();
  }, [threadRootId, focusId, focusParam]);

  const threadSortPrefs = useMemo(() => {
    if (!streamSortPrefsHeadId) return normalizeStreamThreadSortPrefs(undefined);
    const stored = streamThreadSortByRoot[streamSortPrefsHeadId];
    return resolveStreamThreadSortPrefsForHead(stored, Boolean(headNodeForStreamSort?.children?.length));
  }, [streamThreadSortByRoot, streamSortPrefsHeadId, headNodeForStreamSort]);

  const tree = useMemo(() => {
    if (!threadRootId) return treeFull;
    return sortNoteTreeWithStreamPrefsMap(
      filterTreeByVisibleNoteTypes(treeFull, visibleNoteTypes),
      streamThreadSortByRoot
    );
  }, [threadRootId, treeFull, visibleNoteTypes, streamThreadSortByRoot]);
  const actualRootId = threadRootId;
  const layoutStorageKey = useMemo(() => canvasLayoutThreadKey(threadRootId), [threadRootId]);

  const displayTree = useMemo(() => {
    const fn = focusId && actualRootId ? findNode(tree, focusId) : null;
    if (fn && !noteIdEq(focusId, actualRootId)) {
      return [{ ...fn, children: fn.children || [] }];
    }
    return tree;
  }, [tree, focusId, actualRootId]);

  const canvasNotes = useMemo(() => flattenCanvasNotes(displayTree), [displayTree]);
  const canvasLeadId = useMemo(
    () => canvasLeadNoteId(displayTree, focusId, threadRootId),
    [displayTree, focusId, threadRootId]
  );
  const sequenceOrderedNotes = useMemo(() => {
    const notes = canvasNotes;
    if (notes.length === 0) return [];
    const lid = canvasLeadId ? String(canvasLeadId) : null;
    if (!lid) return notes;
    const lead = notes.find((n) => String(n.id) === lid);
    if (!lead) return notes;
    const rest = notes.filter((n) => String(n.id) !== lid);
    return [lead, ...rest];
  }, [canvasNotes, canvasLeadId]);

  /** Stream sort including starred grouping — used for auto layouts and connector order there. */
  const manualSequenceOrderedNotes = useMemo(() => {
    const notes = canvasNotes;
    if (notes.length === 0) return [];
    const lid = canvasLeadId ? String(canvasLeadId) : null;
    if (!lid) {
      return sortNotesByStreamOrderNoStarBias(notes, threadSortPrefs);
    }
    const lead = notes.find((n) => String(n.id) === lid);
    if (!lead) return sortNotesByStreamOrderNoStarBias(notes, threadSortPrefs);
    const rest = notes.filter((n) => String(n.id) !== lid);
    const sortedRest = sortNotesByStreamOrderNoStarBias(rest, threadSortPrefs);
    return [lead, ...sortedRest];
  }, [canvasNotes, canvasLeadId, threadSortPrefs]);

  const sequenceNotesForCanvas = useMemo(() => {
    if (
      canvasArrangement === CANVAS_ARRANGEMENT.VERTICAL ||
      canvasArrangement === CANVAS_ARRANGEMENT.HORIZONTAL
    ) {
      return sequenceOrderedNotes;
    }
    return manualSequenceOrderedNotes;
  }, [canvasArrangement, sequenceOrderedNotes, manualSequenceOrderedNotes]);

  const layoutRankById = useMemo(() => {
    const m = new Map();
    sequenceNotesForCanvas.forEach((n, rank) => m.set(String(n.id), rank));
    return m;
  }, [sequenceNotesForCanvas]);

  const sequenceLayoutKey = useMemo(() => {
    const sortSig = `${threadSortPrefs.sortMode}:${threadSortPrefs.starredFirst ? 1 : 0}`;
    const noteSig = sequenceOrderedNotes
      .map((n) => `${n.id}:${n.starred ? 1 : 0}:${noteThreadSortKeyMs(n)}`)
      .join('|');
    return `${sortSig}|${noteSig}`;
  }, [sequenceOrderedNotes, threadSortPrefs]);

  const sequenceOrderedNotesRef = useRef(sequenceOrderedNotes);
  sequenceOrderedNotesRef.current = sequenceOrderedNotes;
  const threadById = useMemo(() => new Map(thread.map((n) => [n.id, n])), [thread]);
  const threadByIdRef = useRef(threadById);
  threadByIdRef.current = threadById;

  const layoutMinHeightForNoteId = useCallback((nid) => {
    const n = threadByIdRef.current.get(nid);
    return n && bannerImageAttachment(n) ? DEFAULT_CARD_H_WITH_BANNER : 0;
  }, []);

  /** Same “focused thread head” rule as Stream (`streamHeadHideDeleteId`) for thread image background. */
  const canvasStreamHeadHideDeleteId = useMemo(() => {
    if (!threadRootId) return null;
    const urlFocus = focusParam?.trim() || null;
    const merged = focusId ?? urlFocus;
    if (merged != null) return merged;
    if (displayTree.length === 1) return displayTree[0].id;
    return null;
  }, [threadRootId, focusId, focusParam, displayTree]);

  const threadBgHeadNote = useMemo(() => {
    if (!threadRootId || canvasStreamHeadHideDeleteId == null) return null;
    return (
      threadById.get(canvasStreamHeadHideDeleteId) ??
      thread.find((n) => noteIdEq(n.id, canvasStreamHeadHideDeleteId)) ??
      null
    );
  }, [threadRootId, canvasStreamHeadHideDeleteId, threadById, thread]);

  const threadBgImageAtt = useMemo(() => bannerImageAttachment(threadBgHeadNote), [threadBgHeadNote]);

  const showCanvasNoteAttachmentBg = Boolean(
    threadRootId && streamThreadImageBgEnabled && threadBgImageAtt?.id
  );
  const showCanvasRootUploadBg =
    canvasUseStreamRootBackground && streamRootBackgroundPresent && !showCanvasNoteAttachmentBg;

  const canvasBackgroundFetchUrl = useMemo(() => {
    if (showCanvasNoteAttachmentBg) return noteFileUrl(threadBgImageAtt.id);
    if (showCanvasRootUploadBg) return userBackgroundFileUrl(userBackgroundFetchRevision);
    return null;
  }, [
    showCanvasNoteAttachmentBg,
    showCanvasRootUploadBg,
    threadBgImageAtt?.id,
    userBackgroundFetchRevision,
  ]);

  const canvasBackgroundOpacity = showCanvasNoteAttachmentBg
    ? streamThreadImageBgOpacity
    : streamRootBackgroundOpacity;

  const showCanvasViewportBg = Boolean(canvasBackgroundFetchUrl);

  const focusedNode = focusId && actualRootId ? findNode(tree, focusId) : null;
  const replyParentId = focusId && focusedNode ? focusId : threadRootId;
  const focusSnippet = focusedNode?.content?.slice(0, 50) || '';

  useEffect(() => {
    const noteId = focusId || threadRootId;
    if (!noteId || !threadRootId) return;
    if (loadingThread) return;
    if (thread.length === 0) return;

    const row = threadById.get(noteId) || thread.find((n) => noteIdEq(n.id, noteId));
    if (!row) return;

    if (lastVisitedNoteRef.current === noteId) return;
    lastVisitedNoteRef.current = noteId;

    const title = firstLinePreview(row.content || '');
    (async () => {
      try {
        const threadPath = await getNoteThreadPath(noteId, { excludeLeaf: false });
        setNoteHistory((prev) => {
          const rest = prev.filter((x) => !noteIdEq(x.noteId, noteId));
          return [
            {
              noteId: String(noteId),
              threadRootId: String(threadRootId),
              title,
              threadPath: threadPath || title,
              visitedAt: new Date().toISOString(),
            },
            ...rest,
          ].slice(0, 20);
        });
      } catch (e) {
        console.error(e);
      }
    })();
  }, [threadRootId, focusId, threadById, loadingThread, thread]);

  useEffect(() => {
    if (!historyOpen) return undefined;
    const onDoc = (e) => {
      if (historyMenuRef.current?.contains(e.target) || historyBtnRef.current?.contains(e.target)) return;
      setHistoryOpen(false);
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [historyOpen]);

  const resetComposeMeta = useCallback(() => {
    setComposeNoteType('note');
    setComposeStartDate('');
    setComposeStartTime('');
    setComposeEndDate('');
    setComposeEndTime('');
  }, []);

  useEffect(() => {
    resetComposeMeta();
  }, [threadRootId, resetComposeMeta]);

  const cycleComposeNoteType = useCallback(() => {
    const i = NOTE_TYPE_OPTIONS.findIndex((o) => o.value === composeNoteType);
    const idx = i < 0 ? 0 : i;
    setComposeNoteType(NOTE_TYPE_OPTIONS[(idx + 1) % NOTE_TYPE_OPTIONS.length].value);
  }, [composeNoteType]);

  const composeTypeLabel =
    NOTE_TYPE_OPTIONS.find((o) => o.value === composeNoteType)?.label ?? composeNoteType;

  /** Saved layout / zoom / lines: keyed like bookmark URL (`focus=` or root). Override only until URL matches. */
  const fk = useMemo(() => {
    if (canvasLayoutFkOverride !== undefined) {
      return canvasFocusKey(canvasLayoutFkOverride);
    }
    return canvasFocusKey(focusParam || null);
  }, [canvasLayoutFkOverride, focusParam]);

  useLayoutEffect(() => {
    if (canvasLayoutFkOverride === undefined) return;
    const want = canvasLayoutFkOverride === null ? null : String(canvasLayoutFkOverride);
    const have = focusParam ? String(focusParam) : null;
    if (want === have) {
      setCanvasLayoutFkOverride(undefined);
    }
  }, [focusParam, canvasLayoutFkOverride]);

  const layoutStorageKeyRef = useRef(layoutStorageKey);
  const fkRef = useRef(fk);
  layoutStorageKeyRef.current = layoutStorageKey;
  fkRef.current = fk;

  /** Only changes when saved card JSON for this view changes — avoids re-hydrating rects on every save echo (which broke drag). */
  const savedCardsLayoutSig = useMemo(() => {
    const block = canvasLayouts[String(layoutStorageKey)]?.[fk];
    return JSON.stringify(block?.cards ?? null);
  }, [canvasLayouts, layoutStorageKey, fk]);

  useEffect(() => {
    setCanvasLayoutFkOverride(undefined);
  }, [threadRootId]);

  useEffect(() => {
    if (!threadRootId) {
      setFocusId(null);
      focusFromUrl.current = '';
      return;
    }
    if (!thread.length) return;
    const key = `${threadRootId}|${focusParam || ''}`;
    if (focusFromUrl.current === key) return;
    if (focusParam && !findNode(tree, focusParam)) return;
    focusFromUrl.current = key;
    setFocusId(focusParam || null);
  }, [threadRootId, focusParam, thread, tree]);

  useEffect(() => {
    if (!canvasNotes.length) {
      setCardRects({});
      return;
    }
    const vp = viewportRef.current;
    const vrect = vp?.getBoundingClientRect();
    const vw = vrect?.width ?? 800;
    const vh = vrect?.height ?? 600;

    setCardRects((prev) => {
      const next = {};
      let saved = {};
      try {
        if (savedCardsLayoutSig && savedCardsLayoutSig !== 'null') {
          const p = JSON.parse(savedCardsLayoutSig);
          if (p && typeof p === 'object' && !Array.isArray(p)) saved = p;
        }
      } catch {
        saved = {};
      }
      const savedIsEmpty = Object.keys(saved).length === 0;
      const rankById = layoutRankById;

      canvasNotes.forEach((n) => {
        const id = String(n.id);
        if (saved[id] && typeof saved[id].x === 'number') {
          const minBannerH = bannerImageAttachment(n) ? DEFAULT_CARD_H_WITH_BANNER : 0;
          next[id] = {
            x: saved[id].x,
            y: saved[id].y,
            w: saved[id].w,
            h: Math.max(saved[id].h, minBannerH),
          };
        }
      });

      canvasNotes.forEach((n) => {
        const id = String(n.id);
        if (next[id]) return;
        if (!savedIsEmpty && prev[id]) {
          next[id] = prev[id];
        }
      });

      canvasNotes.forEach((n) => {
        const id = String(n.id);
        if (next[id]) return;
        if (savedIsEmpty) {
          next[id] = defaultRectForRank(rankById.get(id) ?? 0, n);
        }
      });

      canvasNotes.forEach((n) => {
        const id = String(n.id);
        if (next[id]) return;
        const existingRects = Object.entries(next)
          .filter(([oid]) => oid !== id)
          .map(([, r]) => r);
        const rank = rankById.get(id) ?? 0;
        if (canvasArrangement === CANVAS_ARRANGEMENT.MANUAL) {
          let anchorRect = null;
          if (manualNewNoteAnchor === CANVAS_MANUAL_NEW_NOTE_ANCHOR.LAST) {
            for (let i = manualSequenceOrderedNotes.length - 1; i >= 0; i -= 1) {
              const oid = String(manualSequenceOrderedNotes[i].id);
              if (oid === id) continue;
              const r = next[oid] ?? prev[oid];
              if (r) {
                anchorRect = r;
                break;
              }
            }
          }
          if (!anchorRect && manualSequenceOrderedNotes[0]) {
            const leadId = String(manualSequenceOrderedNotes[0].id);
            anchorRect = next[leadId] ?? prev[leadId];
          }
          next[id] = rectForNewNoteNearAnchor(anchorRect, existingRects, scale, tx, ty, vw, vh);
        } else if (
          (canvasArrangement === CANVAS_ARRANGEMENT.VERTICAL ||
            canvasArrangement === CANVAS_ARRANGEMENT.HORIZONTAL) &&
          connectorMode === CANVAS_CONNECTOR_MODE.NONE
        ) {
          const lead = sequenceOrderedNotesRef.current[0];
          const leadId = lead ? String(lead.id) : null;
          const anchorRect = leadId ? next[leadId] ?? prev[leadId] : null;
          next[id] = rectForNewNoteNearAnchor(anchorRect, existingRects, scale, tx, ty, vw, vh);
        } else {
          next[id] = rectForNewNoteAvoidOverlap(scale, tx, ty, vw, vh, rank, existingRects, n);
        }
      });

      return next;
    });
  }, [
    canvasNotes,
    canvasLeadId,
    canvasArrangement,
    connectorMode,
    manualNewNoteAnchor,
    manualSequenceOrderedNotes,
    layoutRankById,
    layoutStorageKey,
    fk,
    savedCardsLayoutSig,
    scale,
    tx,
    ty,
  ]);

  /** Auto layouts: reposition all cards when stream order, stars, or sort prefs change. */
  useEffect(() => {
    if (
      canvasArrangement !== CANVAS_ARRANGEMENT.VERTICAL &&
      canvasArrangement !== CANVAS_ARRANGEMENT.HORIZONTAL
    ) {
      return;
    }
    const ordered = sequenceOrderedNotesRef.current;
    if (!ordered.length) return;
    const getSize = (id) => {
      const r = cardRectsRef.current[id];
      return r && typeof r.w === 'number' && typeof r.h === 'number' ? { w: r.w, h: r.h } : null;
    };
    const align = autoFocusAlignRef.current;
    /** Wide corridor only for hub spokes; chain / no lines keep focus beside the stack. */
    const focusPeerSpacing =
      connectorMode === CANVAS_CONNECTOR_MODE.FOCUS_TO_CHILDREN ? 'wide' : 'compact';
    const snapOpts = {
      minHeightForNoteId: layoutMinHeightForNoteId,
      focusPeerSpacing,
      wrapAfter: autoArrangementWrapAfterRef.current,
    };
    const computed =
      canvasArrangement === CANVAS_ARRANGEMENT.VERTICAL
        ? computeCanvasVerticalArrangementRects(ordered, getSize, align, snapOpts)
        : computeCanvasHorizontalArrangementRects(ordered, getSize, align, snapOpts);
    setCardRects((prev) => ({ ...prev, ...computed }));
    scheduleSaveRef.current();
  }, [
    canvasArrangement,
    connectorMode,
    autoFocusAlign,
    autoArrangementWrapAfter,
    sequenceLayoutKey,
    layoutMinHeightForNoteId,
  ]);

  useEffect(() => {
    const block = canvasLayouts[String(layoutStorageKey)]?.[fk];
    const v = resolveCanvasView(block, isCanvasMobileViewport);
    setScale(v.scale);
    setTx(v.tx);
    setTy(v.ty);
  }, [layoutStorageKey, fk, canvasLayouts, isCanvasMobileViewport]);

  useEffect(() => {
    const block = canvasLayouts[String(layoutStorageKey)]?.[fk];
    const p = resolveCanvasBlockPrefs(block || {});
    setCanvasArrangement(p.canvasArrangement);
    setConnectorMode(p.connectorMode);
    setManualNewNoteAnchor(p.manualNewNoteAnchor);
    setAutoFocusAlign(p.autoFocusAlign);
    setAutoArrangementWrapAfter(p.autoArrangementWrapAfter ?? 0);
    setManualConnections(p.manualConnections ?? []);
  }, [layoutStorageKey, fk, canvasLayouts]);

  useEffect(() => {
    if (!sequenceMenuOpen) return;
    const block = canvasLayouts[String(layoutStorageKey)]?.[fk];
    const p = resolveCanvasBlockPrefs(block || {});
    setDraftArrangement(p.canvasArrangement);
    setDraftConnector(p.connectorMode);
    setDraftManualNewNoteAnchor(p.manualNewNoteAnchor);
    setDraftAutoFocusAlign(p.autoFocusAlign);
    setDraftAutoArrangementWrapAfter(p.autoArrangementWrapAfter ?? 0);
  }, [sequenceMenuOpen, layoutStorageKey, fk, canvasLayouts]);

  useEffect(() => {
    const block = canvasLayouts[String(layoutStorageKey)]?.[fk];
    const sd = block?.starredDock;
    if (
      sd &&
      typeof sd === 'object' &&
      typeof sd.top === 'number' &&
      typeof sd.right === 'number' &&
      Number.isFinite(sd.top) &&
      Number.isFinite(sd.right)
    ) {
      setStarredDockPos({ top: sd.top, right: sd.right });
    } else {
      setStarredDockPos(null);
    }
  }, [layoutStorageKey, fk, canvasLayouts]);

  /** Saves cards, pan/zoom, and line/layout prefs (arrangement, connector mode, anchors, focus align) for this thread/focus. */
  const persistCanvasLayoutNow = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const tid = layoutStorageKeyRef.current;
    const focusKey = fkRef.current;
    const cards = { ...cardRectsRef.current };
    const curRaw = canvasLayoutsRef.current[tid]?.[focusKey];
    const curBlock = curRaw && typeof curRaw === 'object' ? curRaw : {};
    const showSeq =
      canvasArrangementRef.current !== CANVAS_ARRANGEMENT.MANUAL &&
      connectorModeRef.current !== CANVAS_CONNECTOR_MODE.NONE;
    const pos = {
      scale: scaleRef.current,
      tx: txRef.current,
      ty: tyRef.current,
      showSequenceLines: showSeq,
    };
    const mobile = isCanvasMobileViewportRef.current;
    const partial = { cards };
    if (mobile) {
      partial.viewMobile = pos;
      partial.view = { ...(curBlock.view || {}), showSequenceLines: pos.showSequenceLines };
    } else {
      partial.view = pos;
      partial.viewMobile = { ...(curBlock.viewMobile || {}), showSequenceLines: pos.showSequenceLines };
    }
    if (starredDockPosRef.current != null) {
      partial.starredDock = {
        top: starredDockPosRef.current.top,
        right: starredDockPosRef.current.right,
      };
    }
    partial.canvasArrangement = canvasArrangementRef.current;
    partial.connectorMode = connectorModeRef.current;
    partial.manualNewNoteAnchor = manualNewNoteAnchorRef.current;
    partial.autoFocusAlign = autoFocusAlignRef.current;
    partial.autoArrangementWrapAfter = autoArrangementWrapAfterRef.current;
    partial.manualConnections = filterManualConnectionsForVisibleNotes(
      manualConnectionsRef.current,
      new Set(Object.keys(cards))
    );
    const patchLayouts = mergeCanvasLayoutPatch(canvasLayoutsRef.current, tid, focusKey, partial);
    try {
      await patchUserSettings({ canvasLayouts: patchLayouts });
      setCanvasLayouts(patchLayouts);
    } catch (e) {
      console.error(e);
    }
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persistCanvasLayoutNow();
    }, SAVE_DEBOUNCE_MS);
  }, [persistCanvasLayoutNow]);

  useEffect(() => {
    const onHidden = () => {
      void persistCanvasLayoutNow();
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') onHidden();
    };
    window.addEventListener('pagehide', onHidden);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', onHidden);
      document.removeEventListener('visibilitychange', onVis);
      void persistCanvasLayoutNow();
    };
  }, [persistCanvasLayoutNow]);

  scaleRef.current = scale;
  txRef.current = tx;
  tyRef.current = ty;
  starredDockPosRef.current = starredDockPos;
  isCanvasMobileViewportRef.current = isCanvasMobileViewport;
  scheduleSaveRef.current = scheduleSave;

  useEffect(() => {
    if (!zoomFieldFocused) {
      setZoomPercentStr(String(Math.round(scale * 100)));
    }
  }, [scale, zoomFieldFocused]);

  const zoomByFactor = useCallback(
    (factor) => {
      const vp = viewportRef.current;
      if (!vp) return;
      const { width: vw, height: vh } = vp.getBoundingClientRect();
      const cx = vw / 2;
      const cy = vh / 2;
      setScale((s) => {
        const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s * factor));
        const f = next / s;
        setTx((t) => cx - f * (cx - t));
        setTy((t) => cy - f * (cy - t));
        return next;
      });
      scheduleSave();
    },
    [scheduleSave]
  );

  const applyZoomPercentField = useCallback(() => {
    const raw = zoomPercentStr.replace(/%/g, '').trim();
    const pct = parseFloat(raw);
    if (!Number.isFinite(pct)) {
      setZoomPercentStr(String(Math.round(scale * 100)));
      return;
    }
    const clampedPct = Math.min(400, Math.max(20, Math.round(pct)));
    const next = clampedPct / 100;
    const vp = viewportRef.current;
    if (!vp) {
      setScale(next);
      setZoomPercentStr(String(clampedPct));
      scheduleSave();
      return;
    }
    const { width: vw, height: vh } = vp.getBoundingClientRect();
    const cx = vw / 2;
    const cy = vh / 2;
    setScale((s) => {
      const f = next / s;
      setTx((t) => cx - f * (cx - t));
      setTy((t) => cy - f * (cy - t));
      return next;
    });
    setZoomPercentStr(String(clampedPct));
    scheduleSave();
  }, [zoomPercentStr, scale, scheduleSave]);

  const fitAllCardsInView = useCallback(() => {
    const vp = viewportRef.current;
    const notes = canvasNotes;
    if (!vp || !notes.length) return;
    const rects = cardRectsRef.current;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of notes) {
      const r = rects[String(n.id)];
      if (!r) return;
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.w);
      maxY = Math.max(maxY, r.y + r.h);
    }
    const bw = Math.max(maxX - minX, 1);
    const bh = Math.max(maxY - minY, 1);
    const { width: vw, height: vh } = vp.getBoundingClientRect();
    const pad = 40;
    const fitW = (vw - pad * 2) / bw;
    const fitH = (vh - pad * 2) / bh;
    let nextScale = Math.min(fitW, fitH, FIT_CONTENT_VIEW_MAX_SCALE);
    if (!Number.isFinite(nextScale) || nextScale <= 0) nextScale = 1;
    nextScale = Math.max(0.2, nextScale);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setScale(nextScale);
    setTx(vw / 2 - cx * nextScale);
    setTy(vh / 2 - cy * nextScale);
  }, [canvasNotes]);

  /** Fit everything when there is no saved card layout yet, or after explicit reset. */
  useEffect(() => {
    const vk = `${layoutStorageKey}|${fk}`;
    if (canvasViewKeyRef.current !== vk) {
      canvasViewKeyRef.current = vk;
      fitAppliedForEmptyRef.current = false;
    }

    if (loadingThread || !canvasNotes.length) return;
    if (!viewportRef.current) return;
    if (canvasNotes.some((n) => !cardRects[String(n.id)])) return;

    const emptySaved = savedCardsLayoutSig === '{}' || savedCardsLayoutSig === 'null';
    if (!emptySaved && !pendingFitAllRef.current) {
      fitAppliedForEmptyRef.current = false;
      return;
    }
    if (fitAppliedForEmptyRef.current && !pendingFitAllRef.current) return;

    if (pendingFitAllRef.current) pendingFitAllRef.current = false;
    fitAppliedForEmptyRef.current = true;

    fitAllCardsInView();
    scheduleSaveRef.current();
  }, [
    loadingThread,
    canvasNotes,
    cardRects,
    savedCardsLayoutSig,
    layoutStorageKey,
    fk,
    fitAllCardsInView,
  ]);

  const handleWheelNative = useCallback(
    (e) => {
      if (!viewportRef.current) return;
      const root = viewportRef.current;
      if (!(e.ctrlKey || e.metaKey)) {
        const wheelEl = pointerEventTargetElement(e) ?? e.target;
        if (wheelEventShouldScrollNestedTarget(wheelEl, root, e.deltaX, e.deltaY)) {
          return;
        }
      }
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        const delta = -e.deltaY * WHEEL_ZOOM_SENS;
        setScale((s) => {
          const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s + delta));
          const f = next / s;
          setTx((t) => cx - f * (cx - t));
          setTy((t) => cy - f * (cy - t));
          return next;
        });
        scheduleSave();
      } else {
        setTx((t) => t - e.deltaX);
        setTy((t) => t - e.deltaY);
        scheduleSave();
      }
    },
    [scheduleSave]
  );

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.addEventListener('wheel', handleWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', handleWheelNative);
  }, [handleWheelNative, loadingThread, thread.length]);

  const onViewportPointerMoveGlobal = useCallback((e) => {
    pointerMoveInnerRef.current(e);
  }, []);

  const onViewportPointerUpGlobal = useCallback((e) => {
    pointerUpInnerRef.current(e);
  }, []);

  const detachViewportPointerTracking = useCallback(() => {
    if (!viewportPointerTrackingRef.current) return;
    viewportPointerTrackingRef.current = false;
    window.removeEventListener('pointermove', onViewportPointerMoveGlobal);
    window.removeEventListener('pointerup', onViewportPointerUpGlobal);
    window.removeEventListener('pointercancel', onViewportPointerUpGlobal);
  }, [onViewportPointerMoveGlobal, onViewportPointerUpGlobal]);

  const attachViewportPointerTracking = useCallback(() => {
    if (viewportPointerTrackingRef.current) return;
    viewportPointerTrackingRef.current = true;
    window.addEventListener('pointermove', onViewportPointerMoveGlobal, { passive: false });
    window.addEventListener('pointerup', onViewportPointerUpGlobal);
    window.addEventListener('pointercancel', onViewportPointerUpGlobal);
  }, [onViewportPointerMoveGlobal, onViewportPointerUpGlobal]);

  const onViewportPointerDown = useCallback(
    (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const hit = pointerEventTargetElement(e);
      if (hit?.closest('.canvas-card-frame')) return;
      const el = viewportRef.current;
      if (!el) return;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const wasEmpty = viewportPointersRef.current.size === 0;
      viewportPointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const m = viewportPointersRef.current;
      if (m.size === 2) {
        panSessionRef.current = null;
        const pts = [...m.values()];
        const d = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        pinchSessionRef.current = {
          startDist: Math.max(d, 1e-6),
          startScale: scaleRef.current,
        };
      } else if (m.size === 1) {
        pinchSessionRef.current = null;
        panSessionRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          startTx: txRef.current,
          startTy: tyRef.current,
        };
      }
      if (wasEmpty) attachViewportPointerTracking();
    },
    [attachViewportPointerTracking]
  );

  useEffect(() => {
    return () => {
      detachViewportPointerTracking();
      viewportPointersRef.current.clear();
    };
  }, [detachViewportPointerTracking]);

  const refreshThread = useCallback(() => {
    if (!threadRootId) {
      return getRoots(false).then(setThread).catch(() => {});
    }
    return getThread(threadRootId, false).then(setThread).catch(() => {});
  }, [threadRootId]);

  const handleMergeNoteIntoAbove = useCallback(
    async (note, aboveNoteId) => {
      const childIds = thread
        .filter((row) => row.parent_id != null && noteIdEq(row.parent_id, note.id))
        .map((row) => row.id);
      await mergeNoteIntoSiblingAbove(String(aboveNoteId), String(note.id), childIds);
      await refreshThread();
    },
    [thread, refreshThread]
  );

  const handleOpenMoveNote = useCallback((note) => {
    setMoveNoteTarget(note);
  }, []);

  const applyFocus = useCallback(
    async (id) => {
      await persistCanvasLayoutNow();
      if (!threadRootId) {
        setFocusId(id);
        return;
      }
      const layoutTarget = id && !noteIdEq(id, threadRootId) ? String(id) : null;
      flushSync(() => {
        setCanvasLayoutFkOverride(layoutTarget);
        setFocusId(id);
        if (id && !noteIdEq(id, threadRootId)) {
          setSearchParams({ thread: threadRootId, focus: id });
        } else {
          setSearchParams({ thread: threadRootId });
        }
      });
    },
    [threadRootId, setSearchParams, persistCanvasLayoutNow]
  );

  const handleCalendarPick = useCallback(
    async (ev) => {
      const titleRaw = typeof ev?.title === 'string' ? ev.title.trim() : '';
      const baseTitle = titleRaw || '(untitled event)';
      const feedLabel = typeof ev?.feedName === 'string' ? ev.feedName.trim() : '';
      const title = feedLabel ? `${baseTitle} (${feedLabel})` : baseTitle;
      const descRaw = typeof ev?.description === 'string' ? ev.description : '';
      const description = descRaw.replace(/\s+/g, ' ').trim();
      const attendees = Array.isArray(ev?.attendees) ? ev.attendees : [];
      const detail = buildCalendarEventDetailNoteContent(description, attendees);
      const where = threadRootId ? 'in this thread' : 'as a new thread';
      if (!window.confirm(`Create an event note for “${title}” ${where}?`)) return;
      const f = calendarFeedPickToComposeFields(ev);
      const meta = eventFieldsToPayload('event', {
        startDate: f.startDate,
        startTime: f.startTime,
        endDate: f.endDate,
        endTime: f.endTime,
      });
      if (meta.error) {
        window.alert(meta.error);
        return;
      }
      if (submitting) return;
      setSubmitting(true);
      try {
        const note = threadRootId
          ? await createNote({ content: title, parent_id: replyParentId, ...meta })
          : await createNote({ content: title, ...meta });
        await syncConnectionsFromContent(note.id, title, '');
        await syncTagsFromContent(note.id, title, [], '');
        if (detail) {
          const child = await createNote({
            content: detail,
            parent_id: note.id,
            note_type: 'note',
          });
          await syncConnectionsFromContent(child.id, detail, '');
          await syncTagsFromContent(child.id, detail, [], '');
        }
        if (threadRootId) {
          await refreshThread();
          await applyFocus(note.id);
        } else {
          const full = {
            ...note,
            reply_count: note.reply_count ?? 0,
            descendant_count: note.descendant_count ?? 0,
            connection_count: note.connection_count ?? 0,
            attachments: note.attachments || [],
          };
          await persistCanvasLayoutNow();
          setThread((prev) => [full, ...prev.filter((x) => x.id !== full.id)]);
          setFocusId(null);
          setSearchParams({ thread: String(full.id) });
        }
      } catch (err) {
        console.error(err);
        window.alert(err?.message || 'Could not create event note');
      } finally {
        setSubmitting(false);
      }
    },
    [
      submitting,
      threadRootId,
      replyParentId,
      refreshThread,
      applyFocus,
      setSearchParams,
      persistCanvasLayoutNow,
    ]
  );

  const upOneLevel = useCallback(async () => {
    if (!threadRootId || !focusId || noteIdEq(focusId, actualRootId)) return;
    const p = parentInFilteredTree(tree, focusId);
    if (!p) {
      await persistCanvasLayoutNow();
      flushSync(() => {
        setCanvasLayoutFkOverride(null);
        setSearchParams({ thread: threadRootId });
        setFocusId(null);
      });
      return;
    }
    if (noteIdEq(p, actualRootId)) {
      await persistCanvasLayoutNow();
      flushSync(() => {
        setCanvasLayoutFkOverride(null);
        setSearchParams({ thread: threadRootId });
        setFocusId(null);
      });
    } else {
      await applyFocus(p);
    }
  }, [threadRootId, focusId, actualRootId, tree, setSearchParams, applyFocus, persistCanvasLayoutNow]);

  /** Clear thread/focus but stay on Canvas (all threads view). */
  const goToCanvasRoot = useCallback(async () => {
    await persistCanvasLayoutNow();
    flushSync(() => {
      setCanvasLayoutFkOverride(undefined);
      setSearchParams({});
      setFocusId(null);
    });
  }, [setSearchParams, persistCanvasLayoutNow]);

  const makeOpenThread = useCallback(
    (noteId) => async () => {
      if (!threadRootId) {
        await persistCanvasLayoutNow();
        setSearchParams({ thread: String(noteId) });
        return;
      }
      await applyFocus(noteId);
    },
    [threadRootId, setSearchParams, applyFocus, persistCanvasLayoutNow]
  );

  const onGoToNote = useCallback(
    async ({ noteId, threadRootId: root }) => {
      await persistCanvasLayoutNow();
      setSearchParams({ thread: root, focus: noteId });
    },
    [setSearchParams, persistCanvasLayoutNow]
  );

  const applyCanvasSequence = useCallback(async () => {
    if (
      !window.confirm(
        'This may change where notes appear on the canvas depending on your choices. Continue?'
      )
    ) {
      return;
    }
    const tid = layoutStorageKeyRef.current;
    const focusKey = fkRef.current;
    const ordered = sequenceOrderedNotesRef.current;
    const getSize = (id) => {
      const r = cardRectsRef.current[id];
      return r && typeof r.w === 'number' && typeof r.h === 'number' ? { w: r.w, h: r.h } : null;
    };
    const effectiveConnector =
      draftArrangement === CANVAS_ARRANGEMENT.MANUAL
        ? CANVAS_CONNECTOR_MODE.NONE
        : draftConnector;
    const snapOpts = {
      minHeightForNoteId: layoutMinHeightForNoteId,
      focusPeerSpacing:
        effectiveConnector === CANVAS_CONNECTOR_MODE.FOCUS_TO_CHILDREN ? 'wide' : 'compact',
      wrapAfter: draftAutoArrangementWrapAfter,
    };
    let nextCards = { ...cardRectsRef.current };
    if (draftArrangement === CANVAS_ARRANGEMENT.VERTICAL) {
      const computed = computeCanvasVerticalArrangementRects(ordered, getSize, draftAutoFocusAlign, snapOpts);
      nextCards = { ...nextCards, ...computed };
    } else if (draftArrangement === CANVAS_ARRANGEMENT.HORIZONTAL) {
      const computed = computeCanvasHorizontalArrangementRects(ordered, getSize, draftAutoFocusAlign, snapOpts);
      nextCards = { ...nextCards, ...computed };
    }

    cardRectsRef.current = nextCards;
    canvasArrangementRef.current = draftArrangement;
    connectorModeRef.current = effectiveConnector;
    manualNewNoteAnchorRef.current = draftManualNewNoteAnchor;
    autoFocusAlignRef.current = draftAutoFocusAlign;
    autoArrangementWrapAfterRef.current = draftAutoArrangementWrapAfter;

    setCardRects(nextCards);
    setCanvasArrangement(draftArrangement);
    setConnectorMode(effectiveConnector);
    setManualNewNoteAnchor(draftManualNewNoteAnchor);
    setAutoFocusAlign(draftAutoFocusAlign);
    setAutoArrangementWrapAfter(draftAutoArrangementWrapAfter);
    setSequenceMenuOpen(false);
    pendingFitAllRef.current = true;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const curRaw = canvasLayoutsRef.current[tid]?.[focusKey];
    const curBlock = curRaw && typeof curRaw === 'object' ? curRaw : {};
    const linesOn = effectiveConnector !== CANVAS_CONNECTOR_MODE.NONE;
    const pos = {
      scale: scaleRef.current,
      tx: txRef.current,
      ty: tyRef.current,
      showSequenceLines: linesOn,
    };
    const mobile = isCanvasMobileViewportRef.current;
    const partial = {
      cards: nextCards,
      canvasArrangement: draftArrangement,
      connectorMode: effectiveConnector,
      manualNewNoteAnchor: draftManualNewNoteAnchor,
      autoFocusAlign: draftAutoFocusAlign,
      autoArrangementWrapAfter: draftAutoArrangementWrapAfter,
      manualConnections: filterManualConnectionsForVisibleNotes(
        manualConnectionsRef.current,
        new Set(Object.keys(nextCards))
      ),
    };
    if (mobile) {
      partial.viewMobile = pos;
      partial.view = { ...(curBlock.view || {}), showSequenceLines: linesOn };
    } else {
      partial.view = pos;
      partial.viewMobile = { ...(curBlock.viewMobile || {}), showSequenceLines: linesOn };
    }
    if (starredDockPosRef.current != null) {
      partial.starredDock = {
        top: starredDockPosRef.current.top,
        right: starredDockPosRef.current.right,
      };
    }
    const patchLayouts = mergeCanvasLayoutPatch(canvasLayoutsRef.current, tid, focusKey, partial);
    try {
      await patchUserSettings({ canvasLayouts: patchLayouts });
      setCanvasLayouts(patchLayouts);
    } catch (e) {
      console.error(e);
    }
  }, [
    draftArrangement,
    draftConnector,
    draftManualNewNoteAnchor,
    draftAutoFocusAlign,
    draftAutoArrangementWrapAfter,
    layoutMinHeightForNoteId,
  ]);

  const resetCanvasLayout = useCallback(async () => {
    if (
      !window.confirm(
        'Clear saved card positions and view (zoom/pan) for this canvas? Starred notes are not changed.'
      )
    ) {
      return;
    }
    const tid = layoutStorageKey;
    const focusKey = fk;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const emptyBlock = {
      view: { scale: 1, tx: 0, ty: 0, showSequenceLines: true },
      viewMobile: { scale: 1, tx: 0, ty: 0, showSequenceLines: true },
      cards: {},
      canvasArrangement: CANVAS_ARRANGEMENT.MANUAL,
      connectorMode: CANVAS_CONNECTOR_MODE.THREAD_CHAIN,
      manualNewNoteAnchor: CANVAS_MANUAL_NEW_NOTE_ANCHOR.FOCUS,
      autoFocusAlign: CANVAS_AUTO_FOCUS_ALIGN.CENTER,
      autoArrangementWrapAfter: 0,
      manualConnections: [],
    };
    const patchLayouts = replaceCanvasLayoutFocusBlock(
      canvasLayoutsRef.current,
      tid,
      focusKey,
      emptyBlock
    );
    try {
      await patchUserSettings({ canvasLayouts: patchLayouts });
      pendingFitAllRef.current = true;
      fitAppliedForEmptyRef.current = false;
      setCanvasLayouts(patchLayouts);
      setCanvasArrangement(CANVAS_ARRANGEMENT.MANUAL);
      setConnectorMode(CANVAS_CONNECTOR_MODE.THREAD_CHAIN);
      setManualNewNoteAnchor(CANVAS_MANUAL_NEW_NOTE_ANCHOR.FOCUS);
      setAutoFocusAlign(CANVAS_AUTO_FOCUS_ALIGN.CENTER);
      setAutoArrangementWrapAfter(0);
      setManualConnections([]);
      canvasArrangementRef.current = CANVAS_ARRANGEMENT.MANUAL;
      connectorModeRef.current = CANVAS_CONNECTOR_MODE.THREAD_CHAIN;
      manualNewNoteAnchorRef.current = CANVAS_MANUAL_NEW_NOTE_ANCHOR.FOCUS;
      autoFocusAlignRef.current = CANVAS_AUTO_FOCUS_ALIGN.CENTER;
      autoArrangementWrapAfterRef.current = 0;
      manualConnectionsRef.current = [];
      setStarredDockPos(null);
    } catch (e) {
      console.error(e);
    }
  }, [layoutStorageKey, fk]);

  const handleCanvasReply = async (e) => {
    e.preventDefault();
    if (!threadRootId || !replyParentId) return;
    const text = replyContent.trim();
    if ((!text && pendingReplyFiles.length === 0) || submitting) return;
    const meta = eventFieldsToPayload(composeNoteType, {
      startDate: composeStartDate,
      startTime: composeStartTime,
      endDate: composeEndDate,
      endTime: composeEndTime,
    });
    if (meta.error) {
      console.error(meta.error);
      return;
    }
    setSubmitting(true);
    try {
      const note = await createNote({ content: text, parent_id: replyParentId, ...meta });
      await syncConnectionsFromContent(note.id, text, '');
      await syncTagsFromContent(note.id, text, [], '');
      if (pendingReplyFiles.length > 0) await uploadNoteFiles(note.id, pendingReplyFiles);
      setReplyContent('');
      setComposeExpanded(false);
      setPendingReplyFiles([]);
      resetComposeMeta();
      if (canvasReplyFileRef.current) canvasReplyFileRef.current.value = '';
      refreshThread();
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCanvasNewRoot = async (e) => {
    e.preventDefault();
    const text = newRootContent.trim();
    if ((!text && pendingRootFiles.length === 0) || submitting) return;
    const meta = eventFieldsToPayload(composeNoteType, {
      startDate: composeStartDate,
      startTime: composeStartTime,
      endDate: composeEndDate,
      endTime: composeEndTime,
    });
    if (meta.error) {
      console.error(meta.error);
      return;
    }
    setSubmitting(true);
    try {
      const note = await createNote({ content: text, ...meta });
      await syncConnectionsFromContent(note.id, text, '');
      await syncTagsFromContent(note.id, text, [], '');
      if (pendingRootFiles.length > 0) await uploadNoteFiles(note.id, pendingRootFiles);
      const full =
        pendingRootFiles.length > 0
          ? await getNote(note.id)
          : {
              ...note,
              reply_count: note.reply_count ?? 0,
              descendant_count: note.descendant_count ?? 0,
              connection_count: note.connection_count ?? 0,
              attachments: note.attachments || [],
            };
      setNewRootContent('');
      setComposeExpanded(false);
      setPendingRootFiles([]);
      resetComposeMeta();
      if (canvasRootFileRef.current) canvasRootFileRef.current.value = '';
      await persistCanvasLayoutNow();
      setThread((prev) => [full, ...prev.filter((x) => x.id !== full.id)]);
      setFocusId(null);
      setSearchParams({ thread: String(full.id) });
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  /** Drag from anywhere on the card (not just a strip). Uses a small move threshold so clicks / insight still work. */
  const onCanvasCardPointerDown = useCallback(
    (noteId, e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (isCanvasDragInteractiveTarget(e.target)) return;

      const id = String(noteId);
      const startRect = cardRectsRef.current[id];
      if (!startRect) return;

      const ox = e.clientX;
      const oy = e.clientY;
      const base = { ...startRect };
      const frameEl = e.currentTarget;
      const DRAG_THRESHOLD_PX = 5;
      let dragging = false;
      setSnapGuides({ vx: [], hy: [] });

      const move = (ev) => {
        if (!dragging) {
          if (Math.hypot(ev.clientX - ox, ev.clientY - oy) < DRAG_THRESHOLD_PX) return;
          dragging = true;
          try {
            frameEl.setPointerCapture(ev.pointerId);
          } catch {
            /* ignore */
          }
        }
        const sc = Math.max(scaleRef.current, 1e-6);
        const dx = (ev.clientX - ox) / sc;
        const dy = (ev.clientY - oy) / sc;
        const rawX = base.x + dx;
        const rawY = base.y + dy;
        const snapTh = Math.max(
          SNAP_GUIDE_SCREEN_PX / Math.max(scaleRef.current, 1e-6),
          SNAP_GUIDE_WORLD_MIN
        );
        const others = Object.entries(cardRectsRef.current)
          .filter(([oid]) => oid !== id)
          .map(([, r]) => r)
          .filter(
            (r) =>
              r &&
              typeof r.x === 'number' &&
              typeof r.y === 'number' &&
              typeof r.w === 'number' &&
              typeof r.h === 'number'
          );
        const sx = snapCanvasAxis('x', rawX, base.w, others, snapTh);
        const sy = snapCanvasAxis('y', rawY, base.h, others, snapTh);
        setSnapGuides({
          vx: uniqSnapLines([...sx.vx, ...sy.vx]),
          hy: uniqSnapLines([...sx.hy, ...sy.hy]),
        });
        setCardRects((prev) => ({
          ...prev,
          [id]: { ...base, x: sx.pos, y: sy.pos },
        }));
      };

      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        setSnapGuides({ vx: [], hy: [] });
        try {
          if (dragging && frameEl.releasePointerCapture) {
            frameEl.releasePointerCapture(ev.pointerId);
          }
        } catch {
          /* ignore */
        }
        if (dragging) {
          scheduleSave();
          const swallowClick = (ce) => {
            ce.preventDefault();
            ce.stopPropagation();
          };
          document.addEventListener('click', swallowClick, { capture: true, once: true });
        }
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [scheduleSave]
  );

  const startResize = useCallback(
    (noteId, e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = String(noteId);
      const start = cardRectsRef.current[id];
      if (!start) return;
      const ox = e.clientX;
      const oy = e.clientY;
      const base = { ...start };
      setSnapGuides({ vx: [], hy: [] });
      const othersOf = () =>
        Object.entries(cardRectsRef.current)
          .filter(([oid]) => oid !== id)
          .map(([, r]) => r)
          .filter(
            (r) =>
              r &&
              typeof r.x === 'number' &&
              typeof r.y === 'number' &&
              typeof r.w === 'number' &&
              typeof r.h === 'number'
          );
      const move = (ev) => {
        const sc = Math.max(scaleRef.current, 1e-6);
        const dx = (ev.clientX - ox) / sc;
        const dy = (ev.clientY - oy) / sc;
        const snapTh = Math.max(SNAP_GUIDE_SCREEN_PX / sc, SNAP_GUIDE_WORLD_MIN);
        const snapped = snapResizeBottomRight(base, dx, dy, othersOf(), MIN_W, MIN_H, snapTh);
        setSnapGuides(snapped.guides);
        setCardRects((prev) => ({
          ...prev,
          [id]: {
            ...base,
            x: base.x,
            y: base.y,
            w: snapped.w,
            h: snapped.h,
          },
        }));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        setSnapGuides({ vx: [], hy: [] });
        scheduleSave();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    },
    [scheduleSave]
  );

  const starredOnCanvas = useMemo(
    () => canvasNotes.filter((n) => n.starred),
    [canvasNotes]
  );

  const zoomToCard = useCallback(
    (noteId) => {
      const id = String(noteId);
      const r = cardRects[id];
      const vp = viewportRef.current;
      if (!r || !vp) return;
      const { width: vw, height: vh } = vp.getBoundingClientRect();
      const pad = 40;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const fitW = (vw - pad * 2) / r.w;
      const fitH = (vh - pad * 2) / r.h;
      let nextScale = Math.min(fitW, fitH, FIT_CONTENT_VIEW_MAX_SCALE);
      if (!Number.isFinite(nextScale) || nextScale <= 0) nextScale = 1;
      nextScale = Math.max(0.2, nextScale);
      setScale(nextScale);
      setTx(vw / 2 - cx * nextScale);
      setTy(vh / 2 - cy * nextScale);
      scheduleSave();
    },
    [cardRects, scheduleSave]
  );

  const unstarFromDock = useCallback(
    async (noteId) => {
      try {
        await unstarNote(noteId);
        refreshThread();
      } catch (e) {
        console.error(e);
      }
    },
    [refreshThread]
  );

  const onStarredDockDragPointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const aside = e.currentTarget.closest('.canvas-starred-dock');
    if (!aside) return;
    const rect = aside.getBoundingClientRect();
    const originTop = starredDockPosRef.current?.top ?? rect.top;
    const originRight = starredDockPosRef.current?.right ?? window.innerWidth - rect.right;
    const session = {
      startX: e.clientX,
      startY: e.clientY,
      originTop,
      originRight,
      w: rect.width,
      h: rect.height,
    };
    const onMove = (ev) => {
      const dx = ev.clientX - session.startX;
      const dy = ev.clientY - session.startY;
      const m = 6;
      let top = session.originTop + dy;
      let right = session.originRight - dx;
      const maxT = window.innerHeight - session.h - m;
      const maxR = window.innerWidth - session.w - m;
      top = Math.min(maxT, Math.max(m, top));
      right = Math.min(maxR, Math.max(m, right));
      setStarredDockPos({ top, right });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      scheduleSaveRef.current();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const viewportClientToWorld = useCallback((clientX, clientY) => {
    const vp = viewportRef.current;
    if (!vp) return null;
    const r = vp.getBoundingClientRect();
    const x = (clientX - r.left - txRef.current) / scaleRef.current;
    const y = (clientY - r.top - tyRef.current) / scaleRef.current;
    return { x, y };
  }, []);

  const removeManualConnectionByKey = useCallback((key) => {
    if (!window.confirm('Remove this arrow?')) return;
    setManualConnections((prev) => prev.filter((edge) => manualConnectionKey(edge) !== key));
    scheduleSaveRef.current();
  }, []);

  const onManualConnectorHitPointerDown = useCallback(
    (e, seg) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.stopPropagation();
      const sx = e.clientX;
      const sy = e.clientY;
      const onUp = (ev) => {
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 10) return;
        removeManualConnectionByKey(seg.key);
      };
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [removeManualConnectionByKey]
  );

  const startBendDrag = useCallback(
    (e, seg) => {
      if (canvasArrangementRef.current !== CANVAS_ARRANGEMENT.MANUAL) return;
      e.stopPropagation();
      e.preventDefault();
      const key = seg.key;
      const fromId = seg.fromId;
      const toId = seg.toId;
      setBendDragEdgeKey(key);
      const onMove = (ev) => {
        const ra = cardRectsRef.current[fromId];
        const rb = cardRectsRef.current[toId];
        if (!ra || !rb) return;
        const wp = viewportClientToWorld(ev.clientX, ev.clientY);
        if (!wp) return;
        const cur = manualConnectionsRef.current.find((ed) => manualConnectionKey(ed) === key);
        let { bendT, bendN } = resolveManualEdgeBends(cur || {});
        for (let iter = 0; iter < 10; iter++) {
          const chord = manualConnectorChord(ra, rb, bendT, bendN);
          const p0 = { x: chord.x1, y: chord.y1 };
          const p2 = { x: chord.x2, y: chord.y2 };
          const { mx, my, tx, ty, nx, ny } = chordBasisWorld(p0, p2);
          const dx = wp.x - mx;
          const dy = wp.y - my;
          const nextT = Math.min(
            MANUAL_EDGE_BEND_LIMIT,
            Math.max(-MANUAL_EDGE_BEND_LIMIT, (dx * tx + dy * ty) / 2)
          );
          const nextN = Math.min(
            MANUAL_EDGE_BEND_LIMIT,
            Math.max(-MANUAL_EDGE_BEND_LIMIT, (dx * nx + dy * ny) / 2)
          );
          if (Math.abs(nextT - bendT) < 1e-4 && Math.abs(nextN - bendN) < 1e-4) {
            bendT = nextT;
            bendN = nextN;
            break;
          }
          bendT = nextT;
          bendN = nextN;
        }
        setManualConnections((prev) =>
          prev.map((ed) =>
            manualConnectionKey(ed) === key ? { ...ed, bendT, bendN, bend: bendN } : ed
          )
        );
      };
      const onUp = () => {
        setBendDragEdgeKey(null);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        scheduleSaveRef.current();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [viewportClientToWorld]
  );

  const startManualLinkDrag = useCallback(
    (e, noteId, side) => {
      if (canvasArrangementRef.current !== CANVAS_ARRANGEMENT.MANUAL) return;
      e.stopPropagation();
      e.preventDefault();
      const id = String(noteId);
      const rect = cardRectsRef.current[id];
      if (!rect) return;
      manualLinkDragSessionRef.current = { fromId: id, fromSide: side };
      const p1 = sideMidpoint(rect, side);
      const w0 = viewportClientToWorld(e.clientX, e.clientY);
      setManualLinkRubber(
        w0 ? { x1: p1.x, y1: p1.y, x2: w0.x, y2: w0.y } : null
      );
      const onMove = (ev) => {
        const s = manualLinkDragSessionRef.current;
        if (!s) return;
        const rr = cardRectsRef.current[s.fromId];
        if (!rr) return;
        const p = sideMidpoint(rr, s.fromSide);
        const w = viewportClientToWorld(ev.clientX, ev.clientY);
        if (!w) return;
        setManualLinkRubber({ x1: p.x, y1: p.y, x2: w.x, y2: w.y });
      };
      const onUp = (ev) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        const s = manualLinkDragSessionRef.current;
        manualLinkDragSessionRef.current = null;
        setManualLinkRubber(null);
        if (!s) return;
        const els = document.elementsFromPoint(ev.clientX, ev.clientY);
        let handleEl = null;
        for (const el of els) {
          if (!(el instanceof Element)) continue;
          const h = el.closest('[data-canvas-link-handle="true"]');
          if (h) {
            handleEl = h;
            break;
          }
        }
        if (!handleEl) return;
        const toId = handleEl.getAttribute('data-note-id');
        if (!toId) return;
        if (toId === s.fromId) return;
        const nextEdge = { fromId: s.fromId, toId, bendT: 0, bendN: 0, bend: 0 };
        const k = manualConnectionKey(nextEdge);
        setManualConnections((prev) =>
          normalizeManualConnections([
            ...prev.filter((e) => manualConnectionKey(e) !== k),
            nextEdge,
          ])
        );
        scheduleSaveRef.current();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    },
    [viewportClientToWorld]
  );

  const connectorPoints = useMemo(() => {
    if (canvasArrangement === CANVAS_ARRANGEMENT.MANUAL) return [];
    if (connectorMode === CANVAS_CONNECTOR_MODE.NONE) return [];
    const notes = sequenceNotesForCanvas;
    if (notes.length < 2) return [];
    if (connectorMode === CANVAS_CONNECTOR_MODE.FOCUS_TO_CHILDREN) {
      const lead = notes[0];
      const a = cardRects[String(lead.id)];
      if (!a) return [];
      const pts = [];
      for (let i = 1; i < notes.length; i++) {
        const b = cardRects[String(notes[i].id)];
        if (!b) continue;
        if (canvasArrangement === CANVAS_ARRANGEMENT.HORIZONTAL) {
          pts.push(connectorFocusToChildHorizontal(a, b));
        } else if (canvasArrangement === CANVAS_ARRANGEMENT.VERTICAL) {
          pts.push(connectorFocusToChildVertical(a, b));
        } else {
          pts.push(connectorBetweenRects(a, b));
        }
      }
      return pts;
    }
    const pts = [];
    for (let i = 0; i < notes.length - 1; i++) {
      const a = cardRects[String(notes[i].id)];
      const b = cardRects[String(notes[i + 1].id)];
      if (!a || !b) continue;
      pts.push(connectorBetweenRects(a, b));
    }
    return pts;
  }, [canvasArrangement, connectorMode, sequenceNotesForCanvas, cardRects]);

  const onDraftArrangementChange = useCallback((v) => {
    setDraftArrangement(v);
    if (v === CANVAS_ARRANGEMENT.MANUAL || v === CANVAS_ARRANGEMENT.KEEP) {
      setDraftConnector(CANVAS_CONNECTOR_MODE.NONE);
    }
  }, []);

  const manualLinkSegments = useMemo(() => {
    const ids = new Set(sequenceNotesForCanvas.map((n) => String(n.id)));
    const filtered = filterManualConnectionsForVisibleNotes(manualConnections, ids);
    return filtered
      .map((edge) => {
        const ra = cardRects[edge.fromId];
        const rb = cardRects[edge.toId];
        if (!ra || !rb) return null;
        const { bendT, bendN } = resolveManualEdgeBends(edge);
        const chord = manualConnectorChord(ra, rb, bendT, bendN);
        const p0 = { x: chord.x1, y: chord.y1 };
        const p2 = { x: chord.x2, y: chord.y2 };
        const q = quadControlFromChordBends(p0, p2, bendT, bendN);
        const mid = quadCurveMidpoint(p0, q, p2);
        const pathD = `M ${p0.x} ${p0.y} Q ${q.x} ${q.y} ${p2.x} ${p2.y}`;
        const key = manualConnectionKey(edge);
        return {
          ...edge,
          bendT,
          bendN,
          bend: bendN,
          key,
          pathD,
          mid,
          p0,
          p2,
          q,
        };
      })
      .filter(Boolean);
  }, [manualConnections, cardRects, sequenceNotesForCanvas]);

  pointerMoveInnerRef.current = (e) => {
    if (!viewportRef.current) return;
    if (!viewportPointersRef.current.has(e.pointerId)) return;
    viewportPointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const m = viewportPointersRef.current;
    if (m.size === 2 && pinchSessionRef.current) {
      e.preventDefault();
      const pinch = pinchSessionRef.current;
      const pts = [...m.values()];
      const d = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const rect = viewportRef.current.getBoundingClientRect();
      const mx = (pts[0].x + pts[1].x) / 2 - rect.left;
      const my = (pts[0].y + pts[1].y) / 2 - rect.top;
      const stretch = d / pinch.startDist;
      let nextScale = pinch.startScale * stretch ** PINCH_ZOOM_EXP;
      nextScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextScale));
      setScale((s) => {
        const f = nextScale / s;
        setTx((t) => mx - f * (mx - t));
        setTy((t) => my - f * (my - t));
        return nextScale;
      });
      scheduleSaveRef.current();
    } else if (m.size === 1 && panSessionRef.current) {
      const p = panSessionRef.current;
      setTx(p.startTx + (e.clientX - p.startX));
      setTy(p.startTy + (e.clientY - p.startY));
    }
  };

  pointerUpInnerRef.current = (e) => {
    if (!viewportPointersRef.current.has(e.pointerId)) return;
    viewportPointersRef.current.delete(e.pointerId);
    const m = viewportPointersRef.current;
    if (m.size === 1) {
      pinchSessionRef.current = null;
      const pt = [...m.values()][0];
      panSessionRef.current = {
        startX: pt.x,
        startY: pt.y,
        startTx: txRef.current,
        startTy: tyRef.current,
      };
    } else if (m.size === 0) {
      pinchSessionRef.current = null;
      panSessionRef.current = null;
      detachViewportPointerTracking();
      scheduleSaveRef.current();
    }
  };

  const rootNote = thread[0];
  const layoutTitle =
    threadRootId && rootNote
      ? rootNote.content?.slice(0, 40) + (rootNote.content?.length > 40 ? '…' : '')
      : 'Canvas';

  const summaryIds = useMemo(() => collectVisibleNoteIds(displayTree), [displayTree]);

  const openHistoryEntry = useCallback(
    async (it) => {
      if (!it?.noteId) return;
      setHistoryOpen(false);
      await persistCanvasLayoutNow();
      if (it.threadRootId) setSearchParams({ thread: it.threadRootId, focus: it.noteId });
      else setSearchParams({ thread: it.noteId });
      setFocusId(it.noteId);
    },
    [setSearchParams, persistCanvasLayoutNow]
  );

  const historyControl = (
    <div className="stream-page-history-wrap canvas-toolbar-history-wrap">
      <button
        ref={historyBtnRef}
        type="button"
        className="canvas-icon-btn"
        aria-label="History"
        title="History"
        onClick={() => setHistoryOpen((v) => !v)}
      >
        <NavIconHistory className="stream-page-nav-icon" />
      </button>
      {historyOpen && (
        <div ref={historyMenuRef} className="stream-page-history-menu" role="menu" aria-label="Recent notes">
          {noteHistory.length === 0 ? (
            <p className="stream-page-history-empty">No recently visited notes.</p>
          ) : (
            <ul className="stream-page-history-list">
              {noteHistory.map((it) => (
                <li key={it.noteId}>
                  <button type="button" className="stream-page-history-item" onClick={() => openHistoryEntry(it)}>
                    <span className="stream-page-history-title">{historyPrimaryLabel(it.title, it.threadPath)}</span>
                    <span className="stream-page-history-path">{it.threadPath || ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );

  const showCompose = !loadingThread && !(threadRootId && thread.length === 0);

  const navLinks = [
    { to: '/stream', label: 'Stream' },
    { to: '/canvas', label: 'Canvas' },
    { to: '/outline', label: 'Outline' },
    { to: '/calendar', label: 'Calendar' },
    { to: '/search', label: 'Search' },
  ];

  return (
    <Layout title={layoutTitle} noteTypeFilterEnabled onLogout={logout} viewLinks={navLinks}>
      <HoverInsightProvider onNoteUpdated={refreshThread} onGoToNote={onGoToNote}>
        <div className={`canvas-page${showCanvasViewportBg ? ' canvas-page--root-bg' : ''}`}>
          {showCanvasViewportBg ? (
            <StreamThreadImageBackground
              fetchUrl={canvasBackgroundFetchUrl}
              imageOpacity={canvasBackgroundOpacity}
              animate={streamBackgroundAnimate}
              crtEffect={streamBackgroundCrtEffect}
            />
          ) : null}
          <div className="canvas-toolbar">
            <div className="canvas-toolbar-left">
              {focusId && !noteIdEq(focusId, actualRootId) ? (
                <button
                  type="button"
                  className="canvas-icon-btn"
                  onClick={upOneLevel}
                  aria-label="Up one level"
                  title="Up one level"
                >
                  <NavIconUpOneLevel />
                </button>
              ) : null}
              {threadRootId ? (
                <button
                  type="button"
                  className="canvas-icon-btn"
                  onClick={goToCanvasRoot}
                  aria-label="Canvas root — all threads"
                  title="Canvas root — all threads"
                >
                  <NavIconRootLevel />
                </button>
              ) : null}
              {user ? historyControl : null}
              {threadRootId && summaryIds.length > 0 ? (
                <button
                  type="button"
                  className="canvas-icon-btn"
                  onClick={() => setSummaryOpen(true)}
                  aria-label="AI thread summary"
                  title="AI thread summary"
                >
                  <NavIconBrain />
                </button>
              ) : null}
            </div>
            <div className="canvas-toolbar-right">
              <CanvasSequenceMenu
                open={sequenceMenuOpen}
                onOpenToggle={() => setSequenceMenuOpen((o) => !o)}
                onClose={() => setSequenceMenuOpen(false)}
                arrangement={draftArrangement}
                connectorMode={draftConnector}
                linesActive={sequenceMenuLinesActive}
                manualNewNoteAnchor={draftManualNewNoteAnchor}
                autoFocusAlign={draftAutoFocusAlign}
                autoArrangementWrapAfter={draftAutoArrangementWrapAfter}
                onArrangementChange={onDraftArrangementChange}
                onConnectorModeChange={setDraftConnector}
                onManualNewNoteAnchorChange={setDraftManualNewNoteAnchor}
                onAutoFocusAlignChange={setDraftAutoFocusAlign}
                onAutoArrangementWrapAfterChange={setDraftAutoArrangementWrapAfter}
                onApply={applyCanvasSequence}
              >
                <NavIconSequenceLines className="stream-page-nav-icon" />
              </CanvasSequenceMenu>
              <div className="canvas-toolbar-zoom">
                <button
                  type="button"
                  className="canvas-icon-btn canvas-zoom-step"
                  onClick={() => zoomByFactor(1 / ZOOM_STEP_FACTOR)}
                  aria-label="Zoom out 5 percent"
                  title="Zoom out (5%)"
                >
                  −
                </button>
                <div className="canvas-zoom-field">
                  <input
                    type="text"
                    inputMode="numeric"
                    className="canvas-zoom-input"
                    aria-label="Zoom percent"
                    value={zoomPercentStr}
                    onChange={(e) => setZoomPercentStr(e.target.value)}
                    onFocus={() => setZoomFieldFocused(true)}
                    onBlur={() => {
                      setZoomFieldFocused(false);
                      applyZoomPercentField();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                    }}
                  />
                  <span className="canvas-zoom-unit" aria-hidden>
                    %
                  </span>
                </div>
                <button
                  type="button"
                  className="canvas-icon-btn canvas-zoom-step"
                  onClick={() => zoomByFactor(ZOOM_STEP_FACTOR)}
                  aria-label="Zoom in 5 percent"
                  title="Zoom in (5%)"
                >
                  +
                </button>
              </div>
              {thread.length > 0 ? (
                <button
                  type="button"
                  className="canvas-icon-btn"
                  onClick={resetCanvasLayout}
                  aria-label="Reset canvas layout"
                  title="Reset canvas layout — clear positions and zoom"
                >
                  <NavIconRefresh />
                </button>
              ) : null}
            </div>
          </div>

          <div className={`canvas-page-main${showCanvasViewportBg ? ' canvas-page-main--root-bg' : ''}`}>
          {loadingThread ? (
            <p className="canvas-muted">Loading…</p>
          ) : threadRootId && thread.length === 0 ? (
            <p className="canvas-muted">Thread not found.</p>
          ) : thread.length === 0 ? (
            <p className="canvas-muted">No notes yet.</p>
          ) : (
            <>
            <div
              className="canvas-viewport"
              ref={viewportRef}
              onPointerDown={onViewportPointerDown}
            >
              <div
                className="canvas-world"
                style={{
                  transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
                  transformOrigin: '0 0',
                }}
              >
                {automaticSequenceLinesVisible ? (
                  <svg className="canvas-connectors" aria-hidden>
                    <defs>
                      <marker
                        id="canvas-sequence-arrow"
                        markerUnits="userSpaceOnUse"
                        refX={10}
                        refY={5}
                        markerWidth={10}
                        markerHeight={10}
                        orient="auto"
                        viewBox="0 0 10 10"
                      >
                        <path
                          d="M0,0 L10,5 L0,10 z"
                          className="canvas-connector-arrowhead"
                        />
                      </marker>
                    </defs>
                    {connectorPoints.map((seg, i) => (
                      <line
                        key={i}
                        className="canvas-connector-line"
                        x1={seg.x1}
                        y1={seg.y1}
                        x2={seg.x2}
                        y2={seg.y2}
                        strokeWidth={2}
                        strokeDasharray="5 8"
                        markerEnd="url(#canvas-sequence-arrow)"
                      />
                    ))}
                  </svg>
                ) : null}
                {canvasArrangement === CANVAS_ARRANGEMENT.MANUAL && manualLinkSegments.length > 0 ? (
                  <svg className="canvas-manual-connectors-visible" aria-hidden>
                    <defs>
                      <marker
                        id="canvas-manual-arrow"
                        markerUnits="userSpaceOnUse"
                        refX={10}
                        refY={5}
                        markerWidth={10}
                        markerHeight={10}
                        orient="auto"
                        viewBox="0 0 10 10"
                      >
                        <path d="M0,0 L10,5 L0,10 z" className="canvas-connector-arrowhead" />
                      </marker>
                    </defs>
                    {manualLinkSegments.map((seg) => (
                      <path
                        key={seg.key}
                        d={seg.pathD}
                        className="canvas-manual-connector-line"
                        fill="none"
                        strokeWidth={2}
                        strokeDasharray="5 8"
                        markerEnd="url(#canvas-manual-arrow)"
                      />
                    ))}
                  </svg>
                ) : null}
                {canvasArrangement === CANVAS_ARRANGEMENT.MANUAL && manualLinkSegments.length > 0 ? (
                  <svg className="canvas-manual-edge-interaction" role="presentation" aria-hidden>
                    {manualLinkSegments.map((seg) => (
                      <g
                        key={seg.key}
                        className={`canvas-manual-edge-group${
                          bendDragEdgeKey === seg.key ? ' canvas-manual-edge-group--dragging' : ''
                        }`}
                      >
                        <path
                          d={seg.pathD}
                          className="canvas-manual-connector-hit"
                          fill="none"
                          stroke="transparent"
                          strokeWidth={22}
                          pointerEvents="stroke"
                          onPointerDown={(e) => onManualConnectorHitPointerDown(e, seg)}
                        />
                        <circle
                          className="canvas-manual-bend-handle"
                          cx={seg.mid.x}
                          cy={seg.mid.y}
                          r={12}
                          onPointerDown={(e) => startBendDrag(e, seg)}
                        />
                      </g>
                    ))}
                  </svg>
                ) : null}
                {sequenceNotesForCanvas.map((n) => {
                  const id = String(n.id);
                  const r =
                    cardRects[id] || defaultRectForRank(layoutRankById.get(id) ?? 0, n);
                  const topIds = new Set(displayTree.map((x) => String(x.id)));
                  const depth = topIds.has(id) ? 0 : 1;
                  const parentTagsForInherit =
                    depth > 0 && n.parent_id
                      ? threadById.get(n.parent_id)?.tags ?? []
                      : actualRootId
                        ? threadById.get(actualRootId)?.tags ?? []
                        : [];
                  const mergeAboveSiblingId =
                    threadRootId && n.parent_id
                      ? mergeIntoAboveSiblingIdFromSortedChildren(
                          n,
                          findNode(tree, n.parent_id)?.children || []
                        )
                      : null;
                  return (
                    <div
                      key={id}
                      className="canvas-card-frame"
                      data-canvas-note-id={id}
                      style={{
                        left: r.x,
                        top: r.y,
                        width: r.w,
                        height: r.h,
                      }}
                      onPointerDown={(e) => onCanvasCardPointerDown(n.id, e)}
                      title="Drag to move · use corner to resize"
                    >
                      <div className="canvas-card-body">
                        <NoteCard
                          note={n}
                          depth={depth}
                          hasReplies={
                            (n.children?.length ?? 0) > 0 ||
                            (typeof n.reply_count === 'number' && n.reply_count > 0)
                          }
                          hoverInsightEnabled
                          parentTagsForInherit={parentTagsForInherit}
                          onOpenThread={makeOpenThread(n.id)}
                          onStarredChange={refreshThread}
                          onNoteUpdate={refreshThread}
                          onNoteDelete={refreshThread}
                          onMoveNote={threadRootId ? handleOpenMoveNote : undefined}
                          mergeAboveSiblingId={mergeAboveSiblingId}
                          onMergeNoteIntoAbove={threadRootId ? handleMergeNoteIntoAbove : undefined}
                        />
                      </div>
                      {canvasArrangement === CANVAS_ARRANGEMENT.MANUAL ? (
                        <>
                          {(['top', 'right', 'bottom', 'left']).map((side) => (
                            <div
                              key={side}
                              className={`canvas-card-link-handle-zone canvas-card-link-handle-zone--${side}`}
                            >
                              <button
                                type="button"
                                className="canvas-card-link-handle"
                                data-canvas-link-handle="true"
                                data-note-id={id}
                                data-side={side}
                                aria-label={`Draw arrow from ${side} side`}
                                title="Drag to another note to connect"
                                onPointerDown={(e) => startManualLinkDrag(e, n.id, side)}
                              />
                            </div>
                          ))}
                        </>
                      ) : null}
                      <button
                        type="button"
                        className="canvas-card-resize"
                        aria-label="Resize card"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          startResize(n.id, e);
                        }}
                      />
                    </div>
                  );
                })}
                {manualLinkRubber ? (
                  <svg className="canvas-manual-link-rubber" aria-hidden>
                    <line
                      x1={manualLinkRubber.x1}
                      y1={manualLinkRubber.y1}
                      x2={manualLinkRubber.x2}
                      y2={manualLinkRubber.y2}
                      className="canvas-manual-link-rubber-line"
                      strokeWidth={2}
                    />
                  </svg>
                ) : null}
                {(snapGuides.vx.length > 0 || snapGuides.hy.length > 0) && (
                  <svg className="canvas-snap-guides" aria-hidden>
                    {snapGuides.vx.map((xv, i) => (
                      <line
                        key={`snap-v-${i}`}
                        x1={xv}
                        y1={-50000}
                        x2={xv}
                        y2={50000}
                        className="canvas-snap-guides-line"
                      />
                    ))}
                    {snapGuides.hy.map((yh, i) => (
                      <line
                        key={`snap-h-${i}`}
                        x1={-50000}
                        y1={yh}
                        x2={50000}
                        y2={yh}
                        className="canvas-snap-guides-line"
                      />
                    ))}
                  </svg>
                )}
              </div>
            </div>
            <aside
              className={`canvas-starred-dock${starredDockExpanded ? ' canvas-starred-dock--expanded' : ''}`}
              aria-label="Starred notes"
              style={
                starredDockPos
                  ? {
                      top: starredDockPos.top,
                      right: starredDockPos.right,
                      left: 'auto',
                    }
                  : undefined
              }
            >
              <div className="canvas-starred-dock-toolbar">
                <button
                  type="button"
                  className="canvas-starred-dock-drag-handle"
                  aria-label="Move starred panel"
                  title="Drag to move"
                  onPointerDown={onStarredDockDragPointerDown}
                >
                  <span className="canvas-starred-dock-drag-grip" aria-hidden>
                    ⋮
                  </span>
                </button>
                <button
                  type="button"
                  className="canvas-starred-dock-toggle"
                  onClick={() => setStarredDockExpanded((v) => !v)}
                  aria-expanded={starredDockExpanded}
                  aria-controls="canvas-starred-dock-body"
                  id="canvas-starred-dock-heading"
                >
                  <span className="canvas-starred-dock-title">Starred</span>
                  <span className="canvas-starred-dock-toggle-meta">
                    {starredOnCanvas.length > 0 ? (
                      <span className="canvas-starred-dock-badge">{starredOnCanvas.length}</span>
                    ) : null}
                    <span className="canvas-starred-dock-chevron" aria-hidden>
                      {starredDockExpanded ? '▼' : '▶'}
                    </span>
                  </span>
                </button>
              </div>
              <div
                id="canvas-starred-dock-body"
                className="canvas-starred-dock-body"
                role="region"
                aria-labelledby="canvas-starred-dock-heading"
                hidden={!starredDockExpanded}
              >
                <ul className="canvas-starred-dock-list">
                  {starredOnCanvas.map((n) => (
                    <li key={String(n.id)}>
                      <div
                        className="canvas-starred-row"
                        onDoubleClick={() => zoomToCard(n.id)}
                        title="Double-click to zoom to this note on the canvas"
                      >
                        <span className="canvas-starred-preview">{notePreview(n.content)}</span>
                        <button
                          type="button"
                          className="canvas-starred-unstar"
                          onClick={(e) => {
                            e.stopPropagation();
                            unstarFromDock(n.id);
                          }}
                          aria-label="Remove star"
                          title="Remove star"
                        >
                          ★
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
                {starredOnCanvas.length === 0 ? (
                  <p className="canvas-starred-dock-empty">No starred notes in this view.</p>
                ) : null}
              </div>
            </aside>
            </>
          )}
          {showCompose ? (
            <div
              className="stream-page-compose-wrap canvas-page-compose-wrap"
              data-canvas-compose
              ref={canvasComposeWrapRef}
            >
              {threadRootId ? (
                <form className="stream-page-compose" onSubmit={handleCanvasReply}>
                  <div className="stream-page-compose-mentions">
                    <button
                      type="button"
                      className="mentions-compose-type-btn"
                      disabled={submitting}
                      onClick={cycleComposeNoteType}
                      aria-label={`Note type: ${composeTypeLabel}. Click to switch type.`}
                      title={`${composeTypeLabel} — click for next type`}
                    >
                      <NoteTypeIcon type={composeNoteType} className="mentions-compose-type-icon" />
                    </button>
                    <ComposeExpandableField
                      expanded={composeExpanded}
                      onToggle={() => setComposeExpanded((v) => !v)}
                      disabled={submitting}
                    >
                      <MentionsTextarea
                        placeholder={
                          replyParentId === threadRootId
                            ? 'Reply to thread… (@ link note, # tag)'
                            : `Reply to “${focusSnippet.slice(0, 36)}${focusSnippet.length > 36 ? '…' : ''}”… (@ #)`
                        }
                        value={replyContent}
                        onChange={setReplyContent}
                        rows={composeExpanded ? 14 : 2}
                        disabled={submitting}
                        allowMentionCreate
                        mentionCreateParentId={replyParentId}
                      />
                    </ComposeExpandableField>
                  </div>
                  <NoteTypeEventFields
                    idPrefix="canvas-reply"
                    noteType={composeNoteType}
                    onNoteTypeChange={setComposeNoteType}
                    hideTypeSelect
                    startDate={composeStartDate}
                    onStartDateChange={setComposeStartDate}
                    startTime={composeStartTime}
                    onStartTimeChange={setComposeStartTime}
                    endDate={composeEndDate}
                    onEndDateChange={setComposeEndDate}
                    endTime={composeEndTime}
                    onEndTimeChange={setComposeEndTime}
                    disabled={submitting}
                  />
                  <div className="stream-page-compose-row">
                    <ComposeCalendarPills disabled={submitting} onPickEvent={handleCalendarPick} />
                    <label className="stream-page-file-label stream-page-file-label--hidden">
                      <input
                        ref={canvasReplyFileRef}
                        type="file"
                        multiple
                        accept="image/*,.pdf,.txt,.md,.doc,.docx,.zip"
                        onChange={(e) => setPendingReplyFiles(Array.from(e.target.files || []))}
                      />
                    </label>
                    {pendingReplyFiles.length > 0 && (
                      <span className="stream-page-file-hint">{pendingReplyFiles.length} file(s)</span>
                    )}
                    <div className="stream-page-send-group">
                      <button
                        type="button"
                        className="stream-page-attach-btn"
                        onClick={() => canvasReplyFileRef.current?.click()}
                        aria-label="Attach files"
                        title="Attach files"
                      >
                        <NavIconAttach className="stream-page-attach-icon" />
                      </button>
                      <button
                        type="submit"
                        disabled={(!replyContent.trim() && pendingReplyFiles.length === 0) || submitting}
                      >
                        Send
                      </button>
                    </div>
                  </div>
                </form>
              ) : (
                <form className="stream-page-compose" onSubmit={handleCanvasNewRoot}>
                  <div className="stream-page-compose-mentions">
                    <button
                      type="button"
                      className="mentions-compose-type-btn"
                      disabled={submitting}
                      onClick={cycleComposeNoteType}
                      aria-label={`Note type: ${composeTypeLabel}. Click to switch type.`}
                      title={`${composeTypeLabel} — click for next type`}
                    >
                      <NoteTypeIcon type={composeNoteType} className="mentions-compose-type-icon" />
                    </button>
                    <ComposeExpandableField
                      expanded={composeExpanded}
                      onToggle={() => setComposeExpanded((v) => !v)}
                      disabled={submitting}
                    >
                      <MentionsTextarea
                        placeholder="New thread… @ link note, # tag"
                        value={newRootContent}
                        onChange={setNewRootContent}
                        rows={composeExpanded ? 14 : 2}
                        disabled={submitting}
                        allowMentionCreate
                        mentionCreateParentId={null}
                      />
                    </ComposeExpandableField>
                  </div>
                  <NoteTypeEventFields
                    idPrefix="canvas-root"
                    noteType={composeNoteType}
                    onNoteTypeChange={setComposeNoteType}
                    hideTypeSelect
                    startDate={composeStartDate}
                    onStartDateChange={setComposeStartDate}
                    startTime={composeStartTime}
                    onStartTimeChange={setComposeStartTime}
                    endDate={composeEndDate}
                    onEndDateChange={setComposeEndDate}
                    endTime={composeEndTime}
                    onEndTimeChange={setComposeEndTime}
                    disabled={submitting}
                  />
                  <div className="stream-page-compose-row">
                    <ComposeCalendarPills disabled={submitting} onPickEvent={handleCalendarPick} />
                    <label className="stream-page-file-label stream-page-file-label--hidden">
                      <input
                        ref={canvasRootFileRef}
                        type="file"
                        multiple
                        accept="image/*,.pdf,.txt,.md,.doc,.docx,.zip"
                        onChange={(e) => setPendingRootFiles(Array.from(e.target.files || []))}
                      />
                    </label>
                    {pendingRootFiles.length > 0 && (
                      <span className="stream-page-file-hint">{pendingRootFiles.length} file(s)</span>
                    )}
                    <div className="stream-page-send-group">
                      <button
                        type="button"
                        className="stream-page-attach-btn"
                        onClick={() => canvasRootFileRef.current?.click()}
                        aria-label="Attach files"
                        title="Attach files"
                      >
                        <NavIconAttach className="stream-page-attach-icon" />
                      </button>
                      <button
                        type="submit"
                        disabled={(!newRootContent.trim() && pendingRootFiles.length === 0) || submitting}
                      >
                        Send
                      </button>
                    </div>
                  </div>
                </form>
              )}
            </div>
          ) : null}
          </div>

          <ThreadSummaryModal
            open={summaryOpen}
            onClose={() => setSummaryOpen(false)}
            threadRootId={threadRootId}
            focusNoteId={focusId && !noteIdEq(focusId, actualRootId) ? focusId : null}
            visibleNoteIds={summaryIds}
          />
          <MoveNoteModal
            open={Boolean(moveNoteTarget)}
            onClose={() => setMoveNoteTarget(null)}
            noteToMove={moveNoteTarget}
            onMoved={() => {
              refreshThread();
              setMoveNoteTarget(null);
            }}
          />
        </div>
      </HoverInsightProvider>
    </Layout>
  );
}
