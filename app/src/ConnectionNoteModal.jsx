import React, { useCallback, useEffect, useState } from 'react';
import { getNote, getNoteThreadPath } from './api';
import NoteCard from './NoteCard';

const CONFIRM_UNLINK =
  'Remove the link between these two notes? The notes are not deleted—only the connection is removed.';

/**
 * Modal for a connected (linked) note: full stream-style note actions (edit, tag, star, delete)
 * plus Go to note and Disconnect.
 */
export default function ConnectionNoteModal({
  linked,
  anchorNoteId,
  onClose,
  unlinkPersisted,
  navigateToConnection,
  onNoteUpdated,
}) {
  const [fetched, setFetched] = useState({
    threadPath: '',
    note: null,
    loading: true,
  });

  const refreshNote = useCallback(async () => {
    if (!linked?.id) return;
    try {
      const n = await getNote(linked.id);
      setFetched((prev) => ({ ...prev, note: n }));
    } catch (e) {
      console.error(e);
    }
  }, [linked?.id]);

  useEffect(() => {
    if (!linked?.id) {
      setFetched({ threadPath: '', note: null, loading: false });
      return undefined;
    }
    let cancelled = false;
    setFetched({
      threadPath: linked.threadPath || '',
      note: null,
      loading: true,
    });
    Promise.all([
      getNoteThreadPath(linked.id, { excludeLeaf: true }),
      getNote(linked.id),
    ])
      .then(([path, note]) => {
        if (cancelled) return;
        setFetched({
          threadPath: path || '',
          note,
          loading: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        const fallbackNote = {
          id: linked.id,
          content: linked.content != null ? String(linked.content) : '',
          tags: Array.isArray(linked.tags) ? linked.tags : [],
          starred: !!linked.starred,
          updated_at: linked.updated_at || new Date().toISOString(),
          parent_id: linked.parent_id ?? null,
          note_type: linked.note_type || 'note',
          event_start_at: linked.event_start_at ?? null,
          event_end_at: linked.event_end_at ?? null,
          attachments: Array.isArray(linked.attachments) ? linked.attachments : [],
          reply_count: linked.reply_count ?? 0,
          connection_count:
            linked.connection_count ?? linked.connectionCount ?? 0,
        };
        setFetched({
          threadPath: linked.threadPath || '',
          note: fallbackNote,
          loading: false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [linked?.id]);

  if (!linked?.id || !anchorNoteId) return null;

  const navTarget = fetched.note || linked;

  return (
    <div
      className="hover-insight-modal-backdrop"
      data-insight-ui
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="hover-insight-modal"
        data-insight-ui
        role="dialog"
        aria-modal="true"
        aria-labelledby="hover-insight-modal-title"
      >
        <h2 id="hover-insight-modal-title" className="hover-insight-modal-title">
          Connected note
        </h2>
        <div className="hover-insight-modal-body">
          <p className="hover-insight-modal-section-label">Thread path</p>
          {fetched.loading && !fetched.threadPath ? (
            <p className="hover-insight-muted">Loading path…</p>
          ) : fetched.threadPath ? (
            <p
              className="hover-insight-thread-path hover-insight-thread-path--modal"
              title={fetched.threadPath}
            >
              {fetched.threadPath}
            </p>
          ) : (
            <p className="hover-insight-muted">No path</p>
          )}

          <p className="hover-insight-modal-section-label">Note</p>
          {fetched.loading && !fetched.note ? (
            <p className="hover-insight-muted">Loading note…</p>
          ) : fetched.note ? (
            <div
              className="hover-insight-modal-note-embed"
              onClick={(e) => e.stopPropagation()}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <NoteCard
                note={fetched.note}
                depth={0}
                onOpenThread={(e) => {
                  e?.preventDefault?.();
                  e?.stopPropagation?.();
                  navigateToConnection(navTarget);
                }}
                onStarredChange={() => {
                  refreshNote();
                  onNoteUpdated?.();
                }}
                onNoteUpdate={() => {
                  refreshNote();
                  onNoteUpdated?.();
                }}
                onNoteDelete={() => {
                  onClose();
                  onNoteUpdated?.();
                }}
                hoverInsightEnabled={false}
                hasReplies={(fetched.note.reply_count ?? 0) > 0}
              />
            </div>
          ) : (
            <p className="hover-insight-muted">Could not load note.</p>
          )}
        </div>
        <div className="hover-insight-modal-actions">
          <button
            type="button"
            className="hover-insight-modal-btn hover-insight-modal-btn--danger"
            onClick={() => {
              if (!window.confirm(CONFIRM_UNLINK)) return;
              unlinkPersisted(anchorNoteId, linked.id);
            }}
          >
            Disconnect
          </button>
          <div className="hover-insight-modal-actions-right">
            <button
              type="button"
              className="hover-insight-modal-btn hover-insight-modal-btn--secondary"
              onClick={onClose}
            >
              Close
            </button>
            <button
              type="button"
              className="hover-insight-modal-btn hover-insight-modal-btn--primary"
              onClick={() => navigateToConnection(navTarget)}
            >
              Go to note
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
