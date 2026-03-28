import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import Layout from './Layout';
import NoteCard from './NoteCard';
import ThreadSummaryModal, { collectVisibleNoteIds } from './ThreadSummaryModal';
import { HoverInsightProvider } from './HoverInsightContext';
import { setLastStreamSearchFromParams } from './streamNavMemory';
import { filterTreeByVisibleNoteTypes } from './noteTypeFilter';
import { sortNoteTreeByThreadOrder, sortStarredPinned } from './noteThreadSort';
import { useNoteTypeFilter } from './NoteTypeFilterContext';
import {
  getThread,
  createNote,
  fetchUserSettings,
  patchUserSettings,
  unstarNote,
} from './api';
import { campusFocusKey, mergeCampusLayoutPatch } from './campusLayoutApi';
import {
  NavIconUpOneLevel,
  NavIconRootLevel,
  NavIconBrain,
  NavIconSequenceLines,
} from './icons/NavIcons';
import './CampusPage.css';

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
function flattenCampusNotes(displayTree) {
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

const SAVE_DEBOUNCE_MS = 450;
const MIN_W = 200;
const MIN_H = 120;

export default function CampusPage() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const threadRootId = searchParams.get('thread')?.trim() || null;
  const focusParam = searchParams.get('focus')?.trim() || null;

  const [thread, setThread] = useState([]);
  const [loadingThread, setLoadingThread] = useState(!!threadRootId);
  const [focusId, setFocusId] = useState(null);
  const [campusLayouts, setCampusLayouts] = useState({});
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [showSequenceLines, setShowSequenceLines] = useState(true);

  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [cardRects, setCardRects] = useState({});

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
      setThread([]);
      setLoadingThread(false);
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
        if (s?.campusLayouts && typeof s.campusLayouts === 'object') setCampusLayouts(s.campusLayouts);
      })
      .catch(() => {});
  }, []);

  const treeFull = useMemo(() => buildTree(thread), [thread]);
  const tree = useMemo(
    () => sortNoteTreeByThreadOrder(filterTreeByVisibleNoteTypes(treeFull, visibleNoteTypes)),
    [treeFull, visibleNoteTypes]
  );
  const pinnedTree = useMemo(() => sortStarredPinned(tree), [tree]);
  const actualRootId = threadRootId;

  const displayTree = useMemo(() => {
    const fn = focusId && actualRootId ? findNode(pinnedTree, focusId) : null;
    if (fn && !noteIdEq(focusId, actualRootId)) {
      return [{ ...fn, children: fn.children || [] }];
    }
    return pinnedTree;
  }, [pinnedTree, focusId, actualRootId]);

  const campusNotes = useMemo(() => flattenCampusNotes(displayTree), [displayTree]);
  const threadById = useMemo(() => new Map(thread.map((n) => [n.id, n])), [thread]);
  const focusedNode = focusId && actualRootId ? findNode(pinnedTree, focusId) : null;
  const replyParentId = focusId && focusedNode ? focusId : threadRootId;

  const fk = campusFocusKey(focusId);
  const layoutBlock = useMemo(() => {
    if (!threadRootId) return null;
    const t = campusLayouts[String(threadRootId)];
    return t && typeof t === 'object' ? t[fk] : null;
  }, [campusLayouts, threadRootId, fk]);

  useEffect(() => {
    if (!threadRootId || !thread.length) return;
    const key = `${threadRootId}|${focusParam || ''}`;
    if (focusFromUrl.current === key) return;
    if (focusParam && !findNode(pinnedTree, focusParam)) return;
    focusFromUrl.current = key;
    setFocusId(focusParam || null);
  }, [threadRootId, focusParam, thread, pinnedTree]);

  useEffect(() => {
    if (!campusNotes.length) {
      setCardRects({});
      return;
    }
    setCardRects((prev) => {
      const next = { ...prev };
      const saved = layoutBlock?.cards && typeof layoutBlock.cards === 'object' ? layoutBlock.cards : {};
      campusNotes.forEach((n, i) => {
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
        if (!campusNotes.some((n) => String(n.id) === id)) delete next[id];
      });
      return next;
    });
  }, [campusNotes, layoutBlock, threadRootId, fk]);

  useEffect(() => {
    if (!threadRootId) return;
    const block = campusLayouts[String(threadRootId)]?.[fk];
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
  }, [threadRootId, fk, campusLayouts]);

  const scheduleSave = useCallback(() => {
    if (!threadRootId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      saveTimerRef.current = null;
      const cards = { ...cardRects };
      const patchLayouts = mergeCampusLayoutPatch(campusLayouts, threadRootId, fk, {
        view: { scale, tx, ty, showSequenceLines },
        cards,
      });
      try {
        await patchUserSettings({ campusLayouts: patchLayouts });
        setCampusLayouts(patchLayouts);
      } catch (e) {
        console.error(e);
      }
    }, SAVE_DEBOUNCE_MS);
  }, [threadRootId, fk, campusLayouts, cardRects, scale, tx, ty, showSequenceLines]);

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
      if (e.target.closest('.campus-card-frame')) return;
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
    if (!threadRootId) return;
    getThread(threadRootId, false).then(setThread).catch(() => {});
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
      applyFocus(noteId);
    },
    [applyFocus]
  );

  const onGoToNote = useCallback(
    ({ noteId, threadRootId: root }) => {
      setSearchParams({ thread: root, focus: noteId });
    },
    [setSearchParams]
  );

  const toggleSequenceLines = useCallback(async () => {
    if (!threadRootId) return;
    const next = !showSequenceLines;
    setShowSequenceLines(next);
    const patchLayouts = mergeCampusLayoutPatch(campusLayouts, threadRootId, fk, {
      view: { scale, tx, ty, showSequenceLines: next },
      cards: { ...cardRects },
    });
    try {
      await patchUserSettings({ campusLayouts: patchLayouts });
      setCampusLayouts(patchLayouts);
    } catch (e) {
      console.error(e);
      setShowSequenceLines(!next);
    }
  }, [
    threadRootId,
    showSequenceLines,
    campusLayouts,
    fk,
    scale,
    tx,
    ty,
    cardRects,
  ]);

  const handleAddCard = useCallback(async () => {
    if (!threadRootId || !replyParentId) return;
    try {
      await createNote({
        content: '',
        parent_id: replyParentId,
        note_type: 'note',
      });
      refreshThread();
    } catch (e) {
      console.error(e);
    }
  }, [threadRootId, replyParentId, refreshThread]);

  const startDrag = useCallback(
    (noteId, e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = String(noteId);
      const start = cardRects[id];
      if (!start) return;
      const ox = e.clientX;
      const oy = e.clientY;
      const base = { ...start };
      const move = (ev) => {
        const dx = (ev.clientX - ox) / scale;
        const dy = (ev.clientY - oy) / scale;
        setCardRects((prev) => ({
          ...prev,
          [id]: { ...base, x: base.x + dx, y: base.y + dy },
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
    [cardRects, scale, scheduleSave]
  );

  const startResize = useCallback(
    (noteId, e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = String(noteId);
      const start = cardRects[id];
      if (!start) return;
      const ox = e.clientX;
      const oy = e.clientY;
      const base = { ...start };
      const move = (ev) => {
        const dx = (ev.clientX - ox) / scale;
        const dy = (ev.clientY - oy) / scale;
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
    [cardRects, scale, scheduleSave]
  );

  const starredOnCanvas = useMemo(
    () => campusNotes.filter((n) => n.starred),
    [campusNotes]
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
    for (let i = 0; i < campusNotes.length - 1; i++) {
      const a = cardRects[String(campusNotes[i].id)];
      const b = cardRects[String(campusNotes[i + 1].id)];
      if (!a || !b) continue;
      pts.push({
        x1: a.x + a.w / 2,
        y1: a.y + a.h,
        x2: b.x + b.w / 2,
        y2: b.y,
      });
    }
    return pts;
  }, [campusNotes, cardRects]);

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
      : 'Campus';

  const summaryIds = useMemo(() => collectVisibleNoteIds(displayTree), [displayTree]);

  const navLinks = [
    { to: '/', label: 'Stream' },
    { to: '/campus', label: 'Campus' },
    { to: '/outline', label: 'Outline' },
    { to: '/calendar', label: 'Calendar' },
    { to: '/search', label: 'Search' },
  ];

  if (!threadRootId) {
    return (
      <Layout title="Campus" noteTypeFilterEnabled onLogout={logout} viewLinks={navLinks}>
        <div className="campus-page campus-page--empty">
          <p className="campus-muted">Open a thread from Stream, then use the Campus icon in the header.</p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout title={layoutTitle} noteTypeFilterEnabled onLogout={logout} viewLinks={navLinks}>
      <HoverInsightProvider onNoteUpdated={refreshThread} onGoToNote={onGoToNote}>
        <div className="campus-page">
          <div className="campus-toolbar">
            <div className="campus-toolbar-left">
              {focusId && !noteIdEq(focusId, actualRootId) ? (
                <button
                  type="button"
                  className="campus-icon-btn"
                  onClick={upOneLevel}
                  aria-label="Up one level"
                  title="Up one level"
                >
                  <NavIconUpOneLevel />
                </button>
              ) : null}
              <button
                type="button"
                className="campus-icon-btn"
                onClick={closeThread}
                aria-label="Root level"
                title="Root level"
              >
                <NavIconRootLevel />
              </button>
              {summaryIds.length > 0 ? (
                <button
                  type="button"
                  className="campus-icon-btn"
                  onClick={() => setSummaryOpen(true)}
                  aria-label="AI thread summary"
                  title="AI thread summary"
                >
                  <NavIconBrain />
                </button>
              ) : null}
              <button
                type="button"
                className={`campus-icon-btn${showSequenceLines ? '' : ' campus-icon-btn--off'}`}
                onClick={toggleSequenceLines}
                aria-label={showSequenceLines ? 'Hide sequence lines' : 'Show sequence lines'}
                aria-pressed={showSequenceLines}
                title={showSequenceLines ? 'Hide sequence lines' : 'Show sequence lines'}
              >
                <NavIconSequenceLines />
              </button>
              <button type="button" className="campus-add-btn" onClick={handleAddCard}>
                + Add to thread
              </button>
            </div>
            <div className="campus-zoom-hint">
              Pinch to zoom (two-finger drag does not pan) · ⌃ scroll to zoom · drag background to pan
            </div>
          </div>

          {loadingThread ? (
            <p className="campus-muted">Loading thread…</p>
          ) : thread.length === 0 ? (
            <p className="campus-muted">Thread not found.</p>
          ) : (
            <>
            <aside className="campus-starred-dock" aria-label="Starred notes">
              <div className="campus-starred-dock-title">Starred</div>
              <ul className="campus-starred-dock-list">
                {starredOnCanvas.map((n) => (
                  <li key={String(n.id)}>
                    <div
                      className="campus-starred-row"
                      onDoubleClick={() => zoomToCard(n.id)}
                      title="Double-click to zoom to this note on the canvas"
                    >
                      <span className="campus-starred-preview">{notePreview(n.content)}</span>
                      <button
                        type="button"
                        className="campus-starred-unstar"
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
                <p className="campus-starred-dock-empty">No starred notes in this view.</p>
              ) : null}
            </aside>
            <div
              className="campus-viewport"
              ref={viewportRef}
              onPointerDown={onViewportPointerDown}
            >
              <div
                className="campus-world"
                style={{
                  transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
                  transformOrigin: '0 0',
                }}
              >
                {showSequenceLines ? (
                  <svg className="campus-connectors" aria-hidden>
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
                {campusNotes.map((n) => {
                  const id = String(n.id);
                  const r = cardRects[id] || defaultRect(0);
                  const topIds = new Set(displayTree.map((x) => String(x.id)));
                  const depth = topIds.has(id) ? 0 : 1;
                  const parentTagsForInherit =
                    depth > 0 && n.parent_id
                      ? threadById.get(n.parent_id)?.tags ?? []
                      : threadById.get(actualRootId)?.tags ?? [];
                  return (
                    <div
                      key={id}
                      className="campus-card-frame"
                      data-campus-note-id={id}
                      style={{
                        left: r.x,
                        top: r.y,
                        width: r.w,
                        height: r.h,
                      }}
                    >
                      <div
                        className="campus-card-drag"
                        onPointerDown={(e) => startDrag(n.id, e)}
                        title="Drag to move"
                      />
                      <div className="campus-card-inner">
                        <NoteCard
                          note={n}
                          depth={depth}
                          hideStar
                          hasReplies={(n.children?.length ?? 0) > 0}
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
                        className="campus-card-resize"
                        aria-label="Resize card"
                        onPointerDown={(e) => startResize(n.id, e)}
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
