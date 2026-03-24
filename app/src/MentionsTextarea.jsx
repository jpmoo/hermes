import React, { useState, useRef, useEffect, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
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
  resolveMentionTrigger,
  replaceTriggerQuery,
  formatNoteMentionLink,
  caretForTriggerReplace,
} from './noteBodyUtils';
import './MentionsTextarea.css';

/** First line as shown in @-mention labels (prefix match must agree with this). */
function noteTitleLineForMention(content) {
  return (content || '')
    .split(/\n/)[0]
    .replace(/\r/g, '')
    .replace(/^\uFEFF/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** WebKit on iPad often reports null or stale selectionStart; clamp using known text length. */
function readTextareaCaret(el, text) {
  const len = text.length;
  const raw = el.selectionStart;
  if (raw == null || typeof raw !== 'number' || !Number.isFinite(raw)) {
    return len;
  }
  return Math.min(Math.max(0, Math.round(raw)), len);
}

function caretMenuPosition(textarea, caretPos) {
  const cs = getComputedStyle(textarea);
  const div = document.createElement('div');
  const props = [
    'boxSizing',
    'width',
    'height',
    'overflowX',
    'overflowY',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'fontStyle',
    'fontVariant',
    'fontWeight',
    'fontStretch',
    'fontSize',
    'fontFamily',
    'lineHeight',
    'letterSpacing',
    'textTransform',
    'textIndent',
    'textDecoration',
    'textAlign',
    'whiteSpace',
    'wordSpacing',
    'wordBreak',
    'overflowWrap',
    'tabSize',
  ];
  props.forEach((p) => {
    div.style[p] = cs[p];
  });
  div.style.position = 'fixed';
  div.style.left = '-9999px';
  div.style.top = '0';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';

  const text = textarea.value.slice(0, caretPos);
  div.textContent = text;
  const span = document.createElement('span');
  span.textContent = textarea.value.slice(caretPos) || '.';
  div.appendChild(span);
  document.body.appendChild(div);

  const taRect = textarea.getBoundingClientRect();
  const spanRect = span.getBoundingClientRect();
  const lh = parseFloat(cs.lineHeight) || 20;
  const borderLeft = parseFloat(cs.borderLeftWidth) || 0;
  const borderTop = parseFloat(cs.borderTopWidth) || 0;
  const leftRaw = taRect.left + (spanRect.left - div.getBoundingClientRect().left) - textarea.scrollLeft + borderLeft;
  const topRaw = taRect.top + (spanRect.top - div.getBoundingClientRect().top) - textarea.scrollTop + lh + borderTop;
  document.body.removeChild(div);

  const menuWidth = 280;
  const menuMaxH = 230;
  const pad = 10;
  const vv = window.visualViewport;
  const vLeft = vv ? vv.offsetLeft : 0;
  const vTop = vv ? vv.offsetTop : 0;
  const vW = vv ? vv.width : window.innerWidth;
  const vH = vv ? vv.height : window.innerHeight;
  const left = Math.max(vLeft + pad, Math.min(leftRaw, vLeft + vW - menuWidth - pad));
  const top = Math.max(vTop + pad, Math.min(topRaw, vTop + vH - menuMaxH - pad));
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
}) {
  const taRef = useRef(null);
  const wrapRef = useRef(null);
  const menuRef = useRef(null);
  const [menu, setMenu] = useState(null);
  const [items, setItems] = useState([]);
  const [highlight, setHighlight] = useState(0);
  const [loading, setLoading] = useState(false);
  const searchTimer = useRef(null);
  const tagsCache = useRef(null);
  const menuDomId = useId();
  const refreshDelayTimer = useRef(null);

  useEffect(
    () => () => {
      if (refreshDelayTimer.current) clearTimeout(refreshDelayTimer.current);
    },
    []
  );

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
    /* Use live DOM value: onChange + rAF runs before React re-renders with new `value` prop */
    const text = el.value;
    const rawPos = readTextareaCaret(el, text);
    const { trig, menuCaret } = resolveMentionTrigger(text, rawPos);
    if (!trig) {
      closeMenu();
      return;
    }
    const coords = caretMenuPosition(el, menuCaret);
    setMenu((prev) => {
      if (prev && prev.type === trig.type && prev.start === trig.start && prev.query === trig.query) {
        return { ...prev, caret: rawPos, ...coords };
      }
      return { ...trig, caret: rawPos, ...coords };
    });
  }, [closeMenu]);

  /* Keep the menu above the on-screen keyboard when the visual viewport shrinks (iOS). */
  useEffect(() => {
    if (!menu) return undefined;
    const vv = window.visualViewport;
    if (!vv) return undefined;
    const bump = () => refreshMenu();
    vv.addEventListener('resize', bump);
    vv.addEventListener('scroll', bump);
    return () => {
      vv.removeEventListener('resize', bump);
      vv.removeEventListener('scroll', bump);
    };
  }, [menu, refreshMenu]);

  const menuQueryKey = menu ? `${menu.type}\0${menu.start}\0${menu.query}` : '';

  useEffect(() => {
    if (!menuQueryKey) return;
    setHighlight(0);
  }, [menuQueryKey]);

  /* After value commits, WebKit may update selection on the next frame; validate then using canonical `value`. */
  useEffect(() => {
    if (!menu) return undefined;
    let cancelled = false;
    let innerRaf = 0;
    const outerRaf = requestAnimationFrame(() => {
      innerRaf = requestAnimationFrame(() => {
        if (cancelled) return;
        const el = taRef.current;
        if (!el) return;
        const text = value;
        const pos = readTextareaCaret(el, text);
        const { trig } = resolveMentionTrigger(text, pos);
        if (!trig || trig.start !== menu.start || trig.type !== menu.type) {
          closeMenu();
        }
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(outerRaf);
      cancelAnimationFrame(innerRaf);
    };
  }, [value, menu, closeMenu]);

  useEffect(() => {
    if (!menu) return undefined;
    let onDoc = null;
    let raf2 = 0;
    /* Defer so iPad keyboard / the same gesture doesn’t deliver a capture pointerdown that closes immediately. */
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        onDoc = (e) => {
          if (
            menuRef.current?.contains(e.target) ||
            taRef.current?.contains(e.target) ||
            wrapRef.current?.contains(e.target)
          ) {
            return;
          }
          closeMenu();
        };
        document.addEventListener('pointerdown', onDoc, true);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      if (onDoc) document.removeEventListener('pointerdown', onDoc, true);
    };
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
          const qNorm = qForSearch.trim().toLowerCase();
          const list = await searchContent(qForSearch, 40, { firstLine: true });
          const filtered = list.filter((n) =>
            qNorm ? noteTitleLineForMention(n.content).toLowerCase().startsWith(qNorm) : true
          );
          const noteItems = filtered.slice(0, 12).map((n) => ({
            kind: 'note',
            key: n.id,
            id: n.id,
            label:
              noteTitleLineForMention(n.content).slice(0, 72) || 'Note',
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
            .filter((t) => !qLower || (t.name && t.name.toLowerCase().startsWith(qLower)))
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
          setLoading(false);
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
    const caret = caretForTriggerReplace(el, menu);
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

  const scheduleRefreshMenu = useCallback(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(refreshMenu);
    });
  }, [refreshMenu]);

  const onKeyDown = (e) => {
    if (!menu) {
      /* iOS Safari often omits key for symbols; onChange + scheduleRefreshMenu handles insertion. */
      if (e.key === '@' || e.key === '#') {
        scheduleRefreshMenu();
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
    scheduleRefreshMenu();
    /* WebKit may update selection after the input event; one delayed refresh catches leading #/@. */
    if (refreshDelayTimer.current) clearTimeout(refreshDelayTimer.current);
    refreshDelayTimer.current = setTimeout(() => {
      refreshDelayTimer.current = null;
      refreshMenu();
    }, 100);
  };

  const onBeforeInputInner = (e) => {
    const d = e.nativeEvent?.data;
    if (d === '#' || d === '@') {
      scheduleRefreshMenu();
    }
  };

  const onCompositionEndInner = () => {
    scheduleRefreshMenu();
  };

  const onClickInner = () => scheduleRefreshMenu();
  const onSelectInner = () => scheduleRefreshMenu();

  const textareaEl = (
    <textarea
      ref={taRef}
      className={className}
      rows={rows}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      enterKeyHint="enter"
      onChange={onChangeInner}
      onBeforeInput={onBeforeInputInner}
      onCompositionEnd={onCompositionEndInner}
      onKeyDown={onKeyDown}
      onClick={onClickInner}
      onSelect={onSelectInner}
      aria-autocomplete={menu ? 'list' : undefined}
      aria-controls={menu ? menuDomId : undefined}
      aria-expanded={Boolean(menu && (items.length > 0 || loading))}
    />
  );

  const menuPortal =
    menu &&
    createPortal(
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
        {menu.type === '@' && menu.query.trim().length < 1 && loading && (
          <div className="mentions-menu-hint">Loading recent notes…</div>
        )}
        {menu.type === '@' && menu.query.trim().length >= 1 && loading && (
          <div className="mentions-menu-hint">Searching…</div>
        )}
        {menu.type === '#' && loading && (
          <div className="mentions-menu-hint">Loading tags…</div>
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
      </div>,
      document.body
    );

  return (
    <div ref={wrapRef} className="mentions-textarea-wrap">
      {textareaEl}
      {menuPortal}
    </div>
  );
}
