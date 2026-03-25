import pool from '../db/pool.js';
import { generate } from './ollama.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(s) {
  return typeof s === 'string' && UUID_RE.test(s);
}

/** Browser/client IANA zone (e.g. America/New_York). Invalid values fall back to UTC. */
function sanitizeTimeZone(raw) {
  if (typeof raw !== 'string') return 'UTC';
  const t = raw.trim();
  if (t.length < 2 || t.length > 120) return 'UTC';
  if (!/^[A-Za-z0-9_+\/-]+$/.test(t)) return 'UTC';
  return t;
}

/** Whether the stored instant has a non-midnight UTC clock (skip time-of-day for date-only UTC midnight). */
function hasUtcClockTime(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return (
    d.getUTCHours() !== 0 ||
    d.getUTCMinutes() !== 0 ||
    d.getUTCSeconds() !== 0 ||
    d.getUTCMilliseconds() !== 0
  );
}

function formatInstantInZone(iso, timeZone, withTime) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts = { timeZone, dateStyle: 'medium' };
  if (withTime) opts.timeStyle = 'short';
  try {
    return d.toLocaleString('en-US', opts);
  } catch {
    return d.toLocaleString('en-US', {
      timeZone: 'UTC',
      dateStyle: 'medium',
      ...(withTime ? { timeStyle: 'short' } : {}),
    });
  }
}

function formatEventRange(note, timeZone) {
  if (note.note_type !== 'event') return '';
  const s = note.event_start_at;
  const e = note.event_end_at;
  if (!s && !e) return '';
  if (!s) {
    return formatInstantInZone(e, timeZone, hasUtcClockTime(e));
  }
  const left = formatInstantInZone(s, timeZone, hasUtcClockTime(s));
  if (!e) return left;
  const right = formatInstantInZone(e, timeZone, hasUtcClockTime(e));
  if (left && right && left !== right) return `${left} → ${right}`;
  return left || right;
}

function formatNoteBlock(note, label, timeZone) {
  const lines = [];
  lines.push(`--- ${label} (${note.id}) ---`);
  lines.push(`Type: ${note.note_type || 'note'}`);
  if (note.note_type === 'event') {
    if (note.event_start_at) {
      const d = new Date(note.event_start_at);
      if (!Number.isNaN(d.getTime())) lines.push(`Event start (UTC, ISO 8601): ${d.toISOString()}`);
    }
    if (note.event_end_at) {
      const d = new Date(note.event_end_at);
      if (!Number.isNaN(d.getTime())) lines.push(`Event end (UTC, ISO 8601): ${d.toISOString()}`);
    }
  }
  const ev = formatEventRange(note, timeZone);
  if (ev) {
    lines.push(`Event schedule (user's timezone ${timeZone}): ${ev}`);
  }
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
 *   userId: string,
 *   timeZone?: string
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
    timeZone: timeZoneRaw,
  } = opts;
  const timeZone = sanitizeTimeZone(timeZoneRaw);

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
      parentBlock = `${formatNoteBlock(p, 'Parent note (above the view)', timeZone)}\n\n`;
    }
  }

  const mainBlocks = [];
  for (const id of ordered) {
    const n = byId.get(String(id));
    if (n) mainBlocks.push(formatNoteBlock(n, 'Note in view', timeZone));
  }

  /** Seeds for discovering links: on-screen notes (preorder) plus parent, so parent connections count too. */
  const connectionSeedIds = [...ordered.map(String)];
  if (parentId && threadIdSet.has(String(parentId)) && !connectionSeedIds.includes(String(parentId))) {
    connectionSeedIds.push(String(parentId));
  }

  let connectedBlock = '';
  if (includeConnected && connectionSeedIds.length > 0) {
    const connected = await loadConnectedNotes(
      userId,
      connectionSeedIds,
      [...primarySet],
      18
    );
    if (connected.length > 0) {
      const connectedEmitted = new Set();
      const parts = [];
      for (const c of connected) {
        const rows = includeChildren ? await loadThreadFlat(c.id, userId) : [c];
        const connById = new Map(rows.map((r) => [String(r.id), r]));
        const ch = buildChildrenMap(rows);
        const subtreeOrder = [];
        function preorderFrom(rootId) {
          const node = connById.get(String(rootId));
          if (!node) return;
          subtreeOrder.push(node);
          for (const k of ch.get(rootId) || []) preorderFrom(k.id);
        }
        preorderFrom(c.id);
        for (const n of subtreeOrder) {
          if (connectedEmitted.has(String(n.id))) continue;
          connectedEmitted.add(String(n.id));
          parts.push(
            formatNoteBlock(
              n,
              includeChildren ? 'Connected thread note' : 'Connected note',
              timeZone
            )
          );
        }
      }
      if (parts.length > 0) {
        connectedBlock = `--- Connected notes (linked from the parent and/or notes in view${
          includeChildren ? '; each link includes its reply subtree' : ''
        }) ---\n\n${parts.join('\n\n')}\n\n`;
      }
    }
  }

  const relatedContext = `${parentBlock}${connectedBlock}`;
  const context = `${relatedContext}--- Notes on screen (thread context) ---\n\n${mainBlocks.join('\n\n')}`;

  const prompt = `You summarize notes from a personal knowledge app for the user. Write a clear, cohesive summary in plain prose. Stay at or under 250 words (shorter is fine). Do not add a title line unless it helps; focus on substance.

Context order: first any parent note and connected/linked notes (if present), then the notes currently on screen. Use that ordering when relating background to the visible thread.

For meetings and events: treat the line "Event schedule (user's timezone …)" as the correct local start/end for the user. Prefer that over any time that might appear inside note bodies, and do not convert the ISO UTC lines into a different local time yourself.

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
