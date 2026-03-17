import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { embedNote } from '../services/embedding.js';
import { proposeTagsForNote } from '../services/aiTags.js';

const router = Router();
router.use(requireAuth);

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
    res.json(notes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch thread' });
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
    res.json(notes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to search by tags' });
  }
});

// Semantic search: embed query, similarity search
router.get('/search-semantic', async (req, res) => {
  try {
    const q = req.query.q?.trim();
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const userId = req.userId;
    if (!q) return res.json([]);
    const { embed } = await import('../services/ollama.js');
    const vec = await embed(q);
    if (!vec) return res.json([]);
    const vecStr = `[${vec.join(',')}]`;
    const r = await pool.query(
      `WITH roots AS (
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
      [vecStr, userId, limit]
    );
    const notes = r.rows.map((row) => {
      const { similarity, root_id, ...note } = row;
      return { ...note, similarity, root_id };
    });
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
    res.json(notes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to search' });
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
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Content required' });
    }
    const r = await pool.query(
      `INSERT INTO notes (parent_id, content, external_anchor, user_id) VALUES ($1, $2, $3, $4)
       RETURNING id, parent_id, content, created_at, updated_at, last_activity_at, starred, external_anchor`,
      [parentId || null, content.trim(), externalAnchor || null, userId]
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
