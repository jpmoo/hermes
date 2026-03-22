import pool from '../db/pool.js';
import { generate } from './ollama.js';

const SIM_THRESHOLD = 0.65;
const VECTOR_CANDIDATES = 30;

function normalizeTagName(s) {
  return (s || '').toString().trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Tag suggestions + similar notes for hover UI (non-root notes).
 * Order: Ollama (vocab + up to 4 new), then tags from top similar notes (>0.65) not on note.
 */
export async function getHoverInsight(noteId, userId) {
  const noteR = await pool.query(
    `SELECT id, parent_id, content, embedding::text AS emb_text
     FROM notes WHERE id = $1 AND user_id = $2`,
    [noteId, userId]
  );
  if (noteR.rows.length === 0) return null;
  const { id, parent_id: parentId, content, emb_text: embText } = noteR.rows[0];

  const kidsR = await pool.query(
    `SELECT content FROM notes WHERE parent_id = $1 AND user_id = $2 ORDER BY created_at ASC`,
    [noteId, userId]
  );
  const childrenBlock = kidsR.rows
    .map((r) => r.content?.trim())
    .filter(Boolean)
    .join('\n---\n');

  const activeTagRows = await pool.query(
    `SELECT DISTINCT t.id, t.name
     FROM tags t
     INNER JOIN note_tags nt ON nt.tag_id = t.id AND nt.status = 'approved'
     INNER JOIN notes n ON n.id = nt.note_id AND n.user_id = $1
     ORDER BY t.name`,
    [userId]
  );
  const activeByName = new Map(activeTagRows.rows.map((t) => [t.name.toLowerCase(), t]));

  const onNoteR = await pool.query(
    `SELECT t.id, t.name FROM tags t
     JOIN note_tags nt ON nt.tag_id = t.id AND nt.note_id = $1 AND nt.status = 'approved'`,
    [noteId]
  );
  const onNoteNames = new Set(onNoteR.rows.map((t) => t.name.toLowerCase()));
  const onNoteIds = new Set(onNoteR.rows.map((t) => t.id));

  const tagList =
    activeTagRows.rows.map((t) => t.name).join(', ') || '(no tags in use yet — you may suggest up to 4 new hyphenated tags)';

  const body = [content?.trim(), childrenBlock ? `--- direct replies ---\n${childrenBlock}` : '']
    .filter(Boolean)
    .join('\n\n');

  const ollamaParsed = [];
  if (body.trim()) {
    const prompt = `You tag notes in Hermes. Use ACTIVE TAGS when they fit; otherwise suggest at most 4 NEW tags (lowercase, hyphenated).

Return ONLY a JSON array: [{"tag":"name","from_vocab":true|false}, ...] with 1–12 items. from_vocab is true only if the tag appears in ACTIVE TAGS.

ACTIVE TAGS: ${tagList}

NOTE (and direct replies section if present):
${body.slice(0, 3500)}

JSON array only, no markdown:`;
    const raw = await generate(prompt, { num_predict: 450, temperature: 0.25 });
    if (raw) {
      try {
        const json = raw.replace(/[\s\S]*?(\[[\s\S]*\])\s*$/, '$1');
        const items = JSON.parse(json);
        if (Array.isArray(items)) {
          let newCount = 0;
          for (const it of items) {
            const name = normalizeTagName(it.tag || it.name);
            if (!name) continue;
            const fromVocab = !!it.from_vocab;
            if (!fromVocab) {
              newCount += 1;
              if (newCount > 4) continue;
            }
            ollamaParsed.push({ name, from_vocab: fromVocab });
          }
        }
      } catch {
        /* ignore parse errors */
      }
    }
  }

  const seenNames = new Set(onNoteNames);
  const ollamaTags = [];
  for (const t of ollamaParsed) {
    if (seenNames.has(t.name)) continue;
    seenNames.add(t.name);
    const known = activeByName.get(t.name);
    ollamaTags.push({
      key: `o-${t.name}`,
      name: t.name,
      tagId: known?.id ?? null,
      source: 'ollama',
    });
  }

  let similarRows = [];
  if (embText) {
    const simR = await pool.query(
      `SELECT n.id, n.parent_id, n.content,
              1 - (n.embedding <=> $1::vector) AS similarity
       FROM notes n
       WHERE n.user_id = $2 AND n.id <> $3::uuid AND n.embedding IS NOT NULL
       ORDER BY n.embedding <=> $1::vector
       LIMIT $4`,
      [embText, userId, id, VECTOR_CANDIDATES]
    );
    similarRows = simR.rows.filter((r) => Number(r.similarity) > SIM_THRESHOLD).slice(0, 10);
  }

  const similarIds = similarRows.map((r) => r.id);
  const embeddingTags = [];
  if (similarIds.length) {
    const tr = await pool.query(
      `SELECT DISTINCT t.id, t.name
       FROM note_tags nt
       JOIN tags t ON t.id = nt.tag_id
       WHERE nt.note_id = ANY($1) AND nt.status = 'approved'`,
      [similarIds]
    );
    for (const row of tr.rows) {
      const ln = row.name.toLowerCase();
      if (onNoteIds.has(row.id) || seenNames.has(ln)) continue;
      seenNames.add(ln);
      embeddingTags.push({
        key: `s-${row.id}`,
        name: row.name,
        tagId: row.id,
        source: 'similar',
      });
    }
  }

  const pid = parentId ?? null;
  const similarNotes = similarRows
    .filter((r) => {
      const rp = r.parent_id ?? null;
      return rp !== pid;
    })
    .map((r) => ({
      id: r.id,
      content: r.content,
      similarity: Number(r.similarity),
      parent_id: r.parent_id,
    }));

  const tagSuggestions = [...ollamaTags, ...embeddingTags];

  const pl = await pool.query(
    `SELECT nc.id AS connection_id, nb.id, nb.content, nb.parent_id
     FROM note_connections nc
     JOIN notes nb ON nb.id = nc.linked_note_id AND nb.user_id = $1
     JOIN notes na ON na.id = nc.anchor_note_id AND na.user_id = $1
     WHERE nc.user_id = $1 AND nc.anchor_note_id = $2
     ORDER BY nc.created_at DESC`,
    [userId, id]
  );
  const persistedLinkIds = new Set(pl.rows.map((r) => r.id));
  const persistedLinks = pl.rows.map((r) => ({
    connectionId: r.connection_id,
    id: r.id,
    content: r.content,
    parent_id: r.parent_id,
    persisted: true,
  }));

  const similarNotesFiltered = similarNotes.filter((s) => !persistedLinkIds.has(s.id));

  return {
    tagSuggestions,
    similarNotes: similarNotesFiltered,
    persistedLinks,
  };
}
