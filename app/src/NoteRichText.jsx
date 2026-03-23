import React from 'react';

const UNSAFE_HREF = /^\s*(javascript|data|vbscript):/i;

function trimTrailingPunct(url) {
  let u = url;
  while (/[.,;:!?)]+$/.test(u)) u = u.slice(0, -1);
  return u;
}

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

const BARE_URL_AT_START = /^([a-z][a-z0-9+.-]*:\/\/[^\s<]+|mailto:[^\s<]+)/i;

function tryTagAt(s, pos, tagSet) {
  if (!tagSet || s[pos] !== '#') return null;
  const prevOk = pos === 0 || /[\s\n([{'"`]/.test(s[pos - 1]);
  if (!prevOk) return null;
  const m = s.slice(pos).match(/^#([a-z0-9-]+)(?![a-z0-9-])/);
  if (!m || !tagSet.has(m[1])) return null;
  return { name: m[1], len: m[0].length };
}

function tryParseMarkdownLink(s, pos) {
  if (s[pos] !== '[') return null;
  const closeBracket = s.indexOf(']', pos);
  if (closeBracket <= pos || s[closeBracket + 1] !== '(') return null;
  const closeParen = s.indexOf(')', closeBracket + 2);
  if (closeParen <= closeBracket) return null;
  const label = s.slice(pos + 1, closeBracket);
  const url = s.slice(closeBracket + 2, closeParen);
  return { label, url, end: closeParen + 1 };
}

function indexOfNextSpecial(s, pos) {
  const candidates = [];
  const b = s.indexOf('[', pos);
  if (b >= 0) candidates.push(b);
  const h = s.indexOf('#', pos);
  if (h >= 0) candidates.push(h);
  const sub = s.slice(pos);
  const proto = sub.search(/[a-z][a-z0-9+.-]*:\/\//i);
  if (proto >= 0) candidates.push(pos + proto);
  const mail = sub.search(/mailto:/i);
  if (mail >= 0) candidates.push(pos + mail);
  return candidates.length ? Math.min(...candidates) : -1;
}

/**
 * Note body: markdown links [t](url), bare URLs, hermes-note:// mentions, #tags (when in tagNames).
 */
export default function NoteRichText({ text, tagNames = null, className, onNoteClick }) {
  const s = text == null ? '' : String(text);
  if (!s) return <span className={className}>—</span>;

  const tagSet = tagNames instanceof Set ? tagNames : tagNames?.length ? new Set(tagNames) : null;

  const parts = [];
  let pos = 0;
  let last = 0;
  let key = 0;

  const pushText = (from, to) => {
    if (to > from) {
      parts.push(
        <span key={`t-${key++}`} className="note-rich-plain" style={{ whiteSpace: 'pre-wrap' }}>
          {s.slice(from, to)}
        </span>
      );
    }
  };

  while (pos < s.length) {
    const md = tryParseMarkdownLink(s, pos);
    if (md) {
      const hermes = md.url.match(/^hermes-note:\/\/([0-9a-f-]{36})$/i);
      if (hermes) {
        pushText(last, pos);
        const id = hermes[1];
        parts.push(
          <button
            key={`n-${key++}`}
            type="button"
            className="note-rich-mention"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onNoteClick?.(id);
            }}
          >
            {md.label || 'Note'}
          </button>
        );
        last = md.end;
        pos = md.end;
        continue;
      }
      if (/^https?:\/\//i.test(md.url) || /^mailto:/i.test(md.url)) {
        const href = md.url;
        const label = md.label?.trim();
        pushText(last, pos);
        if (!UNSAFE_HREF.test(href)) {
          parts.push(
            <a
              key={`a-${key++}`}
              href={href}
              title={href}
              className="note-rich-link"
              {...(/^https?:\/\//i.test(href)
                ? { target: '_blank', rel: 'noopener noreferrer' }
                : {})}
              onClick={(e) => e.stopPropagation()}
            >
              {label || formatUrlDisplayLabel(href)}
            </a>
          );
        } else {
          pushText(pos, md.end);
        }
        last = md.end;
        pos = md.end;
        continue;
      }
      pushText(last, pos);
      pushText(pos, md.end);
      last = md.end;
      pos = md.end;
      continue;
    }

    const tm = tryTagAt(s, pos, tagSet);
    if (tm) {
      pushText(last, pos);
      parts.push(
        <span key={`tag-${key++}`} className="note-rich-tag-pill">
          #{tm.name}
        </span>
      );
      last = pos + tm.len;
      pos += tm.len;
      continue;
    }

    const rest = s.slice(pos);
    const um = rest.match(BARE_URL_AT_START);
    if (um) {
      const raw = um[1];
      const url = trimTrailingPunct(raw);
      pushText(last, pos);
      if (url && !UNSAFE_HREF.test(url)) {
        parts.push(
          <a
            key={`a-${key++}`}
            href={url}
            title={url}
            className="note-rich-link"
            {...(/^https?:\/\//i.test(url) ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
            onClick={(e) => e.stopPropagation()}
          >
            {formatUrlDisplayLabel(url)}
          </a>
        );
      } else {
        pushText(pos, pos + raw.length);
      }
      last = pos + um[0].length;
      pos += um[0].length;
      continue;
    }

    const next = indexOfNextSpecial(s, pos);
    if (next < 0) {
      pushText(last, s.length);
      last = s.length;
      break;
    }
    if (next > pos) {
      pushText(last, next);
      last = next;
      pos = next;
      continue;
    }
    pushText(last, pos + 1);
    last = pos + 1;
    pos += 1;
  }

  pushText(last, s.length);

  return <span className={className}>{parts}</span>;
}
