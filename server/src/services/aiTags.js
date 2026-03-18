import pool from '../db/pool.js';
import { generate } from './ollama.js';

export async function proposeTagsForNote(noteId, content, userId) {
  if (!content || !content.trim()) return;
  // Only tags already approved on this user's notes — not orphans or queue-only pending
  const tagRows = await pool.query(
    `SELECT DISTINCT t.id, t.name
     FROM tags t
     INNER JOIN note_tags nt ON nt.tag_id = t.id AND nt.status = 'approved'
     INNER JOIN notes n ON n.id = nt.note_id AND n.user_id = $1
     ORDER BY t.name`,
    [userId]
  );
  const tagNames = tagRows.rows.map((r) => r.name);
  const tagList = tagNames.length
    ? tagNames.join(', ')
    : '(no tags currently in use on your notes; suggest 1-3 new single-word or hyphenated tags)';

  const prompt = `You are a tag suggester for short notes. Given the note text and the existing tag vocabulary, suggest 1-5 tags that best describe the note. Use ONLY tags from the existing list when they fit; otherwise suggest new tags (lowercase, hyphenated). Reply with a JSON array of objects: [{"tag":"tag-name","confidence":0.0-1.0}, ...]. No other text.

Existing tags: ${tagList}

Note text:
${content.trim().slice(0, 2000)}

Reply with only the JSON array:`;

  const raw = await generate(prompt);
  if (!raw) return;

  let items;
  try {
    const json = raw.replace(/[\s\S]*?(\[[\s\S]*\])\s*$/, '$1');
    items = JSON.parse(json);
    if (!Array.isArray(items)) return;
  } catch {
    return;
  }

  for (const it of items) {
    const name = (it.tag || it.name || '').toString().trim().toLowerCase().replace(/\s+/g, '-');
    if (!name) continue;
    const confidence = Math.min(1, Math.max(0, Number(it.confidence) ?? 0.5));

    let tagId;
    const existing = await pool.query('SELECT id FROM tags WHERE name = $1', [name]);
    if (existing.rows.length > 0) {
      tagId = existing.rows[0].id;
    } else {
      const ins = await pool.query('INSERT INTO tags (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id', [name]);
      if (ins.rows.length === 0) {
        const again = await pool.query('SELECT id FROM tags WHERE name = $1', [name]);
        tagId = again.rows[0]?.id;
      } else {
        tagId = ins.rows[0].id;
      }
    }
    if (!tagId) continue;

    await pool.query(
      `INSERT INTO note_tags (note_id, tag_id, source, confidence, status)
       VALUES ($1, $2, 'ai', $3, 'pending')
       ON CONFLICT (note_id, tag_id) DO UPDATE SET source = 'ai', confidence = $3, status = 'pending'`,
      [noteId, tagId, confidence]
    );
  }
}
