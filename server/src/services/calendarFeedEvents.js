import ical from 'node-ical';

const MAX_BODY = 2_000_000;
const FETCH_TIMEOUT_MS = 15_000;

function toDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getSummary(ev) {
  const s = ev.summary;
  if (typeof s === 'string') return s.trim() || 'Untitled';
  if (s && typeof s === 'object' && typeof s.val === 'string') return s.val.trim() || 'Untitled';
  return 'Untitled';
}

/**
 * Expand a VEVENT into one or more { start, end } instances overlapping [rangeFrom, rangeTo).
 */
function expandEventInstances(ev, rangeFrom, rangeTo) {
  const start = toDate(ev.start);
  if (!start) return [];

  const endRaw = toDate(ev.end);
  const defaultDur = ev.datetype === 'date' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const end = endRaw || new Date(start.getTime() + defaultDur);

  if (ev.rrule && typeof ev.rrule.between === 'function') {
    try {
      const dur = Math.max(0, end.getTime() - start.getTime()) || defaultDur;
      /*
       * rrule.between(rangeFrom, rangeTo) only returns occurrences whose *start* lies in the window.
       * Long or multi-day instances that began before today but still overlap today would be missed
       * (e.g. multi-day conference, all-day span). Query from well before "today" and let the caller
       * filter by overlap with [rangeFrom, rangeTo) and end > now.
       */
      const lookbackMs = Math.max(
        120 * 24 * 60 * 60 * 1000,
        dur * 2,
        14 * 24 * 60 * 60 * 1000
      );
      const queryFrom = new Date(rangeFrom.getTime() - lookbackMs);
      const occ = ev.rrule.between(queryFrom, rangeTo, true);
      return occ.map((s) => ({ start: s, end: new Date(s.getTime() + dur) }));
    } catch {
      return [];
    }
  }

  const out = [{ start, end }];

  if (ev.recurrences && typeof ev.recurrences === 'object') {
    for (const sub of Object.values(ev.recurrences)) {
      if (!sub || typeof sub !== 'object') continue;
      const merged = { ...ev, ...sub, recurrences: undefined, rrule: undefined };
      const s2 = toDate(merged.start);
      const e2 = toDate(merged.end) || (s2 ? new Date(s2.getTime() + defaultDur) : null);
      if (s2 && e2) out.push({ start: s2, end: e2 });
    }
  }

  return out;
}

function overlapsWindow(aStart, aEnd, wFrom, wTo) {
  return aStart < wTo && aEnd > wFrom;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** Local calendar YYYY-MM-DD for Hermes date inputs (matches client Date parsing). */
function localYmd(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * iCal all-day DTEND is exclusive (first day after the event). Last inclusive day is one calendar day before.
 */
function allDayInclusiveEndDay(exclusiveEnd) {
  const d = new Date(exclusiveEnd.getTime());
  d.setDate(d.getDate() - 1);
  return localYmd(d);
}

/**
 * @param {string} icsBody
 * @param {Date} rangeFrom start of local "today" as Date
 * @param {Date} rangeTo end of local "today" (exclusive) as Date
 * @param {Date} now
 * @param {string} feedUrl
 * @returns {{ title: string, start: string, end: string, feedUrl: string }[]}
 */
export function eventsFromIcsForDay(icsBody, rangeFrom, rangeTo, now, feedUrl) {
  let parsed;
  try {
    parsed = ical.parseICS(icsBody);
  } catch {
    return [];
  }
  const candidates = [];
  for (const comp of Object.values(parsed)) {
    if (!comp || comp.type !== 'VEVENT') continue;
    if (comp.status === 'CANCELLED') continue;
    const title = getSummary(comp);
    const allDay = comp.datetype === 'date';
    const instances = expandEventInstances(comp, rangeFrom, rangeTo);
    for (const { start, end } of instances) {
      if (!start || !end) continue;
      // Touches this calendar day (client's local [rangeFrom, rangeTo))
      if (!overlapsWindow(start, end, rangeFrom, rangeTo)) continue;
      // Still ongoing: not fully ended yet (includes in-progress and future starts; excludes finished)
      if (end.getTime() <= now.getTime()) continue;
      const row = { title, start: new Date(start), end: new Date(end), feedUrl, allDay };
      if (allDay) {
        row.startDay = localYmd(start);
        row.endDayInclusive = allDayInclusiveEndDay(end);
      }
      candidates.push(row);
    }
  }
  return candidates;
}

export function isAllowedCalendarFeedUrl(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return false;
  return true;
}

export async function fetchIcsText(urlString) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(urlString, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        Accept: 'text/calendar, text/plain, */*',
        'User-Agent': 'HermesCalendar/1.0',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BODY) throw new Error('Calendar response too large');
    return text;
  } finally {
    clearTimeout(t);
  }
}
