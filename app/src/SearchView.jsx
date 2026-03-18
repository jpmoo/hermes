import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { searchSemantic, searchContent } from './api';
import Layout from './Layout';
import NoteCard from './NoteCard';
import './SearchView.css';

export default function SearchView() {
  const [q, setQ] = useState('');
  const [searchMode, setSearchMode] = useState('keyword'); // 'keyword' | 'semantic'
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const { logout } = useAuth();
  const navigate = useNavigate();

  const runSearch = async () => {
    if (!q.trim()) return;
    setLoading(true);
    setSearchError(null);
    try {
      const list =
        searchMode === 'keyword'
          ? await searchContent(q.trim(), 40)
          : await searchSemantic(q.trim(), 25);
      setResults(list);
    } catch (err) {
      setResults([]);
      setSearchError(err.message || 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSearch = (e) => {
    e.preventDefault();
    runSearch();
  };

  const reloadResults = () => {
    if (!q.trim()) return;
    setSearchError(null);
    const fn =
      searchMode === 'keyword'
        ? () => searchContent(q.trim(), 40)
        : () => searchSemantic(q.trim(), 25);
    fn()
      .then(setResults)
      .catch((err) => {
        setResults([]);
        setSearchError(err.message);
      });
  };

  return (
    <Layout
      title="Search"
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
          <div className="search-view-field-row">
            <input
              type="search"
              placeholder="Search notes…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="search-view-input"
              aria-label="Search query"
            />
            <button type="submit" disabled={loading}>
              Search
            </button>
          </div>
          <div
            className="search-view-modes"
            role="radiogroup"
            aria-label="Search type"
          >
            <label className="search-view-mode">
              <input
                type="radio"
                name="searchMode"
                value="keyword"
                checked={searchMode === 'keyword'}
                onChange={() => setSearchMode('keyword')}
              />
              <span className="search-view-mode-label">Keyword</span>
              <span className="search-view-mode-hint">Exact text in note body</span>
            </label>
            <label className="search-view-mode">
              <input
                type="radio"
                name="searchMode"
                value="semantic"
                checked={searchMode === 'semantic'}
                onChange={() => setSearchMode('semantic')}
              />
              <span className="search-view-mode-label">Semantic</span>
              <span className="search-view-mode-hint">Meaning &amp; similarity (Ollama)</span>
            </label>
          </div>
        </form>
        {loading && <p className="search-view-loading">Searching…</p>}
        {!loading && results.length > 0 && (
          <ul
            className={`search-view-list${searchMode === 'keyword' ? ' search-view-list--keyword' : ''}`}
          >
            {results.map((n) => (
              <li key={n.id}>
                {searchMode === 'semantic' && n.similarity != null && (
                  <span className="search-view-sim">
                    {Math.round(n.similarity * 100)}%
                  </span>
                )}
                <NoteCard
                  note={n}
                  depth={0}
                  hasReplies={(n.reply_count ?? 0) > 0}
                  onOpenThread={() =>
                    navigate(`/thread/${n.root_id || n.parent_id || n.id}`)
                  }
                  onStarredChange={reloadResults}
                  onNoteUpdate={reloadResults}
                  onNoteDelete={reloadResults}
                />
              </li>
            ))}
          </ul>
        )}
        {!loading && q && results.length === 0 && !searchError && (
          <p className="search-view-empty">
            {searchMode === 'keyword'
              ? 'No notes contain that text.'
              : 'No results. Try Keyword search for exact words, or rephrase for semantic match.'}
          </p>
        )}
      </div>
    </Layout>
  );
}
