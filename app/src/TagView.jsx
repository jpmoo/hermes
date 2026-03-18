import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getTags, searchByTags } from './api';
import Layout from './Layout';
import NoteCard from './NoteCard';
import './TagView.css';

export default function TagView() {
  const [allTags, setAllTags] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [mode, setMode] = useState('and');
  const [starredOnly, setStarredOnly] = useState(false);
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(false);
  const { logout } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    getTags({ inUseOnly: true }).then(setAllTags).catch(() => setAllTags([]));
  }, []);

  useEffect(() => {
    if (selectedIds.length === 0) {
      setNotes([]);
      return;
    }
    setLoading(true);
    searchByTags(selectedIds, mode, starredOnly).then(setNotes).catch(() => setNotes([])).finally(() => setLoading(false));
  }, [selectedIds.join(','), mode, starredOnly]);

  const toggleTag = (tag) => {
    setSelectedIds((prev) =>
      prev.includes(tag.id) ? prev.filter((id) => id !== tag.id) : [...prev, tag.id]
    );
  };

  const load = () => {
    getTags({ inUseOnly: true })
      .then((tags) => {
        setAllTags(tags);
        const valid = selectedIds.filter((id) => tags.some((t) => t.id === id));
        setSelectedIds(valid);
        if (valid.length === 0) {
          setNotes([]);
          return;
        }
        setLoading(true);
        return searchByTags(valid, mode, starredOnly)
          .then(setNotes)
          .catch(() => setNotes([]))
          .finally(() => setLoading(false));
      })
      .catch(() => setAllTags([]));
  };

  return (
    <Layout
      title="Tags"
      starredOnly={starredOnly}
      onStarredOnlyChange={setStarredOnly}
      onLogout={logout}
      viewLinks={[
        { to: '/', label: 'Stream' },
        { to: '/outline', label: 'Outline' },
        { to: '/queue', label: 'Queue', tooltip: 'Autotagging approval' },
        { to: '/tags', label: 'Tags' },
        { to: '/search', label: 'Search' },
      ]}
    >
      <div className="tag-view">
        <div className="tag-view-picker">
          <p className="tag-view-label">Select tags (click to filter notes)</p>
          <div className="tag-view-tags">
            {allTags.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`tag-view-tag ${selectedIds.includes(t.id) ? 'tag-view-tag--on' : ''}`}
                onClick={() => toggleTag(t)}
              >
                {t.name}
              </button>
            ))}
          </div>
          {selectedIds.length > 0 && (
            <div className="tag-view-mode">
              <label><input type="radio" checked={mode === 'and'} onChange={() => setMode('and')} /> AND</label>
              <label><input type="radio" checked={mode === 'or'} onChange={() => setMode('or')} /> OR</label>
            </div>
          )}
        </div>

        {loading ? (
          <p className="tag-view-loading">Loading…</p>
        ) : selectedIds.length === 0 ? (
          <p className="tag-view-empty">Select one or more tags above to see matching notes.</p>
        ) : notes.length === 0 ? (
          <p className="tag-view-empty">No notes match the selected tags.</p>
        ) : (
          <ul className="tag-view-list">
            {notes.map((n) => (
              <li key={n.id}>
                <NoteCard
                  note={n}
                  depth={0}
                  hasReplies={(n.reply_count ?? 0) > 0}
                  onOpenThread={() => {
                    const root = n.root_id || n.id;
                    const search =
                      n.parent_id && n.root_id
                        ? `?thread=${root}&focus=${n.id}`
                        : `?thread=${root}`;
                    navigate({ pathname: '/', search });
                  }}
                  onStarredChange={load}
                  onNoteUpdate={load}
                  onNoteDelete={load}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Layout>
  );
}
