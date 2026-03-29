import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import {
  similarNotesMinCharsEnvDefault,
  sanitizeSimilarNotesMinChars,
} from '../config/similarNotes.js';

const router = Router();

const NOTE_TYPES = ['note', 'event', 'person', 'organization'];
const NOTE_HISTORY_MAX = 20;

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
      out[tid][fk] = { view, viewMobile, cards };
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
    res.json({
      noteTypeColors,
      similarNotesMinChars: similarStored === undefined ? null : similarStored,
      similarNotesMinDefault: similarNotesMinCharsEnvDefault(),
      similarNotesLimitResultsToMinChars: similarLimitResults,
      noteHistory,
      campusLayouts,
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

    await pool.query('UPDATE users SET settings_json = $1::jsonb WHERE id = $2', [
      JSON.stringify(cur),
      req.userId,
    ]);
    const outColors = sanitizeNoteTypeColors(cur.noteTypeColors);
    const outSimilar = sanitizeSimilarNotesMinChars(cur.similarNotesMinChars);
    const outHistory = sanitizeNoteHistory(cur.noteHistory);
    const outLimitResults = cur.similarNotesLimitResultsToMinChars === true;
    const outCampus = sanitizeCampusLayouts(cur.campusLayouts);
    res.json({
      noteTypeColors: outColors,
      similarNotesMinChars: outSimilar === undefined ? null : outSimilar,
      similarNotesMinDefault: similarNotesMinCharsEnvDefault(),
      similarNotesLimitResultsToMinChars: outLimitResults,
      noteHistory: outHistory,
      campusLayouts: outCampus,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

export default router;
