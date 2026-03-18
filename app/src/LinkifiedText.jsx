import React from 'react';

/** http(s), custom scheme:// (e.g. obsidian://), mailto: */
const LINK_RE = /([a-z][a-z0-9+.-]*:\/\/[^\s<]+|mailto:[^\s<]+)/gi;

const UNSAFE_HREF = /^\s*(javascript|data|vbscript):/i;

function trimTrailingPunct(url) {
  let u = url;
  while (/[.,;:!?)]+$/.test(u)) u = u.slice(0, -1);
  return u;
}

export default function LinkifiedText({ text, className }) {
  const s = text == null ? '' : String(text);
  if (!s) return <span className={className}>—</span>;

  const parts = [];
  let last = 0;
  let m;
  const re = new RegExp(LINK_RE.source, 'gi');
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push({ type: 't', key: `t-${last}`, v: s.slice(last, m.index) });
    const raw = m[1];
    const url = trimTrailingPunct(raw);
    if (!url || UNSAFE_HREF.test(url)) {
      parts.push({ type: 't', key: `t-${m.index}`, v: raw });
      last = m.index + raw.length;
      continue;
    }
    parts.push({ type: 'a', key: `a-${m.index}`, v: url });
    last = m.index + raw.length;
  }
  if (last < s.length) parts.push({ type: 't', key: `t-${last}`, v: s.slice(last) });

  return (
    <span className={className}>
      {parts.map((p) =>
        p.type === 't' ? (
          <span key={p.key} style={{ whiteSpace: 'pre-wrap' }}>
            {p.v}
          </span>
        ) : (
          <a
            key={p.key}
            href={p.v}
            {...(/^https?:\/\//i.test(p.v)
              ? { target: '_blank', rel: 'noopener noreferrer' }
              : {})}
            onClick={(e) => e.stopPropagation()}
          >
            {p.v}
          </a>
        )
      )}
    </span>
  );
}
