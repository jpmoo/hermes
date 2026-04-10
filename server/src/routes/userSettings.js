import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import {
  similarNotesMinCharsEnvDefault,
  sanitizeSimilarNotesMinChars,
} from '../config/similarNotes.js';
import {
  eventsFromIcsForDay,
  fetchIcsText,
  isAllowedCalendarFeedUrl,
} from '../services/calendarFeedEvents.js';

const router = Router();

const MAX_CALENDAR_FEEDS = 12;
const MAX_FEED_URL_LEN = 2048;

function sanitizeCalendarFeedUrls(input) {
  if (input == null || !Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const t = item.trim();
    if (!t || t.length > MAX_FEED_URL_LEN) continue;
    if (!isAllowedCalendarFeedUrl(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= MAX_CALENDAR_FEEDS) break;
  }
  return out;
}

const NOTE_TYPES = ['note', 'event', 'person', 'organization'];
const NOTE_HISTORY_MAX = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeHex(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(s)) return null;
  if (s.length === 4) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
  }
  return s.toLowerCase();
}

function sanitizeNoteTypeColors(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const k of NOTE_TYPES) {
    const h = normalizeHex(input[k]);
    if (h) out[k] = h;
  }
  return out;
}

function sanitizeHistoryEntry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const noteId = typeof input.noteId === 'string' ? input.noteId.trim() : '';
  if (!noteId) return null;
  const title = typeof input.title === 'string' ? input.title.trim().slice(0, 160) : '';
  const threadPath = typeof input.threadPath === 'string' ? input.threadPath.trim().slice(0, 500) : '';
  const threadRootId = typeof input.threadRootId === 'string' ? input.threadRootId.trim() : '';
  const visitedAt = typeof input.visitedAt === 'string' ? input.visitedAt : '';
  const d = visitedAt ? new Date(visitedAt) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return {
    noteId,
    title,
    threadPath,
    ...(threadRootId ? { threadRootId } : {}),
    visitedAt: d.toISOString(),
  };
}

function sanitizeNoteHistory(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const it of input) {
    const row = sanitizeHistoryEntry(it);
    if (!row) continue;
    if (seen.has(row.noteId)) continue;
    seen.add(row.noteId);
    out.push(row);
    if (out.length >= NOTE_HISTORY_MAX) break;
  }
  return out;
}

function sanitizeInboxThreadRootId(input) {
  if (input == null) return undefined;
  if (typeof input !== 'string') return undefined;
  const v = input.trim();
  if (!v) return null;
  return UUID_RE.test(v) ? v : undefined;
}

/** http(s) base URL for Spaztick external API; trailing slash stripped. */
function sanitizeSpaztickApiUrl(input) {
  if (input == null) return undefined;
  if (typeof input !== 'string') return undefined;
  const v = input.trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return v.replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

/** Stored API key for Spaztick X-API-Key; never returned to clients on GET. */
function sanitizeSpaztickApiKey(input) {
  if (input == null) return undefined;
  if (typeof input !== 'string') return undefined;
  const v = input.trim();
  if (!v) return null;
  return v.length > 512 ? v.slice(0, 512) : v;
}

function sanitizeCanvasViewSlice(input) {
  const view = {};
  if (input && typeof input === 'object') {
    const sc = Number(input.scale);
    const tx = Number(input.tx);
    const ty = Number(input.ty);
    if (Number.isFinite(sc) && sc >= 0.08 && sc <= 12) view.scale = sc;
    if (Number.isFinite(tx) && Math.abs(tx) < 5e6) view.tx = tx;
    if (Number.isFinite(ty) && Math.abs(ty) < 5e6) view.ty = ty;
    if (typeof input.showSequenceLines === 'boolean') {
      view.showSequenceLines = input.showSequenceLines;
    }
  }
  return view;
}

/** Canvas layouts (stored as campusLayouts in settings_json): per-thread, per-focus view(s) + card rects. */
function sanitizeCampusLayouts(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const tid of Object.keys(input).slice(0, 48)) {
    if (typeof tid !== 'string' || tid.length > 96) continue;
    const ctx = input[tid];
    if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) continue;
    out[tid] = {};
    for (const fk of Object.keys(ctx).slice(0, 32)) {
      if (typeof fk !== 'string' || fk.length > 128) continue;
      const block = ctx[fk];
      if (!block || typeof block !== 'object') continue;
      const view = sanitizeCanvasViewSlice(block.view);
      const viewMobile = sanitizeCanvasViewSlice(block.viewMobile);
      let starredDock;
      if (block.starredDock && typeof block.starredDock === 'object') {
        const top = Number(block.starredDock.top);
        const right = Number(block.starredDock.right);
        if (
          Number.isFinite(top) &&
          Number.isFinite(right) &&
          top >= 0 &&
          top < 4000 &&
          right >= 0 &&
          right < 4000
        ) {
          starredDock = { top, right };
        }
      }
      const cards = {};
      if (block.cards && typeof block.cards === 'object' && !Array.isArray(block.cards)) {
        let n = 0;
        for (const [nid, rect] of Object.entries(block.cards)) {
          if (n++ >= 240) break;
          if (typeof nid !== 'string' || nid.length > 96) continue;
          if (!rect || typeof rect !== 'object') continue;
          const x = Number(rect.x);
          const y = Number(rect.y);
          const w = Number(rect.w);
          const h = Number(rect.h);
          if (![x, y, w, h].every((v) => Number.isFinite(v))) continue;
          if (w < 100 || w > 2400 || h < 64 || h > 3200) continue;
          if (Math.abs(x) > 1e7 || Math.abs(y) > 1e7) continue;
          cards[nid] = { x, y, w, h };
        }
      }
      const blockOut = { view, viewMobile, cards };
      if (starredDock) blockOut.starredDock = starredDock;
      out[tid][fk] = blockOut;
    }
  }
  return out;
}

router.get('/settings', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT settings_json FROM users WHERE id = $1', [req.userId]);
    const row = r.rows[0];
    const raw = row?.settings_json && typeof row.settings_json === 'object' ? row.settings_json : {};
    const noteTypeColors = sanitizeNoteTypeColors(raw.noteTypeColors);
    const similarStored = sanitizeSimilarNotesMinChars(raw.similarNotesMinChars);
    const noteHistory = sanitizeNoteHistory(raw.noteHistory);
    const similarLimitResults = raw.similarNotesLimitResultsToMinChars === true;
    const campusLayouts = sanitizeCampusLayouts(raw.campusLayouts);
    const inboxThreadRootId = sanitizeInboxThreadRootId(raw.inboxThreadRootId);
    const spUrl = sanitizeSpaztickApiUrl(raw.spaztickApiUrl);
    const spKeyStored = typeof raw.spaztickApiKey === 'string' && raw.spaztickApiKey.trim().length > 0;
    const calendarFeedUrls = sanitizeCalendarFeedUrls(raw.calendarFeedUrls);
    res.json({
      noteTypeColors,
      similarNotesMinChars: similarStored === undefined ? null : similarStored,
      similarNotesMinDefault: similarNotesMinCharsEnvDefault(),
      similarNotesLimitResultsToMinChars: similarLimitResults,
      noteHistory,
      campusLayouts,
      inboxThreadRootId: inboxThreadRootId === undefined ? null : inboxThreadRootId,
      spaztickApiUrl: spUrl === undefined ? null : spUrl,
      spaztickApiKeySet: spKeyStored,
      calendarFeedUrls,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.patch('/settings', requireAuth, async (req, res) => {
  try {
    const {
      noteTypeColors,
      similarNotesMinChars,
      similarNotesLimitResultsToMinChars,
      noteHistory,
      campusLayouts,
      inboxThreadRootId,
      spaztickApiUrl,
      spaztickApiKey,
      calendarFeedUrls,
    } = req.body ?? {};
    const r = await pool.query('SELECT settings_json FROM users WHERE id = $1', [req.userId]);
    const cur = r.rows[0]?.settings_json && typeof r.rows[0].settings_json === 'object'
      ? { ...r.rows[0].settings_json }
      : {};

    if (noteTypeColors !== undefined) {
      if (noteTypeColors === null) {
        delete cur.noteTypeColors;
      } else {
        const cleaned = sanitizeNoteTypeColors(noteTypeColors);
        if (Object.keys(cleaned).length === 0) delete cur.noteTypeColors;
        else cur.noteTypeColors = cleaned;
      }
    }

    if (similarNotesMinChars !== undefined) {
      if (similarNotesMinChars === null) {
        delete cur.similarNotesMinChars;
      } else {
        const n = sanitizeSimilarNotesMinChars(similarNotesMinChars);
        if (n === undefined) {
          return res.status(400).json({ error: 'similarNotesMinChars must be 0–500 or null' });
        }
        cur.similarNotesMinChars = n;
      }
    }

    if (similarNotesLimitResultsToMinChars !== undefined) {
      if (similarNotesLimitResultsToMinChars === null) {
        delete cur.similarNotesLimitResultsToMinChars;
      } else if (
        similarNotesLimitResultsToMinChars !== true &&
        similarNotesLimitResultsToMinChars !== false
      ) {
        return res
          .status(400)
          .json({ error: 'similarNotesLimitResultsToMinChars must be true, false, or null' });
      } else {
        cur.similarNotesLimitResultsToMinChars = similarNotesLimitResultsToMinChars;
      }
    }

    if (noteHistory !== undefined) {
      if (noteHistory === null) {
        delete cur.noteHistory;
      } else {
        const cleaned = sanitizeNoteHistory(noteHistory);
        cur.noteHistory = cleaned;
      }
    }

    if (campusLayouts !== undefined) {
      if (campusLayouts === null) {
        delete cur.campusLayouts;
      } else {
        cur.campusLayouts = sanitizeCampusLayouts(campusLayouts);
      }
    }

    if (inboxThreadRootId !== undefined) {
      if (inboxThreadRootId === null) {
        delete cur.inboxThreadRootId;
      } else {
        const cleanedInbox = sanitizeInboxThreadRootId(inboxThreadRootId);
        if (cleanedInbox === undefined) {
          return res.status(400).json({ error: 'inboxThreadRootId must be a UUID string or null' });
        }
        if (cleanedInbox === null) {
          delete cur.inboxThreadRootId;
        } else {
          const rootCheck = await pool.query(
            'SELECT 1 FROM notes WHERE id = $1 AND user_id = $2 AND parent_id IS NULL',
            [cleanedInbox, req.userId]
          );
          if (rootCheck.rows.length === 0) {
            return res.status(400).json({ error: 'inboxThreadRootId must reference one of your root threads' });
          }
          cur.inboxThreadRootId = cleanedInbox;
        }
      }
    }

    if (spaztickApiUrl !== undefined) {
      if (spaztickApiUrl === null) {
        delete cur.spaztickApiUrl;
      } else {
        const u = sanitizeSpaztickApiUrl(spaztickApiUrl);
        if (u === undefined) {
          return res.status(400).json({ error: 'spaztickApiUrl must be a valid http(s) URL or null' });
        }
        if (u === null) delete cur.spaztickApiUrl;
        else cur.spaztickApiUrl = u;
      }
    }

    if (spaztickApiKey !== undefined) {
      if (spaztickApiKey === null) {
        delete cur.spaztickApiKey;
      } else {
        const k = sanitizeSpaztickApiKey(spaztickApiKey);
        if (k === undefined) {
          return res.status(400).json({ error: 'spaztickApiKey must be a string or null' });
        }
        if (k === null) delete cur.spaztickApiKey;
        else cur.spaztickApiKey = k;
      }
    }

    if (calendarFeedUrls !== undefined) {
      if (calendarFeedUrls === null) {
        delete cur.calendarFeedUrls;
      } else if (!Array.isArray(calendarFeedUrls)) {
        return res.status(400).json({ error: 'calendarFeedUrls must be an array of URLs or null' });
      } else {
        const cleaned = sanitizeCalendarFeedUrls(calendarFeedUrls);
        if (cleaned.length === 0) delete cur.calendarFeedUrls;
        else cur.calendarFeedUrls = cleaned;
      }
    }

    await pool.query('UPDATE users SET settings_json = $1::jsonb WHERE id = $2', [
      JSON.stringify(cur),
      req.userId,
    ]);
    const outColors = sanitizeNoteTypeColors(cur.noteTypeColors);
    const outSimilar = sanitizeSimilarNotesMinChars(cur.similarNotesMinChars);
    const outHistory = sanitizeNoteHistory(cur.noteHistory);
    const outLimitResults = cur.similarNotesLimitResultsToMinChars === true;
    const outCampus = sanitizeCampusLayouts(cur.campusLayouts);
    const outInbox = sanitizeInboxThreadRootId(cur.inboxThreadRootId);
    const outSpUrl = sanitizeSpaztickApiUrl(cur.spaztickApiUrl);
    const outSpKeySet = typeof cur.spaztickApiKey === 'string' && cur.spaztickApiKey.trim().length > 0;
    const outCalendarFeeds = sanitizeCalendarFeedUrls(cur.calendarFeedUrls);
    res.json({
      noteTypeColors: outColors,
      similarNotesMinChars: outSimilar === undefined ? null : outSimilar,
      similarNotesMinDefault: similarNotesMinCharsEnvDefault(),
      similarNotesLimitResultsToMinChars: outLimitResults,
      noteHistory: outHistory,
      campusLayouts: outCampus,
      inboxThreadRootId: outInbox === undefined ? null : outInbox,
      spaztickApiUrl: outSpUrl === undefined ? null : outSpUrl,
      spaztickApiKeySet: outSpKeySet,
      calendarFeedUrls: outCalendarFeeds,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

router.get('/calendar-feed-events', requireAuth, async (req, res) => {
  try {
    const fromStr = typeof req.query.from === 'string' ? req.query.from.trim() : '';
    const toStr = typeof req.query.to === 'string' ? req.query.to.trim() : '';
    const rangeFrom = fromStr ? new Date(fromStr) : null;
    const rangeTo = toStr ? new Date(toStr) : null;
    const now = new Date();
    if (
      !rangeFrom ||
      !rangeTo ||
      Number.isNaN(rangeFrom.getTime()) ||
      Number.isNaN(rangeTo.getTime())
    ) {
      return res.status(400).json({ error: 'Query params from and to must be valid ISO date strings' });
    }
    if (rangeTo <= rangeFrom) {
      return res.status(400).json({ error: 'to must be after from' });
    }

    const r = await pool.query('SELECT settings_json FROM users WHERE id = $1', [req.userId]);
    const raw = r.rows[0]?.settings_json && typeof r.rows[0].settings_json === 'object'
      ? r.rows[0].settings_json
      : {};
    const urls = sanitizeCalendarFeedUrls(raw.calendarFeedUrls);
    const all = [];
    for (const url of urls) {
      try {
        const ics = await fetchIcsText(url);
        const evs = eventsFromIcsForDay(ics, rangeFrom, rangeTo, now, url);
        all.push(...evs);
      } catch (e) {
        console.error('calendar feed fetch failed', url, e?.message || e);
      }
    }
    all.sort((a, b) => a.start.getTime() - b.start.getTime());
    res.json({
      events: all.map((e) => ({
        title: e.title,
        start: e.start.toISOString(),
        end: e.end.toISOString(),
        feedUrl: e.feedUrl,
        ...(e.allDay === true
          ? {
              allDay: true,
              startDay: e.startDay,
              endDayInclusive: e.endDayInclusive,
            }
          : {}),
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load calendar events' });
  }
});

export default router;
