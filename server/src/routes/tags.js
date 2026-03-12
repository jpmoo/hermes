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
    const r = await pool.query('DELETE FROM tags WHERE id = $1 RETURNING id', [req.params.id]);
    if (r.rows.length === 0) return res.status(404).json({ error: 'Tag not found' });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete tag' });
  }
});

export default router;
