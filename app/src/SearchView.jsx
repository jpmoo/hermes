import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { searchSemantic, searchContent } from './api';
import Layout from './Layout';
import NoteCard from './NoteCard';
import './SearchView.css';

export default function SearchView() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const { logout } = useAuth();
  const navigate = useNavigate();

  const handleSearch = async (e) => {
    e.preventDefault();
    if (!q.trim()) return;
    setLoading(true);
    setSearchError(null);
    try {
      const list = await searchSemantic(q.trim(), 25);
      setResults(list);
    } catch (err) {
      setResults([]);
      setSearchError(err.message || 'Semantic search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleTextSearch = async () => {
    if (!q.trim()) return;
    setLoading(true);
    setSearchError(null);
    try {
      const list = await searchContent(q.trim(), 40);
      setResults(list);
    } catch (err) {
      setResults([]);
      setSearchError(err.message || 'Text search failed');
    } finally {
      setLoading(false);
    }
  };

  const load = () => {
    if (!q.trim()) return;
    setSearchError(null);
    searchSemantic(q.trim(), 25).then(setResults).catch((err) => {
      setResults([]);
      setSearchError(err.message);
    });
  };

  return (
    <Layout
      title="Semantic search"
      onLogout={logout}
      viewLinks={[
        { to: '/', label: 'Feed' },
        { to: '/outline', label: 'Outline' },
        { to: '/queue', label: 'Queue' },
        { to: '/tags', label: 'Tags' },
        { to: '/search', label: 'Search' },
        { to: '/orphans', label: 'Orphan files' },
      ]}
    >
      <div className="search-view">
        {searchError && (
          <p className="search-view-error" role="alert">
            {searchError}
          </p>
        )}
        <form className="search-view-form" onSubmit={handleSearch}>
          <input
            type="search"
            placeholder="Search notes…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="search-view-input"
          />
          <button type="submit" disabled={loading}>
            Semantic
          </button>
          <button type="button" disabled={loading} onClick={handleTextSearch}>
            Text contains
          </button>
        </form>
        {loading && <p className="search-view-loading">Searching…</p>}
        {!loading && results.length > 0 && (
          <ul className="search-view-list">
            {results.map((n) => (
              <li key={n.id}>
                {n.similarity != null && (
                  <span className="search-view-sim">{Math.round(n.similarity * 100)}%</span>
                )}
                <NoteCard
                  note={n}
                  depth={0}
                  hasReplies={(n.reply_count ?? 0) > 0}
                  onOpenThread={() => navigate(`/thread/${n.root_id || n.parent_id || n.id}`)}
                  onNoteUpdate={load}
                  onNoteDelete={load}
                />
              </li>
            ))}
          </ul>
        )}
        {!loading && q && results.length === 0 && (
          <p className="search-view-empty">No results. Try different words or check that notes have embeddings (create/edit notes with Ollama running).</p>
        )}
      </div>
    </Layout>
  );
}
