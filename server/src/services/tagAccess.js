import pool from '../db/pool.js';

/**
 * A tag is visible / "belongs" to a user iff it has ≥1 approved note_tags row on that user's notes.
 */

/** @param {string[]} tagIds */
export async function tagsBelongToUser(tagIds, userId) {
  const unique = [...new Set((tagIds || []).filter(Boolean))];
  if (unique.length === 0) return true;
  const r = await pool.query(
    `SELECT COUNT(DISTINCT t.id)::int AS c
     FROM tags t
     INNER JOIN note_tags nt ON nt.tag_id = t.id AND nt.status = 'approved'
     INNER JOIN notes n ON n.id = nt.note_id AND n.user_id = $2
     WHERE t.id = ANY($1::uuid[])`,
    [unique, userId]
  );
  return r.rows[0].c === unique.length;
}

/**
 * For POST .../tags with body.tag_id only: allow if the tag is already on your notes, or it exists but
 * has no approved links yet (e.g. just created via POST /api/tags). Blocks attaching arbitrary IDs for
 * tags that are only approved on someone else's notes.
 */
export async function canAttachTagIdByReference(tagId, userId) {
  if (await tagsBelongToUser([tagId], userId)) return true;
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM note_tags WHERE tag_id = $1 AND status = 'approved'`,
    [tagId]
  );
  return r.rows[0].c === 0;
}

/** SQL fragment: both tag endpoints of a relationship are in the user's approved vocabulary. */
export const REL_BOTH_TAGS_USER_SCOPED = `
  EXISTS (
    SELECT 1 FROM note_tags nt
    INNER JOIN notes n ON n.id = nt.note_id AND n.user_id = $1
    WHERE nt.tag_id = tr.tag_a_id AND nt.status = 'approved'
  )
  AND EXISTS (
    SELECT 1 FROM note_tags nt
    INNER JOIN notes n ON n.id = nt.note_id AND n.user_id = $1
    WHERE nt.tag_id = tr.tag_b_id AND nt.status = 'approved'
  )
`;
