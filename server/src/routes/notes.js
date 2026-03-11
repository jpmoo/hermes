import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

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
        SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor
        FROM notes n
        WHERE n.parent_id IS NULL AND n.user_id = $1 AND n.id IN (SELECT root_id FROM starred_roots)
        ORDER BY n.last_activity_at DESC
      `
      : `
        SELECT id, parent_id, content, created_at, updated_at, last_activity_at, starred, external_anchor
        FROM notes
        WHERE parent_id IS NULL AND user_id = $1
        ORDER BY last_activity_at DESC
      `;
    const r = await pool.query(q, [userId]);
    res.json(r.rows);
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
        SELECT id, parent_id, content, created_at, updated_at, last_activity_at, starred, external_anchor, 0 AS depth
        FROM notes WHERE id = $1 AND user_id = $2
        UNION ALL
        SELECT n.id, n.parent_id, n.content, n.created_at, n.updated_at, n.last_activity_at, n.starred, n.external_anchor, t.depth + 1
        FROM notes n JOIN tree t ON n.parent_id = t.id
        WHERE n.user_id = $2
      )
      SELECT * FROM tree
      ${starredOnly ? 'WHERE starred = true' : ''}
      ORDER BY created_at ASC`,
      [id, userId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Thread not found' });
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch thread' });
  }
});

// Get single note
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, parent_id, content, created_at, updated_at, last_activity_at, starred, external_anchor FROM notes WHERE id = $1 AND user_id = $2',
      [req.params.id, req.userId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Note not found' });
    res.json(r.rows[0]);
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
    res.status(201).json(r.rows[0]);
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
    res.json(r.rows[0]);
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
