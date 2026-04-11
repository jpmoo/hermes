/** Normalize GET /settings calendar feed payload (supports legacy `calendarFeedUrls`). */

const MAX_FEEDS = 12;
const MAX_NAME_LEN = 80;

export function normalizeCalendarFeedsFromApi(data) {
  if (Array.isArray(data?.calendarFeeds)) {
    const out = [];
    const seen = new Set();
    for (const x of data.calendarFeeds) {
      if (!x || typeof x !== 'object' || typeof x.url !== 'string') continue;
      const url = x.url.trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({
        url,
        name: typeof x.name === 'string' ? x.name.trim().slice(0, MAX_NAME_LEN) : '',
      });
      if (out.length >= MAX_FEEDS) break;
    }
    return out;
  }
  if (Array.isArray(data?.calendarFeedUrls)) {
    return data.calendarFeedUrls
      .filter((u) => typeof u === 'string' && u.trim())
      .map((u) => ({ url: u.trim(), name: '' }))
      .slice(0, MAX_FEEDS);
  }
  return [];
}
