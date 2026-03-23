import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getRoots, getThread, createNote, uploadNoteFiles, getNote } from './api';
import Layout from './Layout';
import NoteCard from './NoteCard';
import NoteTypeEventFields from './NoteTypeEventFields';
import MentionsTextarea from './MentionsTextarea';
import { eventFieldsToPayload } from './noteEventUtils';
import { syncTagsFromContent, syncConnectionsFromContent } from './noteBodySync';
import { HoverInsightProvider } from './HoverInsightContext';
import { setLastStreamSearchFromParams } from './streamNavMemory';
import { filterTreeByVisibleNoteTypes, filterRootsByVisibleNoteTypes } from './noteTypeFilter';
import { useNoteTypeFilter } from './NoteTypeFilterContext';
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

function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    const f = findNode(n.children || [], id);
    if (f) return f;
  }
  return null;
}

/** Parent id of targetId in the filtered tree, or null if target is at top level / missing. */
function parentInFilteredTree(nodes, targetId) {
  for (const n of nodes) {
    for (const c of n.children || []) {
      if (c.id === targetId) return n.id;
    }
    const p = parentInFilteredTree(n.children || [], targetId);
    if (p != null) return p;
  }
  return null;
}

/** IDs from tree root down to target (inclusive). */
function pathFromRootToId(nodes, targetId, acc = []) {
  for (const n of nodes) {
    if (n.id === targetId) return [...acc, n.id];
    const sub = pathFromRootToId(n.children || [], targetId, [...acc, n.id]);
    if (sub) return sub;
  }
  return null;
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
  const rootLi = threadListEl.querySelector(':scope > li[data-stream-note]');
  if (!rootLi || rootLi.dataset.streamNote !== pathFromDisplayRoot[0]) return null;

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
      if (li.dataset.streamNote !== targetId) {
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
              hasReplies={(n.children?.length ?? 0) > 0}
              hoverInsightEnabled
              parentTagsForInherit={parentTagsForInherit}
              onOpenThread={(ev) => onFocusNote(n.id, ev)}
              onStarredChange={onStarredChange}
              onNoteUpdate={onNoteUpdate}
              onNoteDelete={onNoteDelete}
            />
            {n.children?.length > 0 && (
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

  const [starredOnly, setStarredOnly] = useState(false);
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
  const { logout } = useAuth();

  const [floatOpen, setFloatOpen] = useState(null);
  const [replyStagger, setReplyStagger] = useState(false);
  const [threadExiting, setThreadExiting] = useState(false);
  const [branchHeadExiting, setBranchHeadExiting] = useState(false);
  const [levelDropDelays, setLevelDropDelays] = useState(null);
  const [flipTick, setFlipTick] = useState(0);
  const flipPayloadRef = useRef(null);
  const levelNavBusyRef = useRef(false);
  const { visibleNoteTypes } = useNoteTypeFilter();

  const loadRoots = useCallback(() => {
    setLoadError(null);
    return getRoots(starredOnly)
      .then(setRoots)
      .catch((err) => {
        setRoots([]);
        setLoadError(err.message || 'Could not load notes.');
      })
      .finally(() => setLoadingRoots(false));
  }, [starredOnly]);

  const loadThread = useCallback(
    (soft = false) => {
      if (!threadRootId) return Promise.resolve();
      if (!soft) {
        setLoadingThread(true);
        setThread([]);
      }
      return getThread(threadRootId, starredOnly)
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
    [threadRootId, starredOnly, setSearchParams]
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
  }, [threadRootId, starredOnly, loadRoots]);

  useEffect(() => {
    if (threadRootId) {
      loadThread(false);
    }
  }, [threadRootId, starredOnly, loadThread]);

  useEffect(() => {
    focusFromUrlApplied.current = '';
    setFocusId(null);
  }, [threadRootId]);

  const threadReady = Boolean(threadRootId && !loadingThread && thread.length > 0);
  const treeFull = useMemo(() => buildTree(thread), [thread]);
  const tree = useMemo(
    () => filterTreeByVisibleNoteTypes(treeFull, visibleNoteTypes),
    [treeFull, visibleNoteTypes]
  );
  const filteredRoots = useMemo(
    () => filterRootsByVisibleNoteTypes(roots, visibleNoteTypes),
    [roots, visibleNoteTypes]
  );
  const actualRootId = thread[0]?.id;
  const displayTree = useMemo(() => {
    const fn = focusId && actualRootId ? findNode(tree, focusId) : null;
    if (fn && focusId !== actualRootId) {
      return [{ ...fn, children: fn.children || [] }];
    }
    return tree;
  }, [tree, focusId, actualRootId]);
  const focusedNode = focusId && actualRootId ? findNode(tree, focusId) : null;

  useEffect(() => {
    if (!threadReady || !focusParam || !thread.length) return;
    const key = `${threadRootId}|${focusParam}`;
    if (focusFromUrlApplied.current === key) return;
    if (!findNode(tree, focusParam)) return;
    focusFromUrlApplied.current = key;
    setFocusId(focusParam);
  }, [threadReady, threadRootId, focusParam, thread, tree]);

  useEffect(() => {
    if (!focusId || !thread.length || !threadRootId) return;
    const row = thread.find((n) => n.id === focusId);
    if (!row) return;
    const t = row.note_type || 'note';
    if (!visibleNoteTypes.has(t)) {
      setFocusId(null);
      setSearchParams({ thread: threadRootId });
    }
  }, [focusId, thread, threadRootId, visibleNoteTypes, setSearchParams]);

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
    if (!focusId || focusId === actualRootId) return;
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
    if (!threadRootId || !focusId || focusId === actualRootId) return;
    if (levelNavBusyRef.current || floatTimerRef.current) return;
    const parentId = parentInFilteredTree(tree, focusId);
    if (!parentId || parentId === actualRootId) {
      animateToFullThread();
      return;
    }
    levelNavBusyRef.current = true;
    focusFromUrlApplied.current = '';
    const leavingHeadId = focusId;
    const listEl = threadListRef.current;
    const art = listEl?.querySelector(':scope > li[data-stream-note] > article');
    const fr = art?.getBoundingClientRect();
    const fromRect = fr
      ? { left: fr.left, top: fr.top, width: fr.width, height: fr.height, noteId: leavingHeadId }
      : null;

    const parentNode = findNode(tree, parentId);
    const delays = parentNode ? buildParentBranchLevelDrops(parentNode, leavingHeadId) : new Map();

    setFocusId(parentId);
    setSearchParams({ thread: threadRootId, focus: parentId });
    setLevelDropDelays(delays);
    if (fromRect) {
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
    const { noteId, left, top, width, height } = payload;
    flipPayloadRef.current = null;
    const toArt = threadListRef.current.querySelector(`li[data-stream-note="${noteId}"] > article`);
    if (!toArt) return;
    const tr = toArt.getBoundingClientRect();
    const dx = left - tr.left;
    const dy = top - tr.top;
    const sx = width / Math.max(tr.width, 1);
    const sy = height / Math.max(tr.height, 1);
    toArt.style.transformOrigin = 'top left';
    toArt.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    toArt.style.transition = 'none';
    const bLi = toArt.closest('li');
    const bUl = bLi?.querySelector(':scope > ul.stream-page-replies');
    if (bUl) {
      bUl.style.opacity = '0';
      bUl.style.transition = 'none';
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        toArt.style.transition =
          'transform 0.52s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.45s ease';
        toArt.style.transform = '';
        window.setTimeout(() => {
          toArt.style.transition = '';
          toArt.style.transformOrigin = '';
        }, 550);
        if (bUl) {
          window.setTimeout(() => {
            bUl.style.transition = 'opacity 0.38s ease';
            bUl.style.opacity = '1';
            window.setTimeout(() => {
              bUl.style.transition = '';
              bUl.style.opacity = '';
            }, 400);
          }, 380);
        }
      });
    });
  }, [flipTick]);

  const threadById = useMemo(() => new Map(thread.map((n) => [n.id, n])), [thread]);

  const replyStaggerDelays = useMemo(() => {
    if (!replyStagger || !thread.length) return null;
    const m = new Map();
    let i = 0;
    function walk(nodes, depth) {
      for (const n of nodes) {
        if (depth > 0) m.set(n.id, i++ * 42);
        walk(n.children || [], depth + 1);
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
      if (id && id !== rid) {
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
      const displayRoot = focusId && focusId !== actualRootId ? focusId : actualRootId;
      const idx = fullPath.indexOf(displayRoot);
      const drillPath = idx >= 0 ? fullPath.slice(idx) : fullPath;
      if (drillPath.length < 2) {
        applyFocusImmediate(id);
        return;
      }
      const li = e?.currentTarget?.closest?.('li[data-stream-note]');
      if (!li || li.dataset.streamNote !== id) {
        applyFocusImmediate(id);
        return;
      }
      if (floatTimerRef.current) {
        clearTimeout(floatTimerRef.current);
        floatTimerRef.current = null;
        clearDrillDimming(listEl);
        setFloatOpen(null);
      }
      const targetLi = applyDrillDimming(listEl, drillPath);
      if (!targetLi) {
        applyFocusImmediate(id);
        return;
      }
      const article = targetLi.querySelector('article');
      const r = (article || targetLi).getBoundingClientRect();
      const row = thread.find((n) => n.id === id);
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
    (id, e) => {
      if (!threadRootId) return;
      if (id === actualRootId) {
        focusFromUrlApplied.current = '';
        if (focusId && focusId !== actualRootId) {
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
      await syncConnectionsFromContent(note.id, text);
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
      await syncConnectionsFromContent(note.id, text);
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

  const navLinks = [
    { to: '/', label: 'Stream' },
    { to: '/outline', label: 'Outline' },
    { to: '/tags', label: 'Tags' },
    { to: '/search', label: 'Search' },
  ];

  return (
    <Layout
      title={layoutTitle}
      starFilterEnabled
      noteTypeFilterEnabled
      starredOnly={starredOnly}
      onStarredOnlyChange={setStarredOnly}
      onLogout={logout}
      viewLinks={navLinks}
    >
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
                {focusId && focusId !== actualRootId ? (
                  <button type="button" className="stream-page-nav-btn" onClick={upOneLevel}>
                    ↑ One level
                  </button>
                ) : null}
                <button type="button" className="stream-page-nav-btn stream-page-nav-btn--root" onClick={closeThread}>
                  Root level
                </button>
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
              <p className="stream-page-level-hint" role="note">
                You are at the root.
              </p>
              {loadError && (
                <p className="stream-page-error" role="alert">
                  {loadError}
                </p>
              )}
              {loadingRoots ? (
                <p className="stream-page-muted">Loading…</p>
              ) : roots.length === 0 && !loadError ? (
                <p className="stream-page-muted">
                  {starredOnly ? 'No starred threads yet.' : 'No threads yet. Start one below.'}
                </p>
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

        <div className="stream-page-compose-wrap">
          {threadRootId ? (
            <form className="stream-page-compose" onSubmit={handleReply}>
              <MentionsTextarea
                placeholder={
                  replyParentId === threadRootId
                    ? 'Reply to thread…'
                    : `Reply to “${focusSnippet.slice(0, 36)}${focusSnippet.length > 36 ? '…' : ''}”…`
                }
                value={replyContent}
                onChange={setReplyContent}
                rows={2}
                disabled={submitting}
              />
              <NoteTypeEventFields
                idPrefix="stream-reply"
                noteType={composeNoteType}
                onNoteTypeChange={setComposeNoteType}
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
                <label className="stream-page-file-label">
                  <input
                    ref={replyFileRef}
                    type="file"
                    multiple
                    accept="image/*,.pdf,.txt,.md,.doc,.docx,.zip"
                    onChange={(e) => setPendingReplyFiles(Array.from(e.target.files || []))}
                  />
                  Attach files
                </label>
                {pendingReplyFiles.length > 0 && (
                  <span className="stream-page-file-hint">{pendingReplyFiles.length} file(s)</span>
                )}
                <button
                  type="submit"
                  disabled={(!replyContent.trim() && pendingReplyFiles.length === 0) || submitting}
                >
                  Send
                </button>
              </div>
            </form>
          ) : (
            <form className="stream-page-compose" onSubmit={handleNewRoot}>
              <MentionsTextarea
                placeholder="New thread…"
                value={newRootContent}
                onChange={setNewRootContent}
                rows={2}
                disabled={submitting}
              />
              <NoteTypeEventFields
                idPrefix="stream-root"
                noteType={composeNoteType}
                onNoteTypeChange={setComposeNoteType}
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
                <label className="stream-page-file-label">
                  <input
                    ref={rootFileRef}
                    type="file"
                    multiple
                    accept="image/*,.pdf,.txt,.md,.doc,.docx,.zip"
                    onChange={(e) => setPendingRootFiles(Array.from(e.target.files || []))}
                  />
                  Attach files
                </label>
                {pendingRootFiles.length > 0 && (
                  <span className="stream-page-file-hint">{pendingRootFiles.length} file(s)</span>
                )}
                <button
                  type="submit"
                  disabled={(!newRootContent.trim() && pendingRootFiles.length === 0) || submitting}
                >
                  Send
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
      </HoverInsightProvider>
    </Layout>
  );
}
