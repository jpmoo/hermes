import { createNote, createNoteConnection, searchContent } from './api';
import { syncConnectionsFromContent, syncTagsFromContent } from './noteBodySync';
import { calendarInviteeNoteContentLine } from './noteEventUtils';

function noteFirstLine(content) {
  if (typeof content !== 'string') return '';
  const line = content.split('\n')[0] ?? '';
  return line.replace(/\r/g, '').trim();
}

function firstLineMatchesInviteeKey(content, line) {
  const a = noteFirstLine(content).toLowerCase();
  const b = String(line).trim().toLowerCase();
  return a === b;
}

/**
 * For each calendar attendee: connect the event note to an existing note whose first line
 * matches the canonical invitee line (name / email), or create a new note under the inbox
 * root when set, otherwise under the event note.
 */
export async function linkOrCreateInviteeNotesForEvent({
  eventNoteId,
  attendees,
  inboxThreadRootId,
  fallbackParentId,
}) {
  const invParent =
    typeof inboxThreadRootId === 'string' && inboxThreadRootId.trim()
      ? inboxThreadRootId.trim()
      : fallbackParentId;

  for (const a of attendees) {
    const line = calendarInviteeNoteContentLine(a);
    const candidates = await searchContent(line, 40, { firstLine: true });
    const existing = candidates.find(
      (n) => n.id !== eventNoteId && firstLineMatchesInviteeKey(n.content, line)
    );
    if (existing) {
      await createNoteConnection(eventNoteId, existing.id);
      continue;
    }
    const inv = await createNote({
      content: line,
      parent_id: invParent,
      note_type: 'note',
    });
    await syncConnectionsFromContent(inv.id, line, '');
    await syncTagsFromContent(inv.id, line, [], '');
    await createNoteConnection(eventNoteId, inv.id);
  }
}
