import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
 * Note body: markdown links [t](url), bare URLs, hermes-note:// mentions, #tags (when in tagNames).
 * @param {boolean} [stopClickPropagation=true] — when false (e.g. Outline rows), clicks bubble so a parent can open the row; parent should ignore targets inside `.note-rich-link` / `button.note-rich-mention`.
 */
export default function NoteRichText({
  text,
  tagNames = null,
  className,
  onNoteClick,
  stopClickPropagation = true,
}) {
  const tagSet = tagNames instanceof Set ? tagNames : tagNames?.length ? new Set(tagNames) : null;
  const s = text == null ? '' : String(text);
  if (!s) return <span className={className}>—</span>;
  const textWithBareHermesLinks = s.replace(
    /\bhermes-note:\/\/([0-9a-f-]{36})\b/gi,
    (_m, id) => `[Linked note](hermes-note://${id})`
  );
  const markdownInput = tagSet
    ? textWithBareHermesLinks.replace(
        /(^|[\s\n([{'"`])#([a-z0-9-]+)(?![a-z0-9-])/gi,
        (m, pre, name) => (tagSet.has(name) ? `${pre}[#${name}](hermes-tag://${name})` : m)
      )
    : textWithBareHermesLinks;

  return (
    <div className={[className, 'note-rich-markdown'].filter(Boolean).join(' ')}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
        li: ({ children }) => <li className="note-rich-li">{children}</li>,
        code: ({ inline, children }) =>
          inline ? <code>{children}</code> : <code className="note-rich-code-block">{children}</code>,
        }}
      >
        {markdownInput}
      </ReactMarkdown>
    </div>
  );
}
