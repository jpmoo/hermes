export const NOTE_TYPE_OPTIONS = [
  { value: 'note', label: 'Note' },
  { value: 'event', label: 'Event' },
  { value: 'person', label: 'Person' },
  { value: 'organization', label: 'Organization' },
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Map ISO instant to <input type="date"> and <input type="time">; empty time = all-day heuristic. */
export function isoToDateTimeFields(iso, isEnd) {
  if (!iso) return { date: '', time: '' };
  const d = new Date(iso);
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const h = d.getHours();
  const m = d.getMinutes();
  const s = d.getSeconds();
  const ms = d.getMilliseconds();
  if (isEnd) {
    if (h === 23 && m === 59 && s >= 59) return { date, time: '' };
  } else if (h === 0 && m === 0 && s === 0 && ms === 0) {
    return { date, time: '' };
  }
  return { date, time: `${pad2(h)}:${pad2(m)}` };
}

/**
 * @param {string} dateStr - yyyy-mm-dd
 * @param {string} timeStr - HH:mm or empty
 * @param {boolean} endOfDay - if true and time empty, use 23:59:59.999 local
 */
export function composeEventInstant(dateStr, timeStr, endOfDay) {
  const dPart = dateStr?.trim();
  if (!dPart) return null;
  const tPart = timeStr?.trim();
  const local = tPart
    ? `${dPart}T${tPart}`
    : endOfDay
      ? `${dPart}T23:59:59.999`
      : `${dPart}T00:00:00`;
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

/**
 * API payload fragment for note_type + event timestamps.
 * @returns {{ note_type: string, event_start_at: string|null, event_end_at: string|null } | { error: string }}
 */
export function eventFieldsToPayload(noteType, { startDate, startTime, endDate, endTime }) {
  const t = noteType || 'note';
  if (t !== 'event') {
    return { note_type: t, event_start_at: null, event_end_at: null };
  }
  const start = composeEventInstant(startDate, startTime, false);
  const endDateTrim = (endDate ?? '').trim();
  const endTimeTrim = (endTime ?? '').trim();
  let eventEnd = null;
  if (endDateTrim) {
    eventEnd = composeEventInstant(endDateTrim, endTimeTrim, !endTimeTrim);
    if (eventEnd === undefined) {
      return { error: 'Invalid event date or time' };
    }
  }
  if (start === undefined) {
    return { error: 'Invalid event date or time' };
  }
  return {
    note_type: 'event',
    event_start_at: start,
    event_end_at: eventEnd,
  };
}

/**
 * Map a calendar-feed API event to compose date/time fields (all-day uses dates only, no times).
 * @param {{ start: string, end: string, allDay?: boolean, startDay?: string, endDayInclusive?: string }} ev
 */
export function calendarFeedPickToComposeFields(ev) {
  if (ev?.allDay === true && typeof ev.startDay === 'string' && ev.startDay) {
    const multi =
      typeof ev.endDayInclusive === 'string' &&
      ev.endDayInclusive &&
      ev.endDayInclusive !== ev.startDay;
    return {
      startDate: ev.startDay,
      startTime: '',
      endDate: multi ? ev.endDayInclusive : '',
      endTime: '',
    };
  }
  const startIso = ev?.start;
  const endIso = ev?.end;
  if (!startIso) {
    return { startDate: '', startTime: '', endDate: '', endTime: '' };
  }
  const s = isoToDateTimeFields(startIso, false);
  const e = endIso ? isoToDateTimeFields(endIso, true) : { date: '', time: '' };
  return {
    startDate: s.date,
    startTime: s.time,
    endDate: e.date,
    endTime: e.time,
  };
}

export function formatEventRange(note) {
  if (note?.note_type !== 'event') return '';
  const fmt = (iso, withTime) => {
    if (!iso) return '';
    const d = new Date(iso);
    const opts = withTime
      ? { dateStyle: 'medium', timeStyle: 'short' }
      : { dateStyle: 'medium' };
    return d.toLocaleString(undefined, opts);
  };
  const s = note.event_start_at;
  const e = note.event_end_at;
  if (!s && !e) return '';
  if (!s) {
    const eFields = isoToDateTimeFields(e, true);
    return fmt(e, Boolean(eFields.time));
  }
  const sFields = isoToDateTimeFields(s, false);
  const sWithTime = Boolean(sFields.time);
  const left = fmt(s, sWithTime);
  if (!e) return left;

  const eFields = isoToDateTimeFields(e, true);
  const eWithTime = Boolean(eFields.time);
  const right = fmt(e, eWithTime);
  if (left && right) {
    if (left === right) return left;
    return `${left} → ${right}`;
  }
  return left || right;
}

/**
 * First child note for a calendar event: optional DESCRIPTION plus invitee list.
 * @param {string} [description]
 * @param {{ displayName?: string, email?: string }[]} [attendees]
 */
export function buildCalendarEventDetailNoteContent(description, attendees) {
  const parts = [];
  const d = typeof description === 'string' ? description.replace(/\s+/g, ' ').trim() : '';
  if (d) parts.push(d);
  const list = Array.isArray(attendees) ? attendees : [];
  const lines = list
    .map((a) => {
      if (!a || typeof a !== 'object') return null;
      const name = typeof a.displayName === 'string' ? a.displayName.trim() : '';
      const em = typeof a.email === 'string' ? a.email.trim() : '';
      if (name && em) return `- ${name} <${em}>`;
      if (name) return `- ${name}`;
      if (em) return `- ${em}`;
      return null;
    })
    .filter(Boolean);
  if (lines.length) {
    parts.push(`Invitees\n${lines.join('\n')}`);
  }
  return parts.join('\n\n').trim();
}

/** One-line title for an auto-created invitee note. */
export function calendarInviteeNoteContentLine(a) {
  if (!a || typeof a !== 'object') return 'Invitee';
  const name = typeof a.displayName === 'string' ? a.displayName.trim() : '';
  const em = typeof a.email === 'string' ? a.email.trim() : '';
  if (name && em) return `${name} <${em}>`;
  return name || em || 'Invitee';
}
