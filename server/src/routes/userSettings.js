import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const NOTE_TYPES = ['note', 'event', 'person', 'organization'];

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

router.get('/settings', requireAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT settings_json FROM users WHERE id = $1', [req.userId]);
    const row = r.rows[0];
    const raw = row?.settings_json && typeof row.settings_json === 'object' ? row.settings_json : {};
    const noteTypeColors = sanitizeNoteTypeColors(raw.noteTypeColors);
    res.json({ noteTypeColors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.patch('/settings', requireAuth, async (req, res) => {
  try {
    const { noteTypeColors } = req.body ?? {};
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

    await pool.query('UPDATE users SET settings_json = $1::jsonb WHERE id = $2', [
      JSON.stringify(cur),
      req.userId,
    ]);
    const outColors = sanitizeNoteTypeColors(cur.noteTypeColors);
    res.json({ noteTypeColors: outColors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

export default router;
