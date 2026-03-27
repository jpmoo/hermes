import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from './AuthContext';
import {
  getRoots,
  getThread,
  createNote,
  uploadNoteFiles,
  getNote,
  getNoteThreadPath,
  fetchUserSettings,
  patchUserSettings,
} from './api';
import Layout from './Layout';
import NoteCard from './NoteCard';
import NoteTypeEventFields from './NoteTypeEventFields';
import MentionsTextarea from './MentionsTextarea';
import NoteTypeIcon from './NoteTypeIcon';
import { eventFieldsToPayload, NOTE_TYPE_OPTIONS } from './noteEventUtils';
import { syncTagsFromContent, syncConnectionsFromContent } from './noteBodySync';
import { HoverInsightProvider } from './HoverInsightContext';
import { setLastStreamSearchFromParams } from './streamNavMemory';
import { filterTreeByVisibleNoteTypes, filterRootsByVisibleNoteTypes } from './noteTypeFilter';
import { sortNoteTreeByThreadOrder, sortStarredPinned } from './noteThreadSort';
import { useNoteTypeFilter } from './NoteTypeFilterContext';
import {
  NavIconAttach,
  NavIconBrain,
  NavIconHistory,
  NavIconRootLevel,
  NavIconUpOneLevel,
} from './icons/NavIcons';
import ThreadSummaryModal, { collectVisibleNoteIds } from './ThreadSummaryModal';
import './StreamPage.css';

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

/** First line of note body for history preview (not a separate title field). */
function firstLinePreview(s) {
  return (s || '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 72);
}

/** Main line in history menu: first-line body preview; falls back to path leaf if preview missing (e.g. legacy entries). */
function historyPrimaryLabel(storedPreview, threadPath) {
  const t = (storedPreview || '').trim();
  if (t && t !== 'Untitled') return t;
  const path = (threadPath || '').trim();
  if (path) {
    const parts = path.split(/\s*>\s*/).filter(Boolean);
    const leaf = parts[parts.length - 1] || path;
    return leaf.slice(0, 72) || 'Note';
  }
  return 'Note';
}

function findNode(nodes, id) {
  for (const n of nodes) {
    if (noteIdEq(n.id, id)) return n;
    const f = findNode(n.children || [], id);
    if (f) return f;
  }
  return null;
}

/** Parent id of targetId in the filtered tree, or null if target is at top level / missing. */
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

/** IDs from tree root down to target (inclusive). */
function pathFromRootToId(nodes, targetId, acc = []) {
  for (const n of nodes) {
    if (noteIdEq(n.id, targetId)) return [...acc, n.id];
    const sub = pathFromRootToId(n.children || [], targetId, [...acc, n.id]);
    if (sub) return sub;
  }
  return null;
}

function findStreamLiByNoteId(listEl, noteId) {
  if (!listEl || noteId == null) return null;
  return [...listEl.querySelectorAll('li[data-stream-note]')].find((li) =>
    noteIdEq(li.getAttribute('data-stream-note'), noteId)
  );
}

function clearDrillDimming(container) {
  if (!container) return;
  container.querySelectorAll('.stream-page-drill-fade, .stream-page-drill-picked').forEach((el) => {
    el.classList.remove('stream-page-drill-fade', 'stream-page-drill-picked');
  });
}

/** Dim nodes not on path from displayed root to target; mark target li picked. Returns target li or null. */
function applyDrillDimming(threadListEl, pathFromDisplayRoot) {
  clearDrillDimming(threadListEl);
  if (!pathFromDisplayRoot || pathFromDisplayRoot.length < 2) return null;
  const headId = pathFromDisplayRoot[0];
  const topLis = [...threadListEl.querySelectorAll(':scope > li[data-stream-note]')];
  const rootLi = topLis.find((li) => noteIdEq(li.getAttribute('data-stream-note'), headId));
  if (!rootLi) return null;

  const rootArticle = rootLi.querySelector(':scope > article');
  if (pathFromDisplayRoot.length > 1 && rootArticle) {
    rootArticle.classList.add('stream-page-drill-fade');
  }

  let ul = rootLi.querySelector(':scope > ul.stream-page-replies');
  for (let depth = 1; depth < pathFromDisplayRoot.length; depth++) {
    const targetId = pathFromDisplayRoot[depth];
    const isLast = depth === pathFromDisplayRoot.length - 1;
    if (!ul) return null;
    const lis = [...ul.querySelectorAll(':scope > li[data-stream-note]')];
    let found = false;
    for (const li of lis) {
      if (!noteIdEq(li.getAttribute('data-stream-note'), targetId)) {
        li.classList.add('stream-page-drill-fade');
        continue;
      }
      found = true;
      if (isLast) {
        li.classList.add('stream-page-drill-picked');
      } else {
        li.querySelector(':scope > article')?.classList.add('stream-page-drill-fade');
        ul = li.querySelector(':scope > ul.stream-page-replies');
      }
      break;
    }
    if (!found) return null;
  }
  return threadListEl.querySelector('li.stream-page-drill-picked');
}

function countSubtreeNotes(n) {
  return 1 + (n.children || []).reduce((s, c) => s + countSubtreeNotes(c), 0);
}

function assignLevelDropTree(n, start, m) {
  m.set(n.id, start);
  let u = start + 36;
  for (const ch of n.children || []) {
    assignLevelDropTree(ch, u, m);
    u += 32;
  }
}

/** P becomes root; former head flipNoteId FLIPs; siblings drop first, flip node's subtree after */
function buildParentBranchLevelDrops(P, flipNoteId) {
  const m = new Map();
  m.set(P.id, 0);
  const children = P.children || [];
  let d = 48;
  for (const c of children) {
    if (c.id === flipNoteId) continue;
    assignLevelDropTree(c, d, m);
    d += 40 + countSubtreeNotes(c) * 28;
  }
  const flipChild = children.find((c) => c.id === flipNoteId);
  let bd = 460;
  for (const ch of flipChild?.children || []) {
    assignLevelDropTree(ch, bd, m);
    bd += 36;
  }
  return m;
}

function buildFullThreadLevelDrops(treeRoots) {
  const m = new Map();
  let d = 0;
  function walk(nodes) {
    for (const n of nodes) {
      m.set(n.id, d);
      d += 30;
      walk(n.children || []);
    }
  }
  walk(treeRoots);
  return m;
}

/**
 * Thread UI is one level at a time: each visible “head” note plus its direct replies only.
 * Deeper replies appear after focusing (click/double-click) that note. Root list has no nested thread.
 */
function StreamList({
  nodes,
  depth,
  onFocusNote,
  onStarredChange,
  onNoteUpdate,
  onNoteDelete,
  staggerDelays,
  levelDropDelays,
  branchHeadExiting,
  indexInParent = 0,
  parentTags = [],
  threadById,
}) {
  return (
    <>
      {nodes.map((n, i) => {
        const levelDropMs = levelDropDelays?.get(n.id);
        const replyMs = !levelDropMs && depth > 0 && staggerDelays?.get(n.id);
        const delayMs = levelDropMs ?? replyMs;
        const animClass = levelDropMs != null ? 'stream-page-level-drop' : replyMs != null ? 'stream-page-reply-stagger' : undefined;
        const headExit = Boolean(branchHeadExiting && depth === 0 && (indexInParent + i) === 0);
        const parentTagsForInherit =
          depth > 0
            ? parentTags
            : n.parent_id
              ? threadById?.get(n.parent_id)?.tags ?? []
              : [];
        return (
          <li
            key={n.id}
            data-stream-note={n.id}
            className={[animClass, headExit ? 'stream-page-branch-head-exit' : ''].filter(Boolean).join(' ') || undefined}
            style={delayMs != null ? { animationDelay: `${delayMs}ms` } : undefined}
          >
            <NoteCard
              note={n}
              depth={depth}
              hideStar={depth === 0}
              hasReplies={(n.children?.length ?? 0) > 0}
              hoverInsightEnabled
              parentTagsForInherit={parentTagsForInherit}
              onOpenThread={(ev) => onFocusNote(n.id, ev, depth)}
              onStarredChange={onStarredChange}
              onNoteUpdate={onNoteUpdate}
              onNoteDelete={onNoteDelete}
            />
            {n.children?.length > 0 && depth === 0 && (
              <ul className="stream-page-replies">
                <StreamList
                  nodes={n.children}
                  depth={depth + 1}
                  parentTags={n.tags || []}
                  threadById={threadById}
                  onFocusNote={onFocusNote}
                  onStarredChange={onStarredChange}
                  onNoteUpdate={onNoteUpdate}
                  onNoteDelete={onNoteDelete}
                  staggerDelays={staggerDelays}
                  levelDropDelays={levelDropDelays}
                  branchHeadExiting={branchHeadExiting}
                  indexInParent={0}
                />
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}

export default function StreamPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const threadRootId = searchParams.get('thread')?.trim() || null;
  const focusParam = searchParams.get('focus')?.trim() || null;

  useEffect(() => {
    setLastStreamSearchFromParams(searchParams);
  }, [searchParams]);

  const [roots, setRoots] = useState([]);
  const [thread, setThread] = useState([]);
  const [loadingRoots, setLoadingRoots] = useState(!threadRootId);
  const [loadingThread, setLoadingThread] = useState(!!threadRootId);
  const [loadError, setLoadError] = useState(null);

  const [newRootContent, setNewRootContent] = useState('');
  const [replyContent, setReplyContent] = useState('');
  const [pendingRootFiles, setPendingRootFiles] = useState([]);
  const [pendingReplyFiles, setPendingReplyFiles] = useState([]);
  const [composeNoteType, setComposeNoteType] = useState('note');
  const [composeStartDate, setComposeStartDate] = useState('');
  const [composeStartTime, setComposeStartTime] = useState('');
  const [composeEndDate, setComposeEndDate] = useState('');
  const [composeEndTime, setComposeEndTime] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [focusId, setFocusId] = useState(null);

  const rootFileRef = useRef(null);
  const replyFileRef = useRef(null);
  const threadAnchorRef = useRef(null);
  const threadListRef = useRef(null);
  const focusFromUrlApplied = useRef('');
  const floatTimerRef = useRef(null);
  const { logout, user } = useAuth();

  const [floatOpen, setFloatOpen] = useState(null);
  const [summaryModalOpen, setSummaryModalOpen] = useState(false);
  const [noteHistory, setNoteHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyBtnRef = useRef(null);
  const historyMenuRef = useRef(null);
  const historySaveTimer = useRef(null);
  const historyInitRef = useRef(false);
  const lastVisitedNoteRef = useRef(null);
  const [replyStagger, setReplyStagger] = useState(false);
  const [threadExiting, setThreadExiting] = useState(false);
  const [branchHeadExiting, setBranchHeadExiting] = useState(false);
  const [levelDropDelays, setLevelDropDelays] = useState(null);
  const [flipTick, setFlipTick] = useState(0);
  const flipPayloadRef = useRef(null);
  const levelNavBusyRef = useRef(false);
  const { visibleNoteTypes } = useNoteTypeFilter();

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

  const cycleComposeNoteType = useCallback(() => {
    const i = NOTE_TYPE_OPTIONS.findIndex((o) => o.value === composeNoteType);
    const idx = i >= 0 ? i : 0;
    setComposeNoteType(NOTE_TYPE_OPTIONS[(idx + 1) % NOTE_TYPE_OPTIONS.length].value);
  }, [composeNoteType]);

  const composeTypeLabel =
    NOTE_TYPE_OPTIONS.find((o) => o.value === composeNoteType)?.label ?? composeNoteType;

  const loadRoots = useCallback(() => {
    setLoadError(null);
    return getRoots(false)
      .then(setRoots)
      .catch((err) => {
        setRoots([]);
        setLoadError(err.message || 'Could not load notes.');
      })
      .finally(() => setLoadingRoots(false));
  }, []);

  const loadThread = useCallback(
    (soft = false) => {
      if (!threadRootId) return Promise.resolve();
      if (!soft) {
        setLoadingThread(true);
        setThread([]);
      }
      return getThread(threadRootId, false)
        .then((rows) => {
          setThread(rows);
          if (rows.length === 0) setSearchParams({});
        })
        .catch(() => {
          setThread([]);
          setSearchParams({});
        })
        .finally(() => {
          if (!soft) setLoadingThread(false);
        });
    },
    [threadRootId, setSearchParams]
  );

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

  useEffect(() => {
    if (!threadRootId) {
      setLoadingRoots(true);
      loadRoots();
      setThread([]);
      setFocusId(null);
      setReplyStagger(false);
      if (floatTimerRef.current) {
        clearTimeout(floatTimerRef.current);
        floatTimerRef.current = null;
      }
      setFloatOpen(null);
      document.querySelectorAll('.stream-page-root-item').forEach((el) => {
        el.classList.remove('stream-page-root-fading', 'stream-page-root-item--picked');
      });
    }
  }, [threadRootId, loadRoots]);

  useEffect(() => {
    if (threadRootId) {
      loadThread(false);
    }
  }, [threadRootId, loadThread]);

  useEffect(() => {
    focusFromUrlApplied.current = '';
    setFocusId(null);
  }, [threadRootId]);

  const threadReady = Boolean(threadRootId && !loadingThread && thread.length > 0);
  const treeFull = useMemo(() => buildTree(thread), [thread]);
  const tree = useMemo(
    () => sortNoteTreeByThreadOrder(filterTreeByVisibleNoteTypes(treeFull, visibleNoteTypes)),
    [treeFull, visibleNoteTypes]
  );
  const pinnedTree = useMemo(() => sortStarredPinned(tree), [tree]);
  const filteredRoots = useMemo(() => {
    const filtered = filterRootsByVisibleNoteTypes(roots, visibleNoteTypes);
    return sortStarredPinned(filtered.map((r) => ({ ...r, children: [] })));
  }, [roots, visibleNoteTypes]);
  /** URL `thread` is the canonical root; do not use `thread[0]` (API orders by created_at, not tree root). */
  const actualRootId = threadRootId;
  const displayTree = useMemo(() => {
    const fn = focusId && actualRootId ? findNode(pinnedTree, focusId) : null;
    if (fn && !noteIdEq(focusId, actualRootId)) {
      return [{ ...fn, children: fn.children || [] }];
    }
    return pinnedTree;
  }, [pinnedTree, focusId, actualRootId]);
  const summaryVisibleIds = useMemo(() => collectVisibleNoteIds(displayTree), [displayTree]);
  const summaryFocusNoteId =
    focusId && actualRootId && !noteIdEq(focusId, actualRootId) ? focusId : null;
  const focusedNode = focusId && actualRootId ? findNode(pinnedTree, focusId) : null;

  useEffect(() => {
    if (!threadReady || !focusParam || !thread.length) return;
    const key = `${threadRootId}|${focusParam}`;
    if (focusFromUrlApplied.current === key) return;
    if (!findNode(pinnedTree, focusParam)) return;
    focusFromUrlApplied.current = key;
    setFocusId(focusParam);
  }, [threadReady, threadRootId, focusParam, thread, pinnedTree]);

  useEffect(() => {
    if (!focusId || !thread.length || !threadRootId) return;
    const row = thread.find((n) => noteIdEq(n.id, focusId));
    if (!row) return;
    const t = row.note_type || 'note';
    if (!visibleNoteTypes.has(t)) {
      setFocusId(null);
      setSearchParams({ thread: threadRootId });
    }
  }, [focusId, thread, threadRootId, visibleNoteTypes, setSearchParams]);

  useEffect(() => {
    if (!threadRootId || !focusId || !tree.length) return;
    if (findNode(pinnedTree, focusId)) return;
    focusFromUrlApplied.current = '';
    setFocusId(null);
    setSearchParams({ thread: threadRootId });
  }, [threadRootId, focusId, pinnedTree, setSearchParams]);

  useEffect(() => {
    if (!threadRootId || !thread.length || loadingThread) return;
    requestAnimationFrame(() => {
      const scrollEl = threadListRef.current?.closest('.stream-page-scroll');
      if (focusParam && scrollEl) {
        scrollEl.scrollTo({ top: 0, behavior: 'auto' });
        return;
      }
      threadAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [threadRootId, thread[0]?.id, loadingThread, focusParam]);

  const openThreadDirect = useCallback(
    (rootId) => {
      if (floatTimerRef.current) {
        clearTimeout(floatTimerRef.current);
        floatTimerRef.current = null;
      }
      setFloatOpen(null);
      setReplyStagger(false);
      setSearchParams({ thread: rootId });
      setFocusId(null);
    },
    [setSearchParams]
  );

  const beginOpenThread = useCallback(
    (rootId, e) => {
      const n = filteredRoots.find((r) => r.id === rootId);
      const li = e?.currentTarget?.closest?.('li.stream-page-root-item');
      if (!n || !li || typeof li.getBoundingClientRect !== 'function') {
        openThreadDirect(rootId);
        return;
      }
      if (floatTimerRef.current) {
        clearTimeout(floatTimerRef.current);
        floatTimerRef.current = null;
      }
      const r = li.getBoundingClientRect();
      li.classList.add('stream-page-root-item--picked');
      document.querySelectorAll('.stream-page-root-item').forEach((el) => {
        if (el !== li) el.classList.add('stream-page-root-fading');
      });
      setFloatOpen({
        note: { ...n },
        top: r.top,
        left: r.left,
        width: r.width,
        phase: 'idle',
      });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setFloatOpen((prev) => (prev && prev.note.id === rootId ? { ...prev, phase: 'move' } : prev));
        });
      });
      floatTimerRef.current = setTimeout(() => {
        floatTimerRef.current = null;
        document.querySelectorAll('.stream-page-root-item').forEach((el) => {
          el.classList.remove('stream-page-root-fading', 'stream-page-root-item--picked');
        });
        setFloatOpen(null);
        setReplyStagger(true);
        setSearchParams({ thread: rootId });
        setFocusId(null);
      }, 480);
    },
    [filteredRoots, openThreadDirect, setSearchParams]
  );

  const closeThread = useCallback(() => {
    setThreadExiting(true);
    setTimeout(() => {
      setSearchParams({});
      setFocusId(null);
      setThreadExiting(false);
      setReplyStagger(false);
      loadRoots();
    }, 220);
  }, [setSearchParams, loadRoots]);

  const clearLevelDropSoon = useCallback(() => {
    window.setTimeout(() => setLevelDropDelays(null), 1550);
  }, []);

  const animateToFullThread = useCallback(() => {
    if (!threadRootId || levelNavBusyRef.current || floatTimerRef.current) return;
    if (!focusId || noteIdEq(focusId, actualRootId)) return;
    levelNavBusyRef.current = true;
    focusFromUrlApplied.current = '';
    setBranchHeadExiting(true);
    window.setTimeout(() => {
      setBranchHeadExiting(false);
      setFocusId(null);
      setSearchParams({ thread: threadRootId });
      setLevelDropDelays(buildFullThreadLevelDrops(tree));
      clearLevelDropSoon();
      levelNavBusyRef.current = false;
    }, 400);
  }, [threadRootId, focusId, actualRootId, thread, tree, setSearchParams, clearLevelDropSoon]);

  const upOneLevel = useCallback(() => {
    if (!threadRootId || !focusId || noteIdEq(focusId, actualRootId)) return;
    if (levelNavBusyRef.current || floatTimerRef.current) return;
    const parentId = parentInFilteredTree(tree, focusId);
    if (!parentId) {
      animateToFullThread();
      return;
    }
    levelNavBusyRef.current = true;
    focusFromUrlApplied.current = '';
    const leavingHeadId = focusId;
    const listEl = threadListRef.current;
    const art =
      listEl?.querySelector(`li[data-stream-note="${leavingHeadId}"] > article`) ||
      listEl?.querySelector(':scope > li[data-stream-note] > article');
    const fr = art?.getBoundingClientRect();
    const fromRect = fr
      ? {
          left: fr.left,
          top: fr.top,
          width: fr.width,
          height: fr.height,
          noteId: leavingHeadId,
          targetParentId: parentId,
        }
      : null;

    const parentNode = findNode(tree, parentId);
    const delays = parentNode ? buildParentBranchLevelDrops(parentNode, leavingHeadId) : new Map();

    const movingToRoot = noteIdEq(parentId, actualRootId);
    /* Keep the same parent-focus transition path even when parent is root. */
    setFocusId(parentId);
    setSearchParams(movingToRoot ? { thread: threadRootId } : { thread: threadRootId, focus: parentId });
    if (fromRect) {
      // Arc FLIP animates this note's transform; exclude it from row-level drop animation to avoid conflicts.
      delays.delete(leavingHeadId);
      setLevelDropDelays(delays);
      flipPayloadRef.current = fromRect;
      setFlipTick((x) => x + 1);
    } else {
      const d = new Map(delays);
      d.set(leavingHeadId, 440);
      setLevelDropDelays(d);
    }
    clearLevelDropSoon();
    window.setTimeout(() => {
      levelNavBusyRef.current = false;
    }, 650);
  }, [
    threadRootId,
    focusId,
    actualRootId,
    thread,
    tree,
    setSearchParams,
    animateToFullThread,
    clearLevelDropSoon,
  ]);

  useLayoutEffect(() => {
    const payload = flipPayloadRef.current;
    if (!payload || !threadListRef.current) return;
    const { noteId, targetParentId, left, top, width, height } = payload;
    flipPayloadRef.current = null;

    const runArcFlip = (el) => {
      const tr = el.getBoundingClientRect();
      const dx = left - tr.left;
      const dy = top - tr.top;
      const sx = width / Math.max(tr.width, 1);
      const sy = height / Math.max(tr.height, 1);
      const midX = dx * 0.45;
      const lift = Math.max(18, Math.min(42, Math.abs(dy) * 0.22));
      const midY = dy * 0.55 - lift;

      el.style.transformOrigin = 'top left';
      el.style.willChange = 'transform';
      const anim = el.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
          { transform: `translate(${midX}px, ${midY}px) scale(${(sx + 1) / 2}, ${(sy + 1) / 2})` },
          { transform: 'translate(0px, 0px) scale(1, 1)' },
        ],
        {
          duration: 560,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'both',
        }
      );
      anim.onfinish = () => {
        el.style.transformOrigin = '';
        el.style.willChange = '';
      };
      anim.oncancel = () => {
        el.style.transformOrigin = '';
        el.style.willChange = '';
      };
    };

    const scopedTargetSelector =
      targetParentId != null
        ? `li[data-stream-note="${targetParentId}"] > ul.stream-page-replies li[data-stream-note="${noteId}"] > article`
        : null;
    const pickTarget = () =>
      (scopedTargetSelector && threadListRef.current?.querySelector(scopedTargetSelector)) ||
      threadListRef.current?.querySelector(`li[data-stream-note="${noteId}"] > article`);

    let toArt = pickTarget();
    if (!toArt) {
      let tries = 0;
      const retryFind = () => {
        const retry = pickTarget();
        if (retry) {
          runArcFlip(retry);
          return;
        }
        tries += 1;
        if (tries < 5) requestAnimationFrame(retryFind);
      };
      requestAnimationFrame(retryFind);
      return;
    }
    runArcFlip(toArt);
    const bLi = toArt.closest('li');
    const bUl = bLi?.querySelector(':scope > ul.stream-page-replies');
    if (bUl) {
      bUl.style.opacity = '0';
      bUl.style.transition = 'none';
    }
    if (bUl) {
      window.setTimeout(() => {
        bUl.style.transition = 'opacity 0.38s ease';
        bUl.style.opacity = '1';
        window.setTimeout(() => {
          bUl.style.transition = '';
          bUl.style.opacity = '';
        }, 400);
      }, 360);
    }
  }, [flipTick]);

  const threadById = useMemo(() => new Map(thread.map((n) => [n.id, n])), [thread]);

  const replyStaggerDelays = useMemo(() => {
    if (!replyStagger || !thread.length) return null;
    const m = new Map();
    let i = 0;
    function walk(nodes, depth) {
      for (const n of nodes) {
        if (depth > 0) m.set(n.id, i++ * 42);
        if (depth < 1) walk(n.children || [], depth + 1);
      }
    }
    walk(displayTree, 0);
    return m;
  }, [replyStagger, thread, displayTree]);

  useEffect(() => {
    if (!replyStagger || !threadReady) return;
    const t = setTimeout(() => setReplyStagger(false), 1400);
    return () => clearTimeout(t);
  }, [replyStagger, threadReady, threadRootId]);

  const applyFocusImmediate = useCallback(
    (id) => {
      setFocusId(id);
      if (!threadRootId) return;
      const rid = thread[0]?.id;
      if (id && !noteIdEq(id, rid)) {
        setSearchParams({ thread: threadRootId, focus: id });
      } else {
        setSearchParams({ thread: threadRootId });
      }
    },
    [threadRootId, thread, setSearchParams]
  );

  const beginDrillFocus = useCallback(
    (id, e) => {
      const listEl = threadListRef.current;
      if (!listEl || loadingThread || !thread.length || !actualRootId) {
        applyFocusImmediate(id);
        return;
      }
      const fullPath = pathFromRootToId(displayTree, id);
      if (!fullPath) {
        applyFocusImmediate(id);
        return;
      }
      const displayRoot = focusId && !noteIdEq(focusId, actualRootId) ? focusId : actualRootId;
      const idx = fullPath.findIndex((x) => noteIdEq(x, displayRoot));
      const drillPath = idx >= 0 ? fullPath.slice(idx) : fullPath;
      if (drillPath.length < 2) {
        applyFocusImmediate(id);
        return;
      }
      const li = e?.currentTarget?.closest?.('li[data-stream-note]');
      if (!li || !noteIdEq(li.getAttribute('data-stream-note'), id)) {
        applyFocusImmediate(id);
        return;
      }
      if (floatTimerRef.current) {
        clearTimeout(floatTimerRef.current);
        floatTimerRef.current = null;
        clearDrillDimming(listEl);
        setFloatOpen(null);
      }
      let targetLi = applyDrillDimming(listEl, drillPath);
      if (!targetLi) {
        targetLi = findStreamLiByNoteId(listEl, id);
      }
      if (!targetLi) {
        applyFocusImmediate(id);
        return;
      }
      const article = targetLi.querySelector('article');
      const r = (article || targetLi).getBoundingClientRect();
      const row = thread.find((n) => noteIdEq(n.id, id));
      if (!row) {
        clearDrillDimming(listEl);
        applyFocusImmediate(id);
        return;
      }
      const node = findNode(tree, id);
      const note = {
        ...row,
        reply_count: node?.children?.length ?? row.reply_count ?? 0,
      };
      setFloatOpen({
        note,
        top: r.top,
        left: r.left,
        width: r.width,
        phase: 'idle',
      });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setFloatOpen((prev) => (prev && prev.note.id === id ? { ...prev, phase: 'move' } : prev));
        });
      });
      floatTimerRef.current = setTimeout(() => {
        floatTimerRef.current = null;
        clearDrillDimming(threadListRef.current);
        setFloatOpen(null);
        setReplyStagger(true);
        setFocusId(id);
        setSearchParams({ thread: threadRootId, focus: id });
      }, 480);
    },
    [
      loadingThread,
      thread,
      tree,
      displayTree,
      actualRootId,
      focusId,
      threadRootId,
      applyFocusImmediate,
      setSearchParams,
    ]
  );

  const onFocusNote = useCallback(
    (id, e, _streamDepth = 0) => {
      if (!threadRootId) return;
      if (noteIdEq(id, actualRootId)) {
        focusFromUrlApplied.current = '';
        if (focusId && !noteIdEq(focusId, actualRootId)) {
          animateToFullThread();
        } else {
          setFocusId(null);
          setSearchParams({ thread: threadRootId });
        }
        return;
      }
      const canAnimate = Boolean(e?.currentTarget && threadListRef.current && !loadingThread);
      if (canAnimate) {
        beginDrillFocus(id, e);
      } else {
        applyFocusImmediate(id);
      }
    },
    [
      threadRootId,
      actualRootId,
      focusId,
      loadingThread,
      beginDrillFocus,
      applyFocusImmediate,
      animateToFullThread,
      setSearchParams,
    ]
  );

  const replyParentId = focusId && focusedNode ? focusId : threadRootId;
  const focusSnippet = focusedNode?.content?.slice(0, 50) || '';

  const refreshAll = () => {
    if (threadRootId) loadThread(true);
    else loadRoots();
  };

  const handleNewRoot = async (e) => {
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
              connection_count: note.connection_count ?? 0,
              attachments: note.attachments || [],
            };
      setNewRootContent('');
      setPendingRootFiles([]);
      resetComposeMeta();
      if (rootFileRef.current) rootFileRef.current.value = '';
      setRoots((prev) => [full, ...prev.filter((x) => x.id !== full.id)]);
      openThreadDirect(full.id);
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleReply = async (e) => {
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
      setPendingReplyFiles([]);
      resetComposeMeta();
      if (replyFileRef.current) replyFileRef.current.value = '';
      await loadThread(true);
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  const rootNote = thread[0];
  const layoutTitle = threadRootId && rootNote
    ? rootNote.content?.slice(0, 40) + (rootNote.content?.length > 40 ? '…' : '')
    : 'Stream';

  const onHoverInsightGoToNote = useCallback(
    ({ noteId, threadRootId: root }) => {
      setSearchParams({ thread: root, focus: noteId });
    },
    [setSearchParams]
  );

  useEffect(() => {
    if (!historyOpen) return undefined;
    const onDoc = (e) => {
      if (historyMenuRef.current?.contains(e.target) || historyBtnRef.current?.contains(e.target)) return;
      setHistoryOpen(false);
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [historyOpen]);

  useEffect(() => {
    const noteId = focusId || threadRootId;
    if (!noteId || !threadRootId) return;
    // While the thread request is in flight, `thread` is [] — do not record yet or we'd cache an empty preview
    // and skip forever (lastVisitedNoteRef already matches noteId).
    if (loadingThread) return;
    if (thread.length === 0) return;

    const row =
      threadById.get(noteId) ||
      thread.find((n) => noteIdEq(n.id, noteId)) ||
      roots.find((r) => noteIdEq(r.id, noteId));
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
  }, [threadRootId, focusId, threadById, roots, loadingThread, thread]);

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
    <div className="stream-page-history-wrap">
      <button
        ref={historyBtnRef}
        type="button"
        className="stream-page-nav-btn stream-page-nav-btn--icon"
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

  const navLinks = [
    { to: '/', label: 'Stream' },
    { to: '/outline', label: 'Outline' },
    { to: '/calendar', label: 'Calendar' },
    { to: '/search', label: 'Search' },
  ];

  return (
    <Layout title={layoutTitle} noteTypeFilterEnabled onLogout={logout} viewLinks={navLinks}>
      <HoverInsightProvider onNoteUpdated={refreshAll} onGoToNote={onHoverInsightGoToNote}>
      <div className="stream-page">
        {floatOpen && (
          <div
            className={`stream-page-float ${floatOpen.phase === 'move' ? 'stream-page-float--move' : ''}`}
            style={{
              '--fp-top': `${floatOpen.top}px`,
              '--fp-left': `${floatOpen.left}px`,
              '--fp-w': `${floatOpen.width}px`,
            }}
            aria-hidden
          >
            <NoteCard
              note={floatOpen.note}
              depth={0}
              hideStar
              hasReplies={(floatOpen.note.reply_count ?? 0) > 0}
              onOpenThread={() => {}}
              onStarredChange={() => {}}
              onNoteUpdate={() => {}}
              onNoteDelete={() => {}}
            />
          </div>
        )}
        <div className="stream-page-scroll">
          {threadRootId ? (
            <>
              <div className={`stream-page-nav-row ${threadExiting ? 'stream-page-nav-row--exit' : ''}`}>
                <div className="stream-page-nav-left">
                  {focusId && !noteIdEq(focusId, actualRootId) ? (
                    <button type="button" className="stream-page-nav-btn stream-page-nav-btn--icon" onClick={upOneLevel} aria-label="Up one level" title="Up one level">
                      <NavIconUpOneLevel className="stream-page-nav-icon" />
                    </button>
                  ) : null}
                  <button type="button" className="stream-page-nav-btn stream-page-nav-btn--icon stream-page-nav-btn--root" onClick={closeThread} aria-label="Root level" title="Root level">
                    <NavIconRootLevel className="stream-page-nav-icon" />
                  </button>
                  {historyControl}
                </div>
                {!loadingThread && thread.length > 0 && tree.length > 0 && summaryVisibleIds.length > 0 ? (
                  <div className="stream-page-nav-right">
                    <button
                      type="button"
                      className="stream-page-nav-btn stream-page-nav-btn--icon"
                      onClick={() => setSummaryModalOpen(true)}
                      aria-label="AI thread summary"
                      title="AI thread summary"
                    >
                      <NavIconBrain className="stream-page-nav-icon" />
                    </button>
                  </div>
                ) : null}
              </div>
              {loadingThread ? (
                <p className="stream-page-muted">Loading thread…</p>
              ) : thread.length === 0 ? (
                <p className="stream-page-muted">Thread not found.</p>
              ) : tree.length === 0 ? (
                <p className="stream-page-muted">No notes match the current type filters.</p>
              ) : (
                <div
                  className={`stream-page-thread-enter ${threadExiting ? 'stream-page-thread-enter--exit' : ''} ${levelDropDelays ? 'stream-page-thread-enter--level-drop' : ''}`}
                  key={threadRootId}
                  ref={threadAnchorRef}
                >
                  <ul className="stream-page-list" ref={threadListRef}>
                    <StreamList
                      nodes={displayTree}
                      depth={0}
                      parentTags={[]}
                      threadById={threadById}
                      onFocusNote={onFocusNote}
                      onStarredChange={refreshAll}
                      onNoteUpdate={() => loadThread(true)}
                      onNoteDelete={() => {
                        loadThread(true);
                        loadRoots();
                      }}
                      staggerDelays={replyStaggerDelays}
                      levelDropDelays={levelDropDelays}
                      branchHeadExiting={branchHeadExiting}
                    />
                  </ul>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="stream-page-nav-row">
                {historyControl}
              </div>
              {loadError && (
                <p className="stream-page-error" role="alert">
                  {loadError}
                </p>
              )}
              {loadingRoots ? (
                <p className="stream-page-muted">Loading…</p>
              ) : roots.length === 0 && !loadError ? (
                <p className="stream-page-muted">No threads yet. Start one below.</p>
              ) : filteredRoots.length === 0 && roots.length > 0 ? (
                <p className="stream-page-muted">No threads match the current type filters.</p>
              ) : roots.length > 0 ? (
                <ul className="stream-page-list">
                  {filteredRoots.map((n) => (
                    <li key={n.id} className="stream-page-root-item">
                      <NoteCard
                        note={n}
                        depth={0}
                        hasReplies={(n.reply_count ?? 0) > 0}
                        hoverInsightEnabled
                        onOpenThread={(ev) => beginOpenThread(n.id, ev)}
                        onStarredChange={loadRoots}
                        onNoteUpdate={loadRoots}
                        onNoteDelete={loadRoots}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
            </>
          )}
        </div>

        <div className="stream-page-compose-wrap" data-stream-compose>
          {threadRootId ? (
            <form className="stream-page-compose" onSubmit={handleReply}>
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
                <MentionsTextarea
                  placeholder={
                    replyParentId === threadRootId
                      ? 'Reply to thread… (@ link note, # tag)'
                      : `Reply to “${focusSnippet.slice(0, 36)}${focusSnippet.length > 36 ? '…' : ''}”… (@ #)`
                  }
                  value={replyContent}
                  onChange={setReplyContent}
                  rows={2}
                  disabled={submitting}
                  mentionCreateParentId={replyParentId}
                />
              </div>
              <NoteTypeEventFields
                idPrefix="stream-reply"
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
                <label className="stream-page-file-label stream-page-file-label--hidden">
                  <input
                    ref={replyFileRef}
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
                    onClick={() => replyFileRef.current?.click()}
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
            <form className="stream-page-compose" onSubmit={handleNewRoot}>
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
                <MentionsTextarea
                  placeholder="New thread… @ link note, # tag"
                  value={newRootContent}
                  onChange={setNewRootContent}
                  rows={2}
                  disabled={submitting}
                />
              </div>
              <NoteTypeEventFields
                idPrefix="stream-root"
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
                <label className="stream-page-file-label stream-page-file-label--hidden">
                  <input
                    ref={rootFileRef}
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
                    onClick={() => rootFileRef.current?.click()}
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
      </div>
        <ThreadSummaryModal
          open={summaryModalOpen}
          onClose={() => setSummaryModalOpen(false)}
          threadRootId={threadRootId}
          focusNoteId={summaryFocusNoteId}
          visibleNoteIds={summaryVisibleIds}
        />
      </HoverInsightProvider>
    </Layout>
  );
}
