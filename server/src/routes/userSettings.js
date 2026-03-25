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

router.get('/settings', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT settings_json FROM users WHERE id = $1', [req.userId]);
    const row = r.rows[0];
    const raw = row?.settings_json && typeof row.settings_json === 'object' ? row.settings_json : {};
    const noteTypeColors = sanitizeNoteTypeColors(raw.noteTypeColors);
    const similarStored = sanitizeSimilarNotesMinChars(raw.similarNotesMinChars);
    const noteHistory = sanitizeNoteHistory(raw.noteHistory);
    res.json({
      noteTypeColors,
      similarNotesMinChars: similarStored === undefined ? null : similarStored,
      similarNotesMinDefault: similarNotesMinCharsEnvDefault(),
      noteHistory,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.patch('/settings', requireAuth, async (req, res) => {
  try {
    const { noteTypeColors, similarNotesMinChars, noteHistory } = req.body ?? {};
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

    if (noteHistory !== undefined) {
      if (noteHistory === null) {
        delete cur.noteHistory;
      } else {
        const cleaned = sanitizeNoteHistory(noteHistory);
        cur.noteHistory = cleaned;
      }
    }

    await pool.query('UPDATE users SET settings_json = $1::jsonb WHERE id = $2', [
      JSON.stringify(cur),
      req.userId,
    ]);
    const outColors = sanitizeNoteTypeColors(cur.noteTypeColors);
    const outSimilar = sanitizeSimilarNotesMinChars(cur.similarNotesMinChars);
    const outHistory = sanitizeNoteHistory(cur.noteHistory);
    res.json({
      noteTypeColors: outColors,
      similarNotesMinChars: outSimilar === undefined ? null : outSimilar,
      similarNotesMinDefault: similarNotesMinCharsEnvDefault(),
      noteHistory: outHistory,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

export default router;
