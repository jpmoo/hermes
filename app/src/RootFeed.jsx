import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getRoots, createNote } from './api';
import Layout from './Layout';
import NoteCard from './NoteCard';
import './RootFeed.css';

export default function RootFeed() {
  const [roots, setRoots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [starredOnly, setStarredOnly] = useState(false);
  const [newContent, setNewContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { logout } = useAuth();
  const navigate = useNavigate();

  const load = () => getRoots(starredOnly).then(setRoots).finally(() => setLoading(false));

  useEffect(() => {
    load();
  }, [starredOnly]);

  const handleCreateRoot = async (e) => {
    e.preventDefault();
    if (!newContent.trim() || submitting) return;
    setSubmitting(true);
    try {
      const note = await createNote({ content: newContent.trim() });
      setNewContent('');
      setRoots((prev) => [note, ...prev]);
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
          <button type="submit" disabled={!newContent.trim() || submitting}>
            Send
          </button>
        </form>

        {loading ? (
          <p className="root-feed-loading">Loading…</p>
        ) : roots.length === 0 ? (
          <p className="root-feed-empty">
            {starredOnly ? 'No starred threads yet.' : 'No notes yet. Start a thread above.'}
          </p>
        ) : (
          <ul className="root-feed-list">
            {roots.map((n) => (
              <li key={n.id}>
                <NoteCard
                  note={n}
                  depth={0}
                  onOpenThread={() => navigate(`/thread/${n.id}`)}
                  onStarredChange={load}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Layout>
  );
}
