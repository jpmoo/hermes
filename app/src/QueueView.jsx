import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import {
  getQueue,
  getQueueCount,
  approveProposal,
  rejectProposal,
  resubmitTaglessNotes,
} from './api';
import Layout from './Layout';
import './QueueView.css';

export default function QueueView() {
  const [items, setItems] = useState([]);
  const [count, setCount] = useState(0);
  const [minConfidencePercent, setMinConfidencePercent] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actioning, setActioning] = useState(new Set());
  const [resubmitBusy, setResubmitBusy] = useState(false);
  const [resubmitMsg, setResubmitMsg] = useState(null);
  const { logout } = useAuth();
  const navigate = useNavigate();

  const load = () => {
    setLoading(true);
    Promise.all([
      getQueue(minConfidencePercent / 100),
      getQueueCount(minConfidencePercent / 100),
    ])
      .then(([list, { count: c }]) => {
        setItems(list);
        setCount(c);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [minConfidencePercent]);

  const handleApprove = async (id) => {
    setActioning((s) => new Set(s).add(id));
    try {
      await approveProposal(id);
      load();
    } catch (err) {
      console.error(err);
    } finally {
      setActioning((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  const handleReject = async (id) => {
    setActioning((s) => new Set(s).add(id));
    try {
      await rejectProposal(id);
      load();
    } catch (err) {
      console.error(err);
    } finally {
      setActioning((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  const handleApproveAll = async () => {
    for (const it of items) {
      await approveProposal(it.id).catch(() => {});
    }
    load();
  };

  const handleResubmitTagless = async () => {
    setResubmitMsg(null);
    const ok = window.confirm(
      'Send notes that have no approved tags through AI tag suggestion again? Up to 150 notes per run (most recent first). New proposals will appear here as Ollama finishes (refresh or wait).'
    );
    if (!ok) return;
    setResubmitBusy(true);
    try {
      const { queued, totalTagless, hasMore } = await resubmitTaglessNotes(150);
      if (queued === 0) {
        setResubmitMsg('No tagless notes with text to process.');
      } else {
        setResubmitMsg(
          `Queued ${queued} note${queued === 1 ? '' : 's'} for suggestions${hasMore ? ` (${totalTagless} tagless total — run again for more)` : ''}. Items will show up below as they are generated.`
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
      title="Tag approval queue"
      onLogout={logout}
      viewLinks={[
        { to: '/', label: 'Stream' },
        { to: '/outline', label: 'Outline' },
        { to: '/queue', label: 'Queue', tooltip: 'Autotagging approval' },
        { to: '/tags', label: 'Tags' },
        { to: '/search', label: 'Search' },
      ]}
    >
      <div className="queue-view">
        <div className="queue-view-toolbar">
          <label className="queue-view-slider">
            <span>Min confidence</span>
            <input
              type="range"
              min="0"
              max="100"
              step="10"
              value={minConfidencePercent}
              onChange={(e) => setMinConfidencePercent(Number(e.target.value))}
            />
            <span>{minConfidencePercent}%</span>
          </label>
          {items.length > 0 && (
            <button type="button" className="queue-view-approve-all" onClick={handleApproveAll}>
              Approve all visible
            </button>
          )}
          <button
            type="button"
            className="queue-view-resubmit"
            disabled={resubmitBusy}
            onClick={handleResubmitTagless}
          >
            {resubmitBusy ? 'Queueing…' : 'Resubmit tagless notes'}
          </button>
        </div>
        {resubmitMsg && <p className="queue-view-resubmit-msg">{resubmitMsg}</p>}

        {loading ? (
          <p className="queue-view-loading">Loading…</p>
        ) : items.length === 0 ? (
          <p className="queue-view-empty">No pending tag proposals. Create or edit notes to get AI suggestions.</p>
        ) : (
          <ul className="queue-view-list">
            {items.map((it) => (
              <li key={it.id} className="queue-view-item">
                <div className="queue-view-item-header">
                  <strong className="queue-view-tag">#{it.tag_name}</strong>
                  {it.confidence != null && (
                    <span className="queue-view-confidence">{(it.confidence * 100).toFixed(0)}%</span>
                  )}
                </div>
                <p className="queue-view-note-content">{it.note_content || '—'}</p>
                {it.ancestry?.length > 1 && (
                  <div className="queue-view-ancestry">
                    <span>Thread: </span>
                    {it.ancestry.map((a, i) => (
                      <span key={a.id}>
                        {i > 0 && ' → '}
                        <button type="button" onClick={() =>
                          navigate({
                            pathname: '/',
                            search: `?thread=${it.ancestry[0].id}`,
                          })
                        }>
                          {a.content?.slice(0, 50)}{a.content?.length > 50 ? '…' : ''}
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="queue-view-item-actions">
                  <button
                    type="button"
                    className="queue-view-approve"
                    onClick={() => handleApprove(it.id)}
                    disabled={actioning.has(it.id)}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="queue-view-reject"
                    onClick={() => handleReject(it.id)}
                    disabled={actioning.has(it.id)}
                  >
                    Reject
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Layout>
  );
}
