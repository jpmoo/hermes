import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { onTagApproved } from '../services/queue.js';

const router = Router();
router.use(requireAuth);

/** Pending count (for badge) — must be before GET / */
router.get('/count', async (req, res) => {
  try {
    const minConfidence = req.query.minConfidence != null ? parseFloat(req.query.minConfidence) : 0;
    const r = await pool.query(
      `SELECT COUNT(*)::int AS c FROM note_tags nt
       JOIN notes n ON n.id = nt.note_id AND n.user_id = $1
       WHERE nt.status = 'pending' AND nt.source IN ('ai', 'complement')
         AND (nt.confidence IS NULL OR nt.confidence >= $2)`,
      [req.userId, minConfidence]
    );
    res.json({ count: r.rows[0].c });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to get count' });
  }
});

/** List pending tag proposals for the user's notes, optional min confidence 0–1 */
router.get('/', async (req, res) => {
  try {
    const minConfidence = req.query.minConfidence != null ? parseFloat(req.query.minConfidence) : 0;
    const userId = req.userId;
    const r = await pool.query(
      `SELECT nt.id, nt.note_id, nt.tag_id, nt.confidence, nt.created_at,
              t.name AS tag_name,
              n.content AS note_content, n.parent_id,
              p.content AS parent_content
       FROM note_tags nt
       JOIN tags t ON t.id = nt.tag_id
       JOIN notes n ON n.id = nt.note_id AND n.user_id = $1
       LEFT JOIN notes p ON p.id = n.parent_id
       WHERE nt.status = 'pending' AND nt.source IN ('ai', 'complement')
         AND (nt.confidence IS NULL OR nt.confidence >= $2)
       ORDER BY nt.confidence DESC NULLS LAST, nt.created_at DESC`,
      [userId, minConfidence]
    );

    const threadAncestry = async (noteId) => {
      const anc = [];
      let pid = noteId;
      for (let i = 0; i < 10 && pid; i++) {
        const row = await pool.query(
          'SELECT id, parent_id, content FROM notes WHERE id = $1 AND user_id = $2',
          [pid, userId]
        );
        if (row.rows.length === 0) break;
        anc.push({ id: row.rows[0].id, content: row.rows[0].content?.slice(0, 80) });
        pid = row.rows[0].parent_id;
      }
      return anc.reverse();
    };

    const items = await Promise.all(
      r.rows.map(async (row) => ({
        id: row.id,
        note_id: row.note_id,
        tag_id: row.tag_id,
        tag_name: row.tag_name,
        confidence: row.confidence,
        created_at: row.created_at,
        note_content: row.note_content,
        ancestry: await threadAncestry(row.note_id),
      }))
    );

    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch queue' });
  }
});

/** Approve a pending proposal; cascades inheritance and enqueues complements */
router.post('/:id/approve', async (req, res) => {
  try {
    const id = req.params.id;
    const userId = req.userId;
    const r = await pool.query(
      `SELECT nt.note_id, nt.tag_id, nt.confidence FROM note_tags nt
       JOIN notes n ON n.id = nt.note_id AND n.user_id = $1
       WHERE nt.id = $2 AND nt.status = 'pending'`,
      [userId, id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Proposal not found' });
    const { note_id: noteId, tag_id: tagId, confidence } = r.rows[0];

    await pool.query(
      `UPDATE note_tags SET status = 'approved', source = CASE WHEN source = 'complement' THEN 'complement' ELSE 'ai' END WHERE id = $1`,
      [id]
    );

    await onTagApproved(noteId, tagId, confidence ?? 0.5);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to approve' });
  }
});

/** Reject a pending proposal */
router.post('/:id/reject', async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE note_tags nt SET status = 'rejected'
       FROM notes n WHERE n.id = nt.note_id AND n.user_id = $1 AND nt.id = $2 AND nt.status = 'pending'
       RETURNING nt.id`,
      [req.userId, req.params.id]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Proposal not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reject' });
  }
});

export default router;
