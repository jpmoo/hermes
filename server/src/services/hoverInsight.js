import pool from '../db/pool.js';
import { generate } from './ollama.js';

/** Nearest neighbors to consider before applying minSimilarity (increase if library is large). */
const VECTOR_CANDIDATES = 120;
const SIM_MIN_BOUND = 0.1;
const SIM_MAX_BOUND = 0.9;
const SIM_MIN_STEP = 0.05;
const SIM_MIN_DEFAULT = 0.5;

/** Clamp + snap client-provided minimum cosine similarity for “similar notes”. */
export function normalizeMinSimilarity(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return SIM_MIN_DEFAULT;
  const snapped = Math.round(n / SIM_MIN_STEP) * SIM_MIN_STEP;
  return Math.min(SIM_MAX_BOUND, Math.max(SIM_MIN_BOUND, snapped));
}

function normalizeTagName(s) {
  return (s || '').toString().trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Tag suggestions + similar notes + persisted links for Stream hover (any note, including thread roots).
 * Order: Ollama (vocab + up to 6 new), then tags from top similar notes (cosine similarity > minSimilarity) not on note.
 * Root notes: no parent block; siblings = other root-level notes; children = direct replies only (no deeper thread).
 * Similar notes: all nearest neighbors above minSimilarity (siblings are not excluded — they were hiding the whole list for replies).
 * Tag harvest from vector-similar notes skips grandchildren+ of the hovered note (immediate children may still appear if similar).
 */
export async function getHoverInsight(noteId, userId, opts = {}) {
  const minSimilarity = normalizeMinSimilarity(opts.minSimilarity ?? SIM_MIN_DEFAULT);
  const noteR = await pool.query(
    `SELECT id, parent_id, content FROM notes WHERE id = $1 AND user_id = $2`,
    [noteId, userId]
  );
  if (noteR.rows.length === 0) return null;
  const { id, parent_id: parentId, content } = noteR.rows[0];

  let parentBlock = '';
  if (parentId) {
    const pr = await pool.query(
      `SELECT content FROM notes WHERE id = $1 AND user_id = $2`,
      [parentId, userId]
    );
    const pc = pr.rows[0]?.content?.trim();
    if (pc) parentBlock = pc;
  }

  /** Direct replies only (one level); not grandchildren or deeper. */
  const kidsR = await pool.query(
    `SELECT content FROM notes WHERE parent_id = $1 AND user_id = $2 ORDER BY created_at ASC LIMIT 40`,
    [noteId, userId]
  );
  const childrenBlock = kidsR.rows
    .map((r) => r.content?.trim())
    .filter(Boolean)
    .join('\n---\n');

  const siblingsR = await pool.query(
    `SELECT content FROM notes
     WHERE user_id = $1 AND id <> $2
       AND (
         (parent_id = $3 AND $3 IS NOT NULL)
         OR (parent_id IS NULL AND $3 IS NULL)
       )
     ORDER BY created_at ASC
     LIMIT 40`,
    [userId, noteId, parentId]
  );
  const siblingsBlock = siblingsR.rows
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
    activeTagRows.rows.map((t) => t.name).join(', ') || '(no tags in use yet — you may suggest up to 6 new hyphenated tags)';

  const contextParts = [
    content?.trim() ? `--- hovered note ---\n${content.trim()}` : '',
    parentBlock ? `--- parent note ---\n${parentBlock}` : '',
    siblingsBlock ? `--- sibling notes (same level in thread) ---\n${siblingsBlock}` : '',
    childrenBlock
      ? `--- direct replies only (immediate children of hovered note, one level — not nested deeper) ---\n${childrenBlock}`
      : '',
  ].filter(Boolean);
  const body = contextParts.join('\n\n');

  const ollamaParsed = [];
  if (body.trim()) {
    const prompt = `You tag notes in Hermes. The HOVERED NOTE is the focus; parent, sibling, and child sections give thread context. Child notes are ONLY immediate replies (one level under the hovered note), not grandchildren or deeper thread. Suggest tags for the hovered note (and context). Use ACTIVE TAGS when they fit; otherwise at most 6 NEW tags (lowercase, hyphenated).

Return ONLY a JSON array: [{"tag":"name","from_vocab":true|false}, ...] with 1–12 items. from_vocab is true only if the tag appears in ACTIVE TAGS.

ACTIVE TAGS: ${tagList}

CONTEXT:
${body.slice(0, 5500)}

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
              if (newCount > 6) continue;
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
      fromVocab: !!t.from_vocab,
    });
  }

  /* Use the hovered row’s embedding in-SQL (avoid vector::text round-trip through node-pg). */
  let similarRows = [];
  const simR = await pool.query(
    `WITH hovered AS (
       SELECT embedding FROM notes WHERE id = $1 AND user_id = $2 AND embedding IS NOT NULL
     )
     SELECT n.id, n.parent_id, n.content,
            1 - (n.embedding <=> hovered.embedding) AS similarity
     FROM notes n
     CROSS JOIN hovered
     WHERE n.user_id = $2 AND n.id <> $1::uuid AND n.embedding IS NOT NULL
     ORDER BY n.embedding <=> hovered.embedding
     LIMIT $3`,
    [id, userId, VECTOR_CANDIDATES]
  );
  similarRows = simR.rows
    .filter((r) => Number(r.similarity) >= minSimilarity)
    .slice(0, 10);

  const similarIds = similarRows.map((r) => r.id);
  /** Grandchildren+ under hovered note: do not use their tags for “similar” tag harvest (only immediate children matter). */
  const deepDescR = await pool.query(
    `WITH RECURSIVE down AS (
       SELECT n.id, 1 AS depth
       FROM notes n
       WHERE n.parent_id = $1::uuid AND n.user_id = $2
       UNION ALL
       SELECT n.id, d.depth + 1
       FROM notes n
       INNER JOIN down d ON n.parent_id = d.id
       WHERE n.user_id = $2
     )
     SELECT id FROM down WHERE depth >= 2`,
    [id, userId]
  );
  const deepDescendantIds = new Set(deepDescR.rows.map((r) => r.id));
  const similarIdsForTagHarvest = similarIds.filter((sid) => !deepDescendantIds.has(sid));

  const embeddingTags = [];
  if (similarIdsForTagHarvest.length) {
    const tr = await pool.query(
      `SELECT DISTINCT t.id, t.name
       FROM note_tags nt
       JOIN tags t ON t.id = nt.tag_id
       WHERE nt.note_id = ANY($1) AND nt.status = 'approved'`,
      [similarIdsForTagHarvest]
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

  const similarNotes = similarRows.map((r) => ({
    id: r.id,
    content: r.content,
    similarity: Number(r.similarity),
    parent_id: r.parent_id,
  }));

  const tagSuggestions = [...ollamaTags, ...embeddingTags];

  /* Per-peer thread root via walk up parent chain — avoids dropping links when a note
   * is missing from the global thread_roots CTE (orphan/broken parent chain, etc.). */
  const pl = await pool.query(
    `WITH raw_links AS (
       SELECT nc.id AS connection_id,
              CASE
                WHEN nc.anchor_note_id = $2::uuid THEN nc.linked_note_id
                ELSE nc.anchor_note_id
              END AS peer_id,
              nc.created_at
       FROM note_connections nc
       WHERE nc.user_id = $1
         AND (nc.anchor_note_id = $2::uuid OR nc.linked_note_id = $2::uuid)
     ),
     dedup AS (
       SELECT DISTINCT ON (peer_id) connection_id, peer_id, created_at
       FROM raw_links
       ORDER BY peer_id, created_at DESC
     )
     SELECT d.connection_id,
            nb.id,
            nb.content,
            nb.parent_id,
            COALESCE(tr.root_id, nb.id) AS thread_root_id,
            CASE
              WHEN an.embedding IS NOT NULL AND nb.embedding IS NOT NULL
              THEN 1 - (nb.embedding <=> an.embedding)
              ELSE NULL
            END AS similarity,
            d.created_at
     FROM dedup d
     JOIN notes nb ON nb.id = d.peer_id AND nb.user_id = $1
     LEFT JOIN LATERAL (
       WITH RECURSIVE up_chain AS (
         SELECT n.id, n.parent_id
         FROM notes n
         WHERE n.id = nb.id AND n.user_id = $1
         UNION ALL
         SELECT p.id, p.parent_id
         FROM notes p
         INNER JOIN up_chain u ON p.id = u.parent_id AND p.user_id = $1
       )
       SELECT uc.id AS root_id
       FROM up_chain uc
       WHERE uc.parent_id IS NULL
       LIMIT 1
     ) tr ON true
     LEFT JOIN notes an ON an.id = $2::uuid AND an.user_id = $1
     ORDER BY similarity DESC NULLS LAST, d.created_at DESC`,
    [userId, id]
  );
  const persistedLinkIds = new Set(pl.rows.map((r) => r.id));
  const persistedLinks = pl.rows.map((r) => ({
    connectionId: r.connection_id,
    id: r.id,
    content: r.content,
    parent_id: r.parent_id,
    threadRootId: r.thread_root_id,
    similarity: r.similarity != null ? Number(r.similarity) : null,
    persisted: true,
  }));

  const similarNotesFiltered = similarNotes.filter((s) => !persistedLinkIds.has(s.id));

  const tagTargetIds = [
    ...new Set([...similarNotesFiltered.map((s) => s.id), ...pl.rows.map((r) => r.id)]),
  ];
  const noteTagsMap = new Map();
  if (tagTargetIds.length > 0) {
    const tagR = await pool.query(
      `SELECT nt.note_id, t.id AS tag_id, t.name
       FROM note_tags nt
       JOIN tags t ON t.id = nt.tag_id
       WHERE nt.note_id = ANY($1::uuid[]) AND nt.status = 'approved'`,
      [tagTargetIds]
    );
    for (const row of tagR.rows) {
      if (!noteTagsMap.has(row.note_id)) noteTagsMap.set(row.note_id, []);
      noteTagsMap.get(row.note_id).push({ id: row.tag_id, name: row.name });
    }
  }

  const similarNotesWithTags = similarNotesFiltered.map((s) => ({
    ...s,
    tags: noteTagsMap.get(s.id) || [],
  }));

  const persistedLinksWithTags = persistedLinks.map((p) => ({
    ...p,
    tags: noteTagsMap.get(p.id) || [],
  }));

  return {
    tagSuggestions,
    similarNotes: similarNotesWithTags,
    persistedLinks: persistedLinksWithTags,
    similarityMin: minSimilarity,
  };
}
