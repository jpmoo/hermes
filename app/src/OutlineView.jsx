import React, {
  useState,
  useEffect,
  useContext,
  createContext,
  useCallback,
  useRef,
  useLayoutEffect,
  useMemo,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getRoots, getThread, getNoteThreadRoot, updateNote } from './api';
import Layout from './Layout';
import { readOutlineExpansion, setOutlineExpanded, setAllOutlineExpansion } from './outlineExpansionStorage';
import NoteTypeIcon from './NoteTypeIcon';
import NoteRichText from './NoteRichText';
import { filterTreeByVisibleNoteTypes } from './noteTypeFilter';
import { sortNoteTreeByThreadOrder, noteThreadSortKeyMs } from './noteThreadSort';
import { useNoteTypeFilter } from './NoteTypeFilterContext';
import './OutlineView.css';

const OutlineExpandContext = createContext({
  expandAllTick: 0,
  collapseAllTick: 0,
});

const OutlineDndContext = createContext(null);

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

function collectNoteIds(nodes) {
  const ids = [];
  for (const n of nodes) {
    ids.push(n.id);
    if (n.children?.length) ids.push(...collectNoteIds(n.children));
  }
  return ids;
}

function sortStarredPinned(nodes) {
  if (!nodes?.length) return nodes || [];
  const starred = [];
  const rest = [];
  for (const n of nodes) {
    const withKids = {
      ...n,
      children: sortStarredPinned(n.children || []),
    };
    if (withKids.starred) starred.push(withKids);
    else rest.push(withKids);
  }
  starred.sort((a, b) => {
    const d = noteThreadSortKeyMs(b) - noteThreadSortKeyMs(a);
    if (d !== 0) return d;
    return String(a.id).localeCompare(String(b.id));
  });
  return [...starred, ...rest];
}

function OutlineNode({ node, depth, streamThreadRootId, onGoToStream, onOpenLinkedNote, onLoadThread, isMultiRoot }) {
  const { expandAllTick, collapseAllTick } = useContext(OutlineExpandContext);
  const dnd = useContext(OutlineDndContext);
  const rc = node.reply_count ?? 0;
  const cc = node.children?.length ?? 0;
  const [open, setOpen] = useState(() => {
    const saved = readOutlineExpansion()[node.id];
    if (typeof saved === 'boolean') return saved;
    /* No auto-expand: opening a parent only reveals direct rows; nested parents stay closed until toggled. */
    return false;
  });
  const [loading, setLoading] = useState(false);
  /** `undefined` = not yet synced; avoids matching tick on first mount and skipping open (Expand all). */
  const prevExpandTick = useRef(undefined);
  const prevCollapseTick = useRef(undefined);

  const childCount = cc;
  const replyCount = rc;
  const hasSubtree = childCount > 0;
  const showToggle =
    hasSubtree || (isMultiRoot && depth === 0 && replyCount > 0);

  useLayoutEffect(() => {
    if (prevExpandTick.current === expandAllTick) return;
    prevExpandTick.current = expandAllTick;
    if (expandAllTick > 0) setOpen(true);
  }, [expandAllTick]);

  useLayoutEffect(() => {
    if (prevCollapseTick.current === collapseAllTick) return;
    const prev = prevCollapseTick.current;
    prevCollapseTick.current = collapseAllTick;
    if (prev !== undefined && collapseAllTick > 0) setOpen(false);
  }, [collapseAllTick]);

  /** Same behavior as the ▼/▶ control: load root thread and/or flip expand state. */
  const runToggle = async () => {
    if (loading) return;
    if (!hasSubtree && replyCount > 0 && onLoadThread && depth === 0) {
      setLoading(true);
      try {
        await onLoadThread(node.id);
      } finally {
        setLoading(false);
      }
      setOpen(true);
      setOutlineExpanded(node.id, true);
      return;
    }
    setOpen((prev) => {
      const next = !prev;
      setOutlineExpanded(node.id, next);
      return next;
    });
  };

  const handleToggleClick = (e) => {
    e.stopPropagation();
    void runToggle();
  };

  const openInStream = () => {
    if (streamThreadRootId) {
      onGoToStream?.(streamThreadRootId, node.id);
    }
  };

  const streamKeyDown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openInStream();
  };

  const rowPad = { paddingLeft: `${depth * 1.25 + 0.5}rem` };

  const tagNames = Array.isArray(node.tags) ? node.tags.map((t) => t?.name ?? t) : [];

  const rowMain = (
    <>
      <NoteTypeIcon type={node.note_type || 'note'} className="outline-type-icon" />
      <span
        className={`outline-content outline-content--rich ${node.starred ? 'outline-content--starred' : ''}`}
      >
        <NoteRichText
          text={node.content}
          tagNames={tagNames}
          className="outline-content-rich-inner"
          onNoteClick={onOpenLinkedNote}
          stopClickPropagation={false}
        />
      </span>
      {node.starred && <span className="outline-star">★</span>}
    </>
  );

  const rowDropProps = dnd
    ? {
        onDragOver: (e) => dnd.onDragOverRow(node.id, e),
        onDrop: (e) => dnd.onDropOnRow(node.id, e),
      }
    : {};

  const dragHandle = dnd ? (
    <span
      className="outline-drag-handle"
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        dnd.onDragStart(node.id, e);
      }}
      onDragEnd={dnd.onDragEnd}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      role="button"
      tabIndex={0}
      aria-label="Drag to move this note"
      title="Drag to move (nest under another row, or drop on top strip for top-level)"
    >
      ⋮⋮
    </span>
  ) : null;

  const nt = node.note_type || 'note';
  const typeRowClass =
    nt === 'organization'
      ? 'outline-row--type-organization'
      : nt === 'person'
        ? 'outline-row--type-person'
        : nt === 'event'
          ? 'outline-row--type-event'
          : '';

  const rowStateClass =
    dnd && dnd.draggingId === node.id
      ? 'outline-row--dragging'
      : dnd && dnd.dropOverId === node.id && dnd.draggingId && dnd.draggingId !== node.id
        ? 'outline-row--drop-target'
        : '';

  const rowClass = ['outline-row', typeRowClass, rowStateClass].filter(Boolean).join(' ');

  const mainClass =
    dnd && dnd.dropOverId === node.id && dnd.draggingId && dnd.draggingId !== node.id
      ? 'outline-row-main outline-row-main--drop-target'
      : 'outline-row-main';

  const handleMainClick = (e) => {
    if (dnd?.consumePostDragRowClick?.()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    /* Let clicks bubble from rich text; http/mailto links keep native behavior without opening Stream. */
    if (e.target.closest?.('button.note-rich-mention')) return;
    const linkEl = e.target.closest?.('a.note-rich-link');
    if (linkEl) {
      const href = linkEl.getAttribute('href')?.trim() || '';
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) return;
      e.preventDefault();
    }
    openInStream();
  };

  return (
    <div className="outline-node">
      {showToggle ? (
        <div className={rowClass} style={rowPad} {...rowDropProps}>
          {dragHandle}
          <button
            type="button"
            className="outline-toggle"
            onClick={handleToggleClick}
            aria-expanded={open && (hasSubtree || loading)}
            disabled={loading}
            title={open ? 'Collapse replies' : 'Expand replies'}
          >
            {loading ? '…' : open ? '▼' : '▶'}
          </button>
          <div
            className={mainClass}
            role="button"
            tabIndex={0}
            aria-label="Open this note in Stream (focused)"
            title="Open in Stream"
            onClick={handleMainClick}
            onKeyDown={streamKeyDown}
          >
            {rowMain}
          </div>
        </div>
      ) : (
        <div className={rowClass} style={rowPad} {...rowDropProps}>
          {dragHandle}
          <span className="outline-spacer" aria-hidden />
          <div
            className={mainClass}
            role="button"
            tabIndex={0}
            aria-label="Open this note in Stream (focused)"
            title="Open in Stream"
            onClick={handleMainClick}
            onKeyDown={streamKeyDown}
          >
            {rowMain}
          </div>
        </div>
      )}
      {hasSubtree && open && (
        <div className="outline-children">
          {node.children.map((c) => (
            <OutlineNode
              key={c.id}
              node={c}
              depth={depth + 1}
              streamThreadRootId={streamThreadRootId}
              onGoToStream={onGoToStream}
              onOpenLinkedNote={onOpenLinkedNote}
              onLoadThread={null}
              isMultiRoot={isMultiRoot}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function OutlineView() {
  const [roots, setRoots] = useState([]);
  const [rootThreads, setRootThreads] = useState({});
  const [loading, setLoading] = useState(true);
  const [expandAllTick, setExpandAllTick] = useState(0);
  const [collapseAllTick, setCollapseAllTick] = useState(0);
  const loadRootInflight = useRef(new Map());
  const rootThreadsRef = useRef({});
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { visibleNoteTypes } = useNoteTypeFilter();

  useEffect(() => {
    rootThreadsRef.current = rootThreads;
  }, [rootThreads]);

  useEffect(() => {
    setLoading(true);
    setRootThreads({});
    loadRootInflight.current = new Map();
    getRoots(false).then(setRoots).finally(() => setLoading(false));
  }, []);

  const loadThreadForRoot = useCallback(async (id, force = false) => {
    if (!force && rootThreadsRef.current[id]) return;
    if (loadRootInflight.current.has(id)) {
      if (!force) {
        await loadRootInflight.current.get(id);
        return;
      }
      loadRootInflight.current.delete(id);
    }
    const p = getThread(id, false)
      .then((flat) => {
        const rootsSorted = sortStarredPinned(sortNoteTreeByThreadOrder(buildTree(flat)));
        const built = rootsSorted[0];
        if (built) {
          setRootThreads((prev) => ({ ...prev, [id]: built }));
        }
      })
      .finally(() => {
        loadRootInflight.current.delete(id);
      });
    loadRootInflight.current.set(id, p);
    await p;
  }, []);

  /** Re-fetch thread bodies for roots saved as expanded (otherwise ▼ shows but children are empty). */
  useEffect(() => {
    if (loading || roots.length === 0) return;
    const map = readOutlineExpansion();
    const needLoad = roots.filter(
      (r) =>
        map[r.id] === true &&
        (r.reply_count ?? 0) > 0 &&
        !rootThreads[r.id]
    );
    if (needLoad.length === 0) return;
    void Promise.all(needLoad.map((r) => loadThreadForRoot(r.id)));
  }, [loading, roots, rootThreads, loadThreadForRoot]);

  const treeRaw = useMemo(
    () =>
      roots.map((r) => {
        const loaded = rootThreads[r.id];
        return {
          ...r,
          children: loaded?.children ?? [],
        };
      }),
    [roots, rootThreads]
  );

  const tree = useMemo(
    () => sortStarredPinned(sortNoteTreeByThreadOrder(filterTreeByVisibleNoteTypes(treeRaw, visibleNoteTypes))),
    [treeRaw, visibleNoteTypes]
  );

  const treeRef = useRef(tree);
  treeRef.current = tree;

  useEffect(() => {
    if (expandAllTick === 0) return;
    let cancelled = false;
    const persist = () => {
      if (cancelled) return;
      const ids = collectNoteIds(treeRef.current);
      setAllOutlineExpansion(ids, true);
    };
    const id0 = requestAnimationFrame(() => {
      if (cancelled) return;
      persist();
      requestAnimationFrame(() => {
        if (cancelled) return;
        persist();
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(id0);
    };
  }, [expandAllTick]);

  useEffect(() => {
    if (collapseAllTick === 0) return;
    const id = requestAnimationFrame(() => {
      const ids = collectNoteIds(treeRef.current);
      setAllOutlineExpansion(ids, false);
    });
    return () => cancelAnimationFrame(id);
  }, [collapseAllTick]);

  const hasAnyExpandable = useCallback(() => {
    function walk(nodes) {
      for (const n of nodes) {
        if ((n.children?.length ?? 0) > 0 || (n.reply_count ?? 0) > 0) return true;
      }
      return false;
    }
    return walk(tree);
  }, [tree]);

  const handleExpandAll = async () => {
    const needLoad = roots.filter((r) => (r.reply_count ?? 0) > 0 && !rootThreads[r.id]);
    await Promise.all(needLoad.map((r) => loadThreadForRoot(r.id)));
    setExpandAllTick((t) => t + 1);
  };

  const handleCollapseAll = () => {
    setExpandAllTick(0);
    setCollapseAllTick((t) => t + 1);
  };

  const openLinkedNote = useCallback(
    async (linkedId) => {
      try {
        const root = await getNoteThreadRoot(linkedId);
        const q = new URLSearchParams();
        q.set('thread', root);
        q.set('focus', linkedId);
        navigate({ pathname: '/', search: q.toString() });
      } catch (e) {
        console.error(e);
      }
    },
    [navigate]
  );

  const draggingIdRef = useRef(null);
  /**
   * After drag-end/drop, some browsers emit a stray click. We used to block *all* row clicks for 250ms,
   * which also swallowed a genuine double-click (both clicks suppressed) — common right after moving a row.
   * Only ignore the next row-main click once; optional timer clears the flag if no click arrives.
   */
  const suppressNextRowClickRef = useRef(false);
  const suppressNextRowClickTimerRef = useRef(null);
  const [draggingId, setDraggingId] = useState(null);
  const [dropOverId, setDropOverId] = useState(null);

  const finishDragUi = useCallback(() => {
    if (suppressNextRowClickTimerRef.current) {
      clearTimeout(suppressNextRowClickTimerRef.current);
      suppressNextRowClickTimerRef.current = null;
    }
    suppressNextRowClickRef.current = true;
    suppressNextRowClickTimerRef.current = window.setTimeout(() => {
      suppressNextRowClickTimerRef.current = null;
      suppressNextRowClickRef.current = false;
    }, 400);
    draggingIdRef.current = null;
    setDraggingId(null);
    setDropOverId(null);
  }, []);

  /** First row-main click after drag/drop: swallow stray activation; clear timer so later clicks work. */
  const consumePostDragRowClick = useCallback(() => {
    if (!suppressNextRowClickRef.current) return false;
    suppressNextRowClickRef.current = false;
    if (suppressNextRowClickTimerRef.current) {
      clearTimeout(suppressNextRowClickTimerRef.current);
      suppressNextRowClickTimerRef.current = null;
    }
    return true;
  }, []);

  const refreshOutlineData = useCallback(async () => {
    loadRootInflight.current.clear();
    rootThreadsRef.current = {};
    setRootThreads({});
    const nr = await getRoots(false);
    setRoots(nr);
    const map = readOutlineExpansion();
    await Promise.all(
      nr
        .filter((r) => (r.reply_count ?? 0) > 0 && map[r.id] === true)
        .map((r) => loadThreadForRoot(r.id, true))
    );
  }, [loadThreadForRoot]);

  const performReparent = useCallback(
    async (draggedId, newParentId) => {
      try {
        await updateNote(draggedId, { parent_id: newParentId });
        await refreshOutlineData();
      } catch (err) {
        console.error(err);
        alert(err.message || 'Could not move note');
      }
    },
    [refreshOutlineData]
  );

  const onDragStart = useCallback((noteId, e) => {
    draggingIdRef.current = noteId;
    e.dataTransfer.setData('text/plain', noteId);
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('application/x-hermes-note-id', noteId);
    } catch {
      /* some browsers restrict custom types */
    }
    /* Defer React state so the first paint doesn’t cancel native drag (esp. with nested links). */
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setDraggingId(noteId));
    });
  }, []);

  const onDragEnd = useCallback(() => {
    finishDragUi();
  }, [finishDragUi]);

  const onDragOverRow = useCallback((targetId, e) => {
    if (!draggingIdRef.current || draggingIdRef.current === targetId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropOverId(targetId);
  }, []);

  const onDropOnRow = useCallback(
    (targetId, e) => {
      e.preventDefault();
      const dragged =
        e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('application/x-hermes-note-id');
      finishDragUi();
      if (!dragged || dragged === targetId) return;
      void performReparent(dragged, targetId);
    },
    [finishDragUi, performReparent]
  );

  const onDragOverRoot = useCallback((e) => {
    if (!draggingIdRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropOverId('__root__');
  }, []);

  const onDropRoot = useCallback(
    (e) => {
      e.preventDefault();
      const dragged =
        e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('application/x-hermes-note-id');
      finishDragUi();
      if (!dragged) return;
      void performReparent(dragged, null);
    },
    [finishDragUi, performReparent]
  );

  const outlineDndValue = useMemo(
    () => ({
      draggingId,
      dropOverId,
      consumePostDragRowClick,
      onDragStart,
      onDragEnd,
      onDragOverRow,
      onDropOnRow,
    }),
    [draggingId, dropOverId, consumePostDragRowClick, onDragStart, onDragEnd, onDragOverRow, onDropOnRow]
  );

  return (
    <Layout
      title="Outline"
      noteTypeFilterEnabled
      onLogout={logout}
      viewLinks={[
        { to: '/', label: 'Stream' },
        { to: '/outline', label: 'Outline' },
        { to: '/tags', label: 'Tags' },
        { to: '/search', label: 'Search' },
      ]}
    >
      <div className="outline-view">
        {!loading && tree.length > 0 && (
          <div className="outline-view-toolbar">
            <div
              className={`outline-drop-root ${dropOverId === '__root__' ? 'outline-drop-root--active' : ''} ${draggingId ? 'outline-drop-root--dragging' : ''}`}
              onDragEnter={onDragOverRoot}
              onDragOver={onDragOverRoot}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) setDropOverId((id) => (id === '__root__' ? null : id));
              }}
              onDrop={onDropRoot}
            >
              {draggingId
                ? 'Release here to make this a top-level thread'
                : 'Drag ⋮⋮ here to move note/thread to root level.'}
            </div>
            {hasAnyExpandable() ? (
              <>
                <button type="button" className="outline-view-tool-btn" onClick={handleExpandAll}>
                  Expand all
                </button>
                <button type="button" className="outline-view-tool-btn" onClick={handleCollapseAll}>
                  Collapse all
                </button>
              </>
            ) : null}
          </div>
        )}

        {loading ? (
          <p className="outline-view-loading">Loading…</p>
        ) : !loading && roots.length > 0 && tree.length === 0 ? (
          <p className="outline-view-empty">No notes match the current type filters.</p>
        ) : tree.length === 0 ? (
          <p className="outline-view-empty">No notes.</p>
        ) : (
          <OutlineExpandContext.Provider value={{ expandAllTick, collapseAllTick }}>
            <OutlineDndContext.Provider value={outlineDndValue}>
              <div className="outline-tree">
                {tree.map((node) => (
                  <OutlineNode
                    key={node.id}
                    node={node}
                    depth={0}
                    isMultiRoot
                    streamThreadRootId={node.id}
                    onLoadThread={loadThreadForRoot}
                    onOpenLinkedNote={openLinkedNote}
                    onGoToStream={(threadRoot, noteId) => {
                      const q = new URLSearchParams();
                      q.set('thread', threadRoot);
                      if (noteId) q.set('focus', noteId);
                      navigate({ pathname: '/', search: q.toString() });
                    }}
                  />
                ))}
              </div>
            </OutlineDndContext.Provider>
          </OutlineExpandContext.Provider>
        )}
      </div>
    </Layout>
  );
}
