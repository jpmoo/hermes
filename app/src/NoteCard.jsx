import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
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
  getNoteThreadRoot,
} from './api';
import NoteRichText, { toggleTaskMarkerAtIndex } from './NoteRichText';
import NoteAttachments from './NoteAttachments';
import NoteTypeEventFields from './NoteTypeEventFields';
import MentionsTextarea from './MentionsTextarea';
import {
  formatEventRange,
  eventFieldsToPayload,
  isoToDateTimeFields,
  NOTE_TYPE_OPTIONS,
} from './noteEventUtils';
import { stripHashtagPrefixFromContent } from './noteBodyUtils';
import { syncTagsFromContent, syncConnectionsFromContent } from './noteBodySync';
import { pointerEventTargetElement } from './pointerEventUtils';
import { useHoverInsight } from './HoverInsightContext';
import NoteTypeIcon from './NoteTypeIcon';
import { NavIconAttach } from './icons/NavIcons';
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
  /** Stream: single-click insight; double-click drills focus (nested rows use immediate focus, no animation) */
  hoverInsightEnabled = false,
  hideStar = false,
}) {
  const navigate = useNavigate();
  const hoverInsight = useHoverInsight();
  /** Second click of a double-click runs drill in `click` (detail===2); skip duplicate work in `dblclick`. */
  const skipNextStreamDblClickDrillRef = useRef(false);
  const tagDropdownRef = useRef(null);
  const editFileInputRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [renderedContent, setRenderedContent] = useState(note.content || '');
  const renderedContentRef = useRef(note.content || '');
  const [editContent, setEditContent] = useState(note.content || '');
  const [editNoteType, setEditNoteType] = useState('note');
  const [editStartDate, setEditStartDate] = useState('');
  const [editStartTime, setEditStartTime] = useState('');
  const [editEndDate, setEditEndDate] = useState('');
  const [editEndTime, setEditEndTime] = useState('');
  const [addingTag, setAddingTag] = useState(false);
  const [tagOptions, setTagOptions] = useState([]);
  const [newTagName, setNewTagName] = useState('');
  const [dropdownParentTags, setDropdownParentTags] = useState([]);
  const [inheritLoading, setInheritLoading] = useState(false);

  const tags = note.tags || [];
  const eventRangeLabel = formatEventRange(note);

  useEffect(() => {
    setEditContent(note.content || '');
  }, [note.id, note.content]);

  useEffect(() => {
    setRenderedContent(note.content || '');
  }, [note.id, note.content]);

  useEffect(() => {
    renderedContentRef.current = renderedContent || '';
  }, [renderedContent]);

  const resetEditMetaFromNote = () => {
    setEditNoteType(note.note_type || 'note');
    const s = isoToDateTimeFields(note.event_start_at, false);
    const e = isoToDateTimeFields(note.event_end_at, true);
    setEditStartDate(s.date);
    setEditStartTime(s.time);
    setEditEndDate(e.date);
    setEditEndTime(e.time);
  };

  useEffect(() => {
    setDropdownParentTags([]);
  }, [note.id]);

  useEffect(() => {
    if (!addingTag) return undefined;
    const close = () => setAddingTag(false);
    const onPointerDown = (e) => {
      const root = tagDropdownRef.current;
      if (root?.contains(e.target)) return;
      close();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [addingTag]);

  const insightSelectedId = hoverInsightEnabled ? hoverInsight?.hover?.note?.id : null;
  const insightActive = Boolean(insightSelectedId);
  const isInsightSelected =
    insightActive &&
    insightSelectedId != null &&
    note.id != null &&
    String(insightSelectedId) === String(note.id);

  const openLinkedNote = useCallback(
    async (linkedId) => {
      try {
        const root = await getNoteThreadRoot(linkedId);
        navigate({ pathname: '/', search: `?thread=${root}&focus=${linkedId}` });
      } catch (err) {
        console.error(err);
      }
    },
    [navigate]
  );

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
    const meta = eventFieldsToPayload(editNoteType, {
      startDate: editStartDate,
      startTime: editStartTime,
      endDate: editEndDate,
      endTime: editEndTime,
    });
    if (meta.error) {
      console.error(meta.error);
      return;
    }
    const trimmed = editContent.trim();
    try {
      await updateNote(note.id, { content: trimmed, ...meta });
      await syncTagsFromContent(note.id, trimmed, note.tags, note.content || '');
      await syncConnectionsFromContent(note.id, trimmed, note.content || '');
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
    resetEditMetaFromNote();
    setEditing(false);
  };

  const cycleEditNoteType = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const opts = NOTE_TYPE_OPTIONS;
    const i = opts.findIndex((o) => o.value === editNoteType);
    const idx = i < 0 ? 0 : i;
    setEditNoteType(opts[(idx + 1) % opts.length].value);
  }, [editNoteType]);

  const beginEdit = (ev) => {
    ev.stopPropagation();
    setEditContent(note.content || '');
    resetEditMetaFromNote();
    setEditing(true);
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
    const t = tags.find((x) => x.id === tagId);
    if (!t) return;
    if (!window.confirm(`Remove the “${t.name}” tag from this note?`)) return;
    try {
      const nextContent = stripHashtagPrefixFromContent(note.content || '', t.name);
      if (nextContent !== (note.content || '')) {
        await updateNote(note.id, { content: nextContent });
      }
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
      const list = await getTags();
      setTagOptions(list);
    } catch (err) {
      console.error(err);
    }
  };

  const replies = hasReplies ?? ((note.reply_count ?? 0) > 0);
  const showThreadline = replies;
  const borderWidth = showThreadline ? Math.min(depth + 2, 6) : 1;
  const rawConn = note?.connection_count ?? note?.connectionCount;
  const connectionCount =
    rawConn == null || rawConn === ''
      ? 0
      : typeof rawConn === 'string'
        ? parseInt(rawConn, 10) || 0
        : Number(rawConn) || 0;
  const hasConnections = connectionCount > 0;
  const displayNoteType = editing ? editNoteType : note.note_type || 'note';
  const typeBgClass =
    displayNoteType === 'organization'
      ? 'note-card--type-organization'
      : displayNoteType === 'person'
        ? 'note-card--type-person'
        : displayNoteType === 'event'
          ? 'note-card--type-event'
          : displayNoteType === 'note'
            ? 'note-card--type-note'
            : '';

  const cardClass = [
    showThreadline ? `note-card note-card--depth-${Math.min(depth, 3)}` : 'note-card note-card--leaf',
    hasConnections ? 'note-card--linked' : '',
    typeBgClass,
  ]
    .filter(Boolean)
    .join(' ');

  const handleDeleteAttachment = async (att) => {
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

  const runStreamDrillOpen = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    hoverInsight?.clearInsightSelection?.();
    onOpenThread?.(ev);
  };

  /** Focus the card on primary button mousedown so the first tap/click activates reliably (custom role=button + tabindex). */
  const handleCardMouseDown = (ev) => {
    if (editing) return;
    if (ev.button !== 0) return;
    const t = pointerEventTargetElement(ev);
    if (!t) return;
    if (t.closest?.('.note-rich-task-checkbox')) return;
    if (t.closest?.('button, a[href], input, textarea, select, [contenteditable="true"]')) return;
    ev.currentTarget.focus({ preventScroll: true });
  };

  const handleCardClick = (ev) => {
    if (editing) return;
    const t = pointerEventTargetElement(ev);
    if (t?.closest?.('.note-rich-task-checkbox')) return;
    if (!hoverInsightEnabled) {
      onOpenThread?.(ev);
      return;
    }
    /* Double-click drill: use the 2nd click (detail===2) so drill fires even when `dblclick` misses
     * the <article> (nested stream rows). Single click selects insight immediately (no delay — delayed
     * open felt like missed clicks and lagged highlight when switching notes). */
    if (ev.detail === 2) {
      skipNextStreamDblClickDrillRef.current = true;
      runStreamDrillOpen(ev);
      return;
    }
    hoverInsight?.selectInsightNote?.(note, ev.currentTarget, depth);
  };

  const handleCardDoubleClick = (ev) => {
    if (editing) return;
    const t = pointerEventTargetElement(ev);
    if (t?.closest?.('.note-rich-task-checkbox')) return;
    if (hoverInsightEnabled) {
      if (skipNextStreamDblClickDrillRef.current) {
        skipNextStreamDblClickDrillRef.current = false;
        ev.preventDefault();
        ev.stopPropagation();
        return;
      }
      runStreamDrillOpen(ev);
      return;
    }
    ev.preventDefault();
    ev.stopPropagation();
    onOpenThread?.(ev);
  };

  const editTypeLabel =
    NOTE_TYPE_OPTIONS.find((o) => o.value === editNoteType)?.label ?? editNoteType;

  const cardClassNames = [
    cardClass,
    'note-card--has-type-icon',
    editing ? 'note-card--editing' : '',
    hoverInsightEnabled && insightActive && !isInsightSelected ? 'note-card--insight-dimmed' : '',
    hoverInsightEnabled && isInsightSelected ? 'note-card--insight-selected' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const streamTitle =
    hoverInsightEnabled && !editing
      ? depth > 0
        ? `Click: tag & connection suggestions · Double-click to focus this note here${
            hasConnections ? ` · ${connectionCount} linked note${connectionCount === 1 ? '' : 's'}` : ''
          }`
        : `Click: tag & connection suggestions · Double-click a reply to focus it here${
            hasConnections ? ` · ${connectionCount} linked note${connectionCount === 1 ? '' : 's'}` : ''
          }`
      : undefined;

  const taskUpdateChainRef = useRef(Promise.resolve());
  const handleToggleTask = useCallback(
    (taskIndex, nextChecked) => {
      taskUpdateChainRef.current = taskUpdateChainRef.current.then(async () => {
        const prevContent = renderedContentRef.current == null ? '' : String(renderedContentRef.current);
        const nextContent = toggleTaskMarkerAtIndex(prevContent, taskIndex, nextChecked);
        if (nextContent === prevContent) return;
        setRenderedContent(nextContent);
        try {
          await updateNote(note.id, { content: nextContent });
          await syncTagsFromContent(note.id, nextContent, note.tags, prevContent);
          await syncConnectionsFromContent(note.id, nextContent, prevContent);
          onNoteUpdate?.();
        } catch (err) {
          console.error(err);
          setRenderedContent(prevContent);
        }
      });
    },
    [note.id, note.tags, onNoteUpdate]
  );

  /**
   * Right connection stripe: for leaf notes, left uses borderWidth 1px + var(--border) — if we reused
   * that for the right, the “stripe” is 1px and the same color as the frame (invisible). Use a
   * minimum 2px and thread accent for leaf+linked; threaded notes keep width/color aligned with left.
   */
  const linkStripeWidthPx = hasConnections
    ? showThreadline
      ? borderWidth
      : Math.max(2, borderWidth)
    : null;
  const linkedBorderVars =
    hasConnections
      ? {
          '--hermes-link-rw': `${linkStripeWidthPx}px`,
          '--hermes-link-rc': !showThreadline
            ? 'var(--accent-dim, #6d5610)'
            : depth <= 0
              ? 'var(--accent-dim, #6d5610)'
              : depth === 1
                ? '#5a4a2a'
                : depth === 2
                  ? '#4a3a1a'
                  : '#3a2a12',
        }
      : null;

  return (
    <article
      className={cardClassNames}
      style={{
        borderLeftWidth: borderWidth,
        ...linkedBorderVars,
      }}
      onClick={editing ? undefined : handleCardClick}
      onMouseDown={editing ? undefined : handleCardMouseDown}
      onDoubleClick={editing ? undefined : handleCardDoubleClick}
      role={editing ? undefined : 'button'}
      tabIndex={editing ? undefined : 0}
      aria-pressed={hoverInsightEnabled && isInsightSelected ? true : undefined}
      title={streamTitle}
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
      {editing ? (
        <button
          type="button"
          className="note-card-type-cycle-btn"
          onClick={cycleEditNoteType}
          aria-label={`Note type: ${editTypeLabel}. Click for next type.`}
          title={`${editTypeLabel} — click for next type`}
        >
          <NoteTypeIcon type={editNoteType} className="note-card-type-icon note-card-type-icon--in-btn" />
        </button>
      ) : (
        <NoteTypeIcon type={note.note_type || 'note'} className="note-card-type-icon" />
      )}
      <div className="note-card-body">
        {editing ? (
          <form className="note-card-edit" onSubmit={handleSaveEdit} onClick={(e) => e.stopPropagation()}>
            <MentionsTextarea
              value={editContent}
              onChange={setEditContent}
              noteId={note.id}
              rows={3}
              className="note-card-edit-textarea"
              autoFocus
            />
            <NoteTypeEventFields
              idPrefix={`edit-${note.id}`}
              noteType={editNoteType}
              onNoteTypeChange={setEditNoteType}
              hideTypeSelect
              startDate={editStartDate}
              onStartDateChange={setEditStartDate}
              startTime={editStartTime}
              onStartTimeChange={setEditStartTime}
              endDate={editEndDate}
              onEndDateChange={setEditEndDate}
              endTime={editEndTime}
              onEndTimeChange={setEditEndTime}
            />
            <div className="note-card-edit-attachments">
              {note.attachments?.length > 0 ? (
                <NoteAttachments attachments={note.attachments} onDeleted={handleDeleteAttachment} />
              ) : null}
            </div>
            <div className="note-card-edit-actions">
              <button
                type="button"
                className="note-card-edit-attach-btn"
                onClick={() => editFileInputRef.current?.click()}
                aria-label="Attach files"
                title="Attach files"
              >
                <NavIconAttach className="note-card-edit-attach-icon" />
              </button>
              <input
                ref={editFileInputRef}
                className="note-card-edit-file-input-hidden"
                type="file"
                multiple
                accept="image/*,.pdf,.txt,.md,.doc,.docx,.zip"
                onChange={handleEditAddFiles}
              />
              <button type="submit">Save</button>
              <button type="button" onClick={handleCancelEdit}>Cancel</button>
            </div>
          </form>
        ) : (
          <>
            <div className="note-card-content">
              {renderedContent?.trim() ? (
                <NoteRichText
                  text={renderedContent}
                  tagNames={tags.map((t) => t.name)}
                  className="note-card-content-rich"
                  onNoteClick={openLinkedNote}
                  onTaskToggle={handleToggleTask}
                />
              ) : note.attachments?.length ? null : (
                '—'
              )}
            </div>
            {eventRangeLabel ? <p className="note-card-event-range">{eventRangeLabel}</p> : null}
            <NoteAttachments attachments={note.attachments} onDeleted={handleDeleteAttachment} />
            {tags.length > 0 && (
              <div className="note-card-tags">
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
        <div className="note-card-meta">
          <div className="note-card-actions" onClick={(e) => e.stopPropagation()}>
            {!editing && (
              <>
                <button type="button" className="note-card-btn" onClick={beginEdit}>Edit</button>
                <button type="button" className="note-card-btn note-card-btn-delete" onClick={handleDelete}>
                  Delete
                </button>
                <div className="note-card-tag-add" ref={tagDropdownRef}>
                  {addingTag ? (
                    <ul
                      id={`note-tag-menu-${note.id}`}
                      className="note-card-tag-dropdown"
                      role="listbox"
                      aria-label="Add tag"
                    >
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
                    </ul>
                  ) : null}
                  <button
                    type="button"
                    className="note-card-tag-add-btn"
                    onClick={openTagDropdown}
                    aria-expanded={addingTag}
                    aria-haspopup="listbox"
                    aria-controls={addingTag ? `note-tag-menu-${note.id}` : undefined}
                  >
                    + Tag
                  </button>
                </div>
              </>
            )}
            {!hideStar && (
              <button
                type="button"
                className={`note-card-star ${note.starred ? 'note-card-star--on' : ''}`}
                onClick={handleStar}
                aria-label={note.starred ? 'Unstar' : 'Star'}
              >
                ★
              </button>
            )}
          </div>
          <time className="note-card-time">
            Last edited:{' '}
            {new Date(note.updated_at).toLocaleDateString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
            })}
          </time>
        </div>
      </div>
    </article>
  );
}
