import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getRoots, getThread } from './api';
import Layout from './Layout';
import './OutlineView.css';

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

function OutlineNode({ node, depth, onSelect }) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children?.length > 0;

  return (
    <div className="outline-node">
      <div
        className="outline-row"
        style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
        onClick={() => onSelect?.(node.id)}
      >
        {hasChildren && (
          <button
            type="button"
            className="outline-toggle"
            onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
            aria-expanded={open}
          >
            {open ? '▼' : '▶'}
          </button>
        )}
        {!hasChildren && <span className="outline-spacer" />}
        <span className={`outline-content ${node.starred ? 'outline-content--starred' : ''}`}>
          {node.content || '—'}
        </span>
        {node.starred && <span className="outline-star">★</span>}
      </div>
      {hasChildren && open && (
        <div className="outline-children">
          {node.children.map((c) => (
            <OutlineNode key={c.id} node={c} depth={depth + 1} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function OutlineView() {
  const { rootId } = useParams();
  const [roots, setRoots] = useState([]);
  const [thread, setThread] = useState([]);
  const [loading, setLoading] = useState(true);
  const [starredOnly, setStarredOnly] = useState(false);
  const { logout } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (rootId) {
      getThread(rootId, starredOnly).then(setThread).finally(() => setLoading(false));
    } else {
      getRoots(starredOnly).then(setRoots).finally(() => setLoading(false));
    }
  }, [rootId, starredOnly]);

  const tree = rootId ? buildTree(thread) : roots.map((r) => ({ ...r, children: [] }));
  const isThread = Boolean(rootId);

  return (
    <Layout
      title={isThread ? 'Outline' : 'All notes (outline)'}
      starredOnly={starredOnly}
      onStarredOnlyChange={setStarredOnly}
      onLogout={logout}
      viewLinks={[
        { to: '/', label: 'Feed' },
        { to: '/outline', label: 'Outline' },
      ]}
    >
      <div className="outline-view">
        {rootId && (
          <button type="button" className="outline-view-back" onClick={() => navigate('/outline')}>
            ← All threads
          </button>
        )}

        {loading ? (
          <p className="outline-view-loading">Loading…</p>
        ) : tree.length === 0 ? (
          <p className="outline-view-empty">No notes.</p>
        ) : (
          <div className="outline-tree">
            {tree.map((node) => (
              <OutlineNode
                key={node.id}
                node={node}
                depth={0}
                onSelect={(id) => {
                  if (isThread) navigate(`/thread/${rootId}`);
                  else navigate(`/outline/${id}`);
                }}
              />
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
