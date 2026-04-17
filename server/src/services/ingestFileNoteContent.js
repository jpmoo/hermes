import path from 'node:path';
import { pdf } from 'pdf-to-img';
import Tesseract from 'tesseract.js';
import {
  generate,
  TAG_MODEL,
  transcribeImageWithVisionOcr,
  OCR_VISION_MODEL,
} from './ollama.js';
import { logOcr, logOcrVerbose } from './ingestOcrLog.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
const MAX_OCR_CHARS_FOR_LLM = 24000;
/** When summarization fails but OCR succeeded, store this much raw OCR in the note (not the filename). */
const MAX_OCR_FALLBACK_NOTE_CHARS = 12000;
/** Below this length (after trim), skip the LLM and use OCR text as the note body. */
const MIN_OCR_CHARS_FOR_SUMMARY = 200;

const OCR_SUMMARY_PROMPT_PREFIX =
  'You summarize OCR text for a note-taking app.\n' +
  '- If the text is readable and meaningful, output ONE concise summary only (no preamble).\n' +
  '- If it is gibberish or unreadable, output exactly the single word FAIL and nothing else—no sentences, no explanation.\n\n' +
  'OCR text:\n\n---\n\n';

/**
 * @typedef {object} IngestOcrStats
 * @property {string} outcome
 * @property {'pdf' | 'image' | null} [kind]
 * @property {string} filename
 * @property {number} [ocrChars]
 * @property {number} [summaryChars]
 * @property {string} [error]
 * @property {string} [llmReply]
 */

/**
 * @param {string} filename
 * @param {string} [mimetype]
 * @returns {'pdf' | 'image' | null}
 */
function classifyIngestFileKind(filename, mimetype) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (IMAGE_EXT.has(ext)) return 'image';
  const mt = (mimetype || '').toLowerCase();
  if (mt === 'application/pdf') return 'pdf';
  if (mt.startsWith('image/') && !mt.includes('svg')) return 'image';
  return null;
}

/** JPEG/PNG: use Ollama vision OCR (GLM-OCR). Other image types still use Tesseract. */
function isJpegOrPng(filename, mimetype) {
  const ext = path.extname(filename || '').toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') return true;
  const mt = (mimetype || '').toLowerCase();
  return mt === 'image/jpeg' || mt === 'image/jpg' || mt === 'image/png';
}

async function tesseractFromImageBuffer(buf) {
  const {
    data: { text },
  } = await Tesseract.recognize(buf, 'eng', {
    logger: () => {},
  });
  return (text || '').trim();
}

/**
 * @param {Buffer} buf
 * @param {string} filename
 * @param {string} [mimetype]
 */
async function ocrImageBuffer(buf, filename, mimetype) {
  if (isJpegOrPng(filename, mimetype)) {
    logOcr('vision_ocr_start', { filename, model: OCR_VISION_MODEL });
    try {
      const text = await transcribeImageWithVisionOcr(buf);
      logOcr('vision_ocr_done', { filename, ocrChars: text.length });
      return text;
    } catch (err) {
      console.error('[Hermes OCR] Vision OCR failed, using Tesseract:', err.message);
      logOcr('vision_ocr_fallback_tesseract', {
        filename,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return tesseractFromImageBuffer(buf);
}

/**
 * @param {Buffer} buf
 * @returns {Promise<string>}
 */
async function ocrPdfBuffer(buf) {
  const doc = await pdf(buf, { scale: 2 });
  logOcr('pdf_rendered', { pageCount: doc.length });
  const parts = [];
  let pageIndex = 0;
  for await (const pageBuf of doc) {
    pageIndex += 1;
    const t = await tesseractFromImageBuffer(pageBuf);
    logOcrVerbose(`PDF page ${pageIndex} OCR`, t);
    if (t) parts.push(t);
  }
  return parts.join('\n\n').trim();
}

/**
 * @param {Buffer} buf
 * @param {'pdf' | 'image'} kind
 * @param {string} filename
 * @param {string} [mimetype]
 * @returns {Promise<string>}
 */
async function ocrPdfOrImage(buf, kind, filename, mimetype) {
  if (kind === 'image') {
    return ocrImageBuffer(buf, filename, mimetype);
  }
  return ocrPdfBuffer(buf);
}

function isFailResponse(s) {
  const raw = String(s ?? '').trim();
  if (!raw) return false;
  const t = raw.replace(/\.$/, '').trim();
  if (t.toUpperCase() === 'FAIL') return true;
  const lower = raw.toLowerCase();
  // Local models often reply with prose instead of a lone "FAIL".
  if (/\bmark (?:this |it )?as\s+fail\b/i.test(raw)) return true;
  if (/\breturn (?:only )?(?:the word )?fail\b/i.test(lower)) return true;
  if (/\bunreadable\b.*\bfail\b/i.test(lower)) return true;
  if (/\bgibberish\b.*\bfail\b/i.test(lower)) return true;
  if (/\bso I will\b.*\bfail\b/i.test(lower) && /unreadable|gibberish/i.test(lower)) return true;
  return false;
}

function noteTextFromOcrWhenLlMUnavailable(ocrText) {
  const t = (ocrText || '').trim();
  if (t.length === 0) return null;
  if (t.length <= MAX_OCR_FALLBACK_NOTE_CHARS) return t;
  return `${t.slice(0, MAX_OCR_FALLBACK_NOTE_CHARS)}\n\n[OCR truncated…]`;
}

/**
 * @param {Buffer} buf
 * @param {string} rawFilename
 * @param {string} [mimetype]
 * @param {{ source?: string, noteId?: string }} [ctx]
 * @returns {Promise<{ noteText: string, stats: IngestOcrStats }>}
 */
export async function runIngestOcrPipeline(buf, rawFilename, mimetype, ctx = {}) {
  const filename = typeof rawFilename === 'string' && rawFilename.trim() ? rawFilename.trim() : 'file';
  const base = {
    source: ctx.source || 'unknown',
    noteId: ctx.noteId || null,
    filename,
    mimeType: mimetype || null,
    bytes: buf?.length ?? 0,
  };

  const kind = classifyIngestFileKind(filename, mimetype);
  if (!kind) {
    const stats = { outcome: 'skipped_not_pdf_or_image', kind: null, filename };
    logOcr('pipeline_done', { ...base, ...stats });
    return { noteText: filename, stats };
  }

  logOcr('pipeline_start', { ...base, kind, ocrSummaryModel: TAG_MODEL });

  let ocrText = '';
  try {
    ocrText = await ocrPdfOrImage(buf, kind, filename, mimetype);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logOcr('pipeline_done', {
      ...base,
      kind,
      outcome: 'ocr_threw',
      error: msg,
    });
    console.error('[Hermes OCR] Ingest OCR error:', err);
    return {
      noteText: filename,
      stats: { outcome: 'ocr_threw', kind, filename, error: msg },
    };
  }

  logOcrVerbose('Full OCR text', ocrText);
  const trimmedOcr = (ocrText || '').trim();
  logOcr('ocr_done', { ...base, kind, ocrChars: trimmedOcr.length });

  if (!trimmedOcr.length) {
    logOcr('pipeline_done', { ...base, kind, outcome: 'empty_ocr', noteText: 'filename_fallback' });
    return {
      noteText: filename,
      stats: { outcome: 'empty_ocr', kind, filename, ocrChars: 0 },
    };
  }

  // Short text from OCR (PDF or image): use as-is; do not call the tag model.
  if (trimmedOcr.length < MIN_OCR_CHARS_FOR_SUMMARY) {
    logOcr('pipeline_done', {
      ...base,
      kind,
      outcome: 'short_ocr_direct',
      ocrChars: trimmedOcr.length,
    });
    return {
      noteText: trimmedOcr,
      stats: {
        outcome: 'short_ocr_direct',
        kind,
        filename,
        ocrChars: trimmedOcr.length,
      },
    };
  }

  const forLlm =
    trimmedOcr.length > MAX_OCR_CHARS_FOR_LLM
      ? `${trimmedOcr.slice(0, MAX_OCR_CHARS_FOR_LLM)}\n[truncated]`
      : trimmedOcr;
  const prompt = `${OCR_SUMMARY_PROMPT_PREFIX}${forLlm}`;

  let summary;
  try {
    summary = await generate(prompt, {
      model: TAG_MODEL,
      temperature: 0.3,
      num_predict: 520,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const fallback = noteTextFromOcrWhenLlMUnavailable(trimmedOcr);
    logOcr('pipeline_done', {
      ...base,
      kind,
      outcome: fallback ? 'llm_threw_ocr_fallback' : 'llm_threw',
      error: msg,
      ocrChars: trimmedOcr.length,
      noteText: fallback ? 'ocr_raw_fallback' : 'filename_fallback',
    });
    console.error('[Hermes OCR] Ingest OCR summary error:', err);
    return {
      noteText: fallback ?? filename,
      stats: {
        outcome: fallback ? 'llm_threw_ocr_fallback' : 'llm_threw',
        kind,
        filename,
        ocrChars: trimmedOcr.length,
        error: msg,
      },
    };
  }

  logOcrVerbose('Raw LLM response', summary);

  if (!summary || !summary.trim()) {
    const fallback = noteTextFromOcrWhenLlMUnavailable(trimmedOcr);
    logOcr('pipeline_done', {
      ...base,
      kind,
      outcome: fallback ? 'llm_empty_ocr_fallback' : 'llm_empty_response',
      ocrChars: trimmedOcr.length,
      noteText: fallback ? 'ocr_raw_fallback' : 'filename_fallback',
    });
    return {
      noteText: fallback ?? filename,
      stats: {
        outcome: fallback ? 'llm_empty_ocr_fallback' : 'llm_empty_response',
        kind,
        filename,
        ocrChars: trimmedOcr.length,
      },
    };
  }

  if (isFailResponse(summary)) {
    const lr = summary.trim();
    const fallback = noteTextFromOcrWhenLlMUnavailable(trimmedOcr);
    const noteText = fallback ?? filename;
    const outcome = fallback ? 'llm_fail_ocr_fallback' : 'llm_fail';
    logOcr('pipeline_done', {
      ...base,
      kind,
      outcome,
      ocrChars: trimmedOcr.length,
      llmReply: lr,
      noteText: fallback ? 'ocr_raw_fallback' : 'filename_fallback',
    });
    return {
      noteText,
      stats: { outcome, kind, filename, ocrChars: trimmedOcr.length, llmReply: lr },
    };
  }

  const trimmed = summary.trim();
  logOcr('pipeline_done', {
    ...base,
    kind,
    outcome: 'summary',
    ocrChars: trimmedOcr.length,
    summaryChars: trimmed.length,
  });
  return {
    noteText: trimmed,
    stats: {
      outcome: 'summary',
      kind,
      filename,
      ocrChars: trimmedOcr.length,
      summaryChars: trimmed.length,
    },
  };
}

/**
 * @param {Buffer} buf
 * @param {string} rawFilename
 * @param {string} [mimetype]
 * @param {{ source?: string, noteId?: string }} [ctx]
 * @returns {Promise<string>} Note body text (filename fallback or summary).
 */
export async function resolveNoteContentFromIngestFile(buf, rawFilename, mimetype, ctx = {}) {
  const { noteText } = await runIngestOcrPipeline(buf, rawFilename, mimetype, ctx);
  return noteText;
}
