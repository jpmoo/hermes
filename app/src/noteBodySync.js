import { addNoteTag, removeNoteTag, createNoteConnection } from './api';
import { extractTagNamesFromContent, extractLinkedNoteIds } from './noteBodyUtils';

/**
 * Add tags for new #hashtags. Remove a tag only if it appeared as a hashtag in
 * `previousContent` but no longer appears in `content` (chip-only tags are kept).
 */
export async function syncTagsFromContent(noteId, content, existingTags, previousContent = '') {
  const prevBody = extractTagNamesFromContent(previousContent);
  const nowBody = extractTagNamesFromContent(content);
  const byName = new Map((existingTags || []).map((t) => [t.name, t]));

  for (const name of nowBody) {
    if (!byName.has(name)) {
      try {
        await addNoteTag(noteId, { name });
      } catch (e) {
        console.error(e);
      }
    }
  }

  for (const t of existingTags || []) {
    if (prevBody.has(t.name) && !nowBody.has(t.name)) {
      try {
        await removeNoteTag(noteId, t.id);
      } catch (e) {
        console.error(e);
      }
    }
  }
}

/** Ensure a connection exists for each hermes-note:// link in content (idempotent). */
export async function syncConnectionsFromContent(anchorNoteId, content) {
  const anchor = String(anchorNoteId).toLowerCase();
  const ids = extractLinkedNoteIds(content);
  for (const id of ids) {
    if (String(id).toLowerCase() === anchor) continue;
    try {
      await createNoteConnection(anchorNoteId, id);
    } catch (e) {
      console.error(e);
    }
  }
}
