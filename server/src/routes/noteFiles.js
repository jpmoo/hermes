import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

/** GET binary file (use Authorization header; front-end may use blob URLs) */
router.get('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT f.data, f.mime_type, f.filename
       FROM note_file_blobs f
       JOIN notes n ON n.id = f.note_id AND n.user_id = $2
       WHERE f.id = $1 AND f.user_id = $2`,
      [req.params.id, req.userId]
    );
    if (r.rows.length === 0) return res.status(404).end();
    const row = r.rows[0];
    const safeName = (row.filename || 'file').replace(/[^\w.\-()+ ]/g, '_');
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(row.data);
  } catch (err) {
    console.error(err);
    res.status(500).end();
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM note_file_blobs f USING notes n
       WHERE f.id = $1 AND f.note_id = n.id AND n.user_id = $2 AND f.user_id = $2
       RETURNING f.id`,
      [req.params.id, req.userId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete' });
  }
});

export default router;
