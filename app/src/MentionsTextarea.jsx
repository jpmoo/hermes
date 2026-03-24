import React, { useState, useRef, useEffect, useCallback, useId } from 'react';
import {
  searchContent,
  getMentionRecentNotes,
  getTags,
  createTag,
  createNote,
  createNoteConnection,
  addNoteTag,
} from './api';
import {
  getActiveTrigger,
  replaceTriggerQuery,
  formatNoteMentionLink,
} from './noteBodyUtils';
import NoteTypeIcon from './NoteTypeIcon';
import './MentionsTextarea.css';

function caretMenuPosition(textarea, caretPos) {
  const textBefore = textarea.value.slice(0, caretPos);
  const lines = textBefore.split('\n');
  const line = lines.length - 1;
  const col = lines[line].length;
  const cs = getComputedStyle(textarea);
  const lh = parseFloat(cs.lineHeight) || 20;
  const pl = parseFloat(cs.paddingLeft) || 0;
  const pt = parseFloat(cs.paddingTop) || 0;
  const cw = 7.2;
  const r = textarea.getBoundingClientRect();
  /* position:fixed is viewport-relative; do not add scroll offsets (getBoundingClientRect is already viewport) */
  const top = r.top + pt + (line + 1) * lh;
  const left = r.left + pl + col * cw;
  return { top, left };
}

export default function MentionsTextarea({
  value,
  onChange,
  noteId = null,
  rows = 3,
  className = '',
  placeholder,
  disabled = false,
  autoFocus = false,
  mentionCreateParentId = null,
  /** Stream compose: show type icon left of box; click cycles types */
  composeNoteType = null,
  composeNoteTypeOptions = null,
  onComposeNoteTypeChange = null,
}) {
  const taRef = useRef(null);
  const menuRef = useRef(null);
  const [menu, setMenu] = useState(null);
  const [items, setItems] = useState([]);
  const [highlight, setHighlight] = useState(0);
  const [loading, setLoading] = useState(false);
  const searchTimer = useRef(null);
  const tagsCache = useRef(null);
  const menuDomId = useId();

  const showComposeTypeChrome = Boolean(
    composeNoteType != null && composeNoteTypeOptions?.length && onComposeNoteTypeChange
  );

  const composeTypeLabel =
    composeNoteTypeOptions?.find((o) => o.value === composeNoteType)?.label ?? composeNoteType ?? 'Note';

  const cycleComposeNoteType = useCallback(() => {
    if (!onComposeNoteTypeChange || !composeNoteTypeOptions?.length) return;
    const i = composeNoteTypeOptions.findIndex((o) => o.value === composeNoteType);
    const idx = i >= 0 ? i : 0;
    const next = composeNoteTypeOptions[(idx + 1) % composeNoteTypeOptions.length];
    onComposeNoteTypeChange(next.value);
  }, [composeNoteType, composeNoteTypeOptions, onComposeNoteTypeChange]);

  const closeMenu = useCallback(() => {
    setMenu(null);
    setItems([]);
    setHighlight(0);
    setLoading(false);
    if (searchTimer.current) {
      clearTimeout(searchTimer.current);
      searchTimer.current = null;
    }
  }, []);

  const refreshMenu = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    const pos = el.selectionStart ?? 0;
    /* Use live DOM value: onChange + rAF runs before React re-renders with new `value` prop */
    const text = el.value;
    const trig = getActiveTrigger(text, pos);
    if (!trig) {
      closeMenu();
      return;
    }
    const coords = caretMenuPosition(el, pos);
    setMenu((prev) => {
      if (prev && prev.type === trig.type && prev.start === trig.start && prev.query === trig.query) {
        return { ...prev, caret: pos, ...coords };
      }
      return { ...trig, caret: pos, ...coords };
    });
  }, [closeMenu]);

  const menuQueryKey = menu ? `${menu.type}\0${menu.start}\0${menu.query}` : '';

  useEffect(() => {
    if (!menuQueryKey) return;
    setHighlight(0);
  }, [menuQueryKey]);

  useEffect(() => {
    if (!menu) return;
    const el = taRef.current;
    if (!el) return;
    const pos = el.selectionStart ?? 0;
    const trig = getActiveTrigger(el.value, pos);
    if (!trig || trig.start !== menu.start || trig.type !== menu.type) {
      closeMenu();
    }
  }, [value, menu, closeMenu]);

  useEffect(() => {
    if (!menu) return undefined;
    const onDoc = (e) => {
      if (menuRef.current?.contains(e.target) || taRef.current?.contains(e.target)) return;
      closeMenu();
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [menu, closeMenu]);

  useEffect(() => {
    if (!menu) return;

    if (menu.type === '@') {
      const q = menu.query.trim();
      const qForSearch = q.replace(/_/g, ' ').trim();
      if (searchTimer.current) clearTimeout(searchTimer.current);
      if (q.length < 1) {
        let cancelled = false;
        setLoading(true);
        (async () => {
          try {
            const list = await getMentionRecentNotes(12);
            if (cancelled) return;
            setItems(
              list.map((n) => ({
                kind: 'note',
                key: n.id,
                id: n.id,
                label:
                  (n.content || '').split(/\n/)[0].replace(/\s+/g, ' ').trim().slice(0, 72) || 'Note',
                raw: n,
              }))
            );
          } catch (e) {
            console.error(e);
            if (!cancelled) setItems([]);
          } finally {
            setLoading(false);
          }
        })();
        return () => {
          cancelled = true;
          if (searchTimer.current) clearTimeout(searchTimer.current);
          setLoading(false);
        };
      }
      setLoading(true);
      searchTimer.current = setTimeout(async () => {
        try {
          const list = await searchContent(qForSearch, 12);
          const noteItems = list.map((n) => ({
            kind: 'note',
            key: n.id,
            id: n.id,
            label:
              (n.content || '').split(/\n/)[0].replace(/\s+/g, ' ').trim().slice(0, 72) || 'Note',
            raw: n,
          }));
          const createItems =
            noteItems.length === 0 && mentionCreateParentId && qForSearch
              ? [
                  {
                    kind: 'note-create',
                    key: '__create_mention_note__',
                    createText: qForSearch,
                    label: `Create note in this thread: "${qForSearch}"`,
                  },
                ]
              : [];
          setItems([
            ...noteItems,
            ...createItems,
          ]);
        } catch (e) {
          console.error(e);
          const createItems =
            mentionCreateParentId && qForSearch
              ? [
                  {
                    kind: 'note-create',
                    key: '__create_mention_note__',
                    createText: qForSearch,
                    label: `Create note in this thread: "${qForSearch}"`,
                  },
                ]
              : [];
          setItems(createItems);
        } finally {
          setLoading(false);
        }
      }, 180);
      return () => {
        if (searchTimer.current) clearTimeout(searchTimer.current);
        searchTimer.current = null;
        setLoading(false);
      };
    }

    if (menu.type === '#') {
      const qRaw = menu.query;
      const q = qRaw.trim();
      const qLower = q.toLowerCase();

      if (q.length < 1) {
        let cancelled = false;
        setLoading(true);
        setItems([]);
        (async () => {
          try {
            if (!tagsCache.current) tagsCache.current = await getTags();
            if (cancelled) return;
            const all = Array.isArray(tagsCache.current) ? tagsCache.current : [];
            const tagItems = all.slice(0, 40).map((t) => ({
              kind: 'tag',
              key: `t-${t.id}`,
              id: t.id,
              name: t.name,
              label: t.name,
            }));
            if (cancelled) return;
            setItems(tagItems);
          } catch (e) {
            console.error(e);
            if (!cancelled) setItems([]);
          } finally {
            setLoading(false);
          }
        })();
        return () => {
          cancelled = true;
          setLoading(false);
        };
      }

      if (searchTimer.current) clearTimeout(searchTimer.current);
      setLoading(true);
      setItems([]);

      (async () => {
        try {
          if (!tagsCache.current) tagsCache.current = await getTags();
          const all = Array.isArray(tagsCache.current) ? tagsCache.current : [];
          const tagItems = all
            .filter((t) => !qLower || (t.name && t.name.toLowerCase().includes(qLower)))
            .slice(0, 24)
            .map((t) => ({
              kind: 'tag',
              key: `t-${t.id}`,
              id: t.id,
              name: t.name,
              label: t.name,
            }));
          const rawTag = q;
          const normalized = rawTag.toLowerCase().replace(/\s+/g, '-');
          const validNewTag = /^[a-z0-9-]+$/.test(normalized) && normalized.length > 0;
          const exactTagExists = all.some((t) => (t.name || '').toLowerCase() === normalized);

          searchTimer.current = setTimeout(async () => {
            try {
              const showCreateRow = validNewTag && !exactTagExists && !tagItems.length;
              const createRow = showCreateRow
                ? [
                    {
                      kind: 'tag',
                      key: '__create__',
                      createNew: true,
                      createName: rawTag,
                      name: normalized,
                      label: `Create tag #${normalized}`,
                    },
                  ]
                : [];
              setItems([...tagItems, ...createRow]);
            } catch (e) {
              console.error(e);
              const showCreateRow = validNewTag && !exactTagExists && !tagItems.length;
              const createRow = showCreateRow
                ? [
                    {
                      kind: 'tag',
                      key: '__create__',
                      createNew: true,
                      createName: rawTag,
                      name: normalized,
                      label: `Create tag #${normalized}`,
                    },
                  ]
                : [];
              setItems([...tagItems, ...createRow]);
            } finally {
              setLoading(false);
            }
          }, 180);
        } catch (e) {
          console.error(e);
          setItems([]);
          setLoading(false);
        }
      })();

      return () => {
        if (searchTimer.current) {
          clearTimeout(searchTimer.current);
          searchTimer.current = null;
        }
        setLoading(false);
      };
    }
    return undefined;
  }, [menuQueryKey, menu?.type, mentionCreateParentId]);

  const applyMention = async (item) => {
    const el = taRef.current;
    if (!menu || !el) return;
    const caret = el.selectionStart ?? menu.caret;
    if (item.kind === 'note-create') {
      if (!mentionCreateParentId) return;
      try {
        const created = await createNote({
          content: item.createText || menu.query.trim().replace(/_/g, ' '),
          parent_id: mentionCreateParentId,
        });
        const label =
          (created.content || '').split(/\n/)[0].replace(/\s+/g, ' ').trim().slice(0, 72) ||
          item.createText ||
          'Note';
        const link = formatNoteMentionLink(label, created.id);
        const next = replaceTriggerQuery(el.value, menu.start, caret, link);
        onChange(next);
        if (noteId) {
          try {
            await createNoteConnection(noteId, created.id);
          } catch (e) {
            console.error(e);
          }
        }
        closeMenu();
        requestAnimationFrame(() => {
          const pos = menu.start + link.length;
          el.focus();
          el.setSelectionRange(pos, pos);
        });
      } catch (e) {
        console.error(e);
      }
      return;
    }
    const link = formatNoteMentionLink(item.label, item.id);
    const next = replaceTriggerQuery(el.value, menu.start, caret, link);
    onChange(next);
    if (noteId) {
      try {
        await createNoteConnection(noteId, item.id);
      } catch (e) {
        console.error(e);
      }
    }
    closeMenu();
    requestAnimationFrame(() => {
      const pos = menu.start + link.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const applyTag = async (item) => {
    const el = taRef.current;
    if (!menu || !el || item.kind === 'note') return;
    const caret = el.selectionStart ?? menu.caret;
    let tagId = item.id;
    let tagName = item.name;
    if (item.createNew) {
      try {
        const created = await createTag(item.createName ?? item.name);
        tagsCache.current = null;
        tagId = created.id;
        tagName = created.name;
      } catch (e) {
        console.error(e);
        return;
      }
    }
    const insertion = `#${tagName}`;
    const next = replaceTriggerQuery(el.value, menu.start, caret, insertion);
    onChange(next);
    if (noteId) {
      try {
        await addNoteTag(noteId, { tag_id: tagId });
      } catch (e) {
        console.error(e);
      }
    }
    closeMenu();
    requestAnimationFrame(() => {
      const pos = menu.start + insertion.length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e) => {
    if (!menu) {
      if (e.key === '@' || e.key === '#') {
        requestAnimationFrame(refreshMenu);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
      return;
    }
    if (items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, items.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const item = items[highlight] ?? items[0];
      if (!item) return;
      if (menu.type === '@') void applyMention(item);
      else if (item.kind === 'note') void applyMention(item);
      else void applyTag(item);
    }
  };

  const onSelect = (item) => {
    if (!menu) return;
    if (menu.type === '@') void applyMention(item);
    else if (item.kind === 'note') void applyMention(item);
    else void applyTag(item);
  };

  const onChangeInner = (e) => {
    onChange(e.target.value);
    requestAnimationFrame(refreshMenu);
  };

  const onClickInner = () => requestAnimationFrame(refreshMenu);
  const onSelectInner = () => requestAnimationFrame(refreshMenu);

  const textareaEl = (
    <textarea
      ref={taRef}
      className={className}
      rows={rows}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      onChange={onChangeInner}
      onKeyDown={onKeyDown}
      onClick={onClickInner}
      onSelect={onSelectInner}
      aria-autocomplete={menu ? 'list' : undefined}
      aria-controls={menu ? menuDomId : undefined}
      aria-expanded={Boolean(menu && (items.length > 0 || loading))}
    />
  );

  return (
    <div
      className={`mentions-textarea-wrap${showComposeTypeChrome ? ' mentions-textarea-wrap--with-type' : ''}`}
    >
      {showComposeTypeChrome ? (
        <>
          <button
            type="button"
            className="mentions-compose-type-btn"
            disabled={disabled}
            onClick={cycleComposeNoteType}
            aria-label={`Note type: ${composeTypeLabel}. Click to switch type.`}
            title={`${composeTypeLabel} — click for next type`}
          >
            <NoteTypeIcon type={composeNoteType} className="mentions-compose-type-icon" />
          </button>
          <div className="mentions-textarea-field">{textareaEl}</div>
        </>
      ) : (
        textareaEl
      )}
      {menu && (
        <div
          ref={menuRef}
          id={menuDomId}
          className="mentions-menu"
          style={{
            position: 'fixed',
            top: menu.top,
            left: menu.left,
            zIndex: 10000,
          }}
          role="listbox"
          aria-label={menu.type === '@' ? 'Notes' : 'Tags and notes'}
        >
          {menu.type === '@' && menu.query.trim().length < 1 && loading && (
            <div className="mentions-menu-hint">Loading recent notes…</div>
          )}
          {menu.type === '@' && menu.query.trim().length >= 1 && loading && (
            <div className="mentions-menu-hint">Searching…</div>
          )}
          {menu.type === '#' && loading && (
            <div className="mentions-menu-hint">Loading tags and notes…</div>
          )}
          {!loading &&
            items.map((it, i) => (
              <button
                key={it.key}
                type="button"
                role="option"
                aria-selected={i === highlight}
                className={`mentions-menu-item ${it.createNew ? 'mentions-menu-item--create' : ''} ${it.kind === 'note' ? 'mentions-menu-item--note-ref' : ''} ${i === highlight ? 'mentions-menu-item--active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelect(it)}
                onMouseEnter={() => setHighlight(i)}
              >
                {menu.type === '@'
                  ? it.label
                  : it.kind === 'note'
                    ? it.label
                    : it.createNew
                      ? it.label
                      : `#${it.name}`}
              </button>
            ))}
          {!loading && menu.type === '@' && menu.query.trim().length < 1 && items.length === 0 && (
            <div className="mentions-menu-hint">No recent notes</div>
          )}
          {!loading && menu.type === '@' && menu.query.trim().length >= 1 && items.length === 0 && (
            <div className="mentions-menu-hint">No matching notes</div>
          )}
          {!loading && menu.type === '#' && items.length === 0 && (
            <div className="mentions-menu-hint">
              No matching tags or notes. For a new tag, use letters, numbers, and hyphens.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
