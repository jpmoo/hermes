import {
  getNote,
  updateNote,
  deleteNote,
  addNoteTag,
  reassignNoteFileBlob,
  patchNoteAttachmentOrder,
} from './api';

/**
 * @param {unknown} note
 * @param {unknown[]|null|undefined} sortedSiblingsUnderSameParent
 * @returns {string|null} id of the sibling immediately above in display order, or null
 */
export function mergeIntoAboveSiblingIdFromSortedChildren(note, sortedSiblingsUnderSameParent) {
  if (!note?.parent_id || !Array.isArray(sortedSiblingsUnderSameParent) || sortedSiblingsUnderSameParent.length < 2) {
    return null;
  }
  const idx = sortedSiblingsUnderSameParent.findIndex((x) => String(x.id) === String(note.id));
  if (idx <= 0) return null;
  return String(sortedSiblingsUnderSameParent[idx - 1].id);
}

/**
 * Merge `sourceNoteId` into sibling `aboveNoteId`: append text and tags, move attachments,
 * reparent direct children of source to above, then delete source.
 * If either note was starred, the surviving (above) note is starred.
 * Source attachments are moved after the target’s existing attachments (display order).
 *
 * @param {string} aboveNoteId
 * @param {string} sourceNoteId
 * @param {string[]} directChildIdsOfSource
 */
export async function mergeNoteIntoSiblingAbove(aboveNoteId, sourceNoteId, directChildIdsOfSource) {
  const aboveId = String(aboveNoteId).trim();
  const sourceId = String(sourceNoteId).trim();
  if (!aboveId || !sourceId || aboveId === sourceId) {
    throw new Error('Invalid merge');
  }
  const [above, source] = await Promise.all([getNote(aboveId), getNote(sourceId)]);
  if (!above?.id || !source?.id) throw new Error('Notes not found');
  if (!source.parent_id) throw new Error('Cannot merge a thread root');
  if (String(source.parent_id) !== String(above.parent_id)) {
    throw new Error('Notes are not siblings');
  }

  const childIds = Array.isArray(directChildIdsOfSource) ? directChildIdsOfSource.map(String) : [];
  for (const cid of childIds) {
    await updateNote(cid, { parent_id: aboveId });
  }

  const normBlobId = (a) => String(a?.id ?? '').trim().toLowerCase();
  const aboveBlobIdsOrdered = (above.attachments || []).map(normBlobId).filter(Boolean);
  const sourceAttachments = source.attachments || [];
  const sourceBlobIdsOrdered = sourceAttachments.map(normBlobId).filter(Boolean);

  for (const att of sourceAttachments) {
    if (att?.id) await reassignNoteFileBlob(att.id, aboveId);
  }

  const mergedBlobOrder = [...aboveBlobIdsOrdered, ...sourceBlobIdsOrdered];
  if (mergedBlobOrder.length > 0) {
    await patchNoteAttachmentOrder(aboveId, mergedBlobOrder);
  }

  const aboveTagIds = new Set((above.tags || []).map((t) => String(t.id)));
  for (const t of source.tags || []) {
    if (t?.id && !aboveTagIds.has(String(t.id))) {
      await addNoteTag(aboveId, { tag_id: t.id });
      aboveTagIds.add(String(t.id));
    }
  }

  const a = (above.content || '').trimEnd();
  const b = (source.content || '').trim();
  const combined = a && b ? `${a}\n\n${b}` : a || b;
  const starred = Boolean(above.starred || source.starred);
  await updateNote(aboveId, { content: combined, starred });

  await deleteNote(sourceId);
}
