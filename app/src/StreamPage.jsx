import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from './AuthContext';
import {
  getRoots,
  getThread,
  createNote,
  uploadNoteFiles,
  getNote,
  getNoteThreadPath,
  getNoteThreadRoot,
  fetchUserSettings,
  patchUserSettings,
} from './api';
import { firstLinePreview, historyPrimaryLabel } from './noteHistoryUtils';
import Layout from './Layout';
import NoteCard from './NoteCard';
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

/**
 * Must exceed max `--stream-exit-delay` + `--stream-exit-duration` from exit stagger
 * (see useLayoutEffect on thread list when branchHeadExiting).
 */
const NOTES_EXIT_TO_ROOT_COMMIT_MS = 2900;

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

/** `useSearchParams` can lag `flushSync` + `setSearchParams`; read the real bar URL for focus. */
function getFocusIdFromLocation() {
  if (typeof window === 'undefined') return null;
  try {
    return new URLSearchParams(window.location.search).get('focus')?.trim() || null;
  } catch {
    return null;
  }
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

/**
 * Row to scroll to after “up one level” focuses `newFocusId`. Stream shows that head plus its direct
 * replies only, so we need a note id that has an `li` under the new head — the child on the path
 * from `newFocus` toward `formerHeadId` (usually `formerHeadId` itself when it was a direct reply).
 */
function scrollTargetForOneLevelUp(treeRoots, newFocusId, formerHeadId) {
  if (formerHeadId == null || newFocusId == null) return newFocusId;
  let id = formerHeadId;
  for (let guard = 0; guard < 256; guard++) {
    const p = parentInFilteredTree(treeRoots, id);
    if (p == null) return newFocusId;
    if (noteIdEq(p, newFocusId)) return id;
    id = p;
  }
  return newFocusId;
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

function streamNoteAttrEscaped(id) {
  if (id == null) return '';
  const s = String(id);
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(s);
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Scroll the note row into view. Uses scrollIntoView + scroll-margin (CSS) so the browser picks the
 * right overflow ancestor (.stream-page-scroll). Avoid manual scrollTop during thread/level-drop
 * animations — rects are wrong until ~400–500ms after focus changes, which caused “stuck at top +
 * bump” behavior.
 * @param {'start' | 'center' | 'end' | 'nearest'} [block] — `end` for new reply near composer; `start` for drill-down.
 */
function scrollStreamListToNote(_streamEl, listEl, noteId, block = 'center') {
  if (!listEl || noteId == null) return false;
  const li = findStreamLiByNoteId(listEl, noteId);
  if (!li) return false;
  li.scrollIntoView({ block, inline: 'nearest', behavior: 'auto' });
  return true;
}

/**
 * Drill-up only: place the target row just below the sticky nav using explicit scrollTop.
 * `scrollIntoView` + large `scroll-margin-top` on thread rows skews alignment (too much scroll near
 * the top of the thread, too little near the bottom); manual math matches viewport geometry.
 */
function scrollStreamDrillUpRowBelowNav(streamEl, listEl, noteId) {
  if (!streamEl || !listEl || noteId == null) return false;
  const li = findStreamLiByNoteId(listEl, noteId);
  if (!li) return false;
  const nav = streamEl.querySelector(':scope > .stream-page-nav-row');
  const navH = nav ? nav.getBoundingClientRect().height : 0;
  const pad = 8;
  const s = streamEl.getBoundingClientRect();
  const r = li.getBoundingClientRect();
  const delta = r.top - s.top + streamEl.scrollTop - navH - pad;
  const maxTop = Math.max(0, streamEl.scrollHeight - streamEl.clientHeight);
  streamEl.scrollTo({ top: Math.min(maxTop, Math.max(0, delta)), behavior: 'auto' });
  return true;
}

function findStreamLiByNoteId(listEl, noteId) {
  if (!listEl || noteId == null) return null;
  return [...listEl.querySelectorAll('li[data-stream-note]')].find((li) =>
    noteIdEq(li.getAttribute('data-stream-note'), noteId)
  );
}

/** Depth in the Stream thread UI (0 = thread head row; each nested `ul.stream-page-replies` adds 1). */
function streamReplyDepthFromLi(li) {
  if (!li) return 0;
  let d = 0;
  let cur = li.parentElement;
  while (cur) {
    if (cur instanceof HTMLElement && cur.tagName === 'UL' && cur.classList.contains('stream-page-replies')) {
      d += 1;
    }
    cur = cur.parentElement;
  }
  return d;
}

function readCssRemVarPx(varName, fallbackRem) {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    if (raw) {
      const m = raw.match(/^([0-9.]+)rem$/i);
      if (m) {
        const rem = Number(m[1]);
        if (Number.isFinite(rem)) {
          const fs = Number.parseFloat(getComputedStyle(document.documentElement).fontSize || '16') || 16;
          return rem * fs;
        }
      }
    }
  } catch {
    /* ignore */
  }
  const fs = Number.parseFloat(getComputedStyle(document.documentElement).fontSize || '16') || 16;
  return fallbackRem * fs;
}

/**
 * Where the drill/open-thread float should land vertically (viewport px) for `.stream-page-float--move`.
 * Prefer measuring the sticky thread nav row; fall back to layout CSS vars if not mounted yet.
 */
function measureStreamFloatMoveTopPx(streamScrollEl) {
  const nav =
    streamScrollEl?.querySelector?.(':scope > .stream-page-nav-row') ??
    document.querySelector('.stream-page-scroll > .stream-page-nav-row');
  if (nav && typeof nav.getBoundingClientRect === 'function') {
    const br = nav.getBoundingClientRect();
    if (br.height > 2) {
      // Small breathing room below the sticky nav chrome (esp. when it wraps to two rows).
      return Math.max(0, Math.round(br.bottom + 10));
    }
  }
  const isCompact =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(
      '(max-width: 767px), screen and (max-height: 480px) and (orientation: landscape) and (max-width: 932px)'
    ).matches;
  const sticky = isCompact
    ? readCssRemVarPx('--stream-nav-sticky-top-mobile', 3.65)
    : readCssRemVarPx('--stream-nav-sticky-top', 3.5);
  const approxNav = isCompact ? 72 : 68;
  return Math.max(0, Math.round(sticky + approxNav));
}

function isCompactStreamViewport() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(
    '(max-width: 767px), screen and (max-height: 480px) and (orientation: landscape) and (max-width: 932px)'
  ).matches;
}

/** Mirrors `index.css` `--hermes-stream-column-max: min(50vw, calc(100vw - 2rem))` in px. */
function streamColumnMaxWidthPx() {
  if (typeof window === 'undefined' || !Number.isFinite(window.innerWidth)) return 720;
  const vw = window.innerWidth;
  return Math.max(0, Math.round(Math.min(vw * 0.5, vw - 32)));
}

function streamMoveFloatTargetWidthPx(naturalCardWidthPx) {
  const w = Number(naturalCardWidthPx);
  if (!Number.isFinite(w) || w <= 0) return streamColumnMaxWidthPx();
  if (isCompactStreamViewport()) {
    const cap = Math.max(0, Math.round(window.innerWidth * 0.9));
    return Math.max(1, Math.min(w, cap));
  }
  const cap = streamColumnMaxWidthPx();
  return Math.max(1, Math.min(w, cap));
}

/** Parent row is always a direct child of the thread list; replies live in ul.stream-page-replies (one UI level). */
function findDrillUpDestinationLi(listEl, parentId, leavingId) {
  if (!listEl || parentId == null || leavingId == null) return null;
  const topLis = [...listEl.querySelectorAll(':scope > li[data-stream-note]')];
  const parentLi = topLis.find((li) => noteIdEq(li.getAttribute('data-stream-note'), parentId));
  if (!parentLi) return null;
  const repliesUl = parentLi.querySelector(':scope > ul.stream-page-replies');
  if (!repliesUl) return null;
  const replyLis = [...repliesUl.querySelectorAll(':scope > li[data-stream-note]')];
  return replyLis.find((li) => noteIdEq(li.getAttribute('data-stream-note'), leavingId)) ?? null;
}

function clearDrillDimming(container) {
  if (!container) return;
  container.querySelectorAll('.stream-page-drill-fade, .stream-page-drill-picked').forEach((el) => {
    el.classList.remove('stream-page-drill-fade', 'stream-page-drill-picked');
  });
}

function clearFloatPicked(container) {
  const root = container ?? document;
  root.querySelectorAll('.stream-page-float-picked').forEach((el) => {
    el.classList.remove('stream-page-float-picked');
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
 * Deeper replies appear after focusing (single-click) that note. Root list has no nested thread.
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
  parentTags = [],
  threadById,
  /** When true, up-to-root exit owns motion — inline stagger delays must not override it. */
  exitToRoot = false,
  /** Hide delete on the NoteCard for this note id at list depth 0 (stream focus target). */
  streamFocusHideDeleteId = null,
}) {
  return (
    <>
      {nodes.map((n) => {
        const levelDropMs = exitToRoot ? undefined : levelDropDelays?.get(n.id);
        const replyMs =
          exitToRoot ? undefined : !levelDropMs && depth > 0 ? staggerDelays?.get(n.id) : undefined;
        const delayMs = levelDropMs ?? replyMs;
        const animClass = exitToRoot
          ? undefined
          : levelDropMs != null
            ? 'stream-page-level-drop'
            : replyMs != null
              ? 'stream-page-reply-stagger'
              : undefined;
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
            className={animClass}
            style={
              !exitToRoot && delayMs != null ? { animationDelay: `${delayMs}ms` } : undefined
            }
          >
            <NoteCard
              note={n}
              depth={depth}
              hideStar={depth === 0}
              hideDelete={
                streamFocusHideDeleteId != null &&
                depth === 0 &&
                noteIdEq(n.id, streamFocusHideDeleteId)
              }
              hasReplies={(n.children?.length ?? 0) > 0}
              hoverInsightEnabled
              drillOnSingleClick
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
                  exitToRoot={exitToRoot}
                  streamFocusHideDeleteId={streamFocusHideDeleteId}
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
  /** Single-param deep link (Spaztick-safe); resolved to thread+focus below */
  const noteOpenParam = searchParams.get('note')?.trim() || null;

  useEffect(() => {
    setLastStreamSearchFromParams(searchParams);
  }, [searchParams]);

  const [roots, setRoots] = useState([]);
  /** Latest roots for thread seeding without widening `loadThread` deps (avoids refetch on roots refresh). */
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const [thread, setThread] = useState([]);
  const [loadingRoots, setLoadingRoots] = useState(!threadRootId);
  const [loadingThread, setLoadingThread] = useState(!!threadRootId);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    if (!noteOpenParam || !/^[0-9a-f-]{36}$/i.test(noteOpenParam)) return undefined;
    let cancelled = false;
    setLoadingRoots(true);
    getNoteThreadRoot(noteOpenParam)
      .then((root) => {
        if (cancelled) return;
        setLoadingRoots(false);
        if (root) {
          setSearchParams({ thread: root, focus: noteOpenParam }, { replace: true });
        } else {
          setSearchParams({}, { replace: true });
        }
      })
      .catch(() => {
        if (cancelled) return;
        setLoadingRoots(false);
        setSearchParams({}, { replace: true });
      });
    return () => {
      cancelled = true;
    };
  }, [noteOpenParam, setSearchParams]);

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
  const [composeExpanded, setComposeExpanded] = useState(false);
  const [focusId, setFocusId] = useState(null);
  /** Animated drill target until `focusId` / URL catch up (avoids stale `focus` param vs state). */
  const [drillPendingFocusId, setDrillPendingFocusId] = useState(null);

  const rootFileRef = useRef(null);
  const replyFileRef = useRef(null);
  const threadAnchorRef = useRef(null);
  const threadListRef = useRef(null);
  const streamScrollRef = useRef(null);
  /**
   * Scroll intent as React state so effects always run (ref-only pending did not re-render when
   * focus was unchanged). Consumed in useEffect after paint.
   */
  const [streamScrollIntent, setStreamScrollIntent] = useState(null);
  const composeWrapRef = useRef(null);
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
  const levelNavBusyRef = useRef(false);
  const { visibleNoteTypes } = useNoteTypeFilter();

  useLayoutEffect(() => {
    const listEl = threadListRef.current;
    if (!branchHeadExiting || !listEl) return;
    const lis = [...listEl.querySelectorAll('li[data-stream-note]')];
    const easings = [
      'cubic-bezier(0.22, 0.65, 0.35, 1)',
      'cubic-bezier(0.33, 0, 0.2, 1)',
      'cubic-bezier(0.2, 0.9, 0.3, 1)',
      'cubic-bezier(0.4, 0, 0.6, 1)',
      'cubic-bezier(0.25, 0.5, 0.4, 1)',
    ];
    lis.forEach((li, i) => {
      const delay = Math.min(i, 18) * 44 + (i % 5) * 32;
      const duration = 720 + (i % 12) * 105;
      const ease = easings[i % easings.length];
      li.style.setProperty('--stream-exit-delay', `${delay}ms`);
      li.style.setProperty('--stream-exit-duration', `${duration}ms`);
      li.style.setProperty('--stream-exit-ease', ease);
      li.style.setProperty('animation-delay', `${delay}ms`);
      li.style.setProperty('animation-duration', `${duration}ms`);
      li.style.setProperty('animation-timing-function', ease);
    });
    return () => {
      lis.forEach((li) => {
        li.style.removeProperty('--stream-exit-delay');
        li.style.removeProperty('--stream-exit-duration');
        li.style.removeProperty('--stream-exit-ease');
        li.style.removeProperty('animation-delay');
        li.style.removeProperty('animation-duration');
        li.style.removeProperty('animation-timing-function');
      });
    };
  }, [branchHeadExiting]);

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
        const seedRoot = rootsRef.current.find((r) => noteIdEq(r.id, threadRootId));
        if (seedRoot) {
          const { children: _ch, ...row } = seedRoot;
          setThread([row]);
        } else {
          setThread([]);
        }
      }
      return getThread(threadRootId, false)
        .then((rows) => {
          setThread(rows);
          if (rows.length === 0) setSearchParams({});
          return rows;
        })
        .catch(() => {
          setThread([]);
          setSearchParams({});
          return null;
        })
        .finally(() => {
          if (!soft) setLoadingThread(false);
        });
    },
    [threadRootId, setSearchParams]
  );

  const loadThreadRef = useRef(loadThread);
  loadThreadRef.current = loadThread;

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
    if (noteOpenParam && /^[0-9a-f-]{36}$/i.test(noteOpenParam)) {
      return;
    }
    if (!threadRootId) {
      setLoadingRoots(true);
      loadRoots();
      setThread([]);
      setFocusId(null);
      setDrillPendingFocusId(null);
      setReplyStagger(false);
      if (floatTimerRef.current) {
        clearTimeout(floatTimerRef.current);
        floatTimerRef.current = null;
      }
      setFloatOpen(null);
      clearFloatPicked(document);
      document.querySelectorAll('.stream-page-root-item').forEach((el) => {
        el.classList.remove('stream-page-root-fading', 'stream-page-root-item--picked');
      });
    }
  }, [threadRootId, loadRoots, noteOpenParam]);

  /* Only refetch when the thread id changes — not when `loadThread` identity changes (e.g. setSearchParams),
   * or drill-down can re-run a hard load mid-interaction and clear focus / tree. */
  useEffect(() => {
    if (!threadRootId) return;
    loadThreadRef.current(false);
  }, [threadRootId]);

  useEffect(() => {
    focusFromUrlApplied.current = '';
    setFocusId(null);
    setDrillPendingFocusId(null);
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
  /** URL `focus` can lead state by a tick; `displayTree` must not use drill-pending (would skip drill animation). */
  const focusForDisplay = focusId ?? focusParam;
  const displayTree = useMemo(() => {
    const fn =
      focusForDisplay && actualRootId ? findNode(pinnedTree, focusForDisplay) : null;
    if (fn && !noteIdEq(focusForDisplay, actualRootId)) {
      return [{ ...fn, children: fn.children || [] }];
    }
    return pinnedTree;
  }, [pinnedTree, focusForDisplay, actualRootId]);
  const summaryVisibleIds = useMemo(() => collectVisibleNoteIds(displayTree), [displayTree]);
  const summaryFocusNoteId =
    focusForDisplay && actualRootId && !noteIdEq(focusForDisplay, actualRootId)
      ? focusForDisplay
      : null;
  const focusedNode =
    focusForDisplay && actualRootId ? findNode(pinnedTree, focusForDisplay) : null;

  /**
   * Stream head must never show delete (PERIOD). Merge every focus source + bar URL + single-head
   * display (only one top-level card ⇒ that card is the head).
   */
  const streamHeadHideDeleteId = useMemo(() => {
    const urlFocus = focusParam ?? getFocusIdFromLocation();
    const merged = focusId ?? drillPendingFocusId ?? urlFocus;
    if (merged != null) return merged;
    if (displayTree.length === 1) return displayTree[0].id;
    return null;
  }, [focusId, focusParam, drillPendingFocusId, displayTree, searchParams]);

  useEffect(() => {
    if (drillPendingFocusId == null) return;
    const match =
      (focusId != null && noteIdEq(focusId, drillPendingFocusId)) ||
      (focusParam != null && noteIdEq(focusParam, drillPendingFocusId));
    if (match) setDrillPendingFocusId(null);
  }, [focusId, focusParam, drillPendingFocusId]);

  useEffect(() => {
    if (!threadReady || !focusParam || !thread.length) return;
    const key = `${threadRootId}|${focusParam}`;
    if (focusFromUrlApplied.current === key) return;
    if (!findNode(pinnedTree, focusParam)) return;
    focusFromUrlApplied.current = key;
    let skipScroll = false;
    flushSync(() => {
      setFocusId((prev) => {
        skipScroll = noteIdEq(prev, focusParam);
        return focusParam;
      });
    });
    // Do not clobber scroll targets set the same tick (e.g. drill-up scrolls to former head while URL focus becomes parent).
    if (!skipScroll) {
      setStreamScrollIntent({ kind: 'note', id: focusParam });
    }
  }, [threadReady, threadRootId, focusParam, thread, pinnedTree]);

  useEffect(() => {
    if (!focusId || !thread.length || !threadRootId) return;
    const row = thread.find((n) => noteIdEq(n.id, focusId));
    if (!row) return;
    const t = row.note_type || 'note';
    if (!visibleNoteTypes.has(t)) {
      setFocusId(null);
      setDrillPendingFocusId(null);
      setSearchParams({ thread: threadRootId });
    }
  }, [focusId, thread, threadRootId, visibleNoteTypes, setSearchParams]);

  /**
   * Drop focus when the note is gone or hidden by type filters. Use `treeFull` + flat `thread` so we
   * don’t clear focus in the render after a reply before `pinnedTree` includes the new note (race).
   */
  useEffect(() => {
    if (!threadRootId || !focusId || !tree.length) return;
    const inThread = thread.some((n) => noteIdEq(n.id, focusId));
    if (!inThread) {
      focusFromUrlApplied.current = '';
      setFocusId(null);
      setDrillPendingFocusId(null);
      setSearchParams({ thread: threadRootId });
      return;
    }
    const inFullTree = findNode(treeFull, focusId);
    if (!inFullTree) return;
    if (findNode(pinnedTree, focusId)) return;
    focusFromUrlApplied.current = '';
    setFocusId(null);
    setDrillPendingFocusId(null);
    setSearchParams({ thread: threadRootId });
  }, [threadRootId, focusId, pinnedTree, treeFull, thread, tree.length, setSearchParams]);

  useLayoutEffect(() => {
    if (!streamScrollIntent) return;
    if (!threadRootId || thread.length === 0) return;

    const intent = streamScrollIntent;
    if (intent.kind !== 'note') return;

    const noteScrollId = intent.id;
    const scrollBlock = intent.block ?? 'center';
    const drillUp = intent.source === 'drillUp';
    let cancelled = false;

    const run = () => {
      if (cancelled) return;
      const sc = streamScrollRef.current;
      const listEl = threadListRef.current;
      if (!sc || !listEl) return;
      if (drillUp) {
        scrollStreamDrillUpRowBelowNav(sc, listEl, noteScrollId);
      } else {
        scrollStreamListToNote(sc, listEl, noteScrollId, scrollBlock);
      }
    };

    // Thread enter + level-drop run ~0.5s; drill-up also staggers sibling drops (hundreds of ms) so
    // the target <li> may not have stable geometry until ~1–1.5s. Default retries cover most flows;
    // drill-up uses a longer schedule so we don’t clear intent before the row finishes settling.
    const delaysMs = drillUp
      ? [0, 40, 100, 200, 320, 480, 650, 900, 1200, 1500]
      : [0, 50, 120, 280, 450, 650, 900];
    const doneMs = drillUp ? 1650 : 950;
    const timers = delaysMs.map((ms) => window.setTimeout(run, ms));
    const doneTimer = window.setTimeout(() => {
      if (!cancelled) setStreamScrollIntent(null);
    }, doneMs);

    return () => {
      cancelled = true;
      timers.forEach((t) => clearTimeout(t));
      clearTimeout(doneTimer);
    };
  }, [streamScrollIntent, threadRootId, thread.length, focusId, displayTree]);

  const openThreadDirect = useCallback(
    (rootId) => {
      if (floatTimerRef.current) {
        clearTimeout(floatTimerRef.current);
        floatTimerRef.current = null;
      }
      clearFloatPicked(threadListRef.current);
      setFloatOpen(null);
      setReplyStagger(false);
      flushSync(() => {
        setSearchParams({ thread: rootId });
        setFocusId(null);
        setDrillPendingFocusId(null);
      });
      setStreamScrollIntent({ kind: 'note', id: rootId, block: 'start' });
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
      clearFloatPicked(threadListRef.current);
      const r = li.getBoundingClientRect();
      li.classList.add('stream-page-root-item--picked');
      document.querySelectorAll('.stream-page-root-item').forEach((el) => {
        if (el !== li) el.classList.add('stream-page-root-fading');
      });
      setFloatOpen({
        note: { ...n },
        depth: 0,
        top: r.top,
        left: r.left,
        width: r.width,
        phase: 'idle',
      });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setFloatOpen((prev) => {
            if (!prev || prev.note.id !== rootId) return prev;
            return {
              ...prev,
              phase: 'move',
              moveTop: measureStreamFloatMoveTopPx(streamScrollRef.current),
              width: streamMoveFloatTargetWidthPx(prev.width),
            };
          });
        });
      });
      floatTimerRef.current = setTimeout(() => {
        floatTimerRef.current = null;
        document.querySelectorAll('.stream-page-root-item').forEach((el) => {
          el.classList.remove('stream-page-root-fading', 'stream-page-root-item--picked');
        });
        setFloatOpen(null);
        setReplyStagger(true);
        flushSync(() => {
          setSearchParams({ thread: rootId });
          setFocusId(null);
          setDrillPendingFocusId(null);
        });
        setStreamScrollIntent({ kind: 'note', id: rootId, block: 'start' });
      }, 480);
    },
    [filteredRoots, openThreadDirect, setSearchParams]
  );

  const closeThread = useCallback(() => {
    setThreadExiting(true);
    setTimeout(() => {
      setSearchParams({});
      setFocusId(null);
      setDrillPendingFocusId(null);
      setThreadExiting(false);
      setReplyStagger(false);
      loadRoots();
    }, 220);
  }, [setSearchParams, loadRoots]);

  const clearLevelDropSoon = useCallback(() => {
    window.setTimeout(() => setLevelDropDelays(null), 1550);
  }, []);

  const animateToFullThread = useCallback(() => {
    if (!threadRootId || levelNavBusyRef.current) return;
    if (floatTimerRef.current) {
      clearTimeout(floatTimerRef.current);
      floatTimerRef.current = null;
    }
    clearFloatPicked(threadListRef.current);
    setFloatOpen(null);
    if (!focusId || noteIdEq(focusId, actualRootId)) return;
    levelNavBusyRef.current = true;
    focusFromUrlApplied.current = '';
    setBranchHeadExiting(true);
    window.setTimeout(() => {
      setBranchHeadExiting(false);
      flushSync(() => {
        setFocusId(null);
        setDrillPendingFocusId(null);
        setSearchParams({ thread: threadRootId });
      });
      setStreamScrollIntent({ kind: 'note', id: actualRootId, block: 'start' });
      setLevelDropDelays(buildFullThreadLevelDrops(tree));
      clearLevelDropSoon();
      levelNavBusyRef.current = false;
    }, NOTES_EXIT_TO_ROOT_COMMIT_MS);
  }, [threadRootId, focusId, actualRootId, thread, tree, setSearchParams, clearLevelDropSoon]);

  const upOneLevel = useCallback(() => {
    if (!threadRootId || !focusId || noteIdEq(focusId, actualRootId)) return;
    if (levelNavBusyRef.current) return;
    const parentId = parentInFilteredTree(tree, focusId);
    if (!parentId) {
      animateToFullThread();
      return;
    }
    levelNavBusyRef.current = true;
    setDrillPendingFocusId(null);
    // Do not clear focusFromUrlApplied here — the URL sync effect would re-run with a stale
    // focus= param (still the child) before React Router updates, resetting focusId and breaking scroll.
    const leavingHeadId = focusId;
    const listEl = threadListRef.current;
    /* Direct-child query misses replies under ul.stream-page-replies (e.g. new calendar event). */
    const headLi = findStreamLiByNoteId(listEl, leavingHeadId);
    const art =
      headLi?.querySelector(':scope > article') ??
      listEl?.querySelector(':scope > li[data-stream-note] > article');
    const fr = art?.getBoundingClientRect();

    const row = thread.find((n) => noteIdEq(n.id, leavingHeadId));
    const headNode = findNode(tree, leavingHeadId);
    const note =
      row != null
        ? { ...row, reply_count: headNode?.children?.length ?? row.reply_count ?? 0 }
        : null;

    const parentNode = findNode(tree, parentId);
    const delays = parentNode ? buildParentBranchLevelDrops(parentNode, leavingHeadId) : new Map();
    delays.delete(leavingHeadId);

    const movingToRoot = noteIdEq(parentId, actualRootId);
    if (floatTimerRef.current) {
      clearTimeout(floatTimerRef.current);
      floatTimerRef.current = null;
    }
    clearFloatPicked(listEl);

    const canFloat = Boolean(fr && note && fr.width > 0 && fr.height > 0);

    const scrollToId = scrollTargetForOneLevelUp(tree, parentId, leavingHeadId);

    /*
     * Up to thread root: deferring focus keeps the parent row out of the DOM, so the float cannot
     * measure the real reply slot (fallback = head row = no motion). When we can float, commit focus
     * immediately so the root row exists; keep the staged exit only when there is no float.
     */
    if (movingToRoot && !canFloat && note) {
      setBranchHeadExiting(true);
      window.setTimeout(() => {
        setBranchHeadExiting(false);
        flushSync(() => {
          setFocusId(parentId);
          setSearchParams({ thread: threadRootId });
          setStreamScrollIntent({ kind: 'note', id: scrollToId, block: 'start', source: 'drillUp' });
        });
        focusFromUrlApplied.current = '';
        const d = new Map(delays);
        d.set(leavingHeadId, 440);
        setLevelDropDelays(d);
        clearLevelDropSoon();
      }, NOTES_EXIT_TO_ROOT_COMMIT_MS);
    } else {
      flushSync(() => {
        setFocusId(parentId);
        setSearchParams(movingToRoot ? { thread: threadRootId } : { thread: threadRootId, focus: parentId });
        setStreamScrollIntent({ kind: 'note', id: scrollToId, block: 'start', source: 'drillUp' });
      });
      if (movingToRoot) {
        focusFromUrlApplied.current = '';
      } else {
        focusFromUrlApplied.current = `${threadRootId}|${parentId}`;
      }
      setLevelDropDelays(delays);
      clearLevelDropSoon();
    }

    if (canFloat) {
      setFloatOpen({
        kind: 'up',
        note,
        depth: streamReplyDepthFromLi(headLi),
        top: fr.top,
        left: fr.left,
        width: fr.width,
        phase: 'idle',
        leavingId: leavingHeadId,
        parentId,
      });
      floatTimerRef.current = setTimeout(() => {
        floatTimerRef.current = null;
        clearFloatPicked(threadListRef.current);
        setFloatOpen(null);
        levelNavBusyRef.current = false;
      }, 480);
    } else if (!movingToRoot) {
      const d = new Map(delays);
      d.set(leavingHeadId, 440);
      setLevelDropDelays(d);
      window.setTimeout(() => {
        levelNavBusyRef.current = false;
      }, 650);
    } else {
      window.setTimeout(() => {
        levelNavBusyRef.current = false;
      }, NOTES_EXIT_TO_ROOT_COMMIT_MS + 40);
    }
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

  /** After “up one level” focus commit, measure the in-tree slot and drive the float (same idea as drill-down). */
  useLayoutEffect(() => {
    if (!floatOpen || floatOpen.kind !== 'up' || floatOpen.phase !== 'idle') return;
    const { leavingId, parentId } = floatOpen;
    const listEl = threadListRef.current;
    const abortUp = () => {
      if (floatTimerRef.current) {
        clearTimeout(floatTimerRef.current);
        floatTimerRef.current = null;
      }
      clearFloatPicked(listEl ?? document);
      setFloatOpen(null);
      levelNavBusyRef.current = false;
    };
    if (!listEl || parentId == null || leavingId == null) {
      abortUp();
      return;
    }
    let li = findDrillUpDestinationLi(listEl, parentId, leavingId);
    if (!li) li = findStreamLiByNoteId(listEl, leavingId);
    if (!li) {
      abortUp();
      return;
    }
    const destArt = li.querySelector('article');
    const r = (destArt || li).getBoundingClientRect();
    if (r.width < 1 && r.height < 1) {
      abortUp();
      return;
    }
    li.classList.add('stream-page-float-picked');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setFloatOpen((prev) => {
          if (!prev || prev.kind !== 'up' || prev.phase !== 'idle') return prev;
          return {
            ...prev,
            phase: 'move',
            endTop: r.top,
            endLeft: r.left,
            endWidth: r.width,
          };
        });
      });
    });
  }, [floatOpen]);

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
      setDrillPendingFocusId(null);
      if (threadRootId) {
        if (id && !noteIdEq(id, actualRootId)) {
          setStreamScrollIntent({ kind: 'note', id, block: 'start' });
        } else {
          setStreamScrollIntent({ kind: 'note', id: actualRootId, block: 'start' });
        }
      }
      flushSync(() => {
        setFocusId(id);
        if (!threadRootId) return;
        if (id && !noteIdEq(id, actualRootId)) {
          setSearchParams({ thread: threadRootId, focus: id });
          focusFromUrlApplied.current = `${threadRootId}|${id}`;
        } else {
          setSearchParams({ thread: threadRootId });
          focusFromUrlApplied.current = '';
        }
      });
    },
    [threadRootId, actualRootId, setSearchParams]
  );

  const handleThreadNoteDelete = useCallback(
    (deletedId) => {
      let parentIdToFocus = null;
      if (threadRootId && focusId && deletedId != null && noteIdEq(focusId, deletedId)) {
        const row = thread.find((n) => noteIdEq(n.id, deletedId));
        if (row?.parent_id != null) {
          parentIdToFocus = row.parent_id;
        }
      }
      loadThread(true).then((rows) => {
        loadRoots();
        if (parentIdToFocus != null) {
          applyFocusImmediate(parentIdToFocus);
        }
      });
    },
    [threadRootId, focusId, thread, loadThread, loadRoots, applyFocusImmediate]
  );

  const beginDrillFocus = useCallback(
    (id, e) => {
      const listEl = threadListRef.current;
      if (!listEl || loadingThread || !thread.length || !actualRootId) {
        applyFocusImmediate(id);
        return;
      }
      const fullPath =
        pathFromRootToId(displayTree, id) ?? pathFromRootToId(pinnedTree, id);
      if (!fullPath) {
        applyFocusImmediate(id);
        return;
      }
      const displayRoot =
        focusForDisplay && !noteIdEq(focusForDisplay, actualRootId)
          ? focusForDisplay
          : actualRootId;
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
        clearFloatPicked(listEl);
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
      setDrillPendingFocusId(id);
      setFloatOpen({
        note,
        depth: streamReplyDepthFromLi(targetLi),
        top: r.top,
        left: r.left,
        width: r.width,
        phase: 'idle',
      });
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setFloatOpen((prev) => {
            if (!prev || prev.note.id !== id) return prev;
            return {
              ...prev,
              phase: 'move',
              moveTop: measureStreamFloatMoveTopPx(streamScrollRef.current),
              width: streamMoveFloatTargetWidthPx(prev.width),
            };
          });
        });
      });
      floatTimerRef.current = setTimeout(() => {
        floatTimerRef.current = null;
        clearDrillDimming(threadListRef.current);
        clearFloatPicked(threadListRef.current);
        setFloatOpen(null);
        setReplyStagger(true);
        flushSync(() => {
          setFocusId(id);
          setSearchParams({ thread: threadRootId, focus: id });
        });
        focusFromUrlApplied.current = `${threadRootId}|${id}`;
        setStreamScrollIntent({ kind: 'note', id, block: 'start' });
      }, 480);
    },
    [
      loadingThread,
      thread,
      tree,
      displayTree,
      pinnedTree,
      actualRootId,
      focusForDisplay,
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
          flushSync(() => {
            setFocusId(null);
            setDrillPendingFocusId(null);
            setSearchParams({ thread: threadRootId });
          });
          setStreamScrollIntent({ kind: 'note', id: actualRootId, block: 'start' });
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

  const replyParentId = focusForDisplay && focusedNode ? focusForDisplay : threadRootId;
  const focusSnippet = focusedNode?.content?.slice(0, 50) || '';

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
          await loadThread(true);
          await new Promise((r) => {
            requestAnimationFrame(() => requestAnimationFrame(r));
          });
          applyFocusImmediate(note.id);
        } else {
          const full = {
            ...note,
            reply_count: note.reply_count ?? 0,
            descendant_count: note.descendant_count ?? 0,
            connection_count: note.connection_count ?? 0,
            attachments: note.attachments || [],
          };
          setRoots((prev) => [full, ...prev.filter((x) => x.id !== full.id)]);
          openThreadDirect(full.id);
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
      loadThread,
      applyFocusImmediate,
      openThreadDirect,
    ]
  );

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
              descendant_count: note.descendant_count ?? 0,
              connection_count: note.connection_count ?? 0,
              attachments: note.attachments || [],
            };
      setNewRootContent('');
      setComposeExpanded(false);
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
      setComposeExpanded(false);
      setPendingReplyFiles([]);
      resetComposeMeta();
      if (replyFileRef.current) replyFileRef.current.value = '';
      await loadThread(true);
      await new Promise((r) => {
        requestAnimationFrame(() => requestAnimationFrame(r));
      });
      const scrollNewReplyIntoView = () => {
        const sc = streamScrollRef.current;
        const listEl = threadListRef.current;
        if (sc && listEl && note?.id) {
          scrollStreamListToNote(sc, listEl, note.id, 'end');
        }
      };
      scrollNewReplyIntoView();
      [60, 180, 400].forEach((ms) => window.setTimeout(scrollNewReplyIntoView, ms));
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
      flushSync(() => {
        if (it.threadRootId) setSearchParams({ thread: it.threadRootId, focus: it.noteId });
        else setSearchParams({ thread: it.noteId });
        setFocusId(it.noteId);
      });
      setStreamScrollIntent({ kind: 'note', id: it.noteId });
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
    { to: '/stream', label: 'Stream' },
    { to: '/canvas', label: 'Canvas' },
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
            className={`stream-page-float ${
              floatOpen.phase === 'move'
                ? floatOpen.kind === 'up'
                  ? 'stream-page-float--move-target'
                  : 'stream-page-float--move'
                : ''
            }`}
            style={{
              '--fp-top': `${floatOpen.top}px`,
              '--fp-left': `${floatOpen.left}px`,
              '--fp-w': `${floatOpen.width}px`,
              ...(floatOpen.phase === 'move' &&
                floatOpen.kind !== 'up' &&
                typeof floatOpen.moveTop === 'number' &&
                Number.isFinite(floatOpen.moveTop)
                ? { '--fp-move-top': `${floatOpen.moveTop}px` }
                : {}),
              ...(floatOpen.kind === 'up' &&
                floatOpen.phase === 'move' &&
                floatOpen.endTop != null && {
                  '--fp-end-top': `${floatOpen.endTop}px`,
                  '--fp-end-left': `${floatOpen.endLeft}px`,
                  '--fp-end-w': `${floatOpen.endWidth}px`,
                }),
            }}
            aria-hidden
          >
            <NoteCard
              note={floatOpen.note}
              depth={typeof floatOpen.depth === 'number' ? floatOpen.depth : 0}
              hideStar={typeof floatOpen.depth === 'number' ? floatOpen.depth === 0 : true}
              hideDelete={
                Boolean(
                  threadRootId &&
                    floatOpen.note &&
                    streamHeadHideDeleteId != null &&
                    noteIdEq(floatOpen.note.id, streamHeadHideDeleteId)
                )
              }
              hasReplies={(floatOpen.note.reply_count ?? 0) > 0}
              hoverInsightEnabled
              drillOnSingleClick
              onOpenThread={() => {}}
              onStarredChange={() => {}}
              onNoteUpdate={() => {}}
              onNoteDelete={() => {}}
            />
          </div>
        )}
        <div ref={streamScrollRef} className="stream-page-scroll">
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
              {loadingThread && thread.length === 0 ? (
                <p className="stream-page-muted">Loading thread…</p>
              ) : thread.length === 0 ? (
                <p className="stream-page-muted">Thread not found.</p>
              ) : tree.length === 0 ? (
                <p className="stream-page-muted">No notes match the current type filters.</p>
              ) : (
                <div
                  className={`stream-page-thread-enter ${threadExiting ? 'stream-page-thread-enter--exit' : ''} ${levelDropDelays ? 'stream-page-thread-enter--level-drop' : ''} ${branchHeadExiting ? 'stream-page-thread-enter--notes-exit-to-root' : ''}`}
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
                      onNoteDelete={handleThreadNoteDelete}
                      staggerDelays={replyStaggerDelays}
                      levelDropDelays={levelDropDelays}
                      exitToRoot={branchHeadExiting}
                      streamFocusHideDeleteId={streamHeadHideDeleteId}
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
                    <li key={n.id} className="stream-page-root-item" data-stream-note={n.id}>
                      <NoteCard
                        note={n}
                        depth={0}
                        hasReplies={(n.reply_count ?? 0) > 0}
                        hoverInsightEnabled
                        drillOnSingleClick
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

        <div className="stream-page-compose-wrap" data-stream-compose ref={composeWrapRef}>
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
                    rows={2}
                    disabled={submitting}
                    allowMentionCreate
                    mentionCreateParentId={replyParentId}
                  />
                </ComposeExpandableField>
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
                <ComposeCalendarPills disabled={submitting} onPickEvent={handleCalendarPick} />
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
                <ComposeExpandableField
                  expanded={composeExpanded}
                  onToggle={() => setComposeExpanded((v) => !v)}
                  disabled={submitting}
                >
                  <MentionsTextarea
                    placeholder="New thread… @ link note, # tag"
                    value={newRootContent}
                    onChange={setNewRootContent}
                    rows={2}
                    disabled={submitting}
                    allowMentionCreate
                    mentionCreateParentId={null}
                  />
                </ComposeExpandableField>
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
                <ComposeCalendarPills disabled={submitting} onPickEvent={handleCalendarPick} />
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
