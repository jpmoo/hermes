import React, { useCallback, useEffect, useState } from 'react';
import { postThreadAiSummary } from './api';
import './ThreadSummaryModal.css';

function collectVisibleNoteIds(nodes) {
  const out = [];
  const walk = (arr) => {
    for (const n of arr || []) {
      if (n?.id != null) out.push(String(n.id));
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

export { collectVisibleNoteIds };

export default function ThreadSummaryModal({
  open,
  onClose,
  threadRootId,
  focusNoteId,
  visibleNoteIds,
}) {
  const [includeChildren, setIncludeChildren] = useState(false);
  const [includeConnected, setIncludeConnected] = useState(false);
  const [summary, setSummary] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) return;
    setSummary('');
    setError(null);
    setLoading(false);
  }, [open]);

  const handleGenerate = useCallback(async () => {
    if (!threadRootId || !visibleNoteIds?.length) return;
    setLoading(true);
    setError(null);
    try {
      const data = await postThreadAiSummary({
        threadRootId: String(threadRootId),
        focusNoteId: focusNoteId ? String(focusNoteId) : null,
        visibleNoteIds,
        includeChildren,
        includeConnected,
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      setSummary(data.summary || '');
    } catch (e) {
      setError(e.message || 'Something went wrong');
      setSummary('');
    } finally {
      setLoading(false);
    }
  }, [
    threadRootId,
    focusNoteId,
    visibleNoteIds,
    includeChildren,
    includeConnected,
  ]);

  if (!open) return null;

  const canGenerate = Boolean(threadRootId && visibleNoteIds?.length);

  return (
    <div
      className="thread-summary-modal-overlay"
      role="presentation"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        className="thread-summary-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="thread-summary-modal-title"
      >
        <h2 id="thread-summary-modal-title">Thread summary</h2>
        <p className="thread-summary-modal-lead">
          With no options checked, the summary uses only what is on screen: the focused note and visible replies
          in this thread. Maximum about 250 words.
        </p>
        <div className="thread-summary-modal-options">
          <label className="thread-summary-modal-check">
            <input
              type="checkbox"
              checked={includeChildren}
              onChange={(e) => setIncludeChildren(e.target.checked)}
            />
            <span>
              Replies: include every in-thread reply under what is on screen—replies to replies, and so
              on—not only notes currently visible.
            </span>
          </label>
          <label className="thread-summary-modal-check">
            <input
              type="checkbox"
              checked={includeConnected}
              onChange={(e) => setIncludeConnected(e.target.checked)}
            />
            <span>
              Connected: include other notes in this thread that are linked or connected to anything on
              screen (separate from the reply tree). With Replies also checked, keep walking: add connected
              notes, then their replies and deeper replies, then more connected notes, until nothing new is
              found.
            </span>
          </label>
        </div>
        <div className="thread-summary-modal-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="thread-summary-modal-generate"
            disabled={!canGenerate || loading}
            onClick={handleGenerate}
          >
            {loading ? 'Generating…' : 'Generate'}
          </button>
        </div>
        {error && (
          <p className="thread-summary-modal-error" role="alert">
            {error}
          </p>
        )}
        {summary ? (
          <div className="thread-summary-modal-output" aria-live="polite">
            {summary}
          </div>
        ) : !loading && !error ? (
          <p className="thread-summary-modal-placeholder">Generated summary will appear here.</p>
        ) : null}
      </div>
    </div>
  );
}
