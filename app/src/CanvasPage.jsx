import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import Layout from './Layout';
import NoteCard from './NoteCard';
import ThreadSummaryModal, { collectVisibleNoteIds } from './ThreadSummaryModal';
import { HoverInsightProvider } from './HoverInsightContext';
import { setLastStreamSearchFromParams } from './streamNavMemory';
import { filterTreeByVisibleNoteTypes, filterRootsByVisibleNoteTypes } from './noteTypeFilter';
import { sortNoteTreeByThreadOrder, sortStarredPinned } from './noteThreadSort';
import { useNoteTypeFilter } from './NoteTypeFilterContext';
import {
  getThread,
  getRoots,
  createNote,
  fetchUserSettings,
  patchUserSettings,
  unstarNote,
} from './api';
import { canvasFocusKey, canvasLayoutThreadKey, mergeCanvasLayoutPatch } from './canvasLayoutApi';
import {
  NavIconUpOneLevel,
  NavIconRootLevel,
  NavIconBrain,
  NavIconSequenceLines,
} from './icons/NavIcons';
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

function defaultRect(i) {
  const col = i % 4;
  const row = Math.floor(i / 4);
  return { x: 48 + col * 380, y: 48 + row * 260, w: 340, h: 220 };
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
      ].join(', ')
    )
  );
}

const SAVE_DEBOUNCE_MS = 450;
const MIN_W = 200;
const MIN_H = 120;

export default function CanvasPage() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const threadRootId = searchParams.get('thread')?.trim() || null;
  const focusParam = searchParams.get('focus')?.trim() || null;

  const [thread, setThread] = useState([]);
  const [loadingThread, setLoadingThread] = useState(true);
  const [focusId, setFocusId] = useState(null);
  const [canvasLayouts, setCanvasLayouts] = useState({});
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [showSequenceLines, setShowSequenceLines] = useState(true);

  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [cardRects, setCardRects] = useState({});

  const cardRectsRef = useRef(cardRects);
  const canvasLayoutsRef = useRef(canvasLayouts);
  const showSequenceLinesRef = useRef(showSequenceLines);
  cardRectsRef.current = cardRects;
  canvasLayoutsRef.current = canvasLayouts;
  showSequenceLinesRef.current = showSequenceLines;

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
  const focusFromUrl = useRef('');
  const { visibleNoteTypes } = useNoteTypeFilter();

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
    fetchUserSettings()
      .then((s) => {
        if (s?.campusLayouts && typeof s.campusLayouts === 'object') setCanvasLayouts(s.campusLayouts);
      })
      .catch(() => {});
  }, []);

  const treeFull = useMemo(() => {
    if (!threadRootId) {
      const roots = filterRootsByVisibleNoteTypes(thread, visibleNoteTypes);
      return sortNoteTreeByThreadOrder(roots.map((r) => ({ ...r, children: [] })));
    }
    return buildTree(thread);
  }, [thread, threadRootId, visibleNoteTypes]);

  const tree = useMemo(() => {
    if (!threadRootId) return treeFull;
    return sortNoteTreeByThreadOrder(filterTreeByVisibleNoteTypes(treeFull, visibleNoteTypes));
  }, [threadRootId, treeFull, visibleNoteTypes]);

  const pinnedTree = useMemo(() => sortStarredPinned(tree), [tree]);
  const actualRootId = threadRootId;
  const layoutStorageKey = useMemo(() => canvasLayoutThreadKey(threadRootId), [threadRootId]);

  const displayTree = useMemo(() => {
    const fn = focusId && actualRootId ? findNode(pinnedTree, focusId) : null;
    if (fn && !noteIdEq(focusId, actualRootId)) {
      return [{ ...fn, children: fn.children || [] }];
    }
    return pinnedTree;
  }, [pinnedTree, focusId, actualRootId]);

  const canvasNotes = useMemo(() => flattenCanvasNotes(displayTree), [displayTree]);
  const threadById = useMemo(() => new Map(thread.map((n) => [n.id, n])), [thread]);
  const focusedNode = focusId && actualRootId ? findNode(pinnedTree, focusId) : null;
  const replyParentId = focusId && focusedNode ? focusId : threadRootId;

  const fk = canvasFocusKey(focusId);

  /** Only changes when saved card JSON for this view changes — avoids re-hydrating rects on every save echo (which broke drag). */
  const savedCardsLayoutSig = useMemo(() => {
    const block = canvasLayouts[String(layoutStorageKey)]?.[fk];
    return JSON.stringify(block?.cards ?? null);
  }, [canvasLayouts, layoutStorageKey, fk]);

  useEffect(() => {
    if (!threadRootId) {
      setFocusId(null);
      focusFromUrl.current = '';
      return;
    }
    if (!thread.length) return;
    const key = `${threadRootId}|${focusParam || ''}`;
    if (focusFromUrl.current === key) return;
    if (focusParam && !findNode(pinnedTree, focusParam)) return;
    focusFromUrl.current = key;
    setFocusId(focusParam || null);
  }, [threadRootId, focusParam, thread, pinnedTree]);

  useEffect(() => {
    if (!canvasNotes.length) {
      setCardRects({});
      return;
    }
    setCardRects((prev) => {
      const next = { ...prev };
      let saved = {};
      try {
        if (savedCardsLayoutSig && savedCardsLayoutSig !== 'null') {
          const p = JSON.parse(savedCardsLayoutSig);
          if (p && typeof p === 'object' && !Array.isArray(p)) saved = p;
        }
      } catch {
        saved = {};
      }
      canvasNotes.forEach((n, i) => {
        const id = String(n.id);
        if (saved[id] && typeof saved[id].x === 'number') {
          next[id] = {
            x: saved[id].x,
            y: saved[id].y,
            w: saved[id].w,
            h: saved[id].h,
          };
        } else if (!next[id]) {
          next[id] = defaultRect(i);
        }
      });
      Object.keys(next).forEach((id) => {
        if (!canvasNotes.some((n) => String(n.id) === id)) delete next[id];
      });
      return next;
    });
  }, [canvasNotes, layoutStorageKey, fk, savedCardsLayoutSig]);

  useEffect(() => {
    const block = canvasLayouts[String(layoutStorageKey)]?.[fk];
    if (block?.view) {
      const v = block.view;
      if (typeof v.scale === 'number' && v.scale >= 0.1 && v.scale <= 10) setScale(v.scale);
      if (typeof v.tx === 'number') setTx(v.tx);
      if (typeof v.ty === 'number') setTy(v.ty);
      setShowSequenceLines(v.showSequenceLines !== false);
    } else {
      setScale(1);
      setTx(0);
      setTy(0);
      setShowSequenceLines(true);
    }
  }, [layoutStorageKey, fk, canvasLayouts]);

  const scheduleSave = useCallback(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      saveTimerRef.current = null;
      const cards = { ...cardRectsRef.current };
      const patchLayouts = mergeCanvasLayoutPatch(canvasLayoutsRef.current, layoutStorageKey, fk, {
        view: {
          scale: scaleRef.current,
          tx: txRef.current,
          ty: tyRef.current,
          showSequenceLines: showSequenceLinesRef.current,
        },
        cards,
      });
      try {
        await patchUserSettings({ campusLayouts: patchLayouts });
        setCanvasLayouts(patchLayouts);
      } catch (e) {
        console.error(e);
      }
    }, SAVE_DEBOUNCE_MS);
  }, [layoutStorageKey, fk]);

  scaleRef.current = scale;
  txRef.current = tx;
  tyRef.current = ty;
  scheduleSaveRef.current = scheduleSave;

  const handleWheelNative = useCallback(
    (e) => {
      if (!viewportRef.current) return;
      e.preventDefault();
      const rect = viewportRef.current.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      if (e.ctrlKey || e.metaKey) {
        const delta = -e.deltaY * 0.002;
        setScale((s) => {
          const next = Math.min(4, Math.max(0.2, s + delta));
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
      getRoots(false).then(setThread).catch(() => {});
    } else {
      getThread(threadRootId, false).then(setThread).catch(() => {});
    }
  }, [threadRootId]);

  const applyFocus = useCallback(
    (id) => {
      setFocusId(id);
      if (!threadRootId) return;
      if (id && !noteIdEq(id, threadRootId)) {
        setSearchParams({ thread: threadRootId, focus: id });
      } else {
        setSearchParams({ thread: threadRootId });
      }
    },
    [threadRootId, setSearchParams]
  );

  const upOneLevel = useCallback(() => {
    if (!threadRootId || !focusId || noteIdEq(focusId, actualRootId)) return;
    const p = parentInFilteredTree(tree, focusId);
    if (!p) {
      setFocusId(null);
      setSearchParams({ thread: threadRootId });
      return;
    }
    if (noteIdEq(p, actualRootId)) {
      setFocusId(null);
      setSearchParams({ thread: threadRootId });
    } else {
      applyFocus(p);
    }
  }, [threadRootId, focusId, actualRootId, tree, setSearchParams, applyFocus]);

  /** Same as Stream “Root level”: leave thread and return to stream root list. */
  const closeThread = useCallback(() => {
    setFocusId(null);
    setSearchParams({});
    navigate({ pathname: '/', search: '' });
  }, [navigate, setSearchParams]);

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

  const toggleSequenceLines = useCallback(async () => {
    const next = !showSequenceLines;
    setShowSequenceLines(next);
    showSequenceLinesRef.current = next;
    const patchLayouts = mergeCanvasLayoutPatch(canvasLayoutsRef.current, layoutStorageKey, fk, {
      view: {
        scale: scaleRef.current,
        tx: txRef.current,
        ty: tyRef.current,
        showSequenceLines: next,
      },
      cards: { ...cardRectsRef.current },
    });
    try {
      await patchUserSettings({ campusLayouts: patchLayouts });
      setCanvasLayouts(patchLayouts);
    } catch (e) {
      console.error(e);
      setShowSequenceLines(!next);
      showSequenceLinesRef.current = !next;
    }
  }, [layoutStorageKey, fk]);

  const handleAddCard = useCallback(async () => {
    try {
      if (threadRootId) {
        if (replyParentId == null) return;
        await createNote({
          content: '',
          parent_id: replyParentId,
          note_type: 'note',
        });
      } else {
        await createNote({
          content: '',
          parent_id: null,
          note_type: 'note',
        });
      }
      refreshThread();
    } catch (e) {
      console.error(e);
    }
  }, [threadRootId, replyParentId, refreshThread]);

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

  const connectorPoints = useMemo(() => {
    const pts = [];
    for (let i = 0; i < canvasNotes.length - 1; i++) {
      const a = cardRects[String(canvasNotes[i].id)];
      const b = cardRects[String(canvasNotes[i + 1].id)];
      if (!a || !b) continue;
      pts.push({
        x1: a.x + a.w / 2,
        y1: a.y + a.h,
        x2: b.x + b.w / 2,
        y2: b.y,
      });
    }
    return pts;
  }, [canvasNotes, cardRects]);

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
      let nextScale = pinch.startScale * (d / pinch.startDist);
      nextScale = Math.min(4, Math.max(0.2, nextScale));
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

  const navLinks = [
    { to: '/', label: 'Stream' },
    { to: '/campus', label: 'Canvas' },
    { to: '/outline', label: 'Outline' },
    { to: '/calendar', label: 'Calendar' },
    { to: '/search', label: 'Search' },
  ];

  return (
    <Layout title={layoutTitle} noteTypeFilterEnabled onLogout={logout} viewLinks={navLinks}>
      <HoverInsightProvider onNoteUpdated={refreshThread} onGoToNote={onGoToNote}>
        <div className="canvas-page">
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
              <button
                type="button"
                className="canvas-icon-btn"
                onClick={closeThread}
                aria-label="Root level"
                title="Root level"
              >
                <NavIconRootLevel />
              </button>
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
              <button
                type="button"
                className={`canvas-icon-btn${showSequenceLines ? '' : ' canvas-icon-btn--off'}`}
                onClick={toggleSequenceLines}
                aria-label={showSequenceLines ? 'Hide sequence lines' : 'Show sequence lines'}
                aria-pressed={showSequenceLines}
                title={showSequenceLines ? 'Hide sequence lines' : 'Show sequence lines'}
              >
                <NavIconSequenceLines />
              </button>
              <button type="button" className="canvas-add-btn" onClick={handleAddCard}>
                {threadRootId ? '+ Add to thread' : '+ Add note'}
              </button>
            </div>
            <div className="canvas-zoom-hint">Pinch/zoom to adjust magnification</div>
          </div>

          {loadingThread ? (
            <p className="canvas-muted">Loading…</p>
          ) : thread.length === 0 ? (
            <p className="canvas-muted">{threadRootId ? 'Thread not found.' : 'No notes yet.'}</p>
          ) : (
            <>
            <aside className="canvas-starred-dock" aria-label="Starred notes">
              <div className="canvas-starred-dock-title">Starred</div>
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
            </aside>
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
                {showSequenceLines ? (
                  <svg className="canvas-connectors" aria-hidden>
                    {connectorPoints.map((seg, i) => (
                      <line
                        key={i}
                        x1={seg.x1}
                        y1={seg.y1}
                        x2={seg.x2}
                        y2={seg.y2}
                        stroke="var(--text-muted)"
                        strokeWidth={2}
                        strokeDasharray="5 8"
                        opacity={0.65}
                      />
                    ))}
                  </svg>
                ) : null}
                {canvasNotes.map((n) => {
                  const id = String(n.id);
                  const r = cardRects[id] || defaultRect(0);
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
                          hideStar
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
            </>
          )}

          <ThreadSummaryModal
            open={summaryOpen}
            onClose={() => setSummaryOpen(false)}
            threadRootId={threadRootId}
            focusNoteId={focusId && !noteIdEq(focusId, actualRootId) ? focusId : null}
            visibleNoteIds={summaryIds}
          />
        </div>
      </HoverInsightProvider>
    </Layout>
  );
}
