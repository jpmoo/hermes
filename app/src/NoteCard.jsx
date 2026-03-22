import React, { useState, useEffect, useRef } from 'react';
import {
  starNote,
  unstarNote,
  updateNote,
  deleteNote,
  getTags,
  getNoteTags,
  addNoteTag,
  removeNoteTag,
  deleteNoteFile,
  uploadNoteFiles,
} from './api';
import LinkifiedText from './LinkifiedText';
import NoteAttachments from './NoteAttachments';
import { useHoverInsight } from './HoverInsightContext';
import './NoteCard.css';

export default function NoteCard({
  note,
  depth = 0,
  onOpenThread,
  onStarredChange,
  onNoteUpdate,
  onNoteDelete,
  hasReplies,
  /** When set, parent’s tags for inherit (stream). Omit to load parent tags via API when note has parent_id. */
  parentTagsForInherit,
  /** Stream: single-click tag/connection panels; double-click opens thread (any depth) */
  hoverInsightEnabled = false,
}) {
  const hoverInsight = useHoverInsight();
  const insightClickTimerRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(note.content || '');
  const [addingTag, setAddingTag] = useState(false);
  const [tagOptions, setTagOptions] = useState([]);
  const [newTagName, setNewTagName] = useState('');
  const [dropdownParentTags, setDropdownParentTags] = useState([]);
  const [inheritLoading, setInheritLoading] = useState(false);

  const tags = note.tags || [];

  useEffect(() => {
    setEditContent(note.content || '');
  }, [note.id, note.content]);

  useEffect(() => {
    setDropdownParentTags([]);
  }, [note.id]);

  useEffect(
    () => () => {
      if (insightClickTimerRef.current) clearTimeout(insightClickTimerRef.current);
    },
    []
  );

  const insightSelectedId = hoverInsightEnabled ? hoverInsight?.hover?.note?.id : null;
  const insightActive = Boolean(insightSelectedId);
  const isInsightSelected = insightActive && insightSelectedId === note.id;

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
      const list = await getTags({ inUseOnly: true });
      let pTags = [];
      if (parentTagsForInherit !== undefined) {
        pTags = parentTagsForInherit;
      } else if (note.parent_id) {
        pTags = await getNoteTags(note.parent_id);
      }
      setDropdownParentTags(pTags);
      setTagOptions(list);
      setAddingTag(true);
    } catch (err) {
      console.error(err);
    }
  };

  const tagsMissingFromParent = dropdownParentTags.filter((t) => !tags.some((x) => x.id === t.id));

  const handleInheritParentTags = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (tagsMissingFromParent.length === 0) return;
    setInheritLoading(true);
    try {
      for (const t of tagsMissingFromParent) {
        await addNoteTag(note.id, { tag_id: t.id });
      }
      setAddingTag(false);
      onNoteUpdate?.();
    } catch (err) {
      console.error(err);
    } finally {
      setInheritLoading(false);
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
      const list = await getTags({ inUseOnly: true });
      setTagOptions(list);
    } catch (err) {
      console.error(err);
    }
  };

  const replies = hasReplies ?? ((note.reply_count ?? 0) > 0);
  const showThreadline = replies;
  const borderWidth = showThreadline ? Math.min(depth + 2, 6) : 1;
  const cardClass = showThreadline
    ? `note-card note-card--depth-${Math.min(depth, 3)}`
    : 'note-card note-card--leaf';

  const handleDeleteAttachment = async (att) => {
    if (
      !window.confirm(
        `Remove “${att.filename}” from this note?\n\nThe file will be permanently deleted from the server.`
      )
    ) {
      return;
    }
    try {
      await deleteNoteFile(att.id);
      onNoteUpdate?.();
    } catch (err) {
      console.error(err);
    }
  };

  const handleEditAddFiles = async (e) => {
    e.stopPropagation();
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    try {
      await uploadNoteFiles(note.id, files);
      onNoteUpdate?.();
    } catch (err) {
      console.error(err);
    }
  };

  const handleCardClick = (ev) => {
    if (editing) return;
    if (!hoverInsightEnabled) {
      onOpenThread?.(ev);
      return;
    }
    const anchorEl = ev.currentTarget;
    if (insightClickTimerRef.current) clearTimeout(insightClickTimerRef.current);
    insightClickTimerRef.current = setTimeout(() => {
      insightClickTimerRef.current = null;
      hoverInsight?.selectInsightNote?.(note, anchorEl, depth);
    }, 280);
  };

  const handleCardDoubleClick = (ev) => {
    if (editing) return;
    if (insightClickTimerRef.current) {
      clearTimeout(insightClickTimerRef.current);
      insightClickTimerRef.current = null;
    }
    ev.preventDefault();
    ev.stopPropagation();
    if (hoverInsightEnabled) {
      hoverInsight?.clearInsightSelection?.();
    }
    onOpenThread?.(ev);
  };

  const cardClassNames = [
    cardClass,
    hoverInsightEnabled && insightActive && !isInsightSelected ? 'note-card--insight-dimmed' : '',
    hoverInsightEnabled && isInsightSelected ? 'note-card--insight-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <article
      className={cardClassNames}
      style={{ borderLeftWidth: borderWidth }}
      onClick={editing ? undefined : handleCardClick}
      onDoubleClick={editing ? undefined : handleCardDoubleClick}
      role={editing ? undefined : 'button'}
      tabIndex={editing ? undefined : 0}
      aria-pressed={hoverInsightEnabled && isInsightSelected ? true : undefined}
      title={
        hoverInsightEnabled && !editing
          ? 'Click: tag & connection suggestions · Double-click: open thread'
          : undefined
      }
      onKeyDown={
        editing
          ? undefined
          : (e) => {
              if (!hoverInsightEnabled) {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onOpenThread?.(e);
                }
                return;
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                hoverInsight?.clearInsightSelection?.();
                onOpenThread?.(e);
              }
              if (e.key === ' ') {
                e.preventDefault();
                hoverInsight?.selectInsightNote?.(note, e.currentTarget, depth);
              }
            }
      }
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
            <div className="note-card-edit-attachments">
              <p className="note-card-edit-attachments-label">Attachments</p>
              {note.attachments?.length > 0 ? (
                <NoteAttachments attachments={note.attachments} onDeleted={handleDeleteAttachment} />
              ) : (
                <p className="note-card-edit-no-files">No files yet.</p>
              )}
              <label className="note-card-edit-add-files">
                <input
                  type="file"
                  multiple
                  accept="image/*,.pdf,.txt,.md,.doc,.docx,.zip"
                  onChange={handleEditAddFiles}
                />
                Add files
              </label>
            </div>
            <div className="note-card-edit-actions">
              <button type="submit">Save</button>
              <button type="button" onClick={handleCancelEdit}>Cancel</button>
            </div>
          </form>
        ) : (
          <>
            <p className="note-card-content">
              {note.content?.trim() ? <LinkifiedText text={note.content} /> : note.attachments?.length ? null : '—'}
            </p>
            <NoteAttachments attachments={note.attachments} onDeleted={handleDeleteAttachment} />
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
                      {dropdownParentTags.length > 0 && (
                        <li className="note-card-tag-inherit">
                          <button
                            type="button"
                            disabled={tagsMissingFromParent.length === 0 || inheritLoading}
                            onClick={handleInheritParentTags}
                            title={
                              tagsMissingFromParent.length === 0
                                ? 'This note already has all tags from its parent'
                                : `Add ${tagsMissingFromParent.length} tag(s) from parent`
                            }
                          >
                            {inheritLoading
                              ? 'Adding…'
                              : tagsMissingFromParent.length === 0
                                ? 'Parent tags already on note'
                                : 'Inherit parent tags'}
                          </button>
                        </li>
                      )}
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
