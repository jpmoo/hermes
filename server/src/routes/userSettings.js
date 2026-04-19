import { Router } from 'express';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { MAX_BYTES } from '../services/noteFileBlobs.js';
import {
  similarNotesMinCharsEnvDefault,
  sanitizeSimilarNotesMinChars,
} from '../config/similarNotes.js';
import {
  eventsFromIcsForDay,
  fetchIcsText,
  isAllowedCalendarFeedUrl,
} from '../services/calendarFeedEvents.js';
import { createSpaztickExternalTask } from '../services/spaztickTask.js';
import { appendHermesLinkToNotes, buildHermesStreamUrl } from '../services/hermesNoteLink.js';

const router = Router();

const userBgUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.min(MAX_BYTES, 25 * 1024 * 1024) },
});

const USER_BG_IMAGE_MIME = /^image\/(jpeg|png|gif|webp|avif|bmp)$/i;

const MAX_CALENDAR_FEEDS = 12;
const MAX_FEED_URL_LEN = 2048;
const MAX_FEED_NAME_LEN = 80;

const MIN_INGEST_API_KEY_LEN = 16;
const MAX_INGEST_API_KEY_LEN = 512;

/** @returns {{ action: 'omit' } | { action: 'clear' } | { action: 'set', value: string } | { action: 'invalid' }} */
function parseIngestApiKeyPatch(input) {
  if (input === undefined) return { action: 'omit' };
  if (input === null) return { action: 'clear' };
  if (typeof input !== 'string') return { action: 'invalid' };
  const s = input.trim();
  if (s.length === 0) return { action: 'clear' };
  if (s.length < MIN_INGEST_API_KEY_LEN || s.length > MAX_INGEST_API_KEY_LEN) return { action: 'invalid' };
  return { action: 'set', value: s };
}

/**
 * @returns {{ url: string, name: string }[]}
 */
function sanitizeCalendarFeeds(input) {
  if (input == null || !Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const item of input) {
    if (typeof item === 'string') {
      const t = item.trim();
      if (!t || t.length > MAX_FEED_URL_LEN) continue;
      if (!isAllowedCalendarFeedUrl(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      out.push({ url: t, name: '' });
      if (out.length >= MAX_CALENDAR_FEEDS) break;
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const url = typeof item.url === 'string' ? item.url.trim() : '';
    if (!url || url.length > MAX_FEED_URL_LEN) continue;
    if (!isAllowedCalendarFeedUrl(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const name =
      typeof item.name === 'string' ? item.name.trim().slice(0, MAX_FEED_NAME_LEN) : '';
    out.push({ url, name });
    if (out.length >= MAX_CALENDAR_FEEDS) break;
  }
  return out;
}

/** Migrate legacy `calendarFeedUrls: string[]` to feeds with optional names. */
function calendarFeedsFromStored(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const feeds = Array.isArray(raw.calendarFeeds) ? raw.calendarFeeds : null;
  if (feeds && feeds.length > 0) {
    const cleaned = sanitizeCalendarFeeds(feeds);
    if (cleaned.length > 0) return cleaned;
  }
  if (Array.isArray(raw.calendarFeedUrls)) {
    return sanitizeCalendarFeeds(raw.calendarFeedUrls);
  }
  return [];
}

function sanitizeCalendarLookoutDays(input) {
  if (input == null || input === '') return 0;
  const n = Math.round(Number(input));
  if (!Number.isFinite(n)) return 0;
  return Math.max(-10, Math.min(10, n));
}

function calendarLookoutDaysFromStored(raw) {
  if (!raw || typeof raw !== 'object') return 0;
  return sanitizeCalendarLookoutDays(raw.calendarLookoutDays);
}

function settingsJsonHasKey(raw, key) {
  return raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, key);
}

function sanitizeTheme(input) {
  if (input == null) return undefined;
  if (input === 'light' || input === 'dark') return input;
  return undefined;
}

/** @returns {'light' | 'dark'} */
function themeFromStored(raw) {
  if (!raw || typeof raw !== 'object') return 'light';
  const t = sanitizeTheme(raw.theme);
  return t === 'dark' ? 'dark' : 'light';
}

function streamThreadImageBgOpacityFromStored(raw) {
  if (!raw || typeof raw !== 'object') return 0.28;
  const n = Number(raw.streamThreadImageBgOpacity);
  if (!Number.isFinite(n)) return 0.28;
  return Math.min(1, Math.max(0, n));
}

function streamThreadImageBgEnabledFromStored(raw) {
  if (!raw || typeof raw !== 'object') return false;
  return raw.streamThreadImageBgEnabled === true;
}

/** Default true: slow drift animation; false = fixed centered cover. */
function streamBackgroundAnimateFromStored(raw) {
  if (!raw || typeof raw !== 'object') return true;
  return raw.streamBackgroundAnimate !== false;
}

/** Horizontal scanline mask on background image (CRT-style). */
function streamBackgroundCrtEffectFromStored(raw) {
  if (!raw || typeof raw !== 'object') return false;
  return raw.streamBackgroundCrtEffect === true;
}

function streamRootBackgroundOpacityFromStored(raw) {
  if (!raw || typeof raw !== 'object') return 0.28;
  const n = Number(raw.streamRootBackgroundOpacity);
  if (!Number.isFinite(n)) return 0.28;
  return Math.min(1, Math.max(0, n));
}

function canvasUseStreamRootBackgroundFromStored(raw) {
  if (!raw || typeof raw !== 'object') return false;
  return raw.canvasUseStreamRootBackground === true;
}

async function streamRootBackgroundPresentForUser(userId) {
  try {
    const r = await pool.query('SELECT 1 FROM user_background_blobs WHERE user_id = $1 LIMIT 1', [userId]);
    return r.rows.length > 0;
  } catch (e) {
    if (e && e.code === '42P01') return false;
    throw e;
  }
}

const HOVER_INSIGHT_TYPES = new Set(['note', 'organization', 'person', 'event']);

function clampHoverPct(n, fallback) {
  if (n == null || n === '') return fallback;
  const x = Math.round(Number(n));
  if (!Number.isFinite(x)) return fallback;
  return Math.min(95, Math.max(5, x));
}

function sanitizeHoverRagdollContext(input) {
  if (!input || typeof input !== 'object') {
    return {
      includeParent: false,
      includeSiblings: false,
      includeChildren: false,
      includeConnected: true,
    };
  }
  return {
    includeParent: Boolean(input.includeParent),
    includeSiblings: Boolean(input.includeSiblings),
    includeChildren: Boolean(input.includeChildren),
    includeConnected: input.includeConnected !== false,
  };
}

function sanitizeHoverSimilarVisibleTypes(input) {
  if (!Array.isArray(input)) return ['note', 'event', 'person', 'organization'];
  const out = [];
  const seen = new Set();
  for (const t of input) {
    if (typeof t === 'string' && HOVER_INSIGHT_TYPES.has(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  if (out.length === 0) return ['note', 'event', 'person', 'organization'];
  return out;
}

/**
 * Normalizes hover-insight UI prefs (theme companion: insight panel sliders / RAG toggles).
 * @returns {{
 *   ragdollContext: object,
 *   ragdollQuerySimilarityMinPct: number,
 *   similarMinPct: number,
 *   similarVisibleTypes: string[],
 * }}
 */
function normalizeHoverInsightObject(hi) {
  const base = {
    ragdollContext: sanitizeHoverRagdollContext(null),
    ragdollQuerySimilarityMinPct: 45,
    similarMinPct: 25,
    similarVisibleTypes: ['note', 'event', 'person', 'organization'],
  };
  if (!hi || typeof hi !== 'object') return base;
  return {
    ragdollContext: sanitizeHoverRagdollContext({
      ...base.ragdollContext,
      ...(hi.ragdollContext && typeof hi.ragdollContext === 'object' ? hi.ragdollContext : {}),
    }),
    ragdollQuerySimilarityMinPct: clampHoverPct(
      hi.ragdollQuerySimilarityMinPct != null ? hi.ragdollQuerySimilarityMinPct : base.ragdollQuerySimilarityMinPct,
      45
    ),
    similarMinPct: clampHoverPct(hi.similarMinPct != null ? hi.similarMinPct : base.similarMinPct, 25),
    similarVisibleTypes:
      hi.similarVisibleTypes !== undefined
        ? sanitizeHoverSimilarVisibleTypes(hi.similarVisibleTypes)
        : base.similarVisibleTypes,
  };
}

function hoverInsightFromStored(raw) {
  if (!raw || typeof raw !== 'object' || raw.hoverInsight == null || typeof raw.hoverInsight !== 'object') {
    return normalizeHoverInsightObject(null);
  }
  return normalizeHoverInsightObject(raw.hoverInsight);
}

const NOTE_TYPES = ['note', 'event', 'person', 'organization'];

const DEFAULT_START_PAGES = ['stream', 'canvas', 'outline', 'calendar', 'search'];

function sanitizeDefaultStartPage(input) {
  if (input == null) return undefined;
  if (typeof input !== 'string') return undefined;
  const v = input.trim().toLowerCase();
  return DEFAULT_START_PAGES.includes(v) ? v : undefined;
}

function defaultStartPageFromStored(raw) {
  const s = sanitizeDefaultStartPage(raw);
  return s ?? 'stream';
}

/** Phone layout; if unset, match desktop/tablet (`defaultStartPage`) for older accounts. */
function defaultStartPagePhoneFromStored(raw) {
  if (!raw || typeof raw !== 'object') return 'stream';
  const p = sanitizeDefaultStartPage(raw.defaultStartPagePhone);
  if (p !== undefined) return p;
  return defaultStartPageFromStored(raw.defaultStartPage);
}
const NOTE_HISTORY_MAX = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const STREAM_THREAD_SORT_MODES = new Set([
  'datetime_asc',
  'datetime_desc',
  'alpha_asc',
  'alpha_desc',
]);

function migrateStreamSortMode(mode) {
  if (typeof mode !== 'string') return 'datetime_asc';
  if (STREAM_THREAD_SORT_MODES.has(mode)) return mode;
  if (mode === 'edit_asc' || mode === 'schedule_asc') return 'datetime_asc';
  if (mode === 'edit_desc' || mode === 'schedule_desc') return 'datetime_desc';
  if (mode === 'alpha_asc') return 'alpha_asc';
  if (mode === 'alpha_desc') return 'alpha_desc';
  return 'datetime_asc';
}
const MAX_STREAM_THREAD_SORT_KEYS = 160;

function sanitizeStreamThreadSortMap(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  let n = 0;
  for (const [tid, v] of Object.entries(input)) {
    if (n++ >= MAX_STREAM_THREAD_SORT_KEYS) break;
    if (typeof tid !== 'string' || !UUID_RE.test(tid.trim())) continue;
    const id = tid.trim().toLowerCase();
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const sortMode = migrateStreamSortMode(v.sortMode);
    const starredFirst = v.starredFirst === false ? false : true;
    out[id] = { sortMode, starredFirst };
  }
  return out;
}

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

function sanitizeCanvasArrangement(input) {
  if (input === 'keep' || input === 'manual' || input === 'vertical' || input === 'horizontal') {
    return input;
  }
  return 'manual';
}

function sanitizeManualNewNoteAnchor(input) {
  if (input === 'last') return 'last';
  return 'focus';
}

function sanitizeAutoFocusAlign(input) {
  if (input === 'start' || input === 'center' || input === 'end') return input;
  return 'center';
}

function sanitizeCanvasConnectorMode(input) {
  if (input === 'thread_chain' || input === 'focus_to_children' || input === 'none') return input;
  return 'thread_chain';
}

/** Canvas layouts in settings_json: per-thread, per-focus view(s) + card rects. Legacy key `campusLayouts` is read once and migrated to `canvasLayouts`. */
function sanitizeCanvasLayouts(input) {
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
      const canvasArrangement = sanitizeCanvasArrangement(block.canvasArrangement);
      const connectorMode = sanitizeCanvasConnectorMode(block.connectorMode);
      const manualNewNoteAnchor = sanitizeManualNewNoteAnchor(block.manualNewNoteAnchor);
      const autoFocusAlign = sanitizeAutoFocusAlign(block.autoFocusAlign);
      const blockOut = {
        view,
        viewMobile,
        cards,
        canvasArrangement,
        connectorMode,
        manualNewNoteAnchor,
        autoFocusAlign,
      };
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
    const layoutRaw =
      raw.canvasLayouts != null ? raw.canvasLayouts : raw.campusLayouts;
    const canvasLayouts = sanitizeCanvasLayouts(layoutRaw);
    const inboxThreadRootId = sanitizeInboxThreadRootId(raw.inboxThreadRootId);
    const spUrl = sanitizeSpaztickApiUrl(raw.spaztickApiUrl);
    const spKeyStored = typeof raw.spaztickApiKey === 'string' && raw.spaztickApiKey.trim().length > 0;
    const ingestApiKeySet =
      typeof raw.ingestApiKeyHash === 'string' && raw.ingestApiKeyHash.trim().length > 0;
    const calendarFeeds = calendarFeedsFromStored(raw);
    const markdownListAlternatingShades = raw.markdownListAlternatingShades !== false;
    const outTheme = themeFromStored(raw);
    const outHoverInsight = hoverInsightFromStored(raw);
    const streamThreadSort = sanitizeStreamThreadSortMap(raw.streamThreadSort);
    const streamThreadImageBgEnabled = streamThreadImageBgEnabledFromStored(raw);
    const streamThreadImageBgOpacity = streamThreadImageBgOpacityFromStored(raw);
    const streamBackgroundAnimate = streamBackgroundAnimateFromStored(raw);
    const streamBackgroundCrtEffect = streamBackgroundCrtEffectFromStored(raw);
    const streamRootBackgroundOpacity = streamRootBackgroundOpacityFromStored(raw);
    const canvasUseStreamRootBackground = canvasUseStreamRootBackgroundFromStored(raw);
    const streamRootBackgroundPresent = await streamRootBackgroundPresentForUser(req.userId);
    res.json({
      noteTypeColors,
      similarNotesMinChars: similarStored === undefined ? null : similarStored,
      similarNotesMinDefault: similarNotesMinCharsEnvDefault(),
      similarNotesLimitResultsToMinChars: similarLimitResults,
      markdownListAlternatingShades,
      noteHistory,
      canvasLayouts,
      defaultStartPage: defaultStartPageFromStored(raw.defaultStartPage),
      defaultStartPagePhone: defaultStartPagePhoneFromStored(raw),
      inboxThreadRootId: inboxThreadRootId === undefined ? null : inboxThreadRootId,
      spaztickApiUrl: spUrl === undefined ? null : spUrl,
      spaztickApiKeySet: spKeyStored,
      ingestApiKeySet,
      calendarFeeds,
      calendarLookoutDays: calendarLookoutDaysFromStored(raw),
      theme: outTheme,
      hoverInsight: outHoverInsight,
      /** True once the key exists in settings_json (client may migrate from localStorage when false). */
      settingsThemeWasSet: settingsJsonHasKey(raw, 'theme'),
      settingsHoverInsightWasSet: settingsJsonHasKey(raw, 'hoverInsight'),
      streamThreadSort,
      streamThreadImageBgEnabled,
      streamThreadImageBgOpacity,
      streamBackgroundAnimate,
      streamBackgroundCrtEffect,
      streamRootBackgroundPresent,
      streamRootBackgroundOpacity,
      canvasUseStreamRootBackground,
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
      canvasLayouts,
      defaultStartPage,
      defaultStartPagePhone,
      inboxThreadRootId,
      spaztickApiUrl,
      spaztickApiKey,
      ingestApiKey,
      calendarFeeds,
      calendarFeedUrls,
      calendarLookoutDays,
      markdownListAlternatingShades,
      theme,
      hoverInsight,
      streamThreadSort,
      streamThreadImageBgEnabled,
      streamThreadImageBgOpacity,
      streamBackgroundAnimate,
      streamBackgroundCrtEffect,
      streamRootBackgroundOpacity,
      canvasUseStreamRootBackground,
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

    if (canvasLayouts !== undefined) {
      if (canvasLayouts === null) {
        delete cur.canvasLayouts;
        delete cur.campusLayouts;
      } else {
        cur.canvasLayouts = sanitizeCanvasLayouts(canvasLayouts);
        delete cur.campusLayouts;
      }
    }

    if (defaultStartPage !== undefined) {
      if (defaultStartPage === null) {
        delete cur.defaultStartPage;
      } else {
        const dsp = sanitizeDefaultStartPage(defaultStartPage);
        if (dsp === undefined) {
          return res.status(400).json({
            error:
              'defaultStartPage must be one of stream, canvas, outline, calendar, search, or null',
          });
        }
        cur.defaultStartPage = dsp;
      }
    }

    if (defaultStartPagePhone !== undefined) {
      if (defaultStartPagePhone === null) {
        delete cur.defaultStartPagePhone;
      } else {
        const dsp = sanitizeDefaultStartPage(defaultStartPagePhone);
        if (dsp === undefined) {
          return res.status(400).json({
            error:
              'defaultStartPagePhone must be one of stream, canvas, outline, calendar, search, or null',
          });
        }
        cur.defaultStartPagePhone = dsp;
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

    if (ingestApiKey !== undefined) {
      const parsed = parseIngestApiKeyPatch(ingestApiKey);
      if (parsed.action === 'invalid') {
        return res.status(400).json({
          error: `ingestApiKey must be null/empty to remove, or a secret of ${MIN_INGEST_API_KEY_LEN}–${MAX_INGEST_API_KEY_LEN} characters`,
        });
      }
      if (parsed.action === 'clear') {
        delete cur.ingestApiKeyHash;
      } else if (parsed.action === 'set') {
        cur.ingestApiKeyHash = await bcrypt.hash(parsed.value, 10);
      }
    }

    const calendarFeedsPayload =
      calendarFeeds !== undefined ? calendarFeeds : calendarFeedUrls;
    if (calendarFeedsPayload !== undefined) {
      if (calendarFeedsPayload === null) {
        delete cur.calendarFeeds;
        delete cur.calendarFeedUrls;
      } else if (!Array.isArray(calendarFeedsPayload)) {
        return res.status(400).json({
          error: 'calendarFeeds must be an array of { url, name? } (or legacy URL strings) or null',
        });
      } else {
        const cleaned = sanitizeCalendarFeeds(calendarFeedsPayload);
        if (cleaned.length === 0) {
          delete cur.calendarFeeds;
          delete cur.calendarFeedUrls;
        } else {
          cur.calendarFeeds = cleaned;
          delete cur.calendarFeedUrls;
        }
      }
    }

    if (calendarLookoutDays !== undefined) {
      if (calendarLookoutDays === null) {
        delete cur.calendarLookoutDays;
      } else {
        cur.calendarLookoutDays = sanitizeCalendarLookoutDays(calendarLookoutDays);
      }
    }

    if (markdownListAlternatingShades !== undefined) {
      if (markdownListAlternatingShades === null) {
        delete cur.markdownListAlternatingShades;
      } else if (
        markdownListAlternatingShades !== true &&
        markdownListAlternatingShades !== false
      ) {
        return res
          .status(400)
          .json({ error: 'markdownListAlternatingShades must be true, false, or null' });
      } else {
        cur.markdownListAlternatingShades = markdownListAlternatingShades;
      }
    }

    if (streamThreadImageBgEnabled !== undefined) {
      if (streamThreadImageBgEnabled === null) {
        delete cur.streamThreadImageBgEnabled;
      } else if (streamThreadImageBgEnabled !== true && streamThreadImageBgEnabled !== false) {
        return res
          .status(400)
          .json({ error: 'streamThreadImageBgEnabled must be true, false, or null' });
      } else {
        cur.streamThreadImageBgEnabled = streamThreadImageBgEnabled;
      }
    }

    if (streamThreadImageBgOpacity !== undefined) {
      if (streamThreadImageBgOpacity === null) {
        delete cur.streamThreadImageBgOpacity;
      } else {
        const n = Number(streamThreadImageBgOpacity);
        if (!Number.isFinite(n)) {
          return res
            .status(400)
            .json({ error: 'streamThreadImageBgOpacity must be a number from 0 to 1, or null' });
        }
        cur.streamThreadImageBgOpacity = Math.min(1, Math.max(0, n));
      }
    }

    if (streamBackgroundAnimate !== undefined) {
      if (streamBackgroundAnimate === null) {
        delete cur.streamBackgroundAnimate;
      } else if (streamBackgroundAnimate !== true && streamBackgroundAnimate !== false) {
        return res
          .status(400)
          .json({ error: 'streamBackgroundAnimate must be true, false, or null' });
      } else {
        cur.streamBackgroundAnimate = streamBackgroundAnimate;
      }
    }

    if (streamBackgroundCrtEffect !== undefined) {
      if (streamBackgroundCrtEffect === null) {
        delete cur.streamBackgroundCrtEffect;
      } else if (streamBackgroundCrtEffect !== true && streamBackgroundCrtEffect !== false) {
        return res
          .status(400)
          .json({ error: 'streamBackgroundCrtEffect must be true, false, or null' });
      } else {
        cur.streamBackgroundCrtEffect = streamBackgroundCrtEffect;
      }
    }

    if (streamRootBackgroundOpacity !== undefined) {
      if (streamRootBackgroundOpacity === null) {
        delete cur.streamRootBackgroundOpacity;
      } else {
        const n = Number(streamRootBackgroundOpacity);
        if (!Number.isFinite(n)) {
          return res
            .status(400)
            .json({ error: 'streamRootBackgroundOpacity must be a number from 0 to 1, or null' });
        }
        cur.streamRootBackgroundOpacity = Math.min(1, Math.max(0, n));
      }
    }

    if (canvasUseStreamRootBackground !== undefined) {
      if (canvasUseStreamRootBackground === null) {
        delete cur.canvasUseStreamRootBackground;
      } else if (canvasUseStreamRootBackground !== true && canvasUseStreamRootBackground !== false) {
        return res
          .status(400)
          .json({ error: 'canvasUseStreamRootBackground must be true, false, or null' });
      } else {
        cur.canvasUseStreamRootBackground = canvasUseStreamRootBackground;
      }
    }

    if (theme !== undefined) {
      if (theme === null) {
        delete cur.theme;
      } else {
        const t = sanitizeTheme(theme);
        if (t === undefined) {
          return res.status(400).json({ error: 'theme must be light, dark, or null' });
        }
        cur.theme = t;
      }
    }

    if (hoverInsight !== undefined) {
      if (hoverInsight === null) {
        delete cur.hoverInsight;
      } else if (typeof hoverInsight !== 'object' || Array.isArray(hoverInsight)) {
        return res.status(400).json({ error: 'hoverInsight must be an object or null' });
      } else {
        const prev = cur.hoverInsight && typeof cur.hoverInsight === 'object' ? cur.hoverInsight : {};
        const prevRc = prev.ragdollContext && typeof prev.ragdollContext === 'object' ? prev.ragdollContext : {};
        const patchRc =
          hoverInsight.ragdollContext && typeof hoverInsight.ragdollContext === 'object'
            ? hoverInsight.ragdollContext
            : {};
        cur.hoverInsight = normalizeHoverInsightObject({
          ...prev,
          ...hoverInsight,
          ragdollContext: { ...prevRc, ...patchRc },
        });
      }
    }

    if (streamThreadSort !== undefined) {
      if (streamThreadSort === null) {
        delete cur.streamThreadSort;
      } else if (typeof streamThreadSort !== 'object' || Array.isArray(streamThreadSort)) {
        return res.status(400).json({ error: 'streamThreadSort must be an object or null' });
      } else {
        cur.streamThreadSort = sanitizeStreamThreadSortMap(streamThreadSort);
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
    const outLayoutsRaw =
      cur.canvasLayouts != null ? cur.canvasLayouts : cur.campusLayouts;
    const outCanvas = sanitizeCanvasLayouts(outLayoutsRaw);
    const outInbox = sanitizeInboxThreadRootId(cur.inboxThreadRootId);
    const outSpUrl = sanitizeSpaztickApiUrl(cur.spaztickApiUrl);
    const outSpKeySet = typeof cur.spaztickApiKey === 'string' && cur.spaztickApiKey.trim().length > 0;
    const outIngestApiKeySet =
      typeof cur.ingestApiKeyHash === 'string' && cur.ingestApiKeyHash.trim().length > 0;
    const outCalendarFeeds = calendarFeedsFromStored(cur);
    const outListAlt = cur.markdownListAlternatingShades !== false;
    const outTheme = themeFromStored(cur);
    const outHoverInsight = hoverInsightFromStored(cur);
    const outStreamThreadSort = sanitizeStreamThreadSortMap(cur.streamThreadSort);
    const outStreamThreadImageBgEnabled = streamThreadImageBgEnabledFromStored(cur);
    const outStreamThreadImageBgOpacity = streamThreadImageBgOpacityFromStored(cur);
    const outStreamBackgroundAnimate = streamBackgroundAnimateFromStored(cur);
    const outStreamBackgroundCrtEffect = streamBackgroundCrtEffectFromStored(cur);
    const outStreamRootBackgroundOpacity = streamRootBackgroundOpacityFromStored(cur);
    const outCanvasUseStreamRootBackground = canvasUseStreamRootBackgroundFromStored(cur);
    const outStreamRootBackgroundPresent = await streamRootBackgroundPresentForUser(req.userId);
    res.json({
      noteTypeColors: outColors,
      similarNotesMinChars: outSimilar === undefined ? null : outSimilar,
      similarNotesMinDefault: similarNotesMinCharsEnvDefault(),
      similarNotesLimitResultsToMinChars: outLimitResults,
      markdownListAlternatingShades: outListAlt,
      noteHistory: outHistory,
      canvasLayouts: outCanvas,
      defaultStartPage: defaultStartPageFromStored(cur.defaultStartPage),
      defaultStartPagePhone: defaultStartPagePhoneFromStored(cur),
      inboxThreadRootId: outInbox === undefined ? null : outInbox,
      spaztickApiUrl: outSpUrl === undefined ? null : outSpUrl,
      spaztickApiKeySet: outSpKeySet,
      ingestApiKeySet: outIngestApiKeySet,
      calendarFeeds: outCalendarFeeds,
      calendarLookoutDays: calendarLookoutDaysFromStored(cur),
      theme: outTheme,
      hoverInsight: outHoverInsight,
      settingsThemeWasSet: settingsJsonHasKey(cur, 'theme'),
      settingsHoverInsightWasSet: settingsJsonHasKey(cur, 'hoverInsight'),
      streamThreadSort: outStreamThreadSort,
      streamThreadImageBgEnabled: outStreamThreadImageBgEnabled,
      streamThreadImageBgOpacity: outStreamThreadImageBgOpacity,
      streamBackgroundAnimate: outStreamBackgroundAnimate,
      streamBackgroundCrtEffect: outStreamBackgroundCrtEffect,
      streamRootBackgroundPresent: outStreamRootBackgroundPresent,
      streamRootBackgroundOpacity: outStreamRootBackgroundOpacity,
      canvasUseStreamRootBackground: outCanvasUseStreamRootBackground,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

/** GET account background image (auth); use with fetch + blob URL in the app. */
router.get('/background', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT data, mime_type, filename FROM user_background_blobs WHERE user_id = $1`,
      [req.userId]
    );
    if (r.rows.length === 0) return res.status(404).end();
    const row = r.rows[0];
    const safeName = (row.filename || 'background').replace(/[^\w.\-()+ ]/g, '_');
    res.setHeader('Content-Type', row.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    res.setHeader('Cache-Control', 'private, max-age=120');
    res.send(row.data);
  } catch (err) {
    if (err && err.code === '42P01') {
      return res.status(503).json({ error: 'Background storage not initialized' });
    }
    console.error(err);
    res.status(500).end();
  }
});

router.post(
  '/background',
  requireAuth,
  (req, res, next) => {
    userBgUpload.single('file')(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File exceeds upload size limit` });
      }
      if (err) return next(err);
      next();
    });
  },
  async (req, res) => {
    try {
      const f = req.file;
      if (!f?.buffer?.length) {
        return res.status(400).json({ error: 'No file (multipart field name: file)' });
      }
      if (!USER_BG_IMAGE_MIME.test(f.mimetype || '')) {
        return res.status(400).json({
          error: 'Background must be an image (JPEG, PNG, GIF, WebP, AVIF, or BMP)',
        });
      }
      const filename = (f.originalname || 'background').slice(0, 512);
      await pool.query(
        `INSERT INTO user_background_blobs (user_id, filename, mime_type, byte_size, data, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (user_id) DO UPDATE SET
           filename = EXCLUDED.filename,
           mime_type = EXCLUDED.mime_type,
           byte_size = EXCLUDED.byte_size,
           data = EXCLUDED.data,
           updated_at = now()`,
        [req.userId, filename, f.mimetype, f.buffer.length, f.buffer]
      );
      res.status(201).json({ ok: true, streamRootBackgroundPresent: true });
    } catch (err) {
      if (err && err.code === '42P01') {
        return res.status(503).json({ error: 'Background storage not initialized' });
      }
      console.error(err);
      res.status(500).json({ error: 'Upload failed' });
    }
  }
);

router.delete('/background', requireAuth, async (req, res) => {
  try {
    await pool.query(`DELETE FROM user_background_blobs WHERE user_id = $1`, [req.userId]);
    res.status(204).send();
  } catch (err) {
    if (err && err.code === '42P01') {
      return res.status(503).json({ error: 'Background storage not initialized' });
    }
    console.error(err);
    res.status(500).json({ error: 'Failed to remove background' });
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
    const feeds = calendarFeedsFromStored(raw);
    const all = [];
    for (const { url, name } of feeds) {
      try {
        const ics = await fetchIcsText(url);
        const evs = eventsFromIcsForDay(ics, rangeFrom, rangeTo, now, url, name);
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
        feedName: e.feedName || '',
        ...(e.description ? { description: e.description } : {}),
        ...(Array.isArray(e.attendees) && e.attendees.length > 0 ? { attendees: e.attendees } : {}),
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

/** Create a Spaztick task with an explicit title and optional notes (e.g. checklist line → task, no note body). */
router.post('/spaztick-task', requireAuth, async (req, res) => {
  try {
    const titleRaw = req.body?.title;
    const notesRaw = req.body?.notes;
    const hermesNoteUrlRaw = req.body?.hermesNoteUrl;
    const noteIdRaw = req.body?.noteId;
    if (typeof titleRaw !== 'string' || !titleRaw.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }
    const title = titleRaw.trim().slice(0, 200);
    const notes = notesRaw == null || notesRaw === '' ? '' : String(notesRaw);

    let clientHttpUrl = null;
    if (typeof hermesNoteUrlRaw === 'string') {
      const u = hermesNoteUrlRaw.trim();
      if (/^https?:\/\//i.test(u) && u.length <= 2048) clientHttpUrl = u;
    }
    let candidateNoteId = null;
    if (typeof noteIdRaw === 'string' && /^[0-9a-f-]{36}$/i.test(noteIdRaw.trim())) {
      candidateNoteId = noteIdRaw.trim().toLowerCase();
    }

    let serverHttpUrl = null;
    let verifiedNoteId = null;
    if (candidateNoteId) {
      const own = await pool.query('SELECT 1 FROM notes WHERE id = $1::uuid AND user_id = $2', [
        candidateNoteId,
        req.userId,
      ]);
      if (own.rows.length > 0) {
        verifiedNoteId = candidateNoteId;
        serverHttpUrl = buildHermesStreamUrl(candidateNoteId, req);
      }
    }
    const httpUrl = clientHttpUrl || serverHttpUrl;
    const notesWithHermes = appendHermesLinkToNotes(notes, { httpUrl, noteId: verifiedNoteId });

    const settingsR = await pool.query('SELECT settings_json FROM users WHERE id = $1', [req.userId]);
    const raw = settingsR.rows[0]?.settings_json && typeof settingsR.rows[0].settings_json === 'object'
      ? settingsR.rows[0].settings_json
      : {};
    const baseUrl =
      typeof raw.spaztickApiUrl === 'string' ? raw.spaztickApiUrl.trim().replace(/\/$/, '') : '';
    const apiKey =
      typeof raw.spaztickApiKey === 'string' ? raw.spaztickApiKey.trim() : '';
    if (!baseUrl || !apiKey) {
      return res.status(400).json({
        error: 'Configure Spaztick API URL and API key in Settings',
        code: 'SPAZTICK_NOT_CONFIGURED',
      });
    }
    try {
      const u = new URL(baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return res.status(400).json({ error: 'Spaztick API URL must be http or https' });
      }
    } catch {
      return res.status(400).json({ error: 'Invalid Spaztick API URL in Settings' });
    }

    const task = await createSpaztickExternalTask({
      baseUrl,
      apiKey,
      title,
      notes: notesWithHermes,
    });
    res.status(201).json({ title, task });
  } catch (err) {
    console.error('spaztick-task:', err);
    const msg = err?.message || 'Failed to create Spaztick task';
    const code = err.status;
    const status =
      typeof code === 'number' && code >= 400 && code < 600 ? code : 502;
    res.status(status).json({ error: msg });
  }
});

export default router;
