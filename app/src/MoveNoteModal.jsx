import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { getAllNotesFlat, updateNote } from './api';
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

/** Depth-first order of pickable targets (matches on-screen row order). */
function orderedPickableIds(nodes, forbidden) {
  const out = [];
  function walk(ns) {
    for (const n of ns || []) {
      if (!forbidden.has(String(n.id))) out.push(n.id);
      walk(n.children);
    }
  }
  walk(nodes);
  return out;
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
        data-move-note-id={String(node.id)}
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
 * Pick any note in the library as the new parent for `noteToMove` (reparent), including other threads.
 */
export default function MoveNoteModal({ open, onClose, noteToMove, onMoved }) {
  const [flat, setFlat] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedParentId, setSelectedParentId] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const treeWrapRef = useRef(null);

  useEffect(() => {
    if (!open || !noteToMove) return undefined;
    setSelectedParentId(null);
    setError(null);
    setFlat([]);
    let cancelled = false;
    setLoading(true);
    getAllNotesFlat()
      .then((rows) => {
        if (!cancelled) setFlat(Array.isArray(rows) ? rows : []);
      })
      .catch((e) => {
        if (!cancelled) setError(e?.message || 'Could not load notes');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, noteToMove?.id]);

  const tree = useMemo(() => buildTree(flat), [flat]);

  const forbidden = useMemo(() => {
    if (!noteToMove?.id) return new Set();
    const moving = findNode(tree, noteToMove.id);
    const self = new Set([String(noteToMove.id)]);
    const desc = moving ? collectDescendantIds(moving) : new Set();
    return new Set([...self, ...desc]);
  }, [tree, noteToMove?.id]);

  const pickableOrder = useMemo(() => orderedPickableIds(tree, forbidden), [tree, forbidden]);

  const subCount = noteToMove ? effectiveDescendantCount(noteToMove) : 0;

  useLayoutEffect(() => {
    if (!open || selectedParentId == null) return;
    const wrap = treeWrapRef.current;
    if (!wrap) return;
    const id = String(selectedParentId).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const el = wrap.querySelector(`[data-move-note-id="${id}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [open, selectedParentId]);

  useEffect(() => {
    if (!open || loading) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose?.();
        return;
      }
      if (pickableOrder.length === 0) return;
      const cur =
        selectedParentId != null
          ? pickableOrder.findIndex((id) => String(id) === String(selectedParentId))
          : -1;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = cur < 0 ? 0 : (cur + 1) % pickableOrder.length;
        setSelectedParentId(pickableOrder[next]);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = cur <= 0 ? pickableOrder.length - 1 : cur - 1;
        setSelectedParentId(pickableOrder[prev]);
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        setSelectedParentId(pickableOrder[0]);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        setSelectedParentId(pickableOrder[pickableOrder.length - 1]);
        return;
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, loading, onClose, pickableOrder, selectedParentId]);

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
        <h2 id="move-note-modal-title">Move note</h2>
        <p className="move-note-modal-lead">
          Choose any note as the new parent — same thread or another. The whole branch (this note and everything
          nested under it) moves together. Scroll the list, or use ↑ ↓ (Home / End) to change the selection.
        </p>
        {error ? <p className="move-note-modal-error">{error}</p> : null}
        <div
          className="move-note-modal-tree-wrap"
          ref={treeWrapRef}
          tabIndex={-1}
          aria-label="All notes — pick new parent"
        >
          {loading ? (
            <p className="move-note-modal-muted">Loading notes…</p>
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
