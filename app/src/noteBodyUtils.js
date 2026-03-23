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
  const candidates = [];

  const at = before.lastIndexOf('@');
  if (at >= 0) {
    const prev = at > 0 ? s[at - 1] : ' ';
    if (at === 0 || /[\s\n([{'"`]/.test(prev)) {
      const after = before.slice(at + 1);
      if (!after.includes('\n') && !after.includes(']') && /^[a-zA-Z0-9\s\-_.]*$/.test(after)) {
        candidates.push({ type: '@', start: at, query: after });
      }
    }
  }

  const hash = before.lastIndexOf('#');
  if (hash >= 0) {
    const prev = hash > 0 ? s[hash - 1] : ' ';
    if (hash === 0 || /[\s\n([{'"`]/.test(prev)) {
      const after = before.slice(hash + 1);
      /* Same token rules as @ so you can type multi-word text to match note titles */
      if (!after.includes('\n') && !after.includes(']') && /^[a-zA-Z0-9\s\-_.]*$/.test(after)) {
        candidates.push({ type: '#', start: hash, query: after });
      }
    }
  }

  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a.start >= b.start ? a : b));
}

export function replaceTriggerQuery(text, triggerStart, caretPos, insertion) {
  const s = String(text);
  const before = s.slice(0, triggerStart);
  const after = s.slice(caretPos);
  return before + insertion + after;
}
