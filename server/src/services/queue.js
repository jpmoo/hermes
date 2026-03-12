import pool from '../db/pool.js';

/** Cascade approved tag to all descendants as inherited; clear matching pending on descendants. Optionally enqueue complements. */
export async function onTagApproved(noteId, tagId, confidence = 0.5) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const note = await client.query('SELECT id, parent_id FROM notes WHERE id = $1', [noteId]);
    if (note.rows.length === 0) throw new Error('Note not found');

    const descendants = await client.query(
      `WITH RECURSIVE tree AS (
        SELECT id FROM notes WHERE parent_id = $1
        UNION ALL
        SELECT n.id FROM notes n JOIN tree t ON n.parent_id = t.id
      ) SELECT id FROM tree`,
      [noteId]
    );

    for (const d of descendants.rows) {
      await client.query(
        `INSERT INTO note_tags (note_id, tag_id, source, status) VALUES ($1, $2, 'inherited', 'approved')
         ON CONFLICT (note_id, tag_id) DO UPDATE SET source = 'inherited', status = 'approved'`,
        [d.id, tagId]
      );
      await client.query(
        `UPDATE note_tags SET status = 'approved', source = 'inherited' WHERE note_id = $1 AND tag_id = $2 AND status = 'pending'`,
        [d.id, tagId]
      );
    }

    const complements = await client.query(
      `SELECT tag_b_id FROM tag_relationships WHERE tag_a_id = $1 AND relationship_type = 'complement'
       UNION
       SELECT tag_a_id FROM tag_relationships WHERE tag_b_id = $1 AND relationship_type = 'complement'`,
      [tagId]
    );

    for (const c of complements.rows) {
      const compTagId = c.tag_a_id ?? c.tag_b_id;
      await client.query(
        `INSERT INTO note_tags (note_id, tag_id, source, confidence, status) VALUES ($1, $2, 'complement', $3, 'pending')
         ON CONFLICT (note_id, tag_id) DO UPDATE SET source = 'complement', confidence = $3, status = 'pending'`,
        [noteId, compTagId, confidence]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
