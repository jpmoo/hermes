/** Markdown link to another note (parsed by NoteRichText). */
export function formatNoteMentionLink(label, noteId) {
  const safe = String(label || 'note')
    .replace(/\]/g, '')
    .replace(/\n/g, ' ')
    .trim()
    .slice(0, 120);
  const text = safe || 'note';
  return `[${text}](hermes-note://${noteId})`;
}

const HERMES_NOTE_LINK_RE = /\[([^\]]*)\]\(hermes-note:\/\/([0-9a-f-]{36})\)/gi;

export function extractLinkedNoteIds(content) {
  const s = content == null ? '' : String(content);
  const ids = new Set();
  let m;
  const re = new RegExp(HERMES_NOTE_LINK_RE.source, 'gi');
  while ((m = re.exec(s)) !== null) {
    ids.add(m[2].toLowerCase());
  }
  return [...ids];
}

function isTagCharBoundary(s, hashIndex) {
  return hashIndex === 0 || /[\s\n([{'"`]/.test(s[hashIndex - 1]);
}

export function extractTagNamesFromContent(content) {
  const s = content == null ? '' : String(content);
  const set = new Set();
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '#' || !isTagCharBoundary(s, i)) continue;
    const m = s.slice(i).match(/^#([a-z0-9-]+)(?![a-z0-9-])/);
    if (m) set.add(m[1]);
  }
  return set;
}

export function stripHashtagPrefixFromContent(content, tagName) {
  const name = String(tagName || '').trim();
  if (!name) return String(content ?? '');
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`#${esc}(?![a-z0-9-])`, 'g');
  return String(content ?? '').replace(re, (m, offset, str) => {
    if (offset === 0 || /[\s\n([{'"`]/.test(str[offset - 1])) return name;
    return m;
  });
}

/**
 * @returns {{ type: '@' | '#', start: number, query: string } | null}
 */
export function getActiveTrigger(text, caretPos) {
  const s = text == null ? '' : String(text);
  const pos = Math.min(Math.max(0, caretPos), s.length);
  const before = s.slice(0, pos);

  // Scan backwards within current token only; whitespace/newline ends token.
  let i = before.length - 1;
  while (i >= 0 && !/[\s\n]/.test(before[i])) i -= 1;
  const tokenStart = i + 1;
  const token = before.slice(tokenStart);
  if (token.length < 1) return null;

  const m = token.match(/^([@#])([a-zA-Z0-9._-]*)$/);
  if (!m) return null;

  const sig = m[1];
  const query = m[2] || '';
  const prev = tokenStart > 0 ? s[tokenStart - 1] : ' ';
  if (!(tokenStart === 0 || /[\s\n([{'"`]/.test(prev))) return null;

  return { type: sig, start: tokenStart, query };
}

export function replaceTriggerQuery(text, triggerStart, caretPos, insertion) {
  const s = String(text);
  const before = s.slice(0, triggerStart);
  const after = s.slice(caretPos);
  return before + insertion + after;
}
