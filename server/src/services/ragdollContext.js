import pool from '../db/pool.js';
import { loadPersistedLinksMetadata } from './hoverInsight.js';

const MAX_CONTEXT_CHARS = 12000;
const CHILD_SIBLING_LIMIT = 40;

/**
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

  const parts = [];
  parts.push('## Selected note\n');
  parts.push((noteContent || '').trim() || '(empty)');

  if (includeConnected) {
    const { persistedLinks } = await loadPersistedLinksMetadata(noteId, userId);
    const texts = (persistedLinks || [])
      .map((p) => (p.content != null ? String(p.content).trim() : ''))
      .filter(Boolean);
    if (texts.length > 0) {
      parts.push('\n\n## Connected notes (linked)\n');
      parts.push(texts.join('\n---\n'));
    }
  }

  if (includeParent && parentId) {
    const pr = await pool.query(`SELECT content FROM notes WHERE id = $1 AND user_id = $2`, [parentId, userId]);
    const pc = pr.rows[0]?.content?.trim();
    if (pc) {
      parts.push('\n\n## Parent note\n');
      parts.push(pc);
    }
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
    const sibTexts = siblingsR.rows.map((r) => r.content?.trim()).filter(Boolean);
    if (sibTexts.length > 0) {
      parts.push('\n\n## Sibling notes (same parent)\n');
      parts.push(sibTexts.join('\n---\n'));
    }
  }

  if (includeChildren) {
    const kidsR = await pool.query(
      `SELECT id, content FROM notes WHERE parent_id = $1 AND user_id = $2 ORDER BY created_at ASC LIMIT ${CHILD_SIBLING_LIMIT}`,
      [noteId, userId]
    );
    const kidTexts = kidsR.rows.map((r) => r.content?.trim()).filter(Boolean);
    if (kidTexts.length > 0) {
      parts.push('\n\n## Direct replies (children)\n');
      parts.push(kidTexts.join('\n---\n'));
    }
  }

  let text = parts.join('');
  if (text.length > MAX_CONTEXT_CHARS) {
    text = `${text.slice(0, MAX_CONTEXT_CHARS)}\n\n[… context truncated …]`;
  }
  return text;
}
