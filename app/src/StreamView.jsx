import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getThread, createNote, getNote } from './api';
import Layout from './Layout';
import NoteCard from './NoteCard';
import './StreamView.css';

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

function StreamList({ nodes, depth, onOpenThread, onStarredChange, onNoteUpdate, onNoteDelete }) {
  return (
    <>
      {nodes.map((n) => (
        <li key={n.id}>
          <NoteCard
            note={n}
            depth={depth}
            onOpenThread={() => onOpenThread(n.id)}
            onStarredChange={onStarredChange}
            onNoteUpdate={onNoteUpdate}
            onNoteDelete={onNoteDelete}
          />
          {n.children?.length > 0 && (
            <ul className="stream-view-replies">
              <StreamList
                nodes={n.children}
                depth={depth + 1}
                onOpenThread={onOpenThread}
                onStarredChange={onStarredChange}
                onNoteUpdate={onNoteUpdate}
                onNoteDelete={onNoteDelete}
              />
            </ul>
          )}
        </li>
      ))}
    </>
  );
}

export default function StreamView() {
  const { rootId } = useParams();
  const [thread, setThread] = useState([]);
  const [rootNote, setRootNote] = useState(null);
  const [loading, setLoading] = useState(true);
  const [starredOnly, setStarredOnly] = useState(false);
  const [replyContent, setReplyContent] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const { logout } = useAuth();
  const navigate = useNavigate();

  const load = () =>
    getThread(rootId, starredOnly)
      .then((rows) => {
        setThread(rows);
        if (rows.length) setRootNote(rows[0]);
        if (rows.length === 0 && rootId) navigate('/');
      })
      .catch(() => {
        setThread([]);
        navigate('/');
      })
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
  }, [rootId, starredOnly]);

  const handleReply = async (e, parentId) => {
    e.preventDefault();
    const content = parentId === rootId ? replyContent : (e.target.querySelector('textarea')?.value ?? '');
    if (!content?.trim() || submitting) return;
    setSubmitting(true);
    try {
      await createNote({ content: content.trim(), parent_id: parentId });
      setReplyContent('');
      setReplyTo(null);
      load();
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  const tree = buildTree(thread);

  return (
    <Layout
      title={rootNote ? (rootNote.content?.slice(0, 40) + (rootNote.content?.length > 40 ? '…' : '')) : 'Thread'}
      starredOnly={starredOnly}
      onStarredOnlyChange={setStarredOnly}
      onLogout={logout}
      viewLinks={[
        { to: '/', label: 'Feed' },
        { to: `/thread/${rootId}`, label: 'Stream' },
        { to: `/outline/${rootId}`, label: 'Outline' },
      ]}
    >
      <div className="stream-view">
        <button type="button" className="stream-view-back" onClick={() => navigate('/')}>
          ← Feed
        </button>

        {loading ? (
          <p className="stream-view-loading">Loading thread…</p>
        ) : thread.length === 0 ? (
          <p className="stream-view-empty">Thread not found.</p>
        ) : (
          <>
            <form className="stream-view-compose" onSubmit={(e) => handleReply(e, rootId)}>
              <textarea
                placeholder="Reply to thread…"
                value={replyContent}
                onChange={(e) => setReplyContent(e.target.value)}
                rows={2}
              />
              <button type="submit" disabled={!replyContent.trim() || submitting}>
                Reply
              </button>
            </form>

            <ul className="stream-view-list">
              <StreamList
                nodes={tree}
                depth={0}
                onOpenThread={(id) => (id === rootId ? null : setReplyTo(id))}
                onStarredChange={load}
                onNoteUpdate={load}
                onNoteDelete={load}
              />
            </ul>
          </>
        )}
      </div>
    </Layout>
  );
}
