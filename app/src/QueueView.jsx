import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { getQueue, getQueueCount, approveProposal, rejectProposal } from './api';
import Layout from './Layout';
import './QueueView.css';

export default function QueueView() {
  const [items, setItems] = useState([]);
  const [count, setCount] = useState(0);
  const [minConfidence, setMinConfidence] = useState(0);
  const [loading, setLoading] = useState(true);
  const [actioning, setActioning] = useState(new Set());
  const { logout } = useAuth();
  const navigate = useNavigate();

  const load = () => {
    setLoading(true);
    Promise.all([getQueue(minConfidence), getQueueCount(minConfidence)])
      .then(([list, { count: c }]) => {
        setItems(list);
        setCount(c);
      })
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, [minConfidence]);

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

  return (
    <Layout
      title="Tag approval queue"
      onLogout={logout}
      viewLinks={[
        { to: '/', label: 'Stream' },
        { to: '/outline', label: 'Outline' },
        { to: '/queue', label: 'Queue' },
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
              max="1"
              step="0.1"
              value={minConfidence}
              onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
            />
            <span>{minConfidence.toFixed(1)}</span>
          </label>
          {items.length > 0 && (
            <button type="button" className="queue-view-approve-all" onClick={handleApproveAll}>
              Approve all visible
            </button>
          )}
        </div>

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
