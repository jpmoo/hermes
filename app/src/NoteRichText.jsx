import React, { useCallback, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { createSpaztickTaskFromTitle } from './api';
import { NoteCardIconSpaztick } from './icons/NoteCardActionIcons';
import { useNoteTypeColors } from './NoteTypeColorContext';
import './NoteRichText.css';

const UNSAFE_HREF = /^\s*(javascript|data|vbscript):/i;

/** Short visible label for http(s) / mailto; full URL stays on `href` and `title`. */
export function formatUrlDisplayLabel(href) {
  const raw = String(href || '').trim();
  if (!raw) return 'Link';
  try {
    const u = new URL(raw);
    if (u.protocol === 'mailto:') {
      const addr = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      return addr || 'Email';
    }
    const host = u.hostname.replace(/^www\./i, '');
    const path = u.pathname === '/' ? '' : u.pathname;
    const tail = path + u.search;
    if (!tail) return host;
    if (tail.length <= 22) return `${host}${tail}`;
    return `${host}/…`;
  } catch {
    return raw.length > 32 ? `${raw.slice(0, 30)}…` : raw;
  }
}

/**
 * Toggle the Nth markdown task marker in text (0-based among `- [ ]` / `- [x]` items).
 * Preserves list marker and spacing; only switches the check token.
 */
export function toggleTaskMarkerAtIndex(text, taskIndex, nextChecked) {
  const src = text == null ? '' : String(text);
  if (taskIndex < 0) return src;
  const re = /(^|\n)([ \t]*[-*]\s+\[)( |x|X)(\])/g;
  let i = 0;
  let replaced = false;
  const out = src.replace(re, (m, pre, start, mark, end) => {
    if (replaced || i !== taskIndex) {
      i += 1;
      return m;
    }
    replaced = true;
    i += 1;
    return `${pre}${start}${nextChecked ? 'x' : ' '}${end}`;
  });
  return replaced ? out : src;
}

/** GFM task lines: `- [ ] title` / `* [x] title` / `1. [ ] title` — document order. */
function extractGfmTaskTitles(src) {
  const out = [];
  for (const line of String(src ?? '').split(/\n/)) {
    const bullet = line.match(/^[ \t]*[-*]\s+\[(?: |x|X)\]\s+(.*)$/);
    const ordered = line.match(/^[ \t]*\d+\.\s+\[(?: |x|X)\]\s+(.*)$/);
    const m = bullet || ordered;
    if (m) out.push(m[1]);
  }
  return out;
}

/** Plain title for Spaztick (strip common inline markdown). */
function plainTextFromTaskLine(line) {
  let t = String(line ?? '').trim();
  if (!t) return '';
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/\*([^*]+)\*/g, '$1');
  t = t.replace(/__([^_]+)__/g, '$1');
  t = t.replace(/_([^_]+)_/g, '$1');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 200);
}

/**
 * Note body: markdown links [t](url), bare URLs, hermes-note:// mentions, #tags (when in tagNames).
 * @param {boolean} [stopClickPropagation=true] — when false (e.g. Outline rows), clicks bubble so a parent can open the row; parent should ignore targets inside `.note-rich-link` / `button.note-rich-mention`.
 */
export default function NoteRichText({
  text,
  tagNames = null,
  className,
  onNoteClick,
  onTaskToggle,
  stopClickPropagation = true,
}) {
  const s = text == null ? '' : String(text);

  const markdownInput = useMemo(() => {
    if (!s) return '';
    const set =
      tagNames instanceof Set
        ? tagNames
        : Array.isArray(tagNames) && tagNames.length
          ? new Set(tagNames)
          : null;
    const textWithBareHermesLinks = s.replace(
      /hermes-note:\/\/([0-9a-f-]{36})/gi,
      (m, id, offset, whole) => {
        if (whole.slice(Math.max(0, offset - 2), offset) === '](') return m;
        return `[Linked note](hermes-note://${id})`;
      }
    );
    return set
      ? textWithBareHermesLinks.replace(
          /(^|[\s\n([{'"`])#([a-z0-9-]+)(?![a-z0-9-])/gi,
          (m, pre, name) => (set.has(name) ? `${pre}[#${name}](hermes-tag://${name})` : m)
        )
      : textWithBareHermesLinks;
  }, [s, tagNames]);

  const taskTitles = useMemo(() => extractGfmTaskTitles(markdownInput), [markdownInput]);
  const taskLineOrdinalRef = useRef(0);
  const { spaztickReady } = useNoteTypeColors();
  const [spaztickBusyIdx, setSpaztickBusyIdx] = useState(null);

  const handleSpaztickLineClick = useCallback(
    async (e, lineIndex, rawLine) => {
      e.preventDefault();
      e.stopPropagation();
      if (!spaztickReady || spaztickBusyIdx !== null) return;
      const title = plainTextFromTaskLine(rawLine);
      if (!title) return;
      setSpaztickBusyIdx(lineIndex);
      try {
        const data = await createSpaztickTaskFromTitle({ title, notes: '' });
        const t = typeof data?.title === 'string' ? data.title : title;
        window.alert(`Spaztick task created: ${t}`);
      } catch (err) {
        window.alert(err?.message || 'Could not create Spaztick task');
      } finally {
        setSpaztickBusyIdx(null);
      }
    },
    [spaztickReady, spaztickBusyIdx]
  );

  let taskItemIndex = 0;
  taskLineOrdinalRef.current = 0;

  if (!s) {
    return <span className={className}>—</span>;
  }

  return (
    <div className={[className, 'note-rich-markdown'].filter(Boolean).join(' ')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => {
          const u = String(url || '').trim();
          if (/^hermes-note:\/\/[0-9a-f-]{36}$/i.test(u)) return u;
          if (/^hermes-tag:\/\/[a-z0-9-]+$/i.test(u)) return u;
          return u;
        }}
        components={{
        a: ({ href, children }) => {
          const url = String(href || '').trim();
          const hermes = url.match(/^hermes-note:\/\/([0-9a-f-]{36})$/i);
          if (hermes) {
            const id = hermes[1];
            return (
              <button
                type="button"
                className="note-rich-mention"
                onClick={(e) => {
                  e.preventDefault();
                  if (stopClickPropagation) e.stopPropagation();
                  onNoteClick?.(id);
                }}
              >
                {children}
              </button>
            );
          }
          const tag = url.match(/^hermes-tag:\/\/([a-z0-9-]+)$/i);
          if (tag) {
            return <span className="note-rich-tag-pill">#{tag[1]}</span>;
          }
          if (!url || UNSAFE_HREF.test(url)) {
            return <span>{children}</span>;
          }
          const isHttp = /^https?:\/\//i.test(url);
          return (
            <a
              href={url}
              title={url}
              className="note-rich-link"
              {...(isHttp ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              onClick={(e) => {
                if (stopClickPropagation) e.stopPropagation();
              }}
            >
              {children}
            </a>
          );
        },
        p: ({ children }) => <p className="note-rich-p">{children}</p>,
        ul: ({ children }) => <ul className="note-rich-ul">{children}</ul>,
        ol: ({ children }) => <ol className="note-rich-ol">{children}</ol>,
        li: ({ className: liClassName, children }) => {
          const isTask = String(liClassName || '').includes('task-list-item');
          const idx = isTask ? taskLineOrdinalRef.current++ : -1;
          const rawLine = idx >= 0 && idx < taskTitles.length ? taskTitles[idx] : '';
          const showSpaztick =
            isTask &&
            spaztickReady &&
            idx >= 0 &&
            Boolean(String(rawLine || '').trim());
          return (
            <li
              className={[
                'note-rich-li',
                showSpaztick ? 'note-rich-li--task-row' : '',
                liClassName,
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {children}
              {showSpaztick ? (
                <button
                  type="button"
                  className="note-rich-task-spaztick-btn"
                  title="Add to Spaztick"
                  aria-label="Add checklist item to Spaztick"
                  disabled={spaztickBusyIdx === idx}
                  onClick={(e) => handleSpaztickLineClick(e, idx, rawLine)}
                >
                  <NoteCardIconSpaztick className="note-rich-task-spaztick-btn__icon" />
                </button>
              ) : null}
            </li>
          );
        },
        input: ({ type, checked, ...rest }) => {
          if (type !== 'checkbox') return <input type={type} {...rest} />;
          const currentIndex = taskItemIndex;
          taskItemIndex += 1;
          const interactive = typeof onTaskToggle === 'function';
          return (
            <input
              type="checkbox"
              className="note-rich-task-checkbox"
              checked={checked === true}
              disabled={!interactive}
              onClick={(e) => {
                if (stopClickPropagation) e.stopPropagation();
              }}
              onChange={(e) => {
                if (stopClickPropagation) e.stopPropagation();
                if (!interactive) return;
                onTaskToggle(currentIndex, e.target.checked);
              }}
            />
          );
        },
        code: ({ inline, children }) =>
          inline ? <code>{children}</code> : <code className="note-rich-code-block">{children}</code>,
        }}
      >
        {markdownInput}
      </ReactMarkdown>
    </div>
  );
}
