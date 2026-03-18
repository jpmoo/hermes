import React, { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getThread, createNote, uploadNoteFiles } from './api';
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

function findNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    const ch = n.children || [];
    const f = findNode(ch, id);
    if (f) return f;
  }
  return null;
}

function StreamList({ nodes, depth, onFocusNote, onStarredChange, onNoteUpdate, onNoteDelete }) {
  return (
    <>
      {nodes.map((n) => (
        <li key={n.id}>
          <NoteCard
            note={n}
            depth={depth}
            hasReplies={(n.children?.length ?? 0) > 0}
            onOpenThread={() => onFocusNote(n.id)}
            onStarredChange={onStarredChange}
            onNoteUpdate={onNoteUpdate}
            onNoteDelete={onNoteDelete}
          />
          {n.children?.length > 0 && (
            <ul className="stream-view-replies">
              <StreamList
                nodes={n.children}
                depth={depth + 1}
                onFocusNote={onFocusNote}
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
  const [pendingFiles, setPendingFiles] = useState([]);
  const [focusId, setFocusId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef(null);
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

  useEffect(() => {
    setFocusId(null);
  }, [rootId, starredOnly]);

  const tree = buildTree(thread);
  useEffect(() => {
    if (!focusId || !thread.length) return;
    if (!findNode(buildTree(thread), focusId)) setFocusId(null);
  }, [thread, focusId]);

  const threadRootId = thread[0]?.id;
  const focusedNode = focusId && threadRootId ? findNode(tree, focusId) : null;
  const displayTree =
    focusedNode && focusId !== threadRootId
      ? [{ ...focusedNode, children: focusedNode.children || [] }]
      : tree;

  const replyParentId = focusId && focusedNode ? focusId : rootId;
  const focusSnippet = focusedNode?.content?.slice(0, 50) || '';

  const handleReply = async (e) => {
    e.preventDefault();
    const text = replyContent.trim();
    if ((!text && pendingFiles.length === 0) || submitting) return;
    setSubmitting(true);
    try {
      const note = await createNote({ content: text, parent_id: replyParentId });
      if (pendingFiles.length > 0) await uploadNoteFiles(note.id, pendingFiles);
      setReplyContent('');
      setPendingFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      load();
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

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
        { to: '/queue', label: 'Queue' },
        { to: '/orphans', label: 'Orphan files' },
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
            {focusId && focusId !== threadRootId && (
              <div className="stream-view-focus-bar">
                <span className="stream-view-focus-label">Focused: {focusSnippet}{focusedNode?.content?.length > 50 ? '…' : ''}</span>
                <button type="button" className="stream-view-focus-clear" onClick={() => setFocusId(null)}>
                  Show full thread
                </button>
              </div>
            )}

            <form className="stream-view-compose" onSubmit={handleReply}>
              <textarea
                placeholder={
                  replyParentId === rootId
                    ? 'Reply to thread…'
                    : `Reply to “${focusSnippet.slice(0, 36)}${focusSnippet.length > 36 ? '…' : ''}”…`
                }
                value={replyContent}
                onChange={(e) => setReplyContent(e.target.value)}
                rows={2}
              />
              <div className="stream-view-compose-row">
                <label className="stream-view-file-label">
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="image/*,.pdf,.txt,.md,.doc,.docx,.zip"
                    onChange={(e) => setPendingFiles(Array.from(e.target.files || []))}
                  />
                  Attach files
                </label>
                {pendingFiles.length > 0 && (
                  <span className="stream-view-file-hint">{pendingFiles.length} file(s) selected</span>
                )}
                <button type="submit" disabled={(!replyContent.trim() && pendingFiles.length === 0) || submitting}>
                  Send
                </button>
              </div>
            </form>

            <ul className="stream-view-list">
              <StreamList
                nodes={displayTree}
                depth={0}
                onFocusNote={setFocusId}
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
