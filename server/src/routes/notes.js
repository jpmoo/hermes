import { Router } from 'express';
import multer from 'multer';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { embedNote } from '../services/embedding.js';
import { proposeTagsForNote } from '../services/aiTags.js';
import { attachBlobListToNotes, MAX_BYTES } from '../services/noteFileBlobs.js';

const router = Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 20 },
});

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
    const noteCheck = await pool.query('SELECT id FROM notes WHERE id = $1 AND user_id = $2', [noteId, userId]);
    if (noteCheck.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    const inserted = [];
    for (const f of files) {
      const buf = f.buffer;
      if (!buf?.length) continue;
      const ins = await pool.query(
        `INSERT INTO note_file_blobs (note_id, user_id, filename, mime_type, byte_size, data)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, filename, mime_type, byte_size`,
        [noteId, userId, f.originalname?.slice(0, 512) || 'file', f.mimetype || 'application/octet-stream', buf.length, buf]
      );
      inserted.push(ins.rows[0]);
    }
    if (inserted.length === 0) return res.status(400).json({ error: 'No valid files' });
    res.status(201).json(inserted);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Root feed: root notes, reverse chron by last_activity_at, optional starred filter
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
        SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor,
               (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count
        FROM notes n
        WHERE n.parent_id IS NULL AND n.user_id = $1 AND n.id IN (SELECT root_id FROM starred_roots)
        ORDER BY n.last_activity_at DESC
      `
      : `
        SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor,
               (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count
        FROM notes n
        WHERE n.parent_id IS NULL AND n.user_id = $1
        ORDER BY n.last_activity_at DESC
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
        SELECT id, parent_id, content, created_at, updated_at, last_activity_at, starred, external_anchor, 0 AS depth,
               (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = notes.id) AS reply_count
        FROM notes WHERE id = $1 AND user_id = $2
        UNION ALL
        SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor, t.depth + 1,
               (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id)
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
    await attachBlobListToNotes(notes, userId);
    res.json(notes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

// Substring search in note body (no Ollama; use when semantic search unavailable)
router.get('/search-content', async (req, res) => {
  try {
    const raw = req.query.q?.trim();
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));
    const userId = req.userId;
    if (!raw) {
      return res.status(400).json({ error: 'Query parameter q required' });
    }
    const escaped = raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%${escaped}%`;
    const r = await pool.query(
      `WITH RECURSIVE roots AS (
        SELECT id, id AS root_id FROM notes WHERE parent_id IS NULL AND user_id = $1
        UNION ALL
        SELECT n.id, r.root_id FROM notes n JOIN roots r ON r.id = n.parent_id
      )
      SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor,
             r.root_id,
             (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count
      FROM notes n
      JOIN roots r ON r.id = n.id
      WHERE n.user_id = $1 AND n.content ILIKE $2 ESCAPE '\\'
      ORDER BY n.last_activity_at DESC
      LIMIT $3`,
      [userId, pattern, limit]
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
      SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor, r.root_id,
             (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count
      FROM notes n
      JOIN note_tags nt ON nt.note_id = n.id AND nt.tag_id IN (${placeholders}) AND nt.status = 'approved'
      JOIN roots r ON r.id = n.id
      WHERE n.user_id = $1
      ${starredOnly ? 'AND n.starred = true' : ''}
      GROUP BY n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor, r.root_id
      ${havingClause}
      ORDER BY n.last_activity_at DESC
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
      SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor,
             r.root_id,
             (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count
      FROM notes n
      JOIN roots r ON r.id = n.id
      WHERE n.user_id = $1 AND n.content ILIKE $2 ESCAPE '\\'
      ORDER BY n.last_activity_at DESC
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
      SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor,
             1 - (n.embedding <=> $1::vector) AS similarity, r.root_id,
             (SELECT COUNT(*)::int FROM notes c WHERE c.parent_id = n.id) AS reply_count
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
    res.json(notes);
  } catch (err) {
    console.error('search-semantic:', err);
    res.status(500).json({
      error: err.message ? `Failed to search: ${err.message}` : 'Failed to search',
      code: 'SEARCH_ERROR',
    });
  }
});

// Get tags for a note (approved only)
router.get('/:id/tags', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT t.id, t.name FROM tags t
       JOIN note_tags nt ON nt.tag_id = t.id AND nt.note_id = $1 AND nt.status = 'approved'
       JOIN notes n ON n.id = nt.note_id AND n.user_id = $2
       ORDER BY t.name`,
      [req.params.id, req.userId]
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
    const r = await pool.query(
      `DELETE FROM note_tags nt USING notes n
       WHERE nt.note_id = n.id AND n.user_id = $1 AND nt.note_id = $2 AND nt.tag_id = $3
       RETURNING nt.id`,
      [req.userId, req.params.id, req.params.tagId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Note or tag link not found' });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to remove tag from note' });
  }
});

/** Queue AI tag proposals for notes with no approved tags (non-empty body). Processes up to `limit` per call in the background. */
router.post('/resubmit-tagless', async (req, res) => {
  try {
    const userId = req.userId;
    const limit = Math.min(300, Math.max(1, parseInt(req.body?.limit ?? req.query?.limit ?? '150', 10) || 150));
    const countR = await pool.query(
      `SELECT COUNT(*)::int AS c FROM notes n
       WHERE n.user_id = $1
       AND TRIM(COALESCE(n.content, '')) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.status = 'approved'
       )`,
      [userId]
    );
    const totalTagless = countR.rows[0].c;
    const r = await pool.query(
      `SELECT n.id, n.content FROM notes n
       WHERE n.user_id = $1
       AND TRIM(COALESCE(n.content, '')) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.status = 'approved'
       )
       ORDER BY n.last_activity_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    const rows = r.rows;
    res.json({
      queued: rows.length,
      totalTagless,
      hasMore: totalTagless > rows.length,
    });
    setImmediate(() => {
      (async () => {
        for (const row of rows) {
          try {
            await proposeTagsForNote(row.id, row.content, userId);
          } catch (e) {
            console.error('resubmit-tagless', row.id, e);
          }
        }
      })();
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to queue tag suggestions' });
  }
});

// Get single note (with tags)
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, parent_id, content, created_at, updated_at, last_activity_at, starred, external_anchor FROM notes WHERE id = $1 AND user_id = $2',
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
    const { content, parent_id: parentId, external_anchor: externalAnchor } = req.body;
    const userId = req.userId;
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'Content must be a string' });
    }
    const text = content.trim();
    const r = await pool.query(
      `INSERT INTO notes (parent_id, content, external_anchor, user_id) VALUES ($1, $2, $3, $4)
       RETURNING id, parent_id, content, created_at, updated_at, last_activity_at, starred, external_anchor`,
      [parentId || null, text, externalAnchor || null, userId]
    );
    const note = r.rows[0];
    embedNote(note.id, note.content).catch(() => {});
    proposeTagsForNote(note.id, note.content, userId).catch(() => {});
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
    const { content, starred, external_anchor: externalAnchor } = req.body;
    const userId = req.userId;
    const updates = [];
    const values = [];
    let i = 1;
    if (content !== undefined) { updates.push(`content = $${i++}`); values.push(content); }
    if (starred !== undefined) { updates.push(`starred = $${i++}`); values.push(!!starred); }
    if (externalAnchor !== undefined) { updates.push(`external_anchor = $${i++}`); values.push(externalAnchor); }
    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    values.push(id, userId);
    const r = await pool.query(
      `UPDATE notes SET ${updates.join(', ')} WHERE id = $${i++} AND user_id = $${i} RETURNING id, parent_id, content, created_at, updated_at, last_activity_at, starred, external_anchor`,
      values
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    const note = r.rows[0];
    if (content !== undefined) {
      embedNote(note.id, note.content).catch(() => {});
      proposeTagsForNote(note.id, note.content, req.userId).catch(() => {});
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
