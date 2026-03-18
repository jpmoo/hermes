import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getTags, searchByTags, resubmitTaglessNotes } from './api';
import Layout from './Layout';
import NoteCard from './NoteCard';
import './TagView.css';

export default function TagView() {
  const [allTags, setAllTags] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [mode, setMode] = useState('and');
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [resubmitBusy, setResubmitBusy] = useState(false);
  const [resubmitMsg, setResubmitMsg] = useState(null);
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
    searchByTags(selectedIds, mode, false).then(setNotes).catch(() => setNotes([])).finally(() => setLoading(false));
  }, [selectedIds.join(','), mode]);

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
        return searchByTags(valid, mode, false)
          .then(setNotes)
          .catch(() => setNotes([]))
          .finally(() => setLoading(false));
      })
      .catch(() => setAllTags([]));
  };

  const handleResubmitTagless = async () => {
    setResubmitMsg(null);
    const ok = window.confirm(
      'Send notes that have no approved tags through AI tag suggestion again? Up to 150 notes per run (most recent first). Proposals appear in the Queue; Ollama runs in the background.'
    );
    if (!ok) return;
    setResubmitBusy(true);
    try {
      const { queued, totalTagless, hasMore } = await resubmitTaglessNotes(150);
      if (queued === 0) {
        setResubmitMsg('No tagless notes with text to process.');
      } else {
        setResubmitMsg(
          `Queued ${queued} note${queued === 1 ? '' : 's'} for suggestions${hasMore ? ` (${totalTagless} tagless total — run again for more)` : ''}. Check the Queue in a few minutes.`
        );
      }
    } catch (e) {
      setResubmitMsg(e.message || 'Request failed');
    } finally {
      setResubmitBusy(false);
    }
  };

  return (
    <Layout
      title="Tags"
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
          <div className="tag-view-toolbar">
            <p className="tag-view-label">Select tags (click to filter notes)</p>
            <button
              type="button"
              className="tag-view-resubmit"
              disabled={resubmitBusy}
              onClick={handleResubmitTagless}
            >
              {resubmitBusy ? 'Queueing…' : 'Resubmit tagless notes'}
            </button>
          </div>
          {resubmitMsg && <p className="tag-view-resubmit-msg">{resubmitMsg}</p>}
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
