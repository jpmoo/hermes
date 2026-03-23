import React, { useState, useRef, useEffect, useCallback, useId } from 'react';
import { searchContent, getTags, createNoteConnection, addNoteTag } from './api';
import {
  getActiveTrigger,
  replaceTriggerQuery,
  formatNoteMentionLink,
} from './noteBodyUtils';
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
  const top = r.top + pt + (line + 1) * lh + window.scrollY;
  const left = r.left + pl + col * cw + window.scrollX;
  return { top, left };
}

export default function MentionsTextarea({
  value,
  onChange,
  noteId = null,
  excludeNoteIds = [],
  rows = 3,
  className = '',
  placeholder,
  disabled = false,
  autoFocus = false,
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
    const trig = getActiveTrigger(value, pos);
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
  }, [value, closeMenu]);

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
    const trig = getActiveTrigger(value, pos);
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
      if (searchTimer.current) clearTimeout(searchTimer.current);
      if (q.length < 1) {
        setItems([]);
        setLoading(false);
        return;
      }
      setLoading(true);
      searchTimer.current = setTimeout(async () => {
        try {
          const list = await searchContent(q, 12);
          const ex = new Set(excludeNoteIds.map(String));
          if (noteId) ex.add(String(noteId));
          const filtered = list.filter((n) => !ex.has(String(n.id)));
          setItems(
            filtered.map((n) => ({
              key: n.id,
              id: n.id,
              label: (n.content || '').replace(/\s+/g, ' ').trim().slice(0, 72) || 'Note',
              raw: n,
            }))
          );
        } catch (e) {
          console.error(e);
          setItems([]);
        } finally {
          setLoading(false);
        }
      }, 200);
      return () => {
        if (searchTimer.current) clearTimeout(searchTimer.current);
      };
    }

    if (menu.type === '#') {
      (async () => {
        try {
          if (!tagsCache.current) tagsCache.current = await getTags();
          const all = tagsCache.current || [];
          const q = menu.query.toLowerCase();
          const filtered = all
            .filter((t) => !q || t.name.includes(q))
            .slice(0, 40)
            .map((t) => ({ key: t.id, id: t.id, name: t.name, label: t.name }));
          setItems(filtered);
        } catch (e) {
          console.error(e);
          setItems([]);
        }
      })();
    }
    return undefined;
  }, [menuQueryKey, menu?.type, noteId, excludeNoteIds]);

  const applyMention = async (item) => {
    const el = taRef.current;
    if (!menu || !el) return;
    const caret = el.selectionStart ?? menu.caret;
    const link = formatNoteMentionLink(item.label, item.id);
    const next = replaceTriggerQuery(value, menu.start, caret, link);
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
    if (!menu || !el) return;
    const caret = el.selectionStart ?? menu.caret;
    const insertion = `#${item.name}`;
    const next = replaceTriggerQuery(value, menu.start, caret, insertion);
    onChange(next);
    if (noteId) {
      try {
        await addNoteTag(noteId, { tag_id: item.id });
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
    if (!menu || items.length === 0) {
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
      if (menu.type === '@') applyMention(item);
      else applyTag(item);
    }
  };

  const onSelect = (item) => {
    if (!menu) return;
    if (menu.type === '@') applyMention(item);
    else applyTag(item);
  };

  const onChangeInner = (e) => {
    onChange(e.target.value);
    requestAnimationFrame(refreshMenu);
  };

  const onClickInner = () => requestAnimationFrame(refreshMenu);
  const onSelectInner = () => requestAnimationFrame(refreshMenu);

  return (
    <div className="mentions-textarea-wrap">
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
        aria-expanded={Boolean(menu && items.length > 0)}
      />
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
          aria-label={menu.type === '@' ? 'Notes' : 'Tags'}
        >
          {menu.type === '@' && menu.query.trim().length < 1 && !loading && (
            <div className="mentions-menu-hint">Keep typing to search notes…</div>
          )}
          {loading && <div className="mentions-menu-hint">Searching…</div>}
          {!loading &&
            items.map((it, i) => (
              <button
                key={it.key}
                type="button"
                role="option"
                aria-selected={i === highlight}
                className={`mentions-menu-item ${i === highlight ? 'mentions-menu-item--active' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelect(it)}
                onMouseEnter={() => setHighlight(i)}
              >
                {menu.type === '@' ? it.label : `#${it.name}`}
              </button>
            ))}
          {!loading && menu.type === '@' && menu.query.trim().length >= 1 && items.length === 0 && (
            <div className="mentions-menu-hint">No matching notes</div>
          )}
          {!loading && menu.type === '#' && items.length === 0 && (
            <div className="mentions-menu-hint">No matching tags</div>
          )}
        </div>
      )}
    </div>
  );
}
