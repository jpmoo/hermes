import React, { useState, useEffect } from 'react';
import { starNote, unstarNote, updateNote, deleteNote, getTags, addNoteTag, removeNoteTag } from './api';
import './NoteCard.css';

export default function NoteCard({ note, depth = 0, onOpenThread, onStarredChange, onNoteUpdate, onNoteDelete }) {
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(note.content || '');
  const [addingTag, setAddingTag] = useState(false);
  const [tagOptions, setTagOptions] = useState([]);
  const [newTagName, setNewTagName] = useState('');

  const tags = note.tags || [];

  useEffect(() => {
    setEditContent(note.content || '');
  }, [note.id, note.content]);

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

  const handleSaveEdit = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (editContent.trim() === (note.content || '').trim()) {
      setEditing(false);
      return;
    }
    try {
      await updateNote(note.id, { content: editContent.trim() });
      setEditing(false);
      onNoteUpdate?.();
    } catch (err) {
      console.error(err);
    }
  };

  const handleCancelEdit = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setEditContent(note.content || '');
    setEditing(false);
  };

  const handleDelete = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm('Delete this note and all its replies? This cannot be undone.')) return;
    try {
      await deleteNote(note.id);
      onNoteDelete?.();
    } catch (err) {
      console.error(err);
    }
  };

  const handleRemoveTag = async (e, tagId) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await removeNoteTag(note.id, tagId);
      onNoteUpdate?.();
    } catch (err) {
      console.error(err);
    }
  };

  const openTagDropdown = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (addingTag) {
      setAddingTag(false);
      return;
    }
    try {
      const list = await getTags();
      setTagOptions(list);
      setAddingTag(true);
    } catch (err) {
      console.error(err);
    }
  };

  const handleAddTag = async (e, tag) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await addNoteTag(note.id, { tag_id: tag.id });
      setAddingTag(false);
      onNoteUpdate?.();
    } catch (err) {
      console.error(err);
    }
  };

  const handleCreateAndAddTag = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const name = newTagName.trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) return;
    try {
      await addNoteTag(note.id, { name });
      setNewTagName('');
      setAddingTag(false);
      onNoteUpdate?.();
      const list = await getTags();
      setTagOptions(list);
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
        {editing ? (
          <form className="note-card-edit" onSubmit={handleSaveEdit} onClick={(e) => e.stopPropagation()}>
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={3}
              autoFocus
            />
            <div className="note-card-edit-actions">
              <button type="submit">Save</button>
              <button type="button" onClick={handleCancelEdit}>Cancel</button>
            </div>
          </form>
        ) : (
          <>
            <p className="note-card-content">{note.content || '—'}</p>
            {tags.length > 0 && (
              <div className="note-card-tags" onClick={(e) => e.stopPropagation()}>
                {tags.map((t) => (
                  <span key={t.id} className="note-card-tag">
                    {t.name}
                    <button type="button" className="note-card-tag-remove" onClick={(e) => handleRemoveTag(e, t.id)} aria-label={`Remove ${t.name}`}>×</button>
                  </span>
                ))}
              </div>
            )}
          </>
        )}
        <div className="note-card-meta" onClick={(e) => e.stopPropagation()}>
          <time className="note-card-time">
            {new Date(note.updated_at).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
          <div className="note-card-actions">
            {!editing && (
              <>
                <button type="button" className="note-card-btn" onClick={(e) => { e.stopPropagation(); setEditing(true); }}>Edit</button>
                <button type="button" className="note-card-btn note-card-btn-delete" onClick={handleDelete}>
                  Delete
                </button>
                <div className="note-card-tag-add">
                  {addingTag ? (
                    <ul className="note-card-tag-dropdown">
                      {tagOptions.filter((t) => !tags.some((x) => x.id === t.id)).map((t) => (
                        <li key={t.id}>
                          <button type="button" onClick={(e) => handleAddTag(e, t)}>{t.name}</button>
                        </li>
                      ))}
                      <li className="note-card-tag-create">
                        <form onSubmit={handleCreateAndAddTag}>
                          <input
                            type="text"
                            placeholder="New tag..."
                            value={newTagName}
                            onChange={(e) => setNewTagName(e.target.value)}
                          />
                          <button type="submit">Add</button>
                        </form>
                      </li>
                      <li><button type="button" onClick={() => setAddingTag(false)}>Close</button></li>
                    </ul>
                  ) : (
                    <button type="button" className="note-card-tag-add-btn" onClick={openTagDropdown}>+ Tag</button>
                  )}
                </div>
              </>
            )}
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
      </div>
    </article>
  );
}
