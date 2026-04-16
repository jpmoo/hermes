import pool from '../db/pool.js';
import { generate, SUMMARY_MODEL } from './ollama.js';

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

/** `instant` as local line in `timeZone` plus ISO UTC so the model can judge past vs future events. */
function formatReferenceNow(timeZone, instant = new Date()) {
  const now = instant;
  const isoUtc = now.toISOString();
  try {
    const localLine = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(now);
    return { localLine, isoUtc };
  } catch {
    return { localLine: isoUtc, isoUtc };
  }
}

/** YYYY-MM-DD calendar day in `timeZone` (for comparing date-only events to "today"). */
function ymdInZone(date, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    const d = new Date(date);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
}

/**
 * Machine-readable timing label for event notes so the model does not infer from body text alone
 * (e.g. "March 24 meeting" still described as upcoming after that day).
 */
function eventTimingDirective(note, referenceInstant, timeZone) {
  if (note.note_type !== 'event') return '';
  const sRaw = note.event_start_at;
  const eRaw = note.event_end_at;
  if (!sRaw && !eRaw) return '';

  const nowMs = referenceInstant.getTime();
  const endMs = eRaw ? new Date(eRaw).getTime() : NaN;
  const startMs = sRaw ? new Date(sRaw).getTime() : NaN;
  if (Number.isNaN(nowMs)) return '';

  const refYmd = ymdInZone(referenceInstant, timeZone);

  if (!Number.isNaN(endMs)) {
    if (nowMs > endMs) {
      return `Event timing vs summary reference: PAST (end before reference instant). Do not say upcoming, approaching, or scheduled; use past tense only.`;
    }
    if (!Number.isNaN(startMs) && nowMs < startMs) {
      return `Event timing vs summary reference: FUTURE (has not started yet at reference instant).`;
    }
    return `Event timing vs summary reference: IN WINDOW (reference instant is on or between start and end).`;
  }

  if (!Number.isNaN(startMs)) {
    if (sRaw && hasUtcClockTime(sRaw)) {
      if (nowMs > startMs) {
        return `Event timing vs summary reference: PAST (start before reference instant; no end time stored). Do not say upcoming or approaching; use past tense unless the body clearly describes a different future occurrence.`;
      }
      return `Event timing vs summary reference: FUTURE (start after reference instant).`;
    }
    const eventYmd = ymdInZone(new Date(sRaw), timeZone);
    if (eventYmd < refYmd) {
      return `Event timing vs summary reference: PAST (event local calendar day ${eventYmd} is before reference day ${refYmd} in ${timeZone}). Ignore informal dates in the body if they conflict; do not say approaching or upcoming; use past tense.`;
    }
    if (eventYmd > refYmd) {
      return `Event timing vs summary reference: FUTURE (event local calendar day ${eventYmd} is after reference day ${refYmd}).`;
    }
    return `Event timing vs summary reference: SAME CALENDAR DAY as reference (${refYmd}).`;
  }

  return '';
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

function formatNoteBlock(note, label, timeZone, referenceInstant) {
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
    const timing = eventTimingDirective(note, referenceInstant, timeZone);
    if (timing) lines.push(timing);
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

/**
 * Add strict in-thread descendants of every id already in `included` (one pass over the snapshot).
 * Returns whether anything was added. Stops when `included.size` reaches `maxTotal`.
 */
function expandDescendantsInPlace(included, childrenByParent, threadIdSet, maxTotal) {
  let added = false;
  const snap = [...included];
  for (const id of snap) {
    if (included.size >= maxTotal) break;
    for (const d of collectDescendantIds(id, childrenByParent)) {
      const ds = String(d);
      if (ds === String(id) || !threadIdSet.has(ds) || included.has(ds)) continue;
      if (included.size >= maxTotal) break;
      included.add(ds);
      added = true;
    }
  }
  return added;
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
 *   includeChildren: boolean, // "Replies": in-thread descendant replies (recursive) beyond what's on screen
 *   includeConnected: boolean, // "Connected": notes linked to the current set (same thread)
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
  const referenceInstant = new Date();
  const { localLine: referenceNowLocal, isoUtc: referenceNowUtc } = formatReferenceNow(
    timeZone,
    referenceInstant
  );

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

  const screenSet = new Set(visibleNoteIds.map(String));
  const threadIdArray = [...threadIdSet];
  const MAX_INCLUDED_NOTES = 220;
  const MAX_CLOSURE_ROUNDS = 40;

  const included = new Set(screenSet);

  const addConnectedPeersIntoIncluded = async () => {
    if (threadIdArray.length === 0) return false;
    const peers = await findConnectedPeerIdsInThread(
      userId,
      [...included],
      threadIdArray,
      [...included]
    );
    let added = false;
    for (const pid of peers) {
      const s = String(pid);
      if (!threadIdSet.has(s) || included.has(s)) continue;
      if (included.size >= MAX_INCLUDED_NOTES) break;
      included.add(s);
      added = true;
    }
    return added;
  };

  /*
   * Default: on-screen notes only (focused branch as rendered).
   * Replies: add all in-thread replies under those notes, recursively, until stable.
   * Connected: add in-thread notes linked to the current set (one hop from on-screen when that is the only extra option).
   * Both: repeatedly add descendants, then linked notes, until stable (walk the tree).
   */
  if (includeConnected && includeChildren) {
    for (let round = 0; round < MAX_CLOSURE_ROUNDS && included.size < MAX_INCLUDED_NOTES; round += 1) {
      let grew = false;
      while (
        included.size < MAX_INCLUDED_NOTES &&
        expandDescendantsInPlace(included, childrenByParent, threadIdSet, MAX_INCLUDED_NOTES)
      ) {
        grew = true;
      }
      if (included.size < MAX_INCLUDED_NOTES && (await addConnectedPeersIntoIncluded())) grew = true;
      if (!grew) break;
    }
  } else if (includeChildren) {
    while (
      included.size < MAX_INCLUDED_NOTES &&
      expandDescendantsInPlace(included, childrenByParent, threadIdSet, MAX_INCLUDED_NOTES)
    ) {
      /* grow until no new in-thread replies */
    }
  } else if (includeConnected) {
    await addConnectedPeersIntoIncluded();
  }

  const subtreeUnderFocus = collectDescendantIds(displayRoot, childrenByParent);
  const mainRegion = new Set();
  for (const id of included) {
    if (subtreeUnderFocus.has(id)) mainRegion.add(id);
  }

  const ordered = [];
  preorderInPrimary(displayRoot, mainRegion, childrenByParent, ordered);

  const mainBlocks = [];
  for (const id of ordered) {
    const n = byId.get(String(id));
    if (n) mainBlocks.push(formatNoteBlock(n, 'Note in view', timeZone, referenceInstant));
  }

  const linkedIds = [...included].filter((id) => !mainRegion.has(id));
  linkedIds.sort((a, b) => {
    const na = byId.get(a);
    const nb = byId.get(b);
    return new Date(na?.created_at || 0) - new Date(nb?.created_at || 0);
  });

  let linkedBlock = '';
  if (linkedIds.length > 0) {
    const parts = linkedIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((n) => formatNoteBlock(n, 'Linked note (same thread)', timeZone, referenceInstant));
    const linkedExplain =
      includeConnected && includeChildren
        ? 'notes in this thread outside the focused subtree below, reached by walking from what was on screen: repeatedly adding in-thread replies, then notes linked to the current set, until stable'
        : includeConnected
          ? 'in-thread notes linked to something on screen (one step), excluding the focused subtree block above'
          : '';
    const linkedHeader = linkedExplain
      ? `--- Linked notes (same thread only; ${linkedExplain}) ---`
      : '--- Linked notes (same thread only) ---';
    linkedBlock = `${linkedHeader}\n\n${parts.join('\n\n')}\n\n`;
  }

  const mainHeader =
    !includeChildren && !includeConnected
      ? 'Notes on screen (focused note and visible replies in this thread)'
      : includeChildren && !includeConnected
        ? 'Focused branch in this thread (on screen, then all in-thread replies under those notes)'
        : !includeChildren && includeConnected
          ? 'Focused branch on screen; linked section adds notes connected to that screen set'
          : 'Focused branch after expanding in-thread replies; linked section adds further same-thread notes from the connected walk';

  const context = `--- ${mainHeader} ---\n\n${mainBlocks.join('\n\n')}${
    linkedBlock ? `\n${linkedBlock}` : ''
  }`;

  const prompt = `You summarize notes from a personal knowledge app for the user.

REFERENCE TIME — compare every dated event, meeting, and deadline in the notes to this instant (the user's zone is ${timeZone}):
- Now (local): ${referenceNowLocal}
- Now (UTC, ISO 8601): ${referenceNowUtc}
Use the "Event schedule (user's timezone …)" lines in the notes as the canonical local start/end when present. If an event's end is before this reference moment, describe it as past or completed, not as upcoming. If its start is after this moment, describe it as upcoming, future, or scheduled—not as if it already happened. If it spans this moment, you may describe it as in progress, today, or similar. When note bodies disagree with the schedule line, trust the schedule line for timing. Do not convert ISO UTC lines into a different local time yourself.

For notes with Type: event, each block may include a line starting "Event timing vs summary reference:"—that line is derived from the same reference instant as above and the stored start/end fields. Treat it as authoritative over informal dates or titles in the Content field. If it says PAST, you must not describe that event as upcoming, approaching, on the way, or soon; use past tense only. If it says FUTURE, do not write as if it already happened.

TENSE — when the relevant date or event window for something is entirely before this reference moment (including from event schedules, deadlines, or created_at when that is the only temporal cue), write about it in the past tense (e.g. "discussed," "was scheduled," "took place"). For things entirely after this moment, use future-appropriate wording. Match tense to the time of the thing you are describing, not only to whether the note still exists.

FORM — write one cohesive narrative in flowing paragraph form (at most two short paragraphs). Do not use bullet points, numbered lists, bold section headings with sub-points, "key takeaways," or an outline structure. Weave the substance together in full sentences as in a brief article or email, not like meeting minutes or slides.

Stay at or under 250 words (shorter is fine). Skip a title unless one short phrase genuinely helps; focus on substance.

Context order: first the focused subtree (under the focused note in this thread), then—if present—a block of other same-thread notes that are linked or reached via the user's reply/connected options (see section headers).

If the notes are empty, too sparse, or too fragmented to justify a real summary, do not invent one. Reply with one or two short sentences only, still in plain prose (no bullets).

${context}

Your response (summary or the honest “not enough context” message):`;

  const summary = await generate(prompt, {
    temperature: 0.35,
    num_predict: 520,
    model: SUMMARY_MODEL,
  });
  if (!summary) {
    return {
      ok: false,
      status: 503,
      error: 'AI summary unavailable (check the local model server and OLLAMA_SUMMARY_MODEL / OLLAMA_TAG_MODEL)',
    };
  }

  return { ok: true, summary: summary.trim() };
}
