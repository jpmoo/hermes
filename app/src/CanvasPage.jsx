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
  sortNoteTreeWithStreamPrefs,
  normalizeStreamThreadSortPrefs,
  noteThreadSortKeyMs,
  resolveStreamThreadSortPrefsForHead,
  sortNotesByStreamOrderNoStarBias,
} from './noteThreadSort';
import { useNoteTypeFilter } from './NoteTypeFilterContext';
import { useNoteTypeColors } from './NoteTypeColorContext';
import StreamThreadImageBackground from './StreamThreadImageBackground';
import { userBackgroundFileUrl, firstImageAttachment, noteFileUrl } from './attachmentUtils';
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
  mergeCanvasLayoutPatch,
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
function defaultRectForRank(rank) {
  return {
    x: DEFAULT_CARD_START_X,
    y: DEFAULT_CARD_START_Y + rank * (DEFAULT_CARD_H + DEFAULT_CARD_GAP_Y),
    w: DEFAULT_CARD_W,
    h: DEFAULT_CARD_H,
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
function rectForNewNoteAvoidOverlap(scale, tx, ty, vw, vh, rank, existingRects) {
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

  candidates.push(defaultRectForRank(rank));

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
      ].join(', ')
    )
  );
}

/**
 * Nested scrollports (long note body, textarea, etc.): let the browser handle wheel/trackpad so we do not
 * steal the gesture for canvas pan. When at scroll limits, the next wheel can still pan the canvas.
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
    if (canY && Math.abs(deltaY) > 0.5) {
      const atTop = node.scrollTop <= 0;
      const atBottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 1;
      if ((deltaY < 0 && !atTop) || (deltaY > 0 && !atBottom)) return true;
    }
    if (canX && Math.abs(deltaX) > 0.5) {
      const atLeft = node.scrollLeft <= 0;
      const atRight = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1;
      if ((deltaX < 0 && !atLeft) || (deltaX > 0 && !atRight)) return true;
    }
    node = node.parentElement;
  }
  return false;
}

const SAVE_DEBOUNCE_MS = 200;
/** Room for Edit / Delete / + Tag / star without wrapping at narrow widths. */
const MIN_W = 280;
const MIN_H = 120;

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;
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
    streamBackgroundAnimate,
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
  /** Per thread root — same storage as Stream sort prefs. */
  const [streamThreadSortByRoot, setStreamThreadSortByRoot] = useState({});
  const [sequenceMenuOpen, setSequenceMenuOpen] = useState(false);
  const [draftArrangement, setDraftArrangement] = useState(CANVAS_ARRANGEMENT.MANUAL);
  const [draftConnector, setDraftConnector] = useState(CANVAS_CONNECTOR_MODE.THREAD_CHAIN);
  const [draftManualNewNoteAnchor, setDraftManualNewNoteAnchor] = useState(
    CANVAS_MANUAL_NEW_NOTE_ANCHOR.FOCUS
  );
  const [draftAutoFocusAlign, setDraftAutoFocusAlign] = useState(CANVAS_AUTO_FOCUS_ALIGN.CENTER);
  const [canvasArrangement, setCanvasArrangement] = useState(CANVAS_ARRANGEMENT.MANUAL);
  const [connectorMode, setConnectorMode] = useState(CANVAS_CONNECTOR_MODE.THREAD_CHAIN);
  const [manualNewNoteAnchor, setManualNewNoteAnchor] = useState(CANVAS_MANUAL_NEW_NOTE_ANCHOR.FOCUS);
  const [autoFocusAlign, setAutoFocusAlign] = useState(CANVAS_AUTO_FOCUS_ALIGN.CENTER);
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

  const cardRectsRef = useRef(cardRects);
  const canvasLayoutsRef = useRef(canvasLayouts);
  const canvasArrangementRef = useRef(CANVAS_ARRANGEMENT.MANUAL);
  const connectorModeRef = useRef(CANVAS_CONNECTOR_MODE.THREAD_CHAIN);
  const manualNewNoteAnchorRef = useRef(CANVAS_MANUAL_NEW_NOTE_ANCHOR.FOCUS);
  const autoFocusAlignRef = useRef(CANVAS_AUTO_FOCUS_ALIGN.CENTER);
  cardRectsRef.current = cardRects;
  canvasLayoutsRef.current = canvasLayouts;
  canvasArrangementRef.current = canvasArrangement;
  connectorModeRef.current = connectorMode;
  manualNewNoteAnchorRef.current = manualNewNoteAnchor;
  autoFocusAlignRef.current = autoFocusAlign;

  const linesVisible = connectorMode !== CANVAS_CONNECTOR_MODE.NONE;

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

  const threadSortPrefs = useMemo(() => {
    if (!threadRootId) return normalizeStreamThreadSortPrefs(undefined);
    const rid = threadRootId.trim().toLowerCase();
    const stored = streamThreadSortByRoot[rid];
    return resolveStreamThreadSortPrefsForHead(stored, Boolean(headNodeForStreamSort?.children?.length));
  }, [streamThreadSortByRoot, threadRootId, headNodeForStreamSort]);

  const tree = useMemo(() => {
    if (!threadRootId) return treeFull;
    return sortNoteTreeWithStreamPrefs(
      filterTreeByVisibleNoteTypes(treeFull, visibleNoteTypes),
      threadSortPrefs
    );
  }, [threadRootId, treeFull, visibleNoteTypes, threadSortPrefs]);
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

  const threadBgImageAtt = useMemo(() => firstImageAttachment(threadBgHeadNote), [threadBgHeadNote]);

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
          next[id] = {
            x: saved[id].x,
            y: saved[id].y,
            w: saved[id].w,
            h: saved[id].h,
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
          next[id] = defaultRectForRank(rankById.get(id) ?? 0);
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
          next[id] = rectForNewNoteAvoidOverlap(scale, tx, ty, vw, vh, rank, existingRects);
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
    if (connectorMode === CANVAS_CONNECTOR_MODE.NONE) {
      return;
    }
    const ordered = sequenceOrderedNotesRef.current;
    if (!ordered.length) return;
    const getSize = (id) => {
      const r = cardRectsRef.current[id];
      return r && typeof r.w === 'number' && typeof r.h === 'number' ? { w: r.w, h: r.h } : null;
    };
    const align = autoFocusAlignRef.current;
    const computed =
      canvasArrangement === CANVAS_ARRANGEMENT.VERTICAL
        ? computeCanvasVerticalArrangementRects(ordered, getSize, align)
        : computeCanvasHorizontalArrangementRects(ordered, getSize, align);
    setCardRects((prev) => ({ ...prev, ...computed }));
    scheduleSaveRef.current();
  }, [canvasArrangement, connectorMode, autoFocusAlign, sequenceLayoutKey]);

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
  }, [layoutStorageKey, fk, canvasLayouts]);

  useEffect(() => {
    if (!sequenceMenuOpen) return;
    const block = canvasLayouts[String(layoutStorageKey)]?.[fk];
    const p = resolveCanvasBlockPrefs(block || {});
    setDraftArrangement(p.canvasArrangement);
    setDraftConnector(p.connectorMode);
    setDraftManualNewNoteAnchor(p.manualNewNoteAnchor);
    setDraftAutoFocusAlign(p.autoFocusAlign);
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
    const pos = {
      scale: scaleRef.current,
      tx: txRef.current,
      ty: tyRef.current,
      showSequenceLines: connectorModeRef.current !== CANVAS_CONNECTOR_MODE.NONE,
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
    let nextScale = Math.min(fitW, fitH, 2.5, 4);
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
        if (wheelEventShouldScrollNestedTarget(e.target, root, e.deltaX, e.deltaY)) {
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
      if (e.target.closest('.canvas-card-frame')) return;
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

  const handleOpenMoveNote = useCallback((note) => {
    setMoveNoteTarget(note);
  }, []);

  const applyFocus = useCallback(
    (id) => {
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
    [threadRootId, setSearchParams]
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
          applyFocus(note.id);
        } else {
          const full = {
            ...note,
            reply_count: note.reply_count ?? 0,
            descendant_count: note.descendant_count ?? 0,
            connection_count: note.connection_count ?? 0,
            attachments: note.attachments || [],
          };
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
    ]
  );

  const upOneLevel = useCallback(() => {
    if (!threadRootId || !focusId || noteIdEq(focusId, actualRootId)) return;
    const p = parentInFilteredTree(tree, focusId);
    if (!p) {
      flushSync(() => {
        setCanvasLayoutFkOverride(null);
        setSearchParams({ thread: threadRootId });
        setFocusId(null);
      });
      return;
    }
    if (noteIdEq(p, actualRootId)) {
      flushSync(() => {
        setCanvasLayoutFkOverride(null);
        setSearchParams({ thread: threadRootId });
        setFocusId(null);
      });
    } else {
      applyFocus(p);
    }
  }, [threadRootId, focusId, actualRootId, tree, setSearchParams, applyFocus]);

  /** Clear thread/focus but stay on Canvas (all threads view). */
  const goToCanvasRoot = useCallback(() => {
    flushSync(() => {
      setCanvasLayoutFkOverride(undefined);
      setSearchParams({});
      setFocusId(null);
    });
  }, [setSearchParams]);

  const makeOpenThread = useCallback(
    (noteId) => () => {
      if (!threadRootId) {
        setSearchParams({ thread: String(noteId) });
        return;
      }
      applyFocus(noteId);
    },
    [threadRootId, setSearchParams, applyFocus]
  );

  const onGoToNote = useCallback(
    ({ noteId, threadRootId: root }) => {
      setSearchParams({ thread: root, focus: noteId });
    },
    [setSearchParams]
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
    let nextCards = { ...cardRectsRef.current };
    if (draftArrangement === CANVAS_ARRANGEMENT.VERTICAL) {
      const computed = computeCanvasVerticalArrangementRects(ordered, getSize, draftAutoFocusAlign);
      nextCards = { ...nextCards, ...computed };
    } else if (draftArrangement === CANVAS_ARRANGEMENT.HORIZONTAL) {
      const computed = computeCanvasHorizontalArrangementRects(ordered, getSize, draftAutoFocusAlign);
      nextCards = { ...nextCards, ...computed };
    }

    cardRectsRef.current = nextCards;
    canvasArrangementRef.current = draftArrangement;
    connectorModeRef.current = draftConnector;
    manualNewNoteAnchorRef.current = draftManualNewNoteAnchor;
    autoFocusAlignRef.current = draftAutoFocusAlign;

    setCardRects(nextCards);
    setCanvasArrangement(draftArrangement);
    setConnectorMode(draftConnector);
    setManualNewNoteAnchor(draftManualNewNoteAnchor);
    setAutoFocusAlign(draftAutoFocusAlign);
    setSequenceMenuOpen(false);
    pendingFitAllRef.current = true;

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const curRaw = canvasLayoutsRef.current[tid]?.[focusKey];
    const curBlock = curRaw && typeof curRaw === 'object' ? curRaw : {};
    const linesOn = draftConnector !== CANVAS_CONNECTOR_MODE.NONE;
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
      connectorMode: draftConnector,
      manualNewNoteAnchor: draftManualNewNoteAnchor,
      autoFocusAlign: draftAutoFocusAlign,
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
  }, [draftArrangement, draftConnector, draftManualNewNoteAnchor, draftAutoFocusAlign]);

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
      canvasArrangementRef.current = CANVAS_ARRANGEMENT.MANUAL;
      connectorModeRef.current = CANVAS_CONNECTOR_MODE.THREAD_CHAIN;
      manualNewNoteAnchorRef.current = CANVAS_MANUAL_NEW_NOTE_ANCHOR.FOCUS;
      autoFocusAlignRef.current = CANVAS_AUTO_FOCUS_ALIGN.CENTER;
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
        const sc = scaleRef.current;
        const dx = (ev.clientX - ox) / sc;
        const dy = (ev.clientY - oy) / sc;
        setCardRects((prev) => ({
          ...prev,
          [id]: { ...base, x: base.x + dx, y: base.y + dy },
        }));
      };

      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
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
      const move = (ev) => {
        const sc = scaleRef.current;
        const dx = (ev.clientX - ox) / sc;
        const dy = (ev.clientY - oy) / sc;
        setCardRects((prev) => ({
          ...prev,
          [id]: {
            ...base,
            w: Math.max(MIN_W, base.w + dx),
            h: Math.max(MIN_H, base.h + dy),
          },
        }));
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        scheduleSave();
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
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
      let nextScale = Math.min(fitW, fitH, 2.5, 4);
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

  const connectorPoints = useMemo(() => {
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
    (it) => {
      if (!it?.noteId) return;
      setHistoryOpen(false);
      if (it.threadRootId) setSearchParams({ thread: it.threadRootId, focus: it.noteId });
      else setSearchParams({ thread: it.noteId });
      setFocusId(it.noteId);
    },
    [setSearchParams]
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
                linesActive={linesVisible}
                manualNewNoteAnchor={draftManualNewNoteAnchor}
                autoFocusAlign={draftAutoFocusAlign}
                onArrangementChange={setDraftArrangement}
                onConnectorModeChange={setDraftConnector}
                onManualNewNoteAnchorChange={setDraftManualNewNoteAnchor}
                onAutoFocusAlignChange={setDraftAutoFocusAlign}
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
                {linesVisible ? (
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
                {sequenceNotesForCanvas.map((n) => {
                  const id = String(n.id);
                  const r =
                    cardRects[id] || defaultRectForRank(layoutRankById.get(id) ?? 0);
                  const topIds = new Set(displayTree.map((x) => String(x.id)));
                  const depth = topIds.has(id) ? 0 : 1;
                  const parentTagsForInherit =
                    depth > 0 && n.parent_id
                      ? threadById.get(n.parent_id)?.tags ?? []
                      : actualRootId
                        ? threadById.get(actualRootId)?.tags ?? []
                        : [];
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
                        />
                      </div>
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
            open={Boolean(moveNoteTarget && threadRootId)}
            onClose={() => setMoveNoteTarget(null)}
            threadRootId={threadRootId}
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
