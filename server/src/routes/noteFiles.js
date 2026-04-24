import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

/** Blobs whose note_id no longer exists (integrity / legacy data). */
router.get('/orphans', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT f.id, f.note_id, f.filename, f.mime_type, f.byte_size, f.created_at
       FROM note_file_blobs f
       WHERE f.user_id = $1
         AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = f.note_id)
       ORDER BY f.created_at DESC`,
      [req.userId]
    );
    res.json(
      r.rows.map((row) => ({
        id: row.id,
        note_id: row.note_id,
        filename: row.filename,
        mime_type: row.mime_type,
        byte_size: Number(row.byte_size),
        created_at: row.created_at,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list orphans' });
  }
});

/** Move a stored blob to another note (same user owns blob source note and target note). */
router.patch('/:id/assign-note', async (req, res) => {
  const blobId = req.params.id;
  const noteId = req.body?.note_id;
  if (noteId == null || String(noteId).trim() === '') {
    return res.status(400).json({ error: 'note_id required' });
  }
  try {
    const r = await pool.query(
      `UPDATE note_file_blobs f SET note_id = $1::uuid
       FROM notes src, notes dst
       WHERE f.id = $2::uuid AND f.user_id = $3
         AND src.id = f.note_id AND src.user_id = $3
         AND dst.id = $1::uuid AND dst.user_id = $3
       RETURNING f.id`,
      [String(noteId).trim(), blobId, req.userId]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ error: 'Attachment or target note not found' });
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reassign attachment' });
  }
});

/** Delete one orphan blob (normal DELETE /:id requires a live note). */
router.delete('/orphans/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `DELETE FROM note_file_blobs f
       WHERE f.id = $1 AND f.user_id = $2
         AND NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = f.note_id)
       RETURNING f.id`,
      [req.params.id, req.userId]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ error: 'Not an orphan or not found' });
    }
    res.status(204).send();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete' });
  }
});

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
