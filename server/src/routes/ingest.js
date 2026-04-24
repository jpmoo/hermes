import { Router } from 'express';
import express from 'express';
import multer from 'multer';
import pool from '../db/pool.js';
import { requireIngestAuth } from '../middleware/ingestAuth.js';
import { embedNote } from '../services/embedding.js';
import { MAX_BYTES } from '../services/noteFileBlobs.js';
import {
  resolveNoteContentFromIngestFile,
  runIngestOcrPipeline,
} from '../services/ingestFileNoteContent.js';
import { logOcr } from '../services/ingestOcrLog.js';
import { proposeTagsForNote } from '../services/aiTags.js';

const router = Router();

const NOTE_RETURNING =
  'id, parent_id, content, created_at, updated_at, last_activity_at, starred, external_anchor, note_type, event_start_at, event_end_at, stream_sibling_index';

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
 * @param {string} userId
 * @param {Record<string, unknown>} body
 * @returns {Promise<{ ok: true, parentId: string } | { ok: false, status: number, error: string }>}
 */
async function resolveIngestParentId(userId, body) {
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
      return { ok: false, status: 400, error: 'parent_id must be a string, null, or omitted' };
    }
  } else {
    parentId = inboxRoot;
  }

  if (!parentId) {
    return {
      ok: false,
      status: 400,
      error:
        'No parent for new note: set Inbox root thread in Settings, or send parent_id (UUID of the note to reply under).',
    };
  }

  const pc = await pool.query('SELECT id FROM notes WHERE id = $1 AND user_id = $2', [parentId, userId]);
  if (pc.rows.length === 0) {
    return { ok: false, status: 400, error: 'parent_id not found or not yours' };
  }

  return { ok: true, parentId };
}

function ingestNotesBodyParser(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) {
    return upload.fields([
      { name: 'file', maxCount: 1 },
      { name: 'files', maxCount: 20 },
    ])(req, res, (err) => {
      if (err?.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File exceeds ${MAX_BYTES} bytes` });
      }
      if (err) return next(err);
      next();
    });
  }
  return express.json({ limit: '4mb' })(req, res, next);
}

/**
 * POST /api/ingest/notes
 * JSON: { content, parent_id?, external_anchor? } — text note (same as before).
 * multipart/form-data: fields parent_id?, external_anchor? and file or files[] — one note per file;
 * PDF/images are OCR’d and summarized when possible; note body is the summary or the raw filename.
 * Each created note includes the uploaded bytes as an attachment.
 */
router.post('/notes', requireIngestAuth, ingestNotesBodyParser, async (req, res) => {
  try {
    const userId = req.userId;

    if (req.is('multipart/form-data')) {
      const raw = req.files;
      const fileList = [...(raw?.file || []), ...(raw?.files || [])];
      if (fileList.length === 0) {
        return res.status(400).json({ error: 'No file (multipart fields: file or files)' });
      }

      const body = req.body ?? {};
      const parentRes = await resolveIngestParentId(userId, body);
      if (!parentRes.ok) {
        return res.status(parentRes.status).json({ error: parentRes.error });
      }
      const { parentId } = parentRes;

      const externalAnchor =
        typeof body.external_anchor === 'string' && body.external_anchor.trim()
          ? body.external_anchor.trim()
          : null;

      const notesOut = [];
      for (const f of fileList) {
        const buf = f.buffer;
        if (!buf?.length) continue;
        const filename = f.originalname?.slice(0, 512) || 'file';
        const mime = f.mimetype || 'application/octet-stream';
        const content = await resolveNoteContentFromIngestFile(buf, filename, mime, { source: 'ingest' });

        const r = await pool.query(
          `INSERT INTO notes (parent_id, content, external_anchor, user_id, note_type, event_start_at, event_end_at, stream_sibling_index)
           VALUES (
             $1, $2, $3, $4, 'note', NULL, NULL,
             COALESCE(
               (SELECT MAX(stream_sibling_index) + 1 FROM notes c WHERE c.parent_id = $1::uuid AND c.user_id = $4::uuid),
               0
             )
           )
           RETURNING ${NOTE_RETURNING}`,
          [parentId, content, externalAnchor, userId]
        );
        const note = r.rows[0];
        embedNote(note.id, note.content).catch(() => {});
        proposeTagsForNote(note.id, note.content, userId).catch(() => {});

        const ins = await pool.query(
          `INSERT INTO note_file_blobs (note_id, user_id, filename, mime_type, byte_size, data, sort_index)
           VALUES ($1, $2, $3, $4, $5, $6, 0)
           RETURNING id, filename, mime_type, byte_size`,
          [note.id, userId, filename, mime, buf.length, buf]
        );
        notesOut.push({ ...note, attachments: [ins.rows[0]] });
      }

      if (notesOut.length === 0) {
        return res.status(400).json({ error: 'No valid files' });
      }

      return res.status(201).json(notesOut);
    }

    const body = req.body ?? {};
    const content = typeof body.content === 'string' ? body.content : '';
    const text = content.trim();
    const externalAnchor =
      typeof body.external_anchor === 'string' && body.external_anchor.trim()
        ? body.external_anchor.trim()
        : null;

    const parentRes = await resolveIngestParentId(userId, body);
    if (!parentRes.ok) {
      return res.status(parentRes.status).json({ error: parentRes.error });
    }
    const { parentId } = parentRes;

    const r = await pool.query(
      `INSERT INTO notes (parent_id, content, external_anchor, user_id, note_type, event_start_at, event_end_at, stream_sibling_index)
       VALUES (
         $1, $2, $3, $4, 'note', NULL, NULL,
         COALESCE(
           (SELECT MAX(stream_sibling_index) + 1 FROM notes c WHERE c.parent_id = $1::uuid AND c.user_id = $4::uuid),
           0
         )
       )
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
 * If the note body is empty, runs the same PDF/image OCR + summary pipeline as JWT /api/notes/…/attachments
 * (ingest is API-only — no X-Hermes-Attachment-Ocr header required).
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
      const noteCheck = await pool.query('SELECT id, content FROM notes WHERE id = $1 AND user_id = $2', [
        noteId,
        userId,
      ]);
      if (noteCheck.rows.length === 0) {
        return res.status(404).json({ error: 'Note not found' });
      }
      const priorContent = noteCheck.rows[0]?.content;
      const contentWasEmpty = !String(priorContent ?? '').trim();
      const runOcr = contentWasEmpty;

      if (!contentWasEmpty) {
        logOcr('attachments_skip_ocr', { noteId, source: 'ingest', reason: 'note_already_has_content' });
      }

      const maxSort = await pool.query(
        `SELECT COALESCE(MAX(sort_index), -1)::int AS m FROM note_file_blobs WHERE note_id = $1::uuid AND user_id = $2`,
        [noteId, userId]
      );
      let nextSort = (maxSort.rows[0]?.m ?? -1) + 1;

      const inserted = [];
      const ocrPieces = [];
      const ocrStats = [];
      for (const f of files) {
        const buf = f.buffer;
        if (!buf?.length) continue;
        const filename = f.originalname?.slice(0, 512) || 'file';
        const mime = f.mimetype || 'application/octet-stream';
        const si = nextSort++;
        const ins = await pool.query(
          `INSERT INTO note_file_blobs (note_id, user_id, filename, mime_type, byte_size, data, sort_index)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, filename, mime_type, byte_size`,
          [noteId, userId, filename, mime, buf.length, buf, si]
        );
        inserted.push(ins.rows[0]);
        if (runOcr) {
          const { noteText, stats } = await runIngestOcrPipeline(buf, filename, mime, {
            source: 'ingest_attachments',
            noteId,
          });
          ocrPieces.push(noteText);
          ocrStats.push(stats);
        }
      }
      if (inserted.length === 0) {
        return res.status(400).json({ error: 'No valid files' });
      }

      if (runOcr && ocrPieces.length > 0) {
        const combined = ocrPieces
          .map((s) => String(s ?? '').trim())
          .filter(Boolean)
          .join('\n\n');
        if (combined) {
          await pool.query('UPDATE notes SET content = $1 WHERE id = $2 AND user_id = $3', [
            combined,
            noteId,
            userId,
          ]);
          embedNote(noteId, combined).catch(() => {});
          proposeTagsForNote(noteId, combined, userId).catch(() => {});
        }
      }

      const payload =
        ocrStats.length > 0 ? { inserted, ocr: ocrStats } : { inserted };
      res.status(201).json(payload);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Upload failed' });
    }
  }
);

export default router;
