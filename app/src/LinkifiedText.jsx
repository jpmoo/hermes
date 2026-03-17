import React from 'react';

const URL_RE = /(https?:\/\/[^\s<]+[^<.,:;"')\]\s]*)/gi;

export default function LinkifiedText({ text, className }) {
  const s = text == null ? '' : String(text);
  if (!s) return <span className={className}>—</span>;

  const parts = [];
  let last = 0;
  let m;
  const re = new RegExp(URL_RE.source, 'gi');
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) parts.push({ type: 't', key: `t-${last}`, v: s.slice(last, m.index) });
    let url = m[1];
    while (/[.,;:!?)]+$/.test(url)) url = url.slice(0, -1);
    parts.push({ type: 'a', key: `a-${m.index}`, v: url });
    last = m.index + m[1].length;
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
          <a key={p.key} href={p.v} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
            {p.v}
          </a>
        )
      )}
    </span>
  );
}
