import path from 'node:path';
import { pdf } from 'pdf-to-img';

/** Max stored thumbnail size (PNG); skip if render exceeds (corrupt / huge canvas). */
const MAX_THUMBNAIL_BYTES = 512 * 1024;

/**
 * @param {string} [mime]
 * @param {string} [filename]
 * @returns {boolean}
 */
export function isPdfAttachmentMime(mime, filename) {
  const mt = String(mime || '').toLowerCase();
  if (mt === 'application/pdf') return true;
  if (path.extname(String(filename || '')).toLowerCase() === '.pdf') return true;
  return false;
}

/**
 * Render PDF page 1 to PNG (small scale for list tiles).
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{ mime: string, data: Buffer } | null>}
 */
export async function buildPdfAttachmentThumbnail(pdfBuffer) {
  if (!pdfBuffer?.length) return null;
  try {
    const doc = await pdf(pdfBuffer, { scale: 0.65 });
    if (!doc.length) return null;
    const pageBuf = await doc.getPage(1);
    if (!pageBuf?.length) return null;
    const data = Buffer.isBuffer(pageBuf) ? pageBuf : Buffer.from(pageBuf);
    if (data.length > MAX_THUMBNAIL_BYTES) {
      console.warn('[Hermes] PDF thumbnail skipped: rendered size exceeds cap');
      return null;
    }
    return { mime: 'image/png', data };
  } catch (e) {
    console.warn('[Hermes] PDF thumbnail generation failed:', e instanceof Error ? e.message : e);
    return null;
  }
}
