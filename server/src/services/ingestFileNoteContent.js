import path from 'node:path';
import { pdf } from 'pdf-to-img';
import Tesseract from 'tesseract.js';
import { generate, SUMMARY_MODEL } from './ollama.js';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
const MAX_OCR_CHARS_FOR_LLM = 24000;

const OCR_SUMMARY_PROMPT_PREFIX =
  'You are summarizing an extracted document for a note taking app. Here is the text extracted via OCR from the document. If the text looks like gibberish or is unreadable, return only the word FAIL. If the text is meaningful, return a concise summary.\n\n---\n\n';

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
  const parts = [];
  for await (const pageBuf of doc) {
    const t = await tesseractFromImageBuffer(pageBuf);
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

/**
 * @param {Buffer} buf
 * @param {string} rawFilename
 * @param {string} [mimetype]
 * @returns {Promise<string>} Note body text (filename fallback or summary).
 */
export async function resolveNoteContentFromIngestFile(buf, rawFilename, mimetype) {
  const filename = typeof rawFilename === 'string' && rawFilename.trim() ? rawFilename.trim() : 'file';
  const kind = classifyIngestFileKind(filename, mimetype);
  if (!kind) {
    return filename;
  }

  let ocrText = '';
  try {
    ocrText = await ocrPdfOrImage(buf, kind);
  } catch (err) {
    console.error('Ingest OCR error:', err.message);
    return filename;
  }

  if (!ocrText) {
    return filename;
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
    console.error('Ingest OCR summary error:', err.message);
    return filename;
  }

  if (!summary || !summary.trim() || isFailResponse(summary)) {
    return filename;
  }

  return summary.trim();
}
