import React from 'react';
import { starNote, unstarNote } from './api';
import './NoteCard.css';

export default function NoteCard({ note, depth = 0, onOpenThread, onStarredChange }) {
  const handleStar = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      if (note.starred) await unstarNote(note.id);
      else await starNote(note.id);
      onStarredChange?.();
    } catch (err) {
      console.error(err);
    }
  };

  const borderWidth = Math.min(depth + 2, 6);

  return (
    <article
      className={`note-card note-card--depth-${Math.min(depth, 3)}`}
      style={{ borderLeftWidth: borderWidth }}
      onClick={onOpenThread}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && onOpenThread?.()}
    >
      <div className="note-card-body">
        <p className="note-card-content">{note.content || '—'}</p>
        <div className="note-card-meta">
          <time className="note-card-time">
            {new Date(note.updated_at).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          <button
            type="button"
            className={`note-card-star ${note.starred ? 'note-card-star--on' : ''}`}
            onClick={handleStar}
            aria-label={note.starred ? 'Unstar' : 'Star'}
          >
            ★
          </button>
        </div>
      </div>
    </article>
  );
}
