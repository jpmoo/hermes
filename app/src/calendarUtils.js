/** Start of local calendar day (midnight). */
export function startOfLocalDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/**
 * Weeks for a month grid (Sun–Sat). Each cell: { date, inMonth, key }.
 * @param {number} year
 * @param {number} monthIndex 0–11
 */
export function buildMonthWeeks(year, monthIndex) {
  const firstOfMonth = new Date(year, monthIndex, 1);
  const lastOfMonth = new Date(year, monthIndex + 1, 0);
  const startGrid = new Date(firstOfMonth);
  startGrid.setDate(firstOfMonth.getDate() - firstOfMonth.getDay());
  const endGrid = new Date(lastOfMonth);
  endGrid.setDate(lastOfMonth.getDate() + (6 - lastOfMonth.getDay()));

  const weeks = [];
  const rowStart = new Date(startGrid);
  while (rowStart <= endGrid) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(rowStart);
      d.setDate(rowStart.getDate() + i);
      week.push({
        date: d,
        inMonth: d.getMonth() === monthIndex,
        key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
      });
    }
    weeks.push(week);
    rowStart.setDate(rowStart.getDate() + 7);
  }
  return weeks;
}

/** Half-open ISO range [first day 00:00, next month first day 00:00). */
export function monthToIsoRange(year, monthIndex) {
  const start = new Date(year, monthIndex, 1, 0, 0, 0, 0);
  const endExclusive = new Date(year, monthIndex + 1, 1, 0, 0, 0, 0);
  return { from: start.toISOString(), to: endExclusive.toISOString() };
}

/** Local inclusive day range for an event (for calendar cells). */
export function eventLocalDayRange(event) {
  const s = new Date(event.event_start_at);
  const startDay = startOfLocalDay(s);
  if (!event.event_end_at) {
    return { startDay, endDay: startDay };
  }
  const e = new Date(event.event_end_at);
  const endDay = startOfLocalDay(e);
  return { startDay, endDay: Math.max(startDay, endDay) };
}

export function weekOverlapsRange(week, startDay, endDay) {
  const ws = startOfLocalDay(week[0].date);
  const we = startOfLocalDay(week[6].date);
  return startDay <= we && endDay >= ws;
}

/** Column span (0–6) for one week row, or null if no overlap. */
export function segmentInWeek(week, startDay, endDay) {
  const ws = startOfLocalDay(week[0].date);
  const wl = startOfLocalDay(week[6].date);
  const segStart = Math.max(startDay, ws);
  const segEnd = Math.min(endDay, wl);
  if (segStart > segEnd) return null;
  const colStart = Math.round((segStart - ws) / 86400000);
  const colEnd = Math.round((segEnd - ws) / 86400000);
  const cs = Math.max(0, Math.min(6, colStart));
  const ce = Math.max(0, Math.min(6, colEnd));
  return { colStart: cs, colEnd: ce, span: ce - cs + 1 };
}

/**
 * @param {{ colStart: number, colEnd: number, event: object }[]} segments
 * @returns {Array<{ colStart: number, colEnd: number, span: number, lane: number, event: object }>}
 */
export function assignEventLanes(segments) {
  const sorted = [...segments].sort(
    (a, b) => a.colStart - b.colStart || a.colEnd - b.colEnd || String(a.event.id).localeCompare(String(b.event.id))
  );
  const laneEnds = [];
  for (const seg of sorted) {
    let laneIdx = laneEnds.findIndex((lastEnd) => lastEnd < seg.colStart);
    if (laneIdx === -1) {
      laneIdx = laneEnds.length;
      laneEnds.push(seg.colEnd);
    } else {
      laneEnds[laneIdx] = seg.colEnd;
    }
    seg.lane = laneIdx;
  }
  return sorted;
}

export function eventBarLabel(event) {
  const t = (event.content || '').trim().split('\n')[0];
  if (!t) return 'Event';
  return t.length > 42 ? `${t.slice(0, 40)}…` : t;
}
