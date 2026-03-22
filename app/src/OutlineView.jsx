import React, { useState, useEffect, useContext, createContext, useCallback, useRef, useLayoutEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getRoots, getThread } from './api';
import Layout from './Layout';
import { readOutlineExpansion, setOutlineExpanded, setAllOutlineExpansion } from './outlineExpansionStorage';
import './OutlineView.css';

const OutlineExpandContext = createContext({
  expandAllTick: 0,
  collapseAllTick: 0,
});

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

function OutlineNode({ node, depth, streamThreadRootId, onGoToStream, onLoadThread, isMultiRoot }) {
  const { expandAllTick, collapseAllTick } = useContext(OutlineExpandContext);
  const rc = node.reply_count ?? 0;
  const cc = node.children?.length ?? 0;
  const [open, setOpen] = useState(() => {
    const saved = readOutlineExpansion()[node.id];
    if (typeof saved === 'boolean') return saved;
    /* No auto-expand: opening a parent only reveals direct rows; nested parents stay closed until toggled. */
    return false;
  });
  const [loading, setLoading] = useState(false);
  const prevExpandTick = useRef(expandAllTick);
  const prevCollapseTick = useRef(collapseAllTick);

  const childCount = cc;
  const replyCount = rc;
  const hasSubtree = childCount > 0;
  const showToggle =
    hasSubtree || (isMultiRoot && depth === 0 && replyCount > 0);

  useLayoutEffect(() => {
    if (prevExpandTick.current !== expandAllTick) {
      prevExpandTick.current = expandAllTick;
      setOpen(true);
    }
  }, [expandAllTick]);

  useLayoutEffect(() => {
    if (prevCollapseTick.current !== collapseAllTick) {
      prevCollapseTick.current = collapseAllTick;
      setOpen(false);
    }
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

  const handleRowClick = () => {
    if (showToggle) {
      void runToggle();
      return;
    }
    if (streamThreadRootId) {
      onGoToStream?.(streamThreadRootId, node.id);
    }
  };

  return (
    <div className="outline-node">
      <div
        className="outline-row"
        style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
        onClick={handleRowClick}
        {...(!showToggle
          ? {
              role: 'button',
              tabIndex: 0,
              onKeyDown: (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                handleRowClick();
              },
            }
          : {})}
      >
        {showToggle ? (
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
        ) : (
          <span className="outline-spacer" aria-hidden />
        )}
        <span className={`outline-content ${node.starred ? 'outline-content--starred' : ''}`}>
          {node.content || '—'}
        </span>
        {node.starred && <span className="outline-star">★</span>}
      </div>
      {hasSubtree && open && (
        <div className="outline-children">
          {node.children.map((c) => (
            <OutlineNode
              key={c.id}
              node={c}
              depth={depth + 1}
              streamThreadRootId={streamThreadRootId}
              onGoToStream={onGoToStream}
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

  useEffect(() => {
    rootThreadsRef.current = rootThreads;
  }, [rootThreads]);

  useEffect(() => {
    setLoading(true);
    setRootThreads({});
    loadRootInflight.current = new Map();
    getRoots(false).then(setRoots).finally(() => setLoading(false));
  }, []);

  const loadThreadForRoot = useCallback(async (id) => {
    if (rootThreadsRef.current[id]) return;
    if (loadRootInflight.current.has(id)) {
      await loadRootInflight.current.get(id);
      return;
    }
    const p = getThread(id, false)
      .then((flat) => {
        const built = buildTree(flat)[0];
        if (built) {
          setRootThreads((prev) => (prev[id] ? prev : { ...prev, [id]: built }));
        }
      })
      .finally(() => {
        loadRootInflight.current.delete(id);
      });
    loadRootInflight.current.set(id, p);
    await p;
  }, []);

  const tree = roots.map((r) => {
    const loaded = rootThreads[r.id];
    return {
      ...r,
      children: loaded?.children ?? [],
    };
  });

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
    setCollapseAllTick((t) => t + 1);
  };

  return (
    <Layout
      title="Outline"
      onLogout={logout}
      viewLinks={[
        { to: '/', label: 'Stream' },
        { to: '/outline', label: 'Outline' },
        { to: '/tags', label: 'Tags' },
        { to: '/search', label: 'Search' },
      ]}
    >
      <div className="outline-view">
        {!loading && tree.length > 0 && hasAnyExpandable() && (
          <div className="outline-view-toolbar">
            <button type="button" className="outline-view-tool-btn" onClick={handleExpandAll}>
              Expand all
            </button>
            <button type="button" className="outline-view-tool-btn" onClick={handleCollapseAll}>
              Collapse all
            </button>
          </div>
        )}

        {loading ? (
          <p className="outline-view-loading">Loading…</p>
        ) : tree.length === 0 ? (
          <p className="outline-view-empty">No notes.</p>
        ) : (
          <OutlineExpandContext.Provider value={{ expandAllTick, collapseAllTick }}>
            <div className="outline-tree">
              {tree.map((node) => (
                <OutlineNode
                  key={node.id}
                  node={node}
                  depth={0}
                  isMultiRoot
                  streamThreadRootId={node.id}
                  onLoadThread={loadThreadForRoot}
                  onGoToStream={(threadRoot, noteId) => {
                    const q = new URLSearchParams();
                    q.set('thread', threadRoot);
                    if (noteId) q.set('focus', noteId);
                    navigate({ pathname: '/', search: q.toString() });
                  }}
                />
              ))}
            </div>
          </OutlineExpandContext.Provider>
        )}
      </div>
    </Layout>
  );
}
