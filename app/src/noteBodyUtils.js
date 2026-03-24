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
/** Map fullwidth / variant punctuation to ASCII so mobile keyboards still open @/# menus. */
function normalizeTriggerSource(s) {
  return String(s ?? '')
    .replace(/\uFF03/g, '#')
    .replace(/\uFE5F/g, '#')
    .replace(/\uFF20/g, '@');
}

export function getActiveTrigger(text, caretPos) {
  const s = normalizeTriggerSource(text == null ? '' : String(text));
  const pos = Math.min(Math.max(0, caretPos), s.length);
  const before = s.slice(0, pos);
  /*
   * Match the most recent trigger at the caret edge.
   * Allows punctuation boundary chars before @/# without requiring whitespace.
   */
  const m = before.match(/(?:^|[^a-zA-Z0-9_])([@#])([a-zA-Z0-9._-]*)$/);
  if (!m) return null;
  const type = m[1];
  const query = m[2] || '';
  const start = pos - (type.length + query.length);
  return { type, start, query };
}

/**
 * WebKit (iPad/iPhone) often reports selectionStart 0 while the user just typed a leading #/@
 * (or a single #query token). Recover trigger + a caret position for menu placement.
 * @returns {{ trig: ReturnType<typeof getActiveTrigger>, menuCaret: number }}
 */
export function resolveMentionTrigger(text, rawCaret) {
  const s = normalizeTriggerSource(text == null ? '' : String(text));
  const pos = Math.min(Math.max(0, rawCaret), s.length);
  let trig = getActiveTrigger(s, pos);
  let menuCaret = pos;

  /*
   * WebKit (iPad/iPhone) often leaves selectionStart *before* the @ or # that just inserted
   * (caret index i points at s[i]). getActiveTrigger(s, i) then sees no trigger; compose box
   * hit this more than inline edit due to sticky/footer focus timing.
   */
  if (!trig && pos < s.length && (s[pos] === '@' || s[pos] === '#')) {
    const t2 = getActiveTrigger(s, pos + 1);
    if (t2 && t2.start === pos) {
      trig = t2;
      menuCaret = pos + 1;
    }
  }

  if (!trig && pos === 0 && s.length > 0 && (s[0] === '#' || s[0] === '@')) {
    if (s.length === 1) {
      trig = getActiveTrigger(s, 1);
      if (trig) menuCaret = 1;
    } else if (/^[#@][a-zA-Z0-9._-]*$/.test(s)) {
      trig = getActiveTrigger(s, s.length);
      if (trig) menuCaret = s.length;
    } else if (s.length === 2) {
      trig = getActiveTrigger(s, 1);
      if (trig) menuCaret = 1;
    }
  }

  return { trig, menuCaret };
}

/** End index of @query or #query (exclusive upper bound for slice) — for broken selectionStart. */
export function triggerReplaceEnd(menuLike) {
  const q = menuLike?.query ?? '';
  const st = menuLike?.start ?? 0;
  return st + 1 + q.length;
}

/** Use when WebKit leaves selection before the typed trigger; never shrink past user’s real caret. */
export function caretForTriggerReplace(el, menuLike) {
  const end = triggerReplaceEnd(menuLike);
  const raw = el.selectionStart ?? end;
  return raw < end ? end : raw;
}

export function replaceTriggerQuery(text, triggerStart, caretPos, insertion) {
  const s = String(text);
  const before = s.slice(0, triggerStart);
  const after = s.slice(caretPos);
  return before + insertion + after;
}
