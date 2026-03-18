import pool from '../db/pool.js';

/** On approve: enqueue complement tags on the same note only (no cascade to descendants — use “Inherit parent tags” in the UI). */
export async function onTagApproved(noteId, tagId, confidence = 0.5) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

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
