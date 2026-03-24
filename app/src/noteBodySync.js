import { addNoteTag, removeNoteTag, createNoteConnection, deleteNoteConnection } from './api';
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

/**
 * Keep mention links and connections in lockstep:
 * - add connections for newly mentioned notes
 * - remove connections when a previously mentioned note is no longer mentioned
 */
export async function syncConnectionsFromContent(anchorNoteId, content, previousContent = '') {
  const anchor = String(anchorNoteId).toLowerCase();
  const prevIds = new Set(extractLinkedNoteIds(previousContent).map((id) => String(id).toLowerCase()));
  const nowIds = new Set(extractLinkedNoteIds(content).map((id) => String(id).toLowerCase()));

  for (const id of nowIds) {
    if (String(id).toLowerCase() === anchor) continue;
    try {
      await createNoteConnection(anchorNoteId, id);
    } catch (e) {
      console.error(e);
    }
  }

  for (const id of prevIds) {
    if (id === anchor || nowIds.has(id)) continue;
    try {
      await deleteNoteConnection(anchorNoteId, id);
    } catch (e) {
      console.error(e);
    }
  }
}
