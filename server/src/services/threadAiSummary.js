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
    const pid = n.parent_id == null ? null : String(n.parent_id);
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
  const stack = [String(rootId)];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    const kids = childrenByParent.get(id) || [];
    for (const k of kids) stack.push(String(k.id));
  }
  return out;
}

function preorderInPrimary(rootId, mainSet, childrenByParent, ordered) {
  const rootKey = String(rootId);
  if (!mainSet.has(rootKey)) return;
  ordered.push(rootKey);
  for (const k of childrenByParent.get(rootKey) || []) {
    preorderInPrimary(k.id, mainSet, childrenByParent, ordered);
  }
}

/** Peers linked to any seed that also lie in this thread (same thread tree). */
async function findConnectedPeerIdsInThread(userId, seedIds, threadIdArray, excludeIds) {
  if (seedIds.length === 0 || threadIdArray.length === 0) return [];
  const ex = excludeIds.map((id) => String(id));
  const r = await pool.query(
    `SELECT DISTINCT other AS id FROM (
       SELECT nc.linked_note_id AS other
       FROM note_connections nc
       WHERE nc.user_id = $1 AND nc.anchor_note_id = ANY($2::uuid[])
       UNION
       SELECT nc.anchor_note_id AS other
       FROM note_connections nc
       WHERE nc.user_id = $1 AND nc.linked_note_id = ANY($2::uuid[])
     ) x
     WHERE other = ANY($3::uuid[])
       AND (cardinality($4::uuid[]) = 0 OR NOT (other = ANY($4::uuid[])))`,
    [userId, seedIds, threadIdArray, ex]
  );
  return r.rows.map((row) => row.id);
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

  /** Focused note at top of view + replies: visible only, or full recursive subtree in this thread when children is on. */
  let mainSet = new Set(visibleNoteIds.map(String));
  if (includeChildren) {
    mainSet = new Set();
    for (const id of collectDescendantIds(displayRoot, childrenByParent)) {
      if (threadIdSet.has(String(id))) mainSet.add(String(id));
    }
  }

  const ordered = [];
  preorderInPrimary(displayRoot, mainSet, childrenByParent, ordered);

  const mainBlocks = [];
  for (const id of ordered) {
    const n = byId.get(String(id));
    if (n) mainBlocks.push(formatNoteBlock(n, 'Note in view', timeZone));
  }

  const MAX_LINKED_NOTES = 150;
  const MAX_LINK_ROUNDS = 40;
  const threadIdArray = [...threadIdSet];

  const linkedSet = new Set();
  if (includeConnected && mainSet.size > 0) {
    const addPeersFromBundle = async () => {
      const bundle = [...mainSet, ...linkedSet];
      if (bundle.length === 0) return false;
      const peers = await findConnectedPeerIdsInThread(userId, bundle, threadIdArray, bundle);
      let added = false;
      for (const pid of peers) {
        const s = String(pid);
        if (!threadIdSet.has(s) || mainSet.has(s) || linkedSet.has(s)) continue;
        if (linkedSet.size >= MAX_LINKED_NOTES) break;
        linkedSet.add(s);
        added = true;
      }
      return added;
    };

    const addDescendantsOfLinked = () => {
      let added = false;
      const snap = [...linkedSet];
      for (const lid of snap) {
        for (const d of collectDescendantIds(lid, childrenByParent)) {
          const ds = String(d);
          if (!threadIdSet.has(ds) || mainSet.has(ds) || linkedSet.has(ds)) continue;
          if (linkedSet.size >= MAX_LINKED_NOTES) break;
          linkedSet.add(ds);
          added = true;
        }
      }
      return added;
    };

    if (includeChildren) {
      for (let round = 0; round < MAX_LINK_ROUNDS && linkedSet.size < MAX_LINKED_NOTES; round += 1) {
        const addedPeers = await addPeersFromBundle();
        const addedDesc = addDescendantsOfLinked();
        if (!addedPeers && !addedDesc) break;
      }
    } else {
      await addPeersFromBundle();
    }
  }

  let linkedBlock = '';
  if (linkedSet.size > 0) {
    const linkedRows = [...linkedSet]
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const parts = linkedRows.map((n) =>
      formatNoteBlock(n, 'Linked note (same thread)', timeZone)
    );
    linkedBlock = `--- Linked notes (same thread only; ${
      includeChildren
        ? 'expanded in rounds: new links, then replies under linked notes, repeat until stable'
        : 'direct links from the focused branch only'
    }) ---\n\n${parts.join('\n\n')}\n\n`;
  }

  const context = `--- Notes in summary (focused note at top and its replies in this thread) ---\n\n${mainBlocks.join(
    '\n\n'
  )}${linkedBlock ? `\n${linkedBlock}` : ''}`;

  const prompt = `You summarize notes from a personal knowledge app for the user. Write a clear, cohesive summary in plain prose. Stay at or under 250 words (shorter is fine). Do not add a title line unless it helps; focus on substance.

Context order: first the focused branch (notes in view, or full in-thread subtree if child notes was selected), then any linked notes that also live in the same thread (if that option was on).

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
