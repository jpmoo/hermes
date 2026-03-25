import pool from '../db/pool.js';
import { generate } from './ollama.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

function formatEventRange(note) {
  if (note.note_type !== 'event') return '';
  const fmt = (iso, withTime) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return withTime
      ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
  };
  const s = note.event_start_at;
  const e = note.event_end_at;
  if (!s && !e) return '';
  const hasTime = (iso) => {
    if (!iso) return false;
    const d = new Date(iso);
    const h = d.getHours();
    const m = d.getMinutes();
    const sec = d.getSeconds();
    const ms = d.getMilliseconds();
    return h !== 0 || m !== 0 || sec !== 0 || ms !== 0;
  };
  if (!s) return fmt(e, hasTime(e));
  const left = fmt(s, hasTime(s));
  if (!e) return left;
  const right = fmt(e, hasTime(e));
  if (left && right && left !== right) return `${left} → ${right}`;
  return left || right;
}

function formatNoteBlock(note, label) {
  const lines = [];
  lines.push(`--- ${label} (${note.id}) ---`);
  lines.push(`Type: ${note.note_type || 'note'}`);
  const ev = formatEventRange(note);
  if (ev) lines.push(`Event time: ${ev}`);
  let body = (note.content || '').trim();
  if (body.length > 8000) body = `${body.slice(0, 8000)}\n… (truncated)`;
  lines.push(body ? `Content:\n${body}` : 'Content: (empty)');
  return lines.join('\n');
}

async function loadThreadFlat(threadRootId, userId) {
  const r = await pool.query(
    `WITH RECURSIVE tree AS (
      SELECT id, parent_id, content, created_at, note_type, event_start_at, event_end_at, 0 AS depth
      FROM notes WHERE id = $1::uuid AND user_id = $2
      UNION ALL
      SELECT n.id, n.parent_id, n.content, n.created_at, n.note_type, n.event_start_at, n.event_end_at, t.depth + 1
      FROM notes n JOIN tree t ON n.parent_id = t.id
      WHERE n.user_id = $2
    )
    SELECT * FROM tree ORDER BY created_at ASC`,
    [threadRootId, userId]
  );
  return r.rows;
}

function buildChildrenMap(rows) {
  const byParent = new Map();
  for (const n of rows) {
    const pid = n.parent_id;
    if (!byParent.has(pid)) byParent.set(pid, []);
    byParent.get(pid).push(n);
  }
  for (const [, list] of byParent) {
    list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }
  return byParent;
}

function collectDescendantIds(rootId, childrenByParent) {
  const out = new Set();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    const kids = childrenByParent.get(id) || [];
    for (const k of kids) stack.push(k.id);
  }
  return out;
}

function preorderInPrimary(rootId, primarySet, childrenByParent, ordered) {
  if (!primarySet.has(rootId)) return;
  ordered.push(rootId);
  for (const k of childrenByParent.get(rootId) || []) {
    preorderInPrimary(k.id, primarySet, childrenByParent, ordered);
  }
}

async function loadConnectedNotes(userId, seedIds, excludeIds, maxExtra) {
  if (seedIds.length === 0 || maxExtra <= 0) return [];
  const ex = [...excludeIds];
  const r = await pool.query(
    `SELECT DISTINCT nb.id
     FROM note_connections nc
     INNER JOIN notes nb ON nb.user_id = $1
       AND (cardinality($2::uuid[]) = 0 OR nb.id <> ALL($2::uuid[]))
       AND (
         (nc.anchor_note_id = ANY($3::uuid[]) AND nb.id = nc.linked_note_id)
         OR (nc.linked_note_id = ANY($3::uuid[]) AND nb.id = nc.anchor_note_id)
       )
     WHERE nc.user_id = $1
     LIMIT $4`,
    [userId, ex, seedIds, maxExtra * 3]
  );
  const peerIds = r.rows.map((row) => row.id).slice(0, maxExtra);
  if (peerIds.length === 0) return [];
  const nr = await pool.query(
    `SELECT id, parent_id, content, note_type, event_start_at, event_end_at
     FROM notes WHERE user_id = $1 AND id = ANY($2::uuid[])`,
    [userId, peerIds]
  );
  return nr.rows;
}

/**
 * @param {{
 *   threadRootId: string,
 *   focusNoteId: string | null | undefined,
 *   visibleNoteIds: string[],
 *   includeChildren: boolean,
 *   includeConnected: boolean,
 *   userId: string
 * }} opts
 */
export async function buildThreadAiSummary(opts) {
  const {
    threadRootId,
    focusNoteId,
    visibleNoteIds,
    includeChildren,
    includeConnected,
    userId,
  } = opts;

  if (!isUuid(threadRootId)) {
    return { ok: false, status: 400, error: 'Invalid threadRootId' };
  }
  if (!Array.isArray(visibleNoteIds) || visibleNoteIds.length === 0) {
    return { ok: false, status: 400, error: 'visibleNoteIds required (non-empty)' };
  }
  for (const id of visibleNoteIds) {
    if (!isUuid(id)) {
      return { ok: false, status: 400, error: 'Invalid note id in visibleNoteIds' };
    }
  }
  if (focusNoteId != null && focusNoteId !== '' && !isUuid(focusNoteId)) {
    return { ok: false, status: 400, error: 'Invalid focusNoteId' };
  }

  const flat = await loadThreadFlat(threadRootId, userId);
  if (flat.length === 0) {
    return { ok: false, status: 404, error: 'Thread not found' };
  }

  const rootRow = flat.find((n) => String(n.id) === String(threadRootId));
  if (!rootRow || rootRow.parent_id != null) {
    return { ok: false, status: 400, error: 'threadRootId must be the thread root note' };
  }

  const byId = new Map(flat.map((n) => [String(n.id), n]));
  const threadIdSet = new Set(flat.map((n) => String(n.id)));

  for (const id of visibleNoteIds) {
    if (!threadIdSet.has(String(id))) {
      return { ok: false, status: 400, error: 'visibleNoteIds must belong to the thread' };
    }
  }

  let displayRoot = threadRootId;
  if (focusNoteId && threadIdSet.has(String(focusNoteId))) {
    displayRoot = focusNoteId;
  }

  const childrenByParent = buildChildrenMap(flat);
  let primarySet = new Set(visibleNoteIds.map(String));

  if (includeChildren) {
    const desc = collectDescendantIds(displayRoot, childrenByParent);
    for (const id of desc) {
      if (threadIdSet.has(String(id))) primarySet.add(String(id));
    }
  }

  const ordered = [];
  preorderInPrimary(displayRoot, primarySet, childrenByParent, ordered);

  const displayRootRow = byId.get(String(displayRoot));
  const parentId = displayRootRow?.parent_id;
  let parentBlock = '';
  if (parentId && threadIdSet.has(String(parentId))) {
    const p = byId.get(String(parentId));
    if (p) {
      parentBlock = `${formatNoteBlock(p, 'Parent note (above the view)')}\n\n`;
    }
  }

  const mainBlocks = [];
  for (const id of ordered) {
    const n = byId.get(String(id));
    if (n) mainBlocks.push(formatNoteBlock(n, 'Note in view'));
  }

  let connectedBlock = '';
  if (includeConnected && ordered.length > 0) {
    const connected = await loadConnectedNotes(
      userId,
      ordered,
      [...primarySet],
      18
    );
    if (connected.length > 0) {
      const connectedEmitted = new Set();
      const parts = [];
      for (const c of connected) {
        const rows = includeChildren ? await loadThreadFlat(c.id, userId) : [c];
        const byId = new Map(rows.map((r) => [String(r.id), r]));
        const ch = buildChildrenMap(rows);
        const subtreeOrder = [];
        function preorderFrom(rootId) {
          const n = byId.get(String(rootId));
          if (!n) return;
          subtreeOrder.push(n);
          for (const k of ch.get(rootId) || []) preorderFrom(k.id);
        }
        preorderFrom(c.id);
        for (const n of subtreeOrder) {
          if (connectedEmitted.has(String(n.id))) continue;
          connectedEmitted.add(String(n.id));
          parts.push(
            formatNoteBlock(
              n,
              includeChildren ? 'Connected thread note' : 'Connected note'
            )
          );
        }
      }
      if (parts.length > 0) {
        connectedBlock = `\n--- Connected notes (linked from the thread) ---\n\n${parts.join('\n\n')}`;
      }
    }
  }

  const context = `${parentBlock}--- Notes on screen (thread context) ---\n\n${mainBlocks.join('\n\n')}${connectedBlock}`;

  const prompt = `You summarize notes from a personal knowledge app for the user. Write a clear, cohesive summary in plain prose. Stay at or under 250 words (shorter is fine). Do not add a title line unless it helps; focus on substance. If event times are given, you may reference them naturally.

If the notes are empty, too sparse, or too fragmented to justify a real narrative (e.g. only placeholders or no meaningful content to weave together), do not invent a summary. Instead reply with one or two short sentences explaining that there is not enough context to summarize meaningfully—no bullet list, no filler narrative.

${context}

Your response (summary or the honest “not enough context” message):`;

  const summary = await generate(prompt, { temperature: 0.35, num_predict: 520 });
  if (!summary) {
    return {
      ok: false,
      status: 503,
      error: 'AI summary unavailable (check the local model server and tag model env)',
    };
  }

  return { ok: true, summary: summary.trim() };
}
