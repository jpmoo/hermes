/** Calendar chip date window: symmetric around “today” in local time. */

export const CALENDAR_LOOKOUT_MIN = -10;
export const CALENDAR_LOOKOUT_MAX = 10;

export function normalizeCalendarLookoutDays(v) {
  if (v === '' || v == null) return 0;
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.max(CALENDAR_LOOKOUT_MIN, Math.min(CALENDAR_LOOKOUT_MAX, n));
}

/**
 * @param {number} lookoutDays 0 = today only; negative extends `from` earlier; positive extends `to` later.
 */
export function localCalendarLookoutBounds(lookoutDays) {
  const d = normalizeCalendarLookoutDays(lookoutDays);
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + Math.min(0, d), 0, 0, 0, 0);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1 + Math.max(0, d), 0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}
