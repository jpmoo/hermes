import { Router } from 'express';
import express from 'express';
import multer from 'multer';
import pool from '../db/pool.js';
import { requireIngestAuth } from '../middleware/ingestAuth.js';
import { embedNote } from '../services/embedding.js';
import { MAX_BYTES } from '../services/noteFileBlobs.js';

const router = Router();

const NOTE_RETURNING =
  'id, parent_id, content, created_at, updated_at, last_activity_at, starred, external_anchor, note_type, event_start_at, event_end_at';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 20 },
});

function inboxRootFromSettings(settingsJson) {
  const raw = settingsJson?.inboxThreadRootId;
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  return t.length > 0 ? t : null;
}

/**
 * POST /api/ingest/notes
 * Body: { content: string, parent_id?: string | null, external_anchor?: string | null }
 * If parent_id is omitted, uses Settings → Inbox root thread (must be set).
 */
router.post('/notes', express.json({ limit: '4mb' }), requireIngestAuth, async (req, res) => {
  try {
    const userId = req.userId;
    const body = req.body ?? {};
    const content = typeof body.content === 'string' ? body.content : '';
    const text = content.trim();
    const externalAnchor =
      typeof body.external_anchor === 'string' && body.external_anchor.trim()
        ? body.external_anchor.trim()
        : null;

    const sr = await pool.query('SELECT settings_json FROM users WHERE id = $1', [userId]);
    const sj = sr.rows[0]?.settings_json;
    const inboxRoot = inboxRootFromSettings(sj);

    let parentId;
    if (Object.prototype.hasOwnProperty.call(body, 'parent_id')) {
      const p = body.parent_id;
      if (p == null || p === '') {
        parentId = null;
      } else if (typeof p === 'string') {
        parentId = p.trim() || null;
      } else {
        return res.status(400).json({ error: 'parent_id must be a string, null, or omitted' });
      }
    } else {
      parentId = inboxRoot;
    }

    if (!parentId) {
      return res.status(400).json({
        error:
          'No parent for new note: set Inbox root thread in Settings, or send parent_id (UUID of the note to reply under).',
      });
    }

    const pc = await pool.query('SELECT id FROM notes WHERE id = $1 AND user_id = $2', [parentId, userId]);
    if (pc.rows.length === 0) {
      return res.status(400).json({ error: 'parent_id not found or not yours' });
    }

    const r = await pool.query(
      `INSERT INTO notes (parent_id, content, external_anchor, user_id, note_type, event_start_at, event_end_at)
       VALUES ($1, $2, $3, $4, 'note', NULL, NULL)
       RETURNING ${NOTE_RETURNING}`,
      [parentId, text, externalAnchor, userId]
    );
    const note = r.rows[0];
    embedNote(note.id, note.content).catch(() => {});
    res.status(201).json(note);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create note' });
  }
});

/**
 * POST /api/ingest/notes/:id/attachments
 * Multipart field name: files (same as main API).
 */
router.post(
  '/notes/:id/attachments',
  requireIngestAuth,
  (req, res, next) => {
    upload.array('files', 20)(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File exceeds ${MAX_BYTES} bytes` });
      }
      if (err) return next(err);
      next();
    });
  },
  async (req, res) => {
    try {
      const noteId = req.params.id;
      const userId = req.userId;
      const files = req.files || [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'No files (use multipart field name files)' });
      }
      const noteCheck = await pool.query('SELECT id FROM notes WHERE id = $1 AND user_id = $2', [
        noteId,
        userId,
      ]);
      if (noteCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Note not found' });
      }
      const inserted = [];
      for (const f of files) {
        const buf = f.buffer;
        if (!buf?.length) continue;
        const ins = await pool.query(
          `INSERT INTO note_file_blobs (note_id, user_id, filename, mime_type, byte_size, data)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, filename, mime_type, byte_size`,
          [
            noteId,
            userId,
            f.originalname?.slice(0, 512) || 'file',
            f.mimetype || 'application/octet-stream',
            buf.length,
            buf,
          ]
        );
        inserted.push(ins.rows[0]);
      }
      if (inserted.length === 0) {
        return res.status(400).json({ error: 'No valid files' });
      }
      res.status(201).json(inserted);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Upload failed' });
    }
  }
);

export default router;
