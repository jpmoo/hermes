import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { REL_BOTH_TAGS_USER_SCOPED, tagsBelongToUser } from '../services/tagAccess.js';

const router = Router();
router.use(requireAuth);

// List tags: only those with ≥1 approved link to this user's notes (never expose other users' / unused vocabulary)
router.get('/', async (req, res) => {
  try {
    const userId = req.userId;
    const r = await pool.query(
      `SELECT DISTINCT t.id, t.name, t.created_at
       FROM tags t
       INNER JOIN note_tags nt ON nt.tag_id = t.id AND nt.status = 'approved'
       INNER JOIN notes n ON n.id = nt.note_id AND n.user_id = $1
       ORDER BY t.name`,
      [userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch tags' });
  }
});

// Create tag
router.post('/', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Tag name required' });
    }
    const n = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!n) return res.status(400).json({ error: 'Tag name required' });
    const r = await pool.query(
      'INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id, name, created_at',
      [n]
    );
    if (r.rows.length === 0) {
      const existing = await pool.query('SELECT id, name, created_at FROM tags WHERE name = $1', [n]);
      return res.status(200).json(existing.rows[0]);
    }
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create tag' });
  }
});

// Remove tag from all of this user's notes; drop global tag row only if no one else still uses it
router.delete('/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const tagId = req.params.id;
    const del = await pool.query(
      `DELETE FROM note_tags nt USING notes n
       WHERE nt.note_id = n.id AND n.user_id = $1 AND nt.tag_id = $2
       RETURNING nt.id`,
      [userId, tagId]
    );
    if (del.rows.length === 0) {
      return res.status(404).json({ error: 'Tag not found on your notes' });
    }
    const remaining = await pool.query('SELECT 1 FROM note_tags WHERE tag_id = $1 LIMIT 1', [tagId]);
    if (remaining.rows.length === 0) {
      await pool.query('DELETE FROM tag_relationships WHERE tag_a_id = $1 OR tag_b_id = $1', [tagId]);
      await pool.query('DELETE FROM tags WHERE id = $1', [tagId]);
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete tag' });
  }
});

// List relationships: only pairs where both tags have approved use on your notes
router.get('/relationships', async (req, res) => {
  try {
    const userId = req.userId;
    const tagId = req.query.tagId;
    const base = `
      SELECT tr.id, tr.tag_a_id, tr.tag_b_id, tr.relationship_type,
             a.name AS tag_a_name, b.name AS tag_b_name
      FROM tag_relationships tr
      JOIN tags a ON a.id = tr.tag_a_id
      JOIN tags b ON b.id = tr.tag_b_id
      WHERE ${REL_BOTH_TAGS_USER_SCOPED}`;
    let r;
    if (tagId) {
      r = await pool.query(
        `${base} AND (tr.tag_a_id = $2::uuid OR tr.tag_b_id = $2::uuid)
         ORDER BY a.name, b.name`,
        [userId, tagId]
      );
    } else {
      r = await pool.query(`${base} ORDER BY a.name, b.name`, [userId]);
    }
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch relationships' });
  }
});

// Create relationship (exclusion | complement)
router.post('/relationships', async (req, res) => {
  try {
    const userId = req.userId;
    const { tag_a_id: tagAId, tag_b_id: tagBId, relationship_type: type } = req.body;
    if (!tagAId || !tagBId || !type || !['exclusion', 'complement'].includes(type)) {
      return res.status(400).json({ error: 'tag_a_id, tag_b_id, relationship_type (exclusion|complement) required' });
    }
    if (tagAId === tagBId) return res.status(400).json({ error: 'Tags must differ' });
    if (!(await tagsBelongToUser([tagAId, tagBId], userId))) {
      return res.status(400).json({ error: 'Both tags must be in use on your notes' });
    }
    const r = await pool.query(
      `INSERT INTO tag_relationships (tag_a_id, tag_b_id, relationship_type) VALUES ($1, $2, $3)
       ON CONFLICT (tag_a_id, tag_b_id) DO UPDATE SET relationship_type = $3
       RETURNING id, tag_a_id, tag_b_id, relationship_type`,
      [tagAId, tagBId, type]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create relationship' });
  }
});

// Delete relationship (only if both tags are in your vocabulary)
router.delete('/relationships/:id', async (req, res) => {
  try {
    const userId = req.userId;
    const rel = await pool.query(
      'SELECT tag_a_id, tag_b_id FROM tag_relationships WHERE id = $1',
      [req.params.id]
    );
    if (rel.rows.length === 0) return res.status(404).json({ error: 'Relationship not found' });
    const { tag_a_id: a, tag_b_id: b } = rel.rows[0];
    if (!(await tagsBelongToUser([a, b], userId))) {
      return res.status(404).json({ error: 'Relationship not found' });
    }
    const r = await pool.query('DELETE FROM tag_relationships WHERE id = $1 RETURNING id', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Relationship not found' });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete relationship' });
  }
});

export default router;
