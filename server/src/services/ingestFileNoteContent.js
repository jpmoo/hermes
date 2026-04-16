import path from 'node:path';
import { pdf } from 'pdf-to-img';
import Tesseract from 'tesseract.js';
import { generate, SUMMARY_MODEL } from './ollama.js';
import { logOcr, logOcrVerbose } from './ingestOcrLog.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
const MAX_OCR_CHARS_FOR_LLM = 24000;
/** When summarization fails but OCR succeeded, store this much raw OCR in the note (not the filename). */
const MAX_OCR_FALLBACK_NOTE_CHARS = 12000;

const OCR_SUMMARY_PROMPT_PREFIX =
  'You are summarizing an extracted document for a note taking app. Here is the text extracted via OCR from the document. If the text looks like gibberish or is unreadable, return only the word FAIL. If the text is meaningful, return a concise summary.\n\n---\n\n';

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
 * @returns {Promise<string>}
 */
async function ocrPdfOrImage(buf, kind) {
  if (kind === 'image') {
    return tesseractFromImageBuffer(buf);
  }
  return ocrPdfBuffer(buf);
}

function isFailResponse(s) {
  const t = (s || '').trim().replace(/\.$/, '');
  return t.toUpperCase() === 'FAIL';
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

  logOcr('pipeline_start', { ...base, kind, summaryModel: SUMMARY_MODEL });

  let ocrText = '';
  try {
    ocrText = await ocrPdfOrImage(buf, kind);
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
  logOcr('ocr_done', { ...base, kind, ocrChars: ocrText.length });

  if (!ocrText) {
    logOcr('pipeline_done', { ...base, kind, outcome: 'empty_ocr', noteText: 'filename_fallback' });
    return {
      noteText: filename,
      stats: { outcome: 'empty_ocr', kind, filename, ocrChars: 0 },
    };
  }

  const forLlm =
    ocrText.length > MAX_OCR_CHARS_FOR_LLM
      ? `${ocrText.slice(0, MAX_OCR_CHARS_FOR_LLM)}\n[truncated]`
      : ocrText;
  const prompt = `${OCR_SUMMARY_PROMPT_PREFIX}${forLlm}`;

  let summary;
  try {
    summary = await generate(prompt, {
      model: SUMMARY_MODEL,
      temperature: 0.3,
      num_predict: 520,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const fallback = noteTextFromOcrWhenLlMUnavailable(ocrText);
    logOcr('pipeline_done', {
      ...base,
      kind,
      outcome: fallback ? 'llm_threw_ocr_fallback' : 'llm_threw',
      error: msg,
      ocrChars: ocrText.length,
      noteText: fallback ? 'ocr_raw_fallback' : 'filename_fallback',
    });
    console.error('[Hermes OCR] Ingest OCR summary error:', err);
    return {
      noteText: fallback ?? filename,
      stats: {
        outcome: fallback ? 'llm_threw_ocr_fallback' : 'llm_threw',
        kind,
        filename,
        ocrChars: ocrText.length,
        error: msg,
      },
    };
  }

  logOcrVerbose('Raw LLM response', summary);

  if (!summary || !summary.trim()) {
    const fallback = noteTextFromOcrWhenLlMUnavailable(ocrText);
    logOcr('pipeline_done', {
      ...base,
      kind,
      outcome: fallback ? 'llm_empty_ocr_fallback' : 'llm_empty_response',
      ocrChars: ocrText.length,
      noteText: fallback ? 'ocr_raw_fallback' : 'filename_fallback',
    });
    return {
      noteText: fallback ?? filename,
      stats: {
        outcome: fallback ? 'llm_empty_ocr_fallback' : 'llm_empty_response',
        kind,
        filename,
        ocrChars: ocrText.length,
      },
    };
  }

  if (isFailResponse(summary)) {
    const lr = summary.trim();
    logOcr('pipeline_done', {
      ...base,
      kind,
      outcome: 'llm_fail',
      ocrChars: ocrText.length,
      llmReply: lr,
      noteText: 'filename_fallback',
    });
    return {
      noteText: filename,
      stats: { outcome: 'llm_fail', kind, filename, ocrChars: ocrText.length, llmReply: lr },
    };
  }

  const trimmed = summary.trim();
  logOcr('pipeline_done', {
    ...base,
    kind,
    outcome: 'summary',
    ocrChars: ocrText.length,
    summaryChars: trimmed.length,
  });
  return {
    noteText: trimmed,
    stats: {
      outcome: 'summary',
      kind,
      filename,
      ocrChars: ocrText.length,
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
