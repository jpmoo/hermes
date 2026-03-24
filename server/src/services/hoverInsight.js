import pool from '../db/pool.js';
import { generate } from './ollama.js';

function normalizeTagName(s) {
  return (s || '').toString().trim().toLowerCase().replace(/\s+/g, '-');
}

const THREAD_PATH_SEGMENT_MAX = 36;

/**
 * Breadcrumb: truncated note snippets joined by " > ", root → … → note.
 * @param {{ excludeLeaf?: boolean }} options — if true, omit the starting note (parent chain only; for linked-note cards where the snippet is shown separately).
 */
export async function getNoteThreadPathDisplay(noteId, userId, options = {}) {
  const excludeLeaf = options.excludeLeaf === true;
  const segments = [];
  let cur = noteId;
  const seen = new Set();
  for (let depth = 0; depth < 64 && cur && !seen.has(cur); depth++) {
    seen.add(cur);
    const r = await pool.query(
      `SELECT parent_id, content FROM notes WHERE id = $1 AND user_id = $2`,
      [cur, userId]
    );
    if (!r.rows.length) break;
    const { parent_id: p, content } = r.rows[0];
    const skipThisNote = excludeLeaf && depth === 0;
    if (!skipThisNote) {
      const text = (content || '').trim().replace(/\s+/g, ' ');
      const piece =
        text.length > THREAD_PATH_SEGMENT_MAX ? `${text.slice(0, THREAD_PATH_SEGMENT_MAX)}…` : text || '—';
      segments.unshift(piece);
    }
    cur = p;
  }
  return segments.join(' > ');
}

/**
 * Linked peers for a note (connections + snippet, cosine sim when embeddings exist, threadPath).
 * Does not attach tags — caller merges from a combined tag query when needed.
 */
export async function loadPersistedLinksMetadata(anchorNoteId, userId) {
  let pl = { rows: [] };
  try {
    pl = await pool.query(
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
              nb.note_type,
              nb.event_start_at,
              nb.event_end_at,
              nb.starred,
              nb.updated_at,
              NULL::uuid AS thread_root_id,
              CASE
                WHEN an.embedding IS NOT NULL AND nb.embedding IS NOT NULL
                THEN 1 - (nb.embedding <=> an.embedding)
                ELSE NULL
              END AS similarity,
              d.created_at
       FROM dedup d
       INNER JOIN notes nb ON nb.id = d.peer_id AND nb.user_id = $1
       LEFT JOIN notes an ON an.id = $2::uuid AND an.user_id = $1
       ORDER BY similarity DESC NULLS LAST, d.created_at DESC`,
      [userId, anchorNoteId]
    );
  } catch (err) {
    console.error('persisted links query:', err.message || err);
  }
  const persistedLinkIds = new Set(pl.rows.map((r) => r.id));
  const persistedLinks = await Promise.all(
    pl.rows.map(async (r) => ({
      connectionId: r.connection_id,
      id: r.id,
      content: r.content,
      parent_id: r.parent_id,
      note_type: r.note_type || 'note',
      event_start_at: r.event_start_at,
      event_end_at: r.event_end_at,
      starred: !!r.starred,
      updated_at: r.updated_at,
      threadRootId: r.thread_root_id,
      similarity: r.similarity != null ? Number(r.similarity) : null,
      persisted: true,
      threadPath: await getNoteThreadPathDisplay(r.id, userId, { excludeLeaf: true }),
    }))
  );
  return { persistedLinks, persistedLinkIds };
}

/** Linked notes with approved tags (for quick-load API). */
export async function getLinkedNotesWithTags(anchorNoteId, userId) {
  const { persistedLinks } = await loadPersistedLinksMetadata(anchorNoteId, userId);
  const ids = persistedLinks.map((p) => p.id);
  const noteTagsMap = new Map();
  if (ids.length > 0) {
    const tagR = await pool.query(
      `SELECT nt.note_id, t.id AS tag_id, t.name
       FROM note_tags nt
       JOIN tags t ON t.id = nt.tag_id
       WHERE nt.note_id = ANY($1::uuid[]) AND nt.status = 'approved'`,
      [ids]
    );
    for (const row of tagR.rows) {
      if (!noteTagsMap.has(row.note_id)) noteTagsMap.set(row.note_id, []);
      noteTagsMap.get(row.note_id).push({ id: row.tag_id, name: row.name });
    }
  }
  const withTags = persistedLinks.map((p) => ({
    ...p,
    tags: noteTagsMap.get(p.id) || [],
  }));
  return { persistedLinks: withTags };
}

/**
 * Tag suggestions + persisted links + vector similar notes for Stream hover.
 * Tags: (1) neighbor — approved tags on parent/siblings/immediate children not on hovered note;
 * (2) Ollama — up to 6 new hyphenated tags; (3) connected — approved tags on linked peers not on hovered note.
 * Similar notes: cosine nearest neighbors (embeddings), excluding self, connection peers, parent,
 * siblings (same parent), and immediate children (already surfaced as thread neighbors).
 */
export async function getHoverInsight(noteId, userId, _opts = {}) {
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
    `SELECT id, content FROM notes WHERE parent_id = $1 AND user_id = $2 ORDER BY created_at ASC LIMIT 40`,
    [noteId, userId]
  );
  const childrenBlock = kidsR.rows
    .map((r) => r.content?.trim())
    .filter(Boolean)
    .join('\n---\n');

  const siblingsR = await pool.query(
    `SELECT id, content FROM notes
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

  /** Approved tags only on parent, siblings, or immediate children — “neighbor” UI must not use linked-peer tags. */
  const neighborNoteIds = [
    ...new Set(
      [parentId, ...siblingsR.rows.map((r) => r.id), ...kidsR.rows.map((r) => r.id)].filter(Boolean)
    ),
  ];
  /** Approved tags on parent / siblings / immediate children that the hovered note does not have yet. */
  let neighborSuggestionRows = { rows: [] };
  if (neighborNoteIds.length > 0) {
    neighborSuggestionRows = await pool.query(
      `SELECT DISTINCT t.id, t.name
       FROM note_tags nt
       JOIN tags t ON t.id = nt.tag_id
       WHERE nt.note_id = ANY($1::uuid[]) AND nt.status = 'approved'
         AND NOT EXISTS (
           SELECT 1 FROM note_tags nt2
           WHERE nt2.note_id = $2 AND nt2.tag_id = t.id AND nt2.status = 'approved'
         )
       ORDER BY t.name`,
      [neighborNoteIds, id]
    );
  }
  const neighborSuggestions = neighborSuggestionRows.rows.map((row) => ({
    key: `n-${row.id}`,
    name: row.name,
    tagId: row.id,
    source: 'neighbor',
  }));

  const tagList =
    activeTagRows.rows.map((t) => t.name).join(', ') || '(no tags in use yet — you may suggest up to 6 new hyphenated tags)';

  const contextParts = [
    `--- hovered note ---\n${content?.trim() || '(empty)'}`,
    parentBlock ? `--- parent note ---\n${parentBlock}` : '',
    siblingsBlock ? `--- sibling notes (same level in thread) ---\n${siblingsBlock}` : '',
    childrenBlock
      ? `--- direct replies only (immediate children of hovered note, one level — not nested deeper) ---\n${childrenBlock}`
      : '',
  ].filter(Boolean);
  const body = contextParts.join('\n\n');

  const ollamaParsed = [];
  const prompt = `You tag notes in Hermes. The HOVERED NOTE is the focus; parent, sibling, and child sections (when present) are thread neighbors only.

Neighbor tags from the thread are listed separately in the app from the database. Your job here is **only**:

**New tags**: up to **6** items with from_vocab **false** — lowercase, hyphenated, helpful for the hovered note (even if the note text is short or empty). Do not use from_vocab true.

Child notes in context are ONLY immediate replies (one level), not deeper thread.

Return ONLY a JSON array: [{"tag":"name","from_vocab":false}, ...] with 1–6 items.

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
          if (it.from_vocab) continue;
          newCount += 1;
          if (newCount > 6) continue;
          ollamaParsed.push({ name, from_vocab: false });
        }
      }
    } catch {
      /* ignore parse errors */
    }
  }

  const seenNames = new Set(onNoteNames);
  for (const row of neighborSuggestions) {
    seenNames.add(row.name.toLowerCase());
  }

  /** Novel tags from the model only (neighbor + connected lists come from SQL). */
  const ollamaTags = [];
  for (const t of ollamaParsed) {
    if (seenNames.has(t.name)) continue;
    const known = activeByName.get(t.name);
    const tid = known?.id ?? null;
    seenNames.add(t.name);
    ollamaTags.push({
      key: `o-${t.name}`,
      name: t.name,
      tagId: tid,
      source: 'ollama',
      fromVocab: false,
    });
  }

  /* Approved tags on explicitly linked notes, not already on the hovered note (de-duped vs Ollama). */
  let connectedTagRows = { rows: [] };
  try {
    connectedTagRows = await pool.query(
      `SELECT DISTINCT t.id, t.name
       FROM note_connections nc
       INNER JOIN notes peer ON peer.user_id = nc.user_id AND (
         (nc.anchor_note_id = $2::uuid AND peer.id = nc.linked_note_id)
         OR (nc.linked_note_id = $2::uuid AND peer.id = nc.anchor_note_id)
       )
       INNER JOIN note_tags nt ON nt.note_id = peer.id AND nt.status = 'approved'
       INNER JOIN tags t ON t.id = nt.tag_id
       WHERE nc.user_id = $1`,
      [userId, id]
    );
  } catch (err) {
    console.error('connected-note tags query:', err.message || err);
  }
  /* Linked peers only; tags not already on the hovered (selected) note. */
  const connectedTags = [];
  for (const row of connectedTagRows.rows) {
    const ln = row.name.toLowerCase();
    if (onNoteIds.has(row.id) || onNoteNames.has(ln) || seenNames.has(ln)) continue;
    seenNames.add(ln);
    connectedTags.push({
      key: `c-${row.id}`,
      name: row.name,
      tagId: row.id,
      source: 'connected',
    });
  }

  const tagSuggestions = [...neighborSuggestions, ...ollamaTags, ...connectedTags];

  const { persistedLinks } = await loadPersistedLinksMetadata(id, userId);

  /** Vector similar notes: exclude linked peers + full thread neighborhood (not capped like Ollama context). */
  let similarNotes = [];
  try {
    const linkedPeerIds = persistedLinks.map((p) => p.id);
    let threadNeighborIds = [];
    try {
      const tn = await pool.query(
        `WITH h AS (SELECT parent_id FROM notes WHERE id = $1::uuid AND user_id = $2)
         SELECT n.id FROM notes n, h
         WHERE n.user_id = $2
           AND n.id <> $1::uuid
           AND (
             n.id = h.parent_id
             OR n.parent_id = $1::uuid
             OR (h.parent_id IS NOT NULL AND n.parent_id = h.parent_id)
             OR (h.parent_id IS NULL AND n.parent_id IS NULL)
           )`,
        [id, userId]
      );
      threadNeighborIds = tn.rows.map((r) => r.id);
    } catch (tnErr) {
      console.error('hover similar thread-neighbor ids:', tnErr.message || tnErr);
    }
    const similarExcludeIds = [...new Set([...linkedPeerIds, ...threadNeighborIds])];

    const similarSql = (hasExclude) => `WITH RECURSIVE roots AS (
         SELECT n.id, n.id AS root_id
         FROM notes n
         WHERE n.parent_id IS NULL AND n.user_id = $2
         UNION ALL
         SELECT c.id, r.root_id
         FROM notes c
         JOIN roots r ON r.id = c.parent_id
       )
       SELECT n.id, n.content, n.note_type, 1 - (n.embedding <=> an.embedding) AS similarity, rt.root_id AS thread_root_id
       FROM notes an
       CROSS JOIN notes n
       JOIN roots rt ON rt.id = n.id
       WHERE an.id = $1::uuid
         AND an.user_id = $2
         AND an.embedding IS NOT NULL
         AND n.user_id = $2
         AND n.embedding IS NOT NULL
         AND n.id <> $1::uuid
         ${hasExclude ? 'AND NOT (n.id = ANY($3::uuid[]))' : ''}
       ORDER BY n.embedding <=> an.embedding
       LIMIT 12`;
    const simR = similarExcludeIds.length
      ? await pool.query(similarSql(true), [id, userId, similarExcludeIds])
      : await pool.query(similarSql(false), [id, userId]);
    similarNotes = await Promise.all(
      simR.rows.map(async (row) => ({
        id: row.id,
        content: row.content,
        note_type: row.note_type || 'note',
        similarity: row.similarity != null ? Number(row.similarity) : null,
        threadRootId: row.thread_root_id,
        threadPath: await getNoteThreadPathDisplay(row.id, userId, { excludeLeaf: true }),
      }))
    );
  } catch (err) {
    console.error('hover similar notes:', err.message || err);
    similarNotes = [];
  }

  const tagTargetIds = [...new Set(persistedLinks.map((p) => p.id))];
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

  const persistedLinksWithTags = persistedLinks.map((p) => ({
    ...p,
    tags: noteTagsMap.get(p.id) || [],
  }));

  return {
    tagSuggestions,
    similarNotes,
    persistedLinks: persistedLinksWithTags,
  };
}
