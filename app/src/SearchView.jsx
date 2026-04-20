import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getTags, searchByTags, searchSemantic, searchContent, getNoteThreadRoot } from './api';
import MoveNoteModal from './MoveNoteModal';
import Layout from './Layout';
import { HoverInsightProvider } from './HoverInsightContext';
import NoteCard from './NoteCard';
import NoteTypeFilterButtons from './NoteTypeFilterButtons';
import { filterNotesByVisibleNoteTypes } from './noteTypeFilter';
import { SearchNoteTypeFilterProvider, useSearchNoteTypeFilter } from './SearchNoteTypeFilterContext';
import { useNoteTypeColors } from './NoteTypeColorContext';
import StreamThreadImageBackground from './StreamThreadImageBackground';
import { userBackgroundFileUrl } from './attachmentUtils';
import './SearchView.css';

function SearchViewInner() {
  const [allTags, setAllTags] = useState([]);
  const [selectedTagIds, setSelectedTagIds] = useState([]);
  const [tagMode, setTagMode] = useState('and');
  const [q, setQ] = useState('');
  const [searchMode, setSearchMode] = useState('keyword');
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [textSearchRequested, setTextSearchRequested] = useState(false);
  const [moveModal, setMoveModal] = useState(null);
  const qRef = useRef(q);
  qRef.current = q;

  const navigate = useNavigate();
  const { visibleNoteTypes } = useSearchNoteTypeFilter();
  const {
    streamRootBackgroundPresent,
    streamRootBackgroundOpacity,
    canvasUseStreamRootBackground,
    userBackgroundFetchRevision,
    streamBackgroundAnimate,
    streamBackgroundCrtEffect,
  } = useNoteTypeColors();
  const showRootViewportBg = canvasUseStreamRootBackground && streamRootBackgroundPresent;

  const filteredResults = useMemo(
    () => filterNotesByVisibleNoteTypes(results, visibleNoteTypes),
    [results, visibleNoteTypes]
  );

  const fetchResults = useCallback(
    async (tagIdsOverride) => {
      const tagIds = tagIdsOverride ?? selectedTagIds;
      const qtrim = qRef.current.trim();
      const hasTags = tagIds.length > 0;
      const hasQ = qtrim.length > 0;

      if (!hasTags && !hasQ) {
        setResults([]);
        setSearchError(null);
        return;
      }

      setLoading(true);
      setSearchError(null);
      try {
        let list = [];
        if (hasTags && hasQ) {
          const [tagNotes, searchNotes] = await Promise.all([
            searchByTags(tagIds, tagMode, false),
            searchMode === 'keyword'
              ? searchContent(qtrim, 80)
              : searchSemantic(qtrim, 50),
          ]);
          const searchIds = new Set(searchNotes.map((n) => String(n.id)));
          list = tagNotes.filter((n) => searchIds.has(String(n.id)));
          const order = new Map(searchNotes.map((n, i) => [String(n.id), i]));
          list.sort((a, b) => (order.get(String(a.id)) ?? 1e9) - (order.get(String(b.id)) ?? 1e9));
          const simById = new Map(searchNotes.map((n) => [String(n.id), n.similarity]));
          list = list.map((n) => ({ ...n, similarity: simById.get(String(n.id)) }));
        } else if (hasTags) {
          list = await searchByTags(tagIds, tagMode, false);
        } else {
          list =
            searchMode === 'keyword'
              ? await searchContent(qtrim, 40)
              : await searchSemantic(qtrim, 25);
        }
        setResults(list);
      } catch (err) {
        setResults([]);
        setSearchError(err.message || 'Search failed');
      } finally {
        setLoading(false);
      }
    },
    [selectedTagIds, tagMode, searchMode]
  );

  useEffect(() => {
    getTags().then(setAllTags).catch(() => setAllTags([]));
  }, []);

  useEffect(() => {
    if (!q.trim()) {
      setTextSearchRequested(false);
    }
  }, [q]);

  useEffect(() => {
    const hasTags = selectedTagIds.length > 0;
    const hasQ = qRef.current.trim().length > 0;
    if (!hasTags && !hasQ) {
      setResults([]);
      setSearchError(null);
      return;
    }
    if (!hasTags && hasQ) {
      setResults([]);
      return;
    }
    if (hasTags) {
      fetchResults();
    }
  }, [selectedTagIds.join(','), tagMode, fetchResults]);

  const handleSearch = (e) => {
    e.preventDefault();
    const trimmed = q.trim();
    if (!trimmed && selectedTagIds.length === 0) return;
    setTextSearchRequested(true);
    fetchResults();
  };

  const refreshAfterNoteChange = () => {
    getTags()
      .then((tags) => {
        setAllTags(tags);
        const valid = selectedTagIds.filter((id) => tags.some((t) => t.id === id));
        setSelectedTagIds(valid);
        const qtrim = qRef.current.trim();
        if (valid.length === 0 && !qtrim) {
          setResults([]);
          return;
        }
        return fetchResults(valid);
      })
      .catch(() => setAllTags([]));
  };

  const handleOpenMoveNote = useCallback(async (note) => {
    if (!note?.parent_id) return;
    try {
      let root = note.root_id;
      if (!root) {
        root = await getNoteThreadRoot(note.id);
      }
      if (!root) return;
      setMoveModal({ note, threadRootId: root });
    } catch (e) {
      console.error(e);
    }
  }, []);

  const toggleTag = (tag) => {
    setSelectedTagIds((prev) =>
      prev.includes(tag.id) ? prev.filter((id) => id !== tag.id) : [...prev, tag.id]
    );
  };

  const hasTags = selectedTagIds.length > 0;
  const hasQ = q.trim().length > 0;

  return (
    <HoverInsightProvider
      onNoteUpdated={refreshAfterNoteChange}
      onGoToNote={({ noteId, threadRootId }) => {
        navigate({
          pathname: '/stream',
          search: `?thread=${encodeURIComponent(threadRootId)}&focus=${encodeURIComponent(noteId)}`,
        });
      }}
    >
    <div className={`search-view${showRootViewportBg ? ' search-view--root-bg' : ''}`}>
        {showRootViewportBg ? (
          <StreamThreadImageBackground
            fetchUrl={userBackgroundFileUrl(userBackgroundFetchRevision)}
            imageOpacity={streamRootBackgroundOpacity}
            animate={streamBackgroundAnimate}
            crtEffect={streamBackgroundCrtEffect}
          />
        ) : null}
        {searchError && (
          <p className="search-view-error" role="alert">
            {searchError}
          </p>
        )}

        <div className="search-view-query">
          <div className="search-view-types-tags-row">
            <div className="search-view-query-section">
              <p className="search-view-section-label" id="search-section-types">
                Note types
              </p>
              <NoteTypeFilterButtons mode="search" />
            </div>

            <div className="search-view-query-section">
              <p className="search-view-section-label" id="search-section-tags">
                Tags <span className="search-view-section-optional">(optional)</span>
              </p>
              <div className="search-view-tags-row">
                {allTags.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`search-view-tag-chip ${selectedTagIds.includes(t.id) ? 'search-view-tag-chip--on' : ''}`}
                    onClick={() => toggleTag(t)}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
              {hasTags && (
                <div className="search-view-tags-mode" role="radiogroup" aria-label="Tag match mode">
                  <label>
                    <input type="radio" checked={tagMode === 'and'} onChange={() => setTagMode('and')} />
                    Match all tags (AND)
                  </label>
                  <label>
                    <input type="radio" checked={tagMode === 'or'} onChange={() => setTagMode('or')} />
                    Match any tag (OR)
                  </label>
                </div>
              )}
            </div>
          </div>

          <form className="search-view-query-section search-view-form" onSubmit={handleSearch}>
            <p className="search-view-section-label" id="search-section-text">
              Text <span className="search-view-section-optional">(optional if tags are selected)</span>
            </p>
            <div className="search-view-text-controls-row">
              <input
                type="search"
                placeholder="Search notes…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="search-view-input search-view-input--flex"
                aria-labelledby="search-section-text"
              />
              <div className="search-view-modes-inline" role="radiogroup" aria-label="How to match text">
                <label
                  className="search-view-mode-inline"
                  title="Exact text in note body"
                >
                  <input
                    type="radio"
                    name="searchMode"
                    value="keyword"
                    checked={searchMode === 'keyword'}
                    onChange={() => setSearchMode('keyword')}
                  />
                  <span>Keyword</span>
                </label>
                <label
                  className="search-view-mode-inline"
                  title="Meaning and similarity (Ollama)"
                >
                  <input
                    type="radio"
                    name="searchMode"
                    value="semantic"
                    checked={searchMode === 'semantic'}
                    onChange={() => setSearchMode('semantic')}
                  />
                  <span>Semantic</span>
                </label>
              </div>
              <button
                type="submit"
                className="search-view-submit-btn"
                disabled={loading || (!hasQ && !hasTags)}
              >
                Search
              </button>
            </div>
          </form>
        </div>

        <div className="search-view-results">
          {loading && <p className="search-view-loading">Searching…</p>}

          {!loading && results.length > 0 && filteredResults.length === 0 && (
            <p className="search-view-empty">
              No notes match the current note-type filters. Turn on more types in the query panel above.
            </p>
          )}

          {!loading && filteredResults.length > 0 && (
            <ul className="search-view-list">
              {filteredResults.map((n) => (
                <li key={n.id}>
                  {searchMode === 'semantic' && n.similarity != null && (
                    <span className="search-view-sim">{Math.round(n.similarity * 100)}%</span>
                  )}
                  <NoteCard
                    note={n}
                    depth={0}
                    hasReplies={(n.reply_count ?? 0) > 0}
                    hoverInsightEnabled
                    onOpenThread={() => {
                      const root = n.root_id || n.id;
                      const search =
                        n.parent_id && n.root_id
                          ? `?thread=${root}&focus=${n.id}`
                          : `?thread=${root}`;
                      navigate({ pathname: '/stream', search });
                    }}
                    onStarredChange={() => {
                      const id = n.id;
                      setResults((prev) =>
                        prev.map((x) => (x.id === id ? { ...x, starred: !x.starred } : x))
                      );
                    }}
                    onNoteUpdate={refreshAfterNoteChange}
                    onNoteDelete={refreshAfterNoteChange}
                    onMoveNote={handleOpenMoveNote}
                  />
                </li>
              ))}
            </ul>
          )}

          {!loading && !searchError && results.length === 0 && (hasTags || textSearchRequested) && (
            <p className="search-view-empty">
              {hasTags && hasQ
                ? 'No notes match both the selected tags and your search.'
                : hasTags
                  ? 'No notes match the selected tags.'
                  : searchMode === 'keyword'
                    ? 'No notes contain that text.'
                    : 'No results. Try Keyword search for exact words, or rephrase for semantic match.'}
            </p>
          )}
        </div>
      </div>
      <MoveNoteModal
        open={Boolean(moveModal)}
        onClose={() => setMoveModal(null)}
        threadRootId={moveModal?.threadRootId ?? null}
        noteToMove={moveModal?.note ?? null}
        onMoved={() => {
          refreshAfterNoteChange();
          setMoveModal(null);
        }}
      />
    </HoverInsightProvider>
  );
}

export default function SearchView() {
  const { logout } = useAuth();
  return (
    <Layout
      title="Search"
      noteTypeFilterEnabled={false}
      onLogout={logout}
      viewLinks={[
        { to: '/stream', label: 'Stream' },
        { to: '/canvas', label: 'Canvas' },
        { to: '/outline', label: 'Outline' },
        { to: '/calendar', label: 'Calendar' },
        { to: '/search', label: 'Search' },
      ]}
    >
      <SearchNoteTypeFilterProvider>
        <SearchViewInner />
      </SearchNoteTypeFilterProvider>
    </Layout>
  );
}
