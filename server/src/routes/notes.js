import { Router } from 'express';
import multer from 'multer';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { embedNote } from '../services/embedding.js';
import {
  getHoverInsight,
  getLinkedNotesWithTags,
  getNoteThreadPathDisplay,
} from '../services/hoverInsight.js';
import { buildThreadAiSummary } from '../services/threadAiSummary.js';
import { attachBlobListToNotes, MAX_BYTES } from '../services/noteFileBlobs.js';
import { canAttachTagIdByReference } from '../services/tagAccess.js';
import { compareNotesSortDesc } from '../utils/noteSortAt.js';
import {
  suggestTaskTitleFromNoteContent,
  createSpaztickExternalTask,
} from '../services/spaztickTask.js';
import { appendHermesLinkToNotes, buildHermesStreamUrl } from '../services/hermesNoteLink.js';
import { runIngestOcrPipeline } from '../services/ingestFileNoteContent.js';
import { logOcr } from '../services/ingestOcrLog.js';
import { proposeTagsForNote } from '../services/aiTags.js';

const router = Router();

/** SQL: timestamp used for list ordering (events → start, else last edit). */
const SQL_NOTE_SORT_AT = `(CASE WHEN n.note_type = 'event' AND n.event_start_at IS NOT NULL THEN n.event_start_at ELSE COALESCE(n.updated_at, n.created_at) END)`;
router.use(requireAuth);

/** Columns returned for list/detail note JSON (PostgreSQL → camel stays snake_case). */
const NOTE_RETURNING =
  'id, parent_id, content, created_at, updated_at, last_activity_at, starred, external_anchor, note_type, event_start_at, event_end_at, stream_sibling_index';

const NOTE_RETURNING_N = NOTE_RETURNING.split(', ')
  .map((col) => `n.${col}`)
  .join(', ');

/** Recursive descendant count (excludes self). Correlated to outer row alias `n`; `userPos` = bind index for `user_id`. */
function sqlDescendantCountFromN(userPos) {
  return `(
  WITH RECURSIVE d AS (
    SELECT c.id FROM notes c WHERE c.parent_id = n.id AND c.user_id = $${userPos}
    UNION ALL
    SELECT c2.id FROM notes c2 JOIN d ON c2.parent_id = d.id WHERE c2.user_id = $${userPos}
  )
  SELECT COUNT(*)::int FROM d
)`;
}

/** Mutates each row with `descendant_count` from parent_id edges in this flat list (thread snapshot). */
function addDescendantCountsToNotes(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return;
  const key = (id) => (id == null ? '' : String(id));
  const childrenByParent = new Map();
  for (const n of notes) {
    const pid = n.parent_id;
    if (pid == null) continue;
    const pk = key(pid);
    if (!childrenByParent.has(pk)) childrenByParent.set(pk, []);
    childrenByParent.get(pk).push(n.id);
  }
  const memo = new Map();
  function countDescendants(noteId) {
    const idKey = key(noteId);
    if (memo.has(idKey)) return memo.get(idKey);
    let total = 0;
    for (const cid of childrenByParent.get(idKey) || []) {
      total += 1 + countDescendants(cid);
    }
    memo.set(idKey, total);
    return total;
  }
  for (const n of notes) {
    n.descendant_count = countDescendants(n.id);
  }
}

const NOTE_TYPES = new Set(['note', 'person', 'event', 'organization']);

function coerceNoteType(v, fallback = 'note') {
  if (v == null || v === '') return fallback;
  if (typeof v !== 'string' || !NOTE_TYPES.has(v)) return null;
  return v;
}

/** undefined = omit; null = clear; string = parse (invalid → false). */
function parseOptionalInstant(raw) {
  if (raw == null || raw === '') return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString();
}

function stripMentionLinksToNote(content, targetNoteId) {
  const s = String(content ?? '');
  const id = String(targetNoteId || '').toLowerCase();
  if (!id) return s;
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mdLinkRe = new RegExp(`\\[([^\\]]*)\\]\\(hermes-note://${esc}\\)`, 'gi');
  const bareRe = new RegExp(`hermes-note://${esc}`, 'gi');
  return s
    /* Keep the readable mention label; remove only link wrapper. */
    .replace(mdLinkRe, '$1')
    .replace(bareRe, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripHashtagPrefixFromContent(content, tagName) {
  const s = String(content ?? '');
  const name = String(tagName || '').trim();
  if (!name) return s;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`#${esc}(?![a-z0-9-])`, 'gi');
  return s
    .replace(re, (m, offset, src) => {
      if (offset === 0 || /[\s\n([{'"`]/.test(src[offset - 1])) return m.slice(1);
      return m;
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 20 },
});

/** OCR + LLM note fill on this route is opt-in so the web UI (plain multipart) only stores files. */
function wantsAttachmentOcrApi(req) {
  const v = String(req.get('x-hermes-attachment-ocr') ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

router.post('/:id/attachments', (req, res, next) => {
  upload.array('files', 20)(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `File exceeds ${MAX_BYTES} bytes` });
    }
    if (err) return next(err);
    next();
  });
}, async (req, res) => {
  try {
    const noteId = req.params.id;
    const userId = req.userId;
    const files = req.files || [];
    if (files.length === 0) return res.status(400).json({ error: 'No files (use field name files)' });
    const noteCheck = await pool.query('SELECT id, content FROM notes WHERE id = $1 AND user_id = $2', [
      noteId,
      userId,
    ]);
    if (noteCheck.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    const priorContent = noteCheck.rows[0]?.content;
    const contentWasEmpty = !String(priorContent ?? '').trim();
    const apiWantsOcr = wantsAttachmentOcrApi(req);
    const runOcr = contentWasEmpty && apiWantsOcr;

    if (!contentWasEmpty) {
      logOcr('attachments_skip_ocr', { noteId, reason: 'note_already_has_content' });
    }

    const maxSort = await pool.query(
      `SELECT COALESCE(MAX(sort_index), -1)::int AS m FROM note_file_blobs WHERE note_id = $1::uuid AND user_id = $2`,
      [noteId, userId]
    );
    let nextSort = (maxSort.rows[0]?.m ?? -1) + 1;

    const inserted = [];
    const ocrPieces = [];
    const ocrStats = [];
    for (const f of files) {
      const buf = f.buffer;
      if (!buf?.length) continue;
      const filename = f.originalname?.slice(0, 512) || 'file';
      const mime = f.mimetype || 'application/octet-stream';
      const si = nextSort++;
      const ins = await pool.query(
        `INSERT INTO note_file_blobs (note_id, user_id, filename, mime_type, byte_size, data, sort_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, filename, mime_type, byte_size`,
        [noteId, userId, filename, mime, buf.length, buf, si]
      );
      inserted.push(ins.rows[0]);
      if (runOcr) {
        const { noteText, stats } = await runIngestOcrPipeline(buf, filename, mime, {
          source: 'attachments',
          noteId,
        });
        ocrPieces.push(noteText);
        ocrStats.push(stats);
      }
    }
    if (inserted.length === 0) return res.status(400).json({ error: 'No valid files' });

    if (runOcr && ocrPieces.length > 0) {
      const combined = ocrPieces
        .map((s) => String(s ?? '').trim())
        .filter(Boolean)
        .join('\n\n');
      if (combined) {
        await pool.query('UPDATE notes SET content = $1 WHERE id = $2 AND user_id = $3', [
          combined,
          noteId,
          userId,
        ]);
        embedNote(noteId, combined).catch(() => {});
        proposeTagsForNote(noteId, combined, userId).catch(() => {});
      }
    }

    const payload =
      ocrStats.length > 0 ? { inserted, ocr: ocrStats } : { inserted };
    res.status(201).json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

/** Set display order of attachments on a note (`ordered_blob_ids` = full permutation of blob ids). */
router.patch('/:id/attachments-order', async (req, res) => {
  const noteId = req.params.id;
  const userId = req.userId;
  const raw = req.body?.ordered_blob_ids;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: 'ordered_blob_ids (non-empty array) required' });
  }
  const normId = (x) => String(x ?? '').trim().toLowerCase();
  const ordered = raw.map(normId).filter(Boolean);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(
      `SELECT id::text FROM note_file_blobs WHERE note_id = $1::uuid AND user_id = $2`,
      [noteId, userId]
    );
    const existing = new Set(cur.rows.map((r) => normId(r.id)));
    if (ordered.length !== existing.size) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'ordered_blob_ids must list every attachment on this note exactly once' });
    }
    for (const id of ordered) {
      if (!existing.has(id)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Unknown blob id for this note' });
      }
    }
    for (let i = 0; i < ordered.length; i++) {
      await client.query(
        `UPDATE note_file_blobs SET sort_index = $1::int
         WHERE id = $2::uuid AND note_id = $3::uuid AND user_id = $4`,
        [i, ordered[i], noteId, userId]
      );
    }
    await client.query('COMMIT');
    res.status(204).send();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Failed to update attachment order' });
  } finally {
    client.release();
  }
});

// Root feed: root threads only; optional starred filter. Order ASC by edit time (events use start time), matching in-thread message order (oldest first, newest at bottom).
router.get('/roots', async (req, res) => {
  try {
    const starredOnly = req.query.starred === 'true';
    const userId = req.userId;
    const q = starredOnly
      ? `
        WITH RECURSIVE subtree(root_id, note_id) AS (
          SELECT id, id FROM notes WHERE parent_id IS NULL AND user_id = $1
          UNION ALL
          SELECT s.root_id, n.id FROM notes n JOIN subtree s ON n.parent_id = s.note_id WHERE n.user_id = $1
        ),
        starred_roots AS (
          SELECT DISTINCT s.root_id FROM subtree s
          JOIN notes n ON n.id = s.note_id AND n.user_id = $1 AND n.starred = true
        )
        SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor, n.note_type, n.event_start_at, n.event_end_at, n.stream_sibling_index,
               (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count,
               (SELECT COUNT(*)::int FROM note_connections nc
                WHERE nc.user_id = $1 AND (nc.anchor_note_id = n.id OR nc.linked_note_id = n.id)) AS connection_count,
               ${sqlDescendantCountFromN(1)} AS descendant_count
        FROM notes n
        WHERE n.parent_id IS NULL AND n.user_id = $1 AND n.id IN (SELECT root_id FROM starred_roots)
        ORDER BY ${SQL_NOTE_SORT_AT} ASC NULLS LAST
      `
      : `
        SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor, n.note_type, n.event_start_at, n.event_end_at, n.stream_sibling_index,
               (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count,
               (SELECT COUNT(*)::int FROM note_connections nc
                WHERE nc.user_id = $1 AND (nc.anchor_note_id = n.id OR nc.linked_note_id = n.id)) AS connection_count,
               ${sqlDescendantCountFromN(1)} AS descendant_count
        FROM notes n
        WHERE n.parent_id IS NULL AND n.user_id = $1
        ORDER BY ${SQL_NOTE_SORT_AT} ASC NULLS LAST
      `;
    const r = await pool.query(q, [userId]);
    const notes = r.rows;
    if (notes.length > 0) {
      const ids = notes.map((n) => n.id);
      const tagRows = await pool.query(
        `SELECT nt.note_id, t.id AS tag_id, t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = ANY($1) AND nt.status = 'approved' ORDER BY t.name`,
        [ids]
      );
      const byNote = {};
      tagRows.rows.forEach((row) => {
        if (!byNote[row.note_id]) byNote[row.note_id] = [];
        byNote[row.note_id].push({ id: row.tag_id, name: row.name });
      });
      notes.forEach((n) => { n.tags = byNote[n.id] || []; });
    }
    await attachBlobListToNotes(notes, userId);
    res.json(notes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch root feed' });
  }
});

// Get full thread (root + descendants) by root id
router.get('/thread/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const starredOnly = req.query.starred === 'true';
    const userId = req.userId;
    const r = await pool.query(
      `WITH RECURSIVE tree AS (
        SELECT id, parent_id, content, created_at, updated_at, last_activity_at, starred, external_anchor, note_type, event_start_at, event_end_at, stream_sibling_index, 0 AS depth,
               (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = notes.id) AS reply_count,
               (SELECT COUNT(*)::int FROM note_connections nc
                WHERE nc.user_id = $2 AND (nc.anchor_note_id = notes.id OR nc.linked_note_id = notes.id)) AS connection_count
        FROM notes WHERE id = $1 AND user_id = $2
        UNION ALL
        SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor, n.note_type, n.event_start_at, n.event_end_at, n.stream_sibling_index, t.depth + 1,
               (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count,
               (SELECT COUNT(*)::int FROM note_connections nc
                WHERE nc.user_id = $2 AND (nc.anchor_note_id = n.id OR nc.linked_note_id = n.id)) AS connection_count
        FROM notes n JOIN tree t ON n.parent_id = t.id
        WHERE n.user_id = $2
      )
      SELECT * FROM tree
      ${starredOnly ? 'WHERE starred = true' : ''}
      ORDER BY created_at ASC`,
      [id, userId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Thread not found' });
    const notes = r.rows;
    const ids = notes.map((n) => n.id);
    const tagRows = await pool.query(
      `SELECT nt.note_id, t.id AS tag_id, t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = ANY($1) AND nt.status = 'approved' ORDER BY t.name`,
      [ids]
    );
    const byNote = {};
    tagRows.rows.forEach((row) => {
      if (!byNote[row.note_id]) byNote[row.note_id] = [];
      byNote[row.note_id].push({ id: row.tag_id, name: row.name });
    });
    notes.forEach((n) => { n.tags = byNote[n.id] || []; });
    addDescendantCountsToNotes(notes);
    await attachBlobListToNotes(notes, userId);
    res.json(notes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

/** Match rows then resolve thread root per note (avoids building the full tree before filtering). */
const NOTE_LIST_FROM_MATCHES = `
  SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor, n.note_type, n.event_start_at, n.event_end_at, n.stream_sibling_index,
         r.root_id,
         (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count,
         (SELECT COUNT(*)::int FROM note_connections nc
          WHERE nc.user_id = $1 AND (nc.anchor_note_id = n.id OR nc.linked_note_id = n.id)) AS connection_count
  FROM notes n
  INNER JOIN matches m ON m.id = n.id
  INNER JOIN LATERAL (
    WITH RECURSIVE anc AS (
      SELECT id, parent_id FROM notes WHERE id = n.id
      UNION ALL
      SELECT p.id, p.parent_id FROM notes p INNER JOIN anc ON p.id = anc.parent_id
    )
    SELECT id AS root_id FROM anc WHERE parent_id IS NULL LIMIT 1
  ) r ON true
  WHERE n.user_id = $1
  ORDER BY m.sort_at DESC NULLS LAST`;

// Substring search in note body (no Ollama; use when semantic search unavailable)
router.get('/search-content', async (req, res) => {
  try {
    const raw = req.query.q?.trim();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
    const userId = req.userId;
    /** @-mention menu: first line only, prefix match (same idea as tag # typeahead). */
    const firstLineOnly =
      req.query.firstLine === '1' ||
      req.query.firstLine === 'true' ||
      req.query.firstLine === 'yes';
    if (!raw) {
      return res.status(400).json({ error: 'Query parameter q required' });
    }
    const escaped = raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%${escaped}%`;
    /* Normalized first line: split on LF, strip CR, trim space/tab/NL, strip UTF-8 BOM if present */
    const firstLineExpr = `NULLIF(
      regexp_replace(
        trim(both E' \\t\\n\\r' from replace(split_part(coalesce(n.content, ''), E'\\n', 1), E'\\r', '')),
        '^' || chr(65279),
        ''
      ),
      ''
    )`;
    const whereClause = firstLineOnly
      ? `n.user_id = $1 AND ${firstLineExpr} ILIKE $2 ESCAPE '\\'`
      : `n.user_id = $1 AND n.content ILIKE $2 ESCAPE '\\'`;
    const matchParams = firstLineOnly ? [userId, `${escaped}%`, limit] : [userId, pattern, limit];
    const r = await pool.query(
      `WITH matches AS (
        SELECT n.id, ${SQL_NOTE_SORT_AT} AS sort_at
        FROM notes n
        WHERE ${whereClause}
        ORDER BY sort_at DESC NULLS LAST
        LIMIT $3
      )
      ${NOTE_LIST_FROM_MATCHES}`,
      matchParams
    );
    const notes = r.rows;
    if (notes.length > 0) {
      const ids = notes.map((n) => n.id);
      const tagRows = await pool.query(
        `SELECT nt.note_id, t.id AS tag_id, t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = ANY($1) AND nt.status = 'approved' ORDER BY t.name`,
        [ids]
      );
      const byNote = {};
      tagRows.rows.forEach((row) => {
        if (!byNote[row.note_id]) byNote[row.note_id] = [];
        byNote[row.note_id].push({ id: row.tag_id, name: row.name });
      });
      notes.forEach((n) => {
        n.tags = byNote[n.id] || [];
      });
    }
    await attachBlobListToNotes(notes, userId);
    res.json(notes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to search content' });
  }
});

// Recent notes for @-mention menu when the query is still empty (fast path; no ILIKE scan)
router.get('/mention-recent', async (req, res) => {
  try {
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit, 10) || 12));
    const userId = req.userId;
    const r = await pool.query(
      `WITH matches AS (
        SELECT n.id, ${SQL_NOTE_SORT_AT} AS sort_at
        FROM notes n
        WHERE n.user_id = $1
        ORDER BY sort_at DESC NULLS LAST
        LIMIT $2
      )
      ${NOTE_LIST_FROM_MATCHES}`,
      [userId, limit]
    );
    const notes = r.rows;
    if (notes.length > 0) {
      const ids = notes.map((n) => n.id);
      const tagRows = await pool.query(
        `SELECT nt.note_id, t.id AS tag_id, t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = ANY($1) AND nt.status = 'approved' ORDER BY t.name`,
        [ids]
      );
      const byNote = {};
      tagRows.rows.forEach((row) => {
        if (!byNote[row.note_id]) byNote[row.note_id] = [];
        byNote[row.note_id].push({ id: row.tag_id, name: row.name });
      });
      notes.forEach((n) => {
        n.tags = byNote[n.id] || [];
      });
    }
    await attachBlobListToNotes(notes, userId);
    res.json(notes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load recent notes' });
  }
});

// Flat / Tag view: notes matching tag(s), mode = and | or
router.get('/search-by-tags', async (req, res) => {
  try {
    const tagIds = req.query.tagIds ? req.query.tagIds.split(',').filter(Boolean) : [];
    const mode = (req.query.mode || 'and').toLowerCase() === 'or' ? 'or' : 'and';
    const starredOnly = req.query.starred === 'true';
    const userId = req.userId;
    if (tagIds.length === 0) {
      return res.json([]);
    }
    const placeholders = tagIds.map((_, i) => `$${i + 2}`).join(', ');
    const havingClause = mode === 'and' ? `HAVING COUNT(DISTINCT nt.tag_id) = ${tagIds.length}` : '';
    const q = `
      WITH RECURSIVE roots AS (
        SELECT id, id AS root_id FROM notes WHERE parent_id IS NULL AND user_id = $1
        UNION ALL
        SELECT n.id, r.root_id FROM notes n JOIN roots r ON r.id = n.parent_id
      )
      SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor, n.note_type, n.event_start_at, n.event_end_at, n.stream_sibling_index, r.root_id,
             (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count,
             (SELECT COUNT(*)::int FROM note_connections nc
              WHERE nc.user_id = $1 AND (nc.anchor_note_id = n.id OR nc.linked_note_id = n.id)) AS connection_count
      FROM notes n
      JOIN note_tags nt ON nt.note_id = n.id AND nt.tag_id IN (${placeholders}) AND nt.status = 'approved'
      JOIN roots r ON r.id = n.id
      WHERE n.user_id = $1
      ${starredOnly ? 'AND n.starred = true' : ''}
      GROUP BY n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor, n.note_type, n.event_start_at, n.event_end_at, n.stream_sibling_index, r.root_id
      ${havingClause}
      ORDER BY ${SQL_NOTE_SORT_AT} DESC NULLS LAST
    `;
    const r = await pool.query(q, [userId, ...tagIds]);
    const notes = r.rows;
    if (notes.length > 0) {
      const ids = notes.map((n) => n.id);
      const tagRows = await pool.query(
        `SELECT nt.note_id, t.id AS tag_id, t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = ANY($1) AND nt.status = 'approved' ORDER BY t.name`,
        [ids]
      );
      const byNote = {};
      tagRows.rows.forEach((row) => {
        if (!byNote[row.note_id]) byNote[row.note_id] = [];
        byNote[row.note_id].push({ id: row.tag_id, name: row.name });
      });
      notes.forEach((n) => { n.tags = byNote[n.id] || []; });
    }
    await attachBlobListToNotes(notes, userId);
    res.json(notes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to search by tags' });
  }
});

/** Event notes overlapping a half-open time range [from, to) for calendar views. */
router.get('/events-in-range', async (req, res) => {
  try {
    const fromRaw = req.query.from;
    const toRaw = req.query.to;
    if (fromRaw == null || String(fromRaw).trim() === '' || toRaw == null || String(toRaw).trim() === '') {
      return res.status(400).json({ error: 'Query parameters from and to are required (ISO 8601)' });
    }
    const rangeStart = parseOptionalInstant(fromRaw);
    const rangeEndExclusive = parseOptionalInstant(toRaw);
    if (rangeStart === false || rangeEndExclusive === false) {
      return res.status(400).json({ error: 'Invalid from or to timestamp' });
    }
    const userId = req.userId;
    const q = `
      SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor, n.note_type, n.event_start_at, n.event_end_at, n.stream_sibling_index,
             r.root_id AS thread_root_id,
             (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count,
             (SELECT COUNT(*)::int FROM note_connections nc
              WHERE nc.user_id = $1 AND (nc.anchor_note_id = n.id OR nc.linked_note_id = n.id)) AS connection_count
      FROM notes n
      INNER JOIN LATERAL (
        WITH RECURSIVE anc AS (
          SELECT id, parent_id FROM notes WHERE id = n.id
          UNION ALL
          SELECT p.id, p.parent_id FROM notes p INNER JOIN anc ON p.id = anc.parent_id
        )
        SELECT id AS root_id FROM anc WHERE parent_id IS NULL LIMIT 1
      ) r ON true
      WHERE n.user_id = $1
        AND n.note_type = 'event'
        AND n.event_start_at IS NOT NULL
        AND n.event_start_at < $3
        AND COALESCE(n.event_end_at, n.event_start_at) >= $2
      ORDER BY n.event_start_at ASC`;
    const r = await pool.query(q, [userId, rangeStart, rangeEndExclusive]);
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load events in range' });
  }
});

// Semantic search: hybrid = substring matches first, then vector similarity (short queries often miss in pure dense search)
router.get('/search-semantic', async (req, res) => {
  try {
    const q = req.query.q?.trim();
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const userId = req.userId;
    if (!q) return res.json([]);
    const escaped = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%${escaped}%`;
    const textFetchLimit = Math.min(100, Math.max(limit * 3, limit));
    const textSql = `WITH RECURSIVE roots AS (
        SELECT id, id AS root_id FROM notes WHERE parent_id IS NULL AND user_id = $1
        UNION ALL
        SELECT n.id, r.root_id FROM notes n JOIN roots r ON r.id = n.parent_id
      )
      SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor, n.note_type, n.event_start_at, n.event_end_at, n.stream_sibling_index,
             r.root_id,
             (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count,
             (SELECT COUNT(*)::int FROM note_connections nc
              WHERE nc.user_id = $1 AND (nc.anchor_note_id = n.id OR nc.linked_note_id = n.id)) AS connection_count
      FROM notes n
      JOIN roots r ON r.id = n.id
      WHERE n.user_id = $1 AND n.content ILIKE $2 ESCAPE '\\'
      ORDER BY ${SQL_NOTE_SORT_AT} DESC NULLS LAST
      LIMIT $3`;
    const textR = await pool.query(textSql, [userId, pattern, textFetchLimit]);

    const { embed, inputForQuery } = await import('../services/ollama.js');
    const vec = await embed(inputForQuery(q));
    const semFetchLimit = Math.min(100, Math.max(limit * 3, limit + 10));
    let semRows = [];
    let vectorSearchError = null;
    if (vec) {
      const vecStr = `[${vec.join(',')}]`;
      try {
        const semR = await pool.query(
          `WITH RECURSIVE roots AS (
        SELECT id, id AS root_id FROM notes WHERE parent_id IS NULL AND user_id = $2
        UNION ALL
        SELECT n.id, r.root_id FROM notes n JOIN roots r ON r.id = n.parent_id
      )
      SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor, n.note_type, n.event_start_at, n.event_end_at, n.stream_sibling_index,
             1 - (n.embedding <=> $1::vector) AS similarity, r.root_id,
             (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count,
             (SELECT COUNT(*)::int FROM note_connections nc
              WHERE nc.user_id = $2 AND (nc.anchor_note_id = n.id OR nc.linked_note_id = n.id)) AS connection_count
      FROM notes n
      JOIN roots r ON r.id = n.id
      WHERE n.user_id = $2 AND n.embedding IS NOT NULL
      ORDER BY n.embedding <=> $1::vector
      LIMIT $3`,
          [vecStr, userId, semFetchLimit]
        );
        semRows = semR.rows;
      } catch (semErr) {
        console.error('search-semantic vector query:', semErr.message);
        vectorSearchError = semErr.message || String(semErr);
      }
    }

    const seen = new Set();
    const notes = [];
    for (const row of textR.rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const { root_id, ...note } = row;
      notes.push({ ...note, root_id, similarity: 1, textMatch: true });
      if (notes.length >= limit) break;
    }
    if (notes.length < limit && semRows.length > 0) {
      for (const row of semRows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        const { similarity, root_id, ...note } = row;
        notes.push({ ...note, similarity, root_id, textMatch: false });
        if (notes.length >= limit) break;
      }
    }

    if (notes.length === 0 && !vec) {
      return res.status(503).json({
        error: 'Semantic search unavailable (Ollama embed failed or returned nothing). Use GET /api/notes/search-content?q=... for text substring search.',
        code: 'EMBED_UNAVAILABLE',
      });
    }
    if (notes.length === 0 && vec && vectorSearchError) {
      const dimHint =
        /dimension|expected/i.test(vectorSearchError)
          ? ' Your DB column notes.embedding must match the embed model size (e.g. 768 for nomic-embed-text). Fix OLLAMA_EMBED_MODEL or alter vector(N), then run npm run reembed.'
          : '';
      return res.status(503).json({
        error: `Vector search failed.${dimHint} Detail: ${vectorSearchError}. Try Keyword search, or fix embeddings and retry.`,
        code: 'VECTOR_SEARCH_FAILED',
      });
    }

    if (notes.length > 0) {
      const ids = notes.map((n) => n.id);
      const tagRows = await pool.query(
        `SELECT nt.note_id, t.id AS tag_id, t.name FROM note_tags nt JOIN tags t ON t.id = nt.tag_id WHERE nt.note_id = ANY($1) AND nt.status = 'approved' ORDER BY t.name`,
        [ids]
      );
      const byNote = {};
      tagRows.rows.forEach((row) => {
        if (!byNote[row.note_id]) byNote[row.note_id] = [];
        byNote[row.note_id].push({ id: row.tag_id, name: row.name });
      });
      notes.forEach((n) => {
        n.tags = byNote[n.id] || [];
      });
    }
    await attachBlobListToNotes(notes, userId);
    notes.sort(compareNotesSortDesc);
    res.json(notes);
  } catch (err) {
    console.error('search-semantic:', err);
    res.status(500).json({
      error: err.message ? `Failed to search: ${err.message}` : 'Failed to search',
      code: 'SEARCH_ERROR',
    });
  }
});

/** Hover insight: static path before /:id/* to avoid any param shadowing. */
router.post('/hover-insight', async (req, res) => {
  try {
    const noteId = req.body?.noteId;
    if (!noteId) return res.status(400).json({ error: 'noteId required' });
    const data = await getHoverInsight(noteId, req.userId);
    if (!data) return res.status(404).json({ error: 'Note not found' });
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build hover insight' });
  }
});

/** Ollama summary: on-screen branch by default; optional full replies subtree and/or linked-note expansion. */
router.post('/thread-ai-summary', async (req, res) => {
  try {
    const b = req.body ?? {};
    const result = await buildThreadAiSummary({
      threadRootId: b.threadRootId,
      focusNoteId: b.focusNoteId,
      visibleNoteIds: b.visibleNoteIds,
      includeChildren: b.includeChildren === true,
      includeConnected: b.includeConnected === true,
      userId: req.userId,
      timeZone: b.timeZone,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json({ summary: result.summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to build thread summary' });
  }
});

// Get tags for a note (approved only)
router.get('/:id/tags', async (req, res) => {
  try {
    const noteId = req.params.id;
    const userId = req.userId;
    const own = await pool.query('SELECT 1 FROM notes WHERE id = $1 AND user_id = $2', [noteId, userId]);
    if (own.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    const r = await pool.query(
      `SELECT t.id, t.name FROM tags t
       JOIN note_tags nt ON nt.tag_id = t.id AND nt.note_id = $1 AND nt.status = 'approved'
       JOIN notes n ON n.id = nt.note_id AND n.user_id = $2
       ORDER BY t.name`,
      [noteId, userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch note tags' });
  }
});

// Add tag to note (create tag if name given, then link with status approved for user-applied)
router.post('/:id/tags', async (req, res) => {
  try {
    const noteId = req.params.id;
    const userId = req.userId;
    const { tag_id: tagId, name } = req.body;
    let tid = tagId;
    if (!tid && name) {
      const n = (name.trim().toLowerCase().replace(/\s+/g, '-'));
      const ins = await pool.query('INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id', [n]);
      if (ins.rows.length > 0) tid = ins.rows[0].id;
      else {
        const ex = await pool.query('SELECT id FROM tags WHERE name = $1', [n]);
        if (ex.rows.length) tid = ex.rows[0].id;
      }
    }
    if (!tid) return res.status(400).json({ error: 'tag_id or name required' });
    // By id: your tags, or unused tag rows (e.g. after POST /api/tags). By name: resolve/create as today.
    if (tagId && !name) {
      if (!(await canAttachTagIdByReference(tid, userId))) {
        return res.status(400).json({ error: 'Tag not available' });
      }
    }
    const noteCheck = await pool.query('SELECT id FROM notes WHERE id = $1 AND user_id = $2', [noteId, userId]);
    if (noteCheck.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    await pool.query(
      `INSERT INTO note_tags (note_id, tag_id, source, status) VALUES ($1, $2, 'user', 'approved')
       ON CONFLICT (note_id, tag_id) DO UPDATE SET source = 'user', status = 'approved'`,
      [noteId, tid]
    );
    const t = await pool.query('SELECT id, name FROM tags WHERE id = $1', [tid]);
    res.status(201).json(t.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to add tag to note' });
  }
});

// Remove tag from note
router.delete('/:id/tags/:tagId', async (req, res) => {
  try {
    const noteId = req.params.id;
    const tagId = req.params.tagId;
    const userId = req.userId;
    const noteRow = await pool.query(
      'SELECT id, content, updated_at, last_activity_at FROM notes WHERE id = $1 AND user_id = $2',
      [noteId, userId]
    );
    if (noteRow.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    const tagRow = await pool.query('SELECT id, name FROM tags WHERE id = $1', [tagId]);
    if (tagRow.rows.length === 0) return res.status(404).json({ error: 'Tag not found' });

    const r = await pool.query(
      `DELETE FROM note_tags nt USING notes n
       WHERE nt.note_id = n.id AND n.user_id = $1 AND nt.note_id = $2 AND nt.tag_id = $3
       RETURNING nt.id`,
      [userId, noteId, tagId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Note or tag link not found' });

    const current = String(noteRow.rows[0].content ?? '');
    const next = stripHashtagPrefixFromContent(current, tagRow.rows[0].name);
    if (next !== current) {
      const row = noteRow.rows[0];
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'INSERT INTO note_propagate_suppress (note_id) VALUES ($1::uuid), ($1::uuid)',
          [noteId]
        );
        await client.query('UPDATE notes SET content = $1 WHERE id = $2 AND user_id = $3', [next, noteId, userId]);
        await client.query(
          'UPDATE notes SET updated_at = $1::timestamptz, last_activity_at = $2::timestamptz WHERE id = $3 AND user_id = $4',
          [row.updated_at, row.last_activity_at, noteId, userId]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove tag from note' });
  }
});

/** List connections by stored orientation (outgoing / incoming); same pair is one row in DB. */
router.get('/:id/connections', async (req, res) => {
  try {
    const noteId = req.params.id;
    const userId = req.userId;
    const own = await pool.query('SELECT id FROM notes WHERE id = $1 AND user_id = $2', [noteId, userId]);
    if (own.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    const out = await pool.query(
      `SELECT nc.id, nc.linked_note_id AS other_id, nb.content, nc.created_at
       FROM note_connections nc
       JOIN notes nb ON nb.id = nc.linked_note_id AND nb.user_id = $1
       WHERE nc.user_id = $1 AND nc.anchor_note_id = $2
       ORDER BY nc.created_at DESC`,
      [userId, noteId]
    );
    const inc = await pool.query(
      `SELECT nc.id, nc.anchor_note_id AS other_id, na.content, nc.created_at
       FROM note_connections nc
       JOIN notes na ON na.id = nc.anchor_note_id AND na.user_id = $1
       WHERE nc.user_id = $1 AND nc.linked_note_id = $2
       ORDER BY nc.created_at DESC`,
      [userId, noteId]
    );
    res.json({
      outgoing: out.rows.map((r) => ({
        connectionId: r.id,
        noteId: r.other_id,
        content: r.content,
        created_at: r.created_at,
      })),
      incoming: inc.rows.map((r) => ({
        connectionId: r.id,
        noteId: r.other_id,
        content: r.content,
        created_at: r.created_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list connections' });
  }
});

/** Create link between two notes (stored as one row; either orientation). Idempotent for the pair. */
router.post('/:id/connections', async (req, res) => {
  try {
    const anchorId = req.params.id;
    const linkedNoteId = req.body?.linkedNoteId;
    const userId = req.userId;
    if (!linkedNoteId) return res.status(400).json({ error: 'linkedNoteId required' });
    if (anchorId === linkedNoteId) return res.status(400).json({ error: 'Cannot connect a note to itself' });
    const [a, b] = await Promise.all([
      pool.query('SELECT 1 FROM notes WHERE id = $1 AND user_id = $2', [anchorId, userId]),
      pool.query('SELECT 1 FROM notes WHERE id = $1 AND user_id = $2', [linkedNoteId, userId]),
    ]);
    if (a.rows.length === 0 || b.rows.length === 0) {
      return res.status(404).json({ error: 'One or both notes not found' });
    }
    const existing = await pool.query(
      `SELECT id, anchor_note_id, linked_note_id, created_at FROM note_connections
       WHERE user_id = $1
         AND (
           (anchor_note_id = $2::uuid AND linked_note_id = $3::uuid)
           OR (anchor_note_id = $3::uuid AND linked_note_id = $2::uuid)
         )
       LIMIT 1`,
      [userId, anchorId, linkedNoteId]
    );
    if (existing.rows.length > 0) return res.status(200).json(existing.rows[0]);
    const ins = await pool.query(
      `INSERT INTO note_connections (user_id, anchor_note_id, linked_note_id)
       VALUES ($1, $2, $3)
       RETURNING id, anchor_note_id, linked_note_id, created_at`,
      [userId, anchorId, linkedNoteId]
    );
    res.status(201).json(ins.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create connection' });
  }
});

/** Remove undirected link between two notes (either stored orientation). */
router.delete('/:id/connections/:linkedNoteId', async (req, res) => {
  try {
    const a = req.params.id;
    const b = req.params.linkedNoteId;
    const r = await pool.query(
      `DELETE FROM note_connections
       WHERE user_id = $1
         AND (
           (anchor_note_id = $2::uuid AND linked_note_id = $3::uuid)
           OR (anchor_note_id = $3::uuid AND linked_note_id = $2::uuid)
         )
       RETURNING id`,
      [req.userId, a, b]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Connection not found' });

    /*
     * Connection is the source of truth: if this link is removed anywhere, scrub matching
     * hermes-note mentions from both note bodies so text and graph stay in sync.
     */
    const notes = await pool.query(
      `SELECT id, content, updated_at, last_activity_at FROM notes WHERE user_id = $1 AND id = ANY($2::uuid[])`,
      [req.userId, [a, b]]
    );
    const byId = new Map(notes.rows.map((n) => [String(n.id).toLowerCase(), n]));
    const na = byId.get(String(a).toLowerCase());
    const nb = byId.get(String(b).toLowerCase());
    async function scrubContentPreservingEditTime(note, linkedNoteId) {
      const next = stripMentionLinksToNote(note.content, linkedNoteId);
      if (next === String(note.content ?? '')) return;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'INSERT INTO note_propagate_suppress (note_id) VALUES ($1::uuid), ($1::uuid)',
          [note.id]
        );
        await client.query('UPDATE notes SET content = $1 WHERE id = $2 AND user_id = $3', [
          next,
          note.id,
          req.userId,
        ]);
        await client.query(
          'UPDATE notes SET updated_at = $1::timestamptz, last_activity_at = $2::timestamptz WHERE id = $3 AND user_id = $4',
          [note.updated_at, note.last_activity_at, note.id, req.userId]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    }
    if (na) await scrubContentPreservingEditTime(na, b);
    if (nb) await scrubContentPreservingEditTime(nb, a);

    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete connection' });
  }
});

// Resolve thread root id for any note (walk parent chain)
router.get('/:id/thread-root', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const r = await pool.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_id FROM notes WHERE id = $1 AND user_id = $2
         UNION ALL
         SELECT n.id, n.parent_id FROM notes n JOIN up u ON n.id = u.parent_id WHERE n.user_id = $2
       )
       SELECT id AS thread_root_id FROM up WHERE parent_id IS NULL LIMIT 1`,
      [id, userId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    res.json({ thread_root_id: r.rows[0].thread_root_id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resolve thread root' });
  }
});

/** Breadcrumb path from thread root to note (snippet segments joined by " > "). */
router.get('/:id/thread-path', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const own = await pool.query('SELECT 1 FROM notes WHERE id = $1 AND user_id = $2', [id, userId]);
    if (own.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    const excludeLeaf =
      req.query.excludeLeaf === '1' || req.query.excludeLeaf === 'true' || req.query.excludeLeaf === 'yes';
    const threadPath = await getNoteThreadPathDisplay(id, userId, { excludeLeaf });
    res.json({ threadPath });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to resolve thread path' });
  }
});

/** Linked notes only (fast; no embeddings / Ollama). Same shape as hover-insight `persistedLinks`. */
router.get('/:id/linked-notes', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.userId;
    const own = await pool.query('SELECT 1 FROM notes WHERE id = $1 AND user_id = $2', [id, userId]);
    if (own.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    const { persistedLinks } = await getLinkedNotesWithTags(id, userId);
    res.json({ persistedLinks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load linked notes' });
  }
});

/** Create a Spaztick task from this note (Ollama title + note body as task notes). See API_ACCESS.md. */
router.post('/:id/spaztick-task', async (req, res) => {
  try {
    const { id: noteId } = req.params;
    const userId = req.userId;
    const noteR = await pool.query('SELECT id, content, created_at FROM notes WHERE id = $1 AND user_id = $2', [
      noteId,
      userId,
    ]);
    if (noteR.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    const settingsR = await pool.query('SELECT settings_json FROM users WHERE id = $1', [userId]);
    const raw = settingsR.rows[0]?.settings_json && typeof settingsR.rows[0].settings_json === 'object'
      ? settingsR.rows[0].settings_json
      : {};
    const baseUrl =
      typeof raw.spaztickApiUrl === 'string' ? raw.spaztickApiUrl.trim().replace(/\/$/, '') : '';
    const apiKey =
      typeof raw.spaztickApiKey === 'string' ? raw.spaztickApiKey.trim() : '';
    if (!baseUrl || !apiKey) {
      return res.status(400).json({
        error: 'Configure Spaztick API URL and API key in Settings',
        code: 'SPAZTICK_NOT_CONFIGURED',
      });
    }
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return res.status(400).json({ error: 'Spaztick API URL must be http or https' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid Spaztick API URL in Settings' });
    }
    const subtreeR = await pool.query(
      `WITH RECURSIVE tree AS (
         SELECT id, parent_id, content, created_at
         FROM notes
         WHERE id = $1 AND user_id = $2
         UNION ALL
         SELECT n.id, n.parent_id, n.content, n.created_at
         FROM notes n
         JOIN tree t ON n.parent_id = t.id
         WHERE n.user_id = $2
       )
       SELECT id, parent_id, content, created_at
       FROM tree`,
      [noteId, userId]
    );

    const all = subtreeR.rows;
    const byParent = new Map();
    for (const row of all) {
      const key = row.parent_id == null ? '__root__' : String(row.parent_id);
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key).push(row);
    }
    for (const kids of byParent.values()) {
      kids.sort((a, b) => {
        const ta = new Date(a.created_at).getTime();
        const tb = new Date(b.created_at).getTime();
        if (ta !== tb) return ta - tb;
        return String(a.id).localeCompare(String(b.id));
      });
    }

    function formatTreeNote(content, depth) {
      const raw = String(content ?? '');
      const lines = raw.split(/\r?\n/);
      const lead = depth === 0 ? '' : `${'  '.repeat(depth)}- `;
      if (lines.length === 0) return lead || '(empty note)';
      const first = `${lead}${lines[0] || '(empty note)'}`;
      if (lines.length === 1) return first;
      const contIndent = `${depth === 0 ? '' : '  '.repeat(depth + 1)}`;
      const tail = lines.slice(1).map((ln) => `${contIndent}${ln}`);
      return [first, ...tail].join('\n');
    }

    const blocks = [];
    function dfs(cur, depth) {
      blocks.push(formatTreeNote(cur.content, depth));
      const kids = byParent.get(String(cur.id)) || [];
      for (const k of kids) dfs(k, depth + 1);
    }
    const root = noteR.rows[0];
    dfs(root, 0);

    const exportNotes = blocks.join('\n\n');
    const title = await suggestTaskTitleFromNoteContent(String(root.content ?? ''));
    const streamUrl = buildHermesStreamUrl(noteId, req);
    const notesForTask = appendHermesLinkToNotes(exportNotes, { httpUrl: streamUrl, noteId });
    const task = await createSpaztickExternalTask({
      baseUrl,
      apiKey,
      title,
      notes: notesForTask,
    });
    res.status(201).json({ title, task });
  } catch (err) {
    console.error('spaztick-task:', err);
    const msg = err?.message || 'Failed to create Spaztick task';
    const code = err?.status;
    const status =
      typeof code === 'number' && code >= 400 && code < 600 ? code : 502;
    res.status(status).json({ error: msg });
  }
});

/** All notes for the current user (flat rows). Client builds the forest for move-note and similar pickers. */
router.get('/all-flat', async (req, res) => {
  try {
    const userId = req.userId;
    const r = await pool.query(
      `SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor, n.note_type, n.event_start_at, n.event_end_at, n.stream_sibling_index,
              (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count,
              (SELECT COUNT(*)::int FROM note_connections nc
               WHERE nc.user_id = $1 AND (nc.anchor_note_id = n.id OR nc.linked_note_id = n.id)) AS connection_count
       FROM notes n WHERE n.user_id = $1
       ORDER BY ${SQL_NOTE_SORT_AT} ASC NULLS LAST, n.id ASC`,
      [userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load notes' });
  }
});

// Get single note (with tags)
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT ${NOTE_RETURNING_N},
              (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count,
              (SELECT COUNT(*)::int FROM note_connections nc
               WHERE nc.user_id = $2 AND (nc.anchor_note_id = n.id OR nc.linked_note_id = n.id)) AS connection_count,
              ${sqlDescendantCountFromN(2)} AS descendant_count
       FROM notes n WHERE n.id = $1::uuid AND n.user_id = $2`,
      [req.params.id, req.userId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    const note = r.rows[0];
    const tags = await pool.query(
      `SELECT t.id, t.name FROM tags t JOIN note_tags nt ON nt.tag_id = t.id AND nt.note_id = $1 AND nt.status = 'approved' ORDER BY t.name`,
      [req.params.id]
    );
    note.tags = tags.rows;
    await attachBlobListToNotes([note], req.userId);
    res.json(note);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch note' });
  }
});

// Create note (root or reply)
router.post('/', async (req, res) => {
  try {
    const {
      content,
      parent_id: parentId,
      external_anchor: externalAnchor,
      note_type: noteTypeRaw,
      event_start_at: eventStartRaw,
      event_end_at: eventEndRaw,
    } = req.body;
    const userId = req.userId;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'Content must be a string' });
    }
    const text = content.trim();
    const noteType = coerceNoteType(noteTypeRaw, 'note');
    if (noteType == null) {
      return res.status(400).json({ error: 'Invalid note_type' });
    }
    let eventStart = null;
    let eventEnd = null;
    if (noteType === 'event') {
      const s = parseOptionalInstant(eventStartRaw);
      const e = parseOptionalInstant(eventEndRaw);
      if (s === false || e === false) {
        return res.status(400).json({ error: 'Invalid event_start_at or event_end_at' });
      }
      eventStart = s;
      eventEnd = e;
    }
    const r = await pool.query(
      `INSERT INTO notes (parent_id, content, external_anchor, user_id, note_type, event_start_at, event_end_at, stream_sibling_index)
       VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         CASE
           WHEN $1::uuid IS NULL THEN NULL
           ELSE COALESCE(
             (SELECT MAX(stream_sibling_index) + 1 FROM notes c WHERE c.parent_id = $1::uuid AND c.user_id = $4::uuid),
             0
           )
         END
       )
       RETURNING ${NOTE_RETURNING}`,
      [parentId || null, text, externalAnchor || null, userId, noteType, eventStart, eventEnd]
    );
    const note = r.rows[0];
    embedNote(note.id, note.content).catch(() => {});
    res.status(201).json(note);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

// Update note
router.patch('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const {
      content,
      starred,
      external_anchor: externalAnchor,
      note_type: noteTypeBody,
      event_start_at: eventStartBody,
      event_end_at: eventEndBody,
      parent_id: parentIdBody,
      stream_sibling_index: streamSiblingBody,
    } = req.body;
    const userId = req.userId;
    const has = (k) => Object.prototype.hasOwnProperty.call(req.body, k);
    const touchMeta = has('note_type') || has('event_start_at') || has('event_end_at');

    const updates = [];
    const values = [];
    let i = 1;
    if (content !== undefined) { updates.push(`content = $${i++}`); values.push(content); }
    if (starred !== undefined) { updates.push(`starred = $${i++}`); values.push(!!starred); }
    if (externalAnchor !== undefined) { updates.push(`external_anchor = $${i++}`); values.push(externalAnchor); }

    if (has('parent_id')) {
      const own = await pool.query('SELECT parent_id FROM notes WHERE id = $1 AND user_id = $2', [id, userId]);
      if (own.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
      const priorParentId = own.rows[0]?.parent_id;
      let newParentId = parentIdBody;
      if (newParentId === '') newParentId = null;
      if (newParentId != null) {
        if (typeof newParentId !== 'string') {
          return res.status(400).json({ error: 'parent_id must be a UUID or null' });
        }
        const p = await pool.query('SELECT id FROM notes WHERE id = $1 AND user_id = $2', [newParentId, userId]);
        if (p.rows.length === 0) {
          return res.status(400).json({ error: 'Parent note not found' });
        }
        if (newParentId === id) {
          return res.status(400).json({ error: 'A note cannot be its own parent' });
        }
        const cycle = await pool.query(
          `WITH RECURSIVE sub AS (
             SELECT id FROM notes WHERE id = $1::uuid AND user_id = $2::uuid
             UNION ALL
             SELECT n.id FROM notes n INNER JOIN sub ON n.parent_id = sub.id WHERE n.user_id = $2::uuid
           )
           SELECT 1 FROM sub WHERE id = $3::uuid LIMIT 1`,
          [id, userId, newParentId]
        );
        if (cycle.rows.length > 0) {
          return res.status(400).json({ error: 'Cannot move a note under itself or its descendants' });
        }
      }
      const parentKey = (v) => (v == null ? '' : String(v));
      const parentChanged = parentKey(priorParentId) !== parentKey(newParentId);
      updates.push(`parent_id = $${i++}`);
      values.push(newParentId);
      if (parentChanged && !has('stream_sibling_index')) {
        updates.push('stream_sibling_index = NULL');
      }
    }

    if (has('stream_sibling_index')) {
      const raw = streamSiblingBody;
      if (raw !== null && raw !== undefined) {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > 1_000_000) {
          return res.status(400).json({ error: 'stream_sibling_index must be null or an integer from 0 to 1000000' });
        }
        updates.push(`stream_sibling_index = $${i++}`);
        values.push(n);
      } else {
        updates.push(`stream_sibling_index = $${i++}`);
        values.push(null);
      }
    }

    if (touchMeta) {
      const cur = await pool.query(`SELECT ${NOTE_RETURNING} FROM notes WHERE id = $1 AND user_id = $2`, [id, userId]);
      if (cur.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
      const prev = cur.rows[0];
      const mergedType = has('note_type')
        ? coerceNoteType(noteTypeBody, 'note')
        : coerceNoteType(prev.note_type, 'note');
      if (mergedType == null) {
        return res.status(400).json({ error: 'Invalid note_type' });
      }
      let nextStart = prev.event_start_at;
      let nextEnd = prev.event_end_at;
      if (mergedType !== 'event') {
        nextStart = null;
        nextEnd = null;
      } else {
        if (has('event_start_at')) {
          const s = parseOptionalInstant(eventStartBody);
          if (s === false) return res.status(400).json({ error: 'Invalid event_start_at' });
          nextStart = s;
        }
        if (has('event_end_at')) {
          const e = parseOptionalInstant(eventEndBody);
          if (e === false) return res.status(400).json({ error: 'Invalid event_end_at' });
          nextEnd = e;
        }
      }
      updates.push(`note_type = $${i++}`);
      values.push(mergedType);
      updates.push(`event_start_at = $${i++}`);
      values.push(nextStart);
      updates.push(`event_end_at = $${i++}`);
      values.push(nextEnd);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(id, userId);
    const r = await pool.query(
      `UPDATE notes SET ${updates.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING ${NOTE_RETURNING}`,
      values
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    const note = r.rows[0];
    if (content !== undefined) {
      embedNote(note.id, note.content).catch(() => {});
    }
    res.json(note);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update note' });
  }
});

// Delete note (cascades to children)
router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM notes WHERE id = $1 AND user_id = $2 RETURNING id', [req.params.id, req.userId]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete note' });
  }
});

// Star/unstar
router.post('/:id/star', async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE notes SET starred = true WHERE id = $1 AND user_id = $2 RETURNING id, starred',
      [req.params.id, req.userId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to star note' });
  }
});

router.delete('/:id/star', async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE notes SET starred = false WHERE id = $1 AND user_id = $2 RETURNING id, starred',
      [req.params.id, req.userId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to unstar note' });
  }
});

export default router;
