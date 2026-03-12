import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

// List all tags (for typeahead / add-tag UI)
router.get('/', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name, created_at FROM tags ORDER BY name');
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

// Delete tag (removes from all notes)
router.delete('/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM note_tags WHERE tag_id = $1', [req.params.id]);
    await pool.query('DELETE FROM tag_relationships WHERE tag_a_id = $1 OR tag_b_id = $1', [req.params.id, req.params.id]);
    const r = await pool.query('DELETE FROM tags WHERE id = $1 RETURNING id', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Tag not found' });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete tag' });
  }
});

// List relationships for a tag or all
router.get('/relationships', async (req, res) => {
  try {
    const tagId = req.query.tagId;
    let r;
    if (tagId) {
      r = await pool.query(
        `SELECT tr.id, tr.tag_a_id, tr.tag_b_id, tr.relationship_type,
                a.name AS tag_a_name, b.name AS tag_b_name
         FROM tag_relationships tr
         JOIN tags a ON a.id = tr.tag_a_id
         JOIN tags b ON b.id = tr.tag_b_id
         WHERE tr.tag_a_id = $1 OR tr.tag_b_id = $1`,
        [tagId]
      );
    } else {
      r = await pool.query(
        `SELECT tr.id, tr.tag_a_id, tr.tag_b_id, tr.relationship_type,
                a.name AS tag_a_name, b.name AS tag_b_name
         FROM tag_relationships tr
         JOIN tags a ON a.id = tr.tag_a_id
         JOIN tags b ON b.id = tr.tag_b_id
         ORDER BY a.name, b.name`
      );
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
    const { tag_a_id: tagAId, tag_b_id: tagBId, relationship_type: type } = req.body;
    if (!tagAId || !tagBId || !type || !['exclusion', 'complement'].includes(type)) {
      return res.status(400).json({ error: 'tag_a_id, tag_b_id, relationship_type (exclusion|complement) required' });
    }
    if (tagAId === tagBId) return res.status(400).json({ error: 'Tags must differ' });
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

// Delete relationship
router.delete('/relationships/:id', async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM tag_relationships WHERE id = $1 RETURNING id', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Relationship not found' });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete relationship' });
  }
});

export default router;
