import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getRoots, createNote, uploadNoteFiles, getNote } from './api';
import Layout from './Layout';
import NoteCard from './NoteCard';
import './RootFeed.css';

export default function RootFeed() {
  const [roots, setRoots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [starredOnly, setStarredOnly] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [pendingFiles, setPendingFiles] = useState([]);
  const fileInputRef = useRef(null);
  const { logout } = useAuth();
  const navigate = useNavigate();

  const load = () => {
    setLoadError(null);
    return getRoots(starredOnly)
      .then((data) => setRoots(data))
      .catch((err) => {
        console.error(err);
        setRoots([]);
        setLoadError(err.message || 'Could not load notes (check server is running and you are logged in).');
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [starredOnly]);

  const handleCreateRoot = async (e) => {
    e.preventDefault();
    const text = newContent.trim();
    if ((!text && pendingFiles.length === 0) || submitting) return;
    setSubmitting(true);
    try {
      const note = await createNote({ content: text });
      if (pendingFiles.length > 0) await uploadNoteFiles(note.id, pendingFiles);
      const full =
        pendingFiles.length > 0
          ? await getNote(note.id)
          : { ...note, reply_count: note.reply_count ?? 0, attachments: note.attachments || [] };
      setNewContent('');
      setPendingFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      setRoots((prev) => [full, ...prev.filter((x) => x.id !== full.id)]);
    } catch (err) {
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Layout
      title="Root feed"
      starredOnly={starredOnly}
      onStarredOnlyChange={setStarredOnly}
      onLogout={logout}
      viewLinks={[
        { to: '/', label: 'Feed' },
        { to: '/outline', label: 'Outline' },
        { to: '/queue', label: 'Queue' },
        { to: '/tags', label: 'Tags' },
        { to: '/search', label: 'Search' },
      ]}
    >
      <div className="root-feed">
        <form className="root-feed-compose" onSubmit={handleCreateRoot}>
          <textarea
            placeholder="New thought…"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            rows={2}
          />
          <div className="root-feed-compose-row">
            <label className="root-feed-file-label">
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
              <span className="root-feed-file-hint">{pendingFiles.length} file(s) selected</span>
            )}
            <button
              type="submit"
              disabled={(!newContent.trim() && pendingFiles.length === 0) || submitting}
            >
              Send
            </button>
          </div>
        </form>

        {loadError && (
          <p className="root-feed-error" role="alert">
            {loadError}
          </p>
        )}
        {loading ? (
          <p className="root-feed-loading">Loading…</p>
        ) : roots.length === 0 && !loadError ? (
          <p className="root-feed-empty">
            {starredOnly ? 'No starred threads yet.' : 'No notes yet. Start a thread above.'}
          </p>
        ) : roots.length > 0 ? (
          <ul className="root-feed-list">
            {roots.map((n) => (
              <li key={n.id}>
                <NoteCard
                  note={n}
                  depth={0}
                  hasReplies={(n.reply_count ?? 0) > 0}
                  onOpenThread={() => navigate(`/thread/${n.id}`)}
                  onStarredChange={load}
                  onNoteUpdate={load}
                  onNoteDelete={load}
                />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Layout>
  );
}
