import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getThread, updateNote } from './api';
import NoteTypeIcon from './NoteTypeIcon';
import { firstLinePreview } from './noteHistoryUtils';
import { effectiveDescendantCount } from './noteDescendantCount';
import './MoveNoteModal.css';

function buildTree(flat) {
  const byId = new Map(flat.map((n) => [n.id, { ...n, children: [] }]));
  const roots = [];
  for (const n of flat) {
    const node = byId.get(n.id);
    if (n.parent_id) {
      const parent = byId.get(n.parent_id);
      if (parent) parent.children.push(node);
      else roots.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function findNode(nodes, id) {
  if (id == null) return null;
  const sid = String(id);
  for (const n of nodes || []) {
    if (String(n.id) === sid) return n;
    const f = findNode(n.children, id);
    if (f) return f;
  }
  return null;
}

function collectDescendantIds(node) {
  const ids = new Set();
  function walk(n) {
    for (const c of n.children || []) {
      ids.add(String(c.id));
      walk(c);
    }
  }
  walk(node);
  return ids;
}

function MoveNoteRow({ node, depth, forbidden, selectedId, onPick }) {
  const fid = String(node.id);
  const isForbidden = forbidden.has(fid);
  const isSelected = selectedId != null && String(selectedId) === fid;
  const label = firstLinePreview(node.content || '') || '(empty)';
  return (
    <>
      <button
        type="button"
        className={[
          'move-note-modal-row',
          isForbidden ? 'move-note-modal-row--forbidden' : '',
          isSelected ? 'move-note-modal-row--selected' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        style={{ paddingLeft: `${depth * 1.25 + 0.5}rem` }}
        disabled={isForbidden}
        onClick={() => {
          if (!isForbidden) onPick(node.id);
        }}
      >
        <NoteTypeIcon type={node.note_type || 'note'} className="move-note-modal-type-icon" />
        <span className="move-note-modal-row-label">{label}</span>
      </button>
      {(node.children || []).map((c) => (
        <MoveNoteRow
          key={c.id}
          node={c}
          depth={depth + 1}
          forbidden={forbidden}
          selectedId={selectedId}
          onPick={onPick}
        />
      ))}
    </>
  );
}

/**
 * Pick another note in the same thread as the new parent for `noteToMove` (reparent).
 */
export default function MoveNoteModal({ open, onClose, threadRootId, noteToMove, onMoved }) {
  const [flat, setFlat] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedParentId, setSelectedParentId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open || !threadRootId) return undefined;
    setSelectedParentId(null);
    setError(null);
    setFlat([]);
    let cancelled = false;
    setLoading(true);
    getThread(threadRootId, false)
      .then((rows) => {
        if (!cancelled) setFlat(Array.isArray(rows) ? rows : []);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || 'Could not load thread');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, threadRootId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const tree = useMemo(() => buildTree(flat), [flat]);

  const forbidden = useMemo(() => {
    if (!noteToMove?.id) return new Set();
    const moving = findNode(tree, noteToMove.id);
    const self = new Set([String(noteToMove.id)]);
    const desc = moving ? collectDescendantIds(moving) : new Set();
    return new Set([...self, ...desc]);
  }, [tree, noteToMove?.id]);

  const subCount = noteToMove ? effectiveDescendantCount(noteToMove) : 0;

  const handleConfirm = useCallback(async () => {
    if (!noteToMove?.id || selectedParentId == null) return;
    if (String(selectedParentId) === String(noteToMove.parent_id)) {
      onClose?.();
      return;
    }
    const targetLabel = firstLinePreview(
      findNode(tree, selectedParentId)?.content || ''
    ) || 'selected note';
    const msg =
      subCount > 0
        ? `Move this note and ${subCount} nested reply(ies) under it to be a reply to “${targetLabel.slice(0, 80)}${targetLabel.length > 80 ? '…' : ''}”?`
        : `Move this note to be a reply to “${targetLabel.slice(0, 80)}${targetLabel.length > 80 ? '…' : ''}”?`;
    if (!window.confirm(`${msg}\n\nThis cannot be undone with a single action.`)) return;
    setSubmitting(true);
    setError(null);
    try {
      await updateNote(noteToMove.id, { parent_id: selectedParentId });
      onMoved?.();
      onClose?.();
    } catch (e) {
      setError(e?.message || 'Could not move note');
    } finally {
      setSubmitting(false);
    }
  }, [noteToMove, selectedParentId, subCount, tree, onClose, onMoved]);

  if (!open || !noteToMove) return null;

  return (
    <div
      className="move-note-modal-overlay"
      role="presentation"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose?.();
      }}
    >
      <div className="move-note-modal" role="dialog" aria-modal="true" aria-labelledby="move-note-modal-title">
        <h2 id="move-note-modal-title">Move note in thread</h2>
        <p className="move-note-modal-lead">
          Choose the note this should become a reply to. The whole branch (this note and everything under it) moves
          together.
        </p>
        {error ? <p className="move-note-modal-error">{error}</p> : null}
        <div className="move-note-modal-tree-wrap">
          {loading ? (
            <p className="move-note-modal-muted">Loading thread…</p>
          ) : (
            <div className="move-note-modal-tree">
              {tree.map((n) => (
                <MoveNoteRow
                  key={n.id}
                  node={n}
                  depth={0}
                  forbidden={forbidden}
                  selectedId={selectedParentId}
                  onPick={setSelectedParentId}
                />
              ))}
            </div>
          )}
        </div>
        <div className="move-note-modal-actions">
          <button type="button" className="move-note-modal-btn move-note-modal-btn--ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="move-note-modal-btn move-note-modal-btn--primary"
            disabled={submitting || loading || selectedParentId == null || String(selectedParentId) === String(noteToMove.parent_id)}
            onClick={() => void handleConfirm()}
          >
            {submitting ? 'Moving…' : 'Move here'}
          </button>
        </div>
      </div>
    </div>
  );
}
