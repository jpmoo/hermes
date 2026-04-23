import pool from '../db/pool.js';
import { loadPersistedLinksMetadata } from './hoverInsight.js';

const MAX_CONTEXT_CHARS = 12000;
const CHILD_SIBLING_LIMIT = 40;

/**
 * Plain note bodies only (trimmed), joined with blank lines — no headings, markers, or placeholders.
 * @param {object} opts
 * @param {boolean} [opts.includeParent]
 * @param {boolean} [opts.includeSiblings]
 * @param {boolean} [opts.includeChildren]
 * @param {boolean} [opts.includeConnected]
 */
export async function buildRagdollThreadContextText(noteId, userId, opts = {}) {
  const includeParent = opts.includeParent === true;
  const includeSiblings = opts.includeSiblings === true;
  const includeChildren = opts.includeChildren === true;
  const includeConnected = opts.includeConnected !== false;

  const noteR = await pool.query(
    `SELECT id, parent_id, content FROM notes WHERE id = $1 AND user_id = $2`,
    [noteId, userId]
  );
  if (noteR.rows.length === 0) return null;
  const { parent_id: parentId, content: noteContent } = noteR.rows[0];

  /** Plain trimmed bodies only (no headings/separators) — order matches prior sections. */
  const bodies = [];
  const main = (noteContent || '').trim();
  if (main) bodies.push(main);

  if (includeConnected) {
    const { persistedLinks } = await loadPersistedLinksMetadata(noteId, userId);
    for (const p of persistedLinks || []) {
      const t = p.content != null ? String(p.content).trim() : '';
      if (t) bodies.push(t);
    }
  }

  if (includeParent && parentId) {
    const pr = await pool.query(`SELECT content FROM notes WHERE id = $1 AND user_id = $2`, [parentId, userId]);
    const pc = (pr.rows[0]?.content || '').trim();
    if (pc) bodies.push(pc);
  }

  if (includeSiblings) {
    const siblingsR = await pool.query(
      `SELECT id, content FROM notes
       WHERE user_id = $1 AND id <> $2::uuid
         AND (
           (parent_id = $3 AND $3 IS NOT NULL)
           OR (parent_id IS NULL AND $3 IS NULL)
         )
       ORDER BY created_at ASC
       LIMIT ${CHILD_SIBLING_LIMIT}`,
      [userId, noteId, parentId]
    );
    for (const row of siblingsR.rows) {
      const t = (row.content || '').trim();
      if (t) bodies.push(t);
    }
  }

  if (includeChildren) {
    const kidsR = await pool.query(
      `SELECT id, content FROM notes WHERE parent_id = $1 AND user_id = $2 ORDER BY created_at ASC LIMIT ${CHILD_SIBLING_LIMIT}`,
      [noteId, userId]
    );
    for (const row of kidsR.rows) {
      const t = (row.content || '').trim();
      if (t) bodies.push(t);
    }
  }

  let text = bodies.join('\n\n');
  if (text.length > MAX_CONTEXT_CHARS) {
    text = text.slice(0, MAX_CONTEXT_CHARS);
  }
  return text;
}
