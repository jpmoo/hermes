/**
 * OCR pipeline visibility. Set HERMES_OCR_DEBUG=1 for previews (OCR text snippet, raw LLM reply).
 * Compact JSON lines are always emitted so journalctl shows outcomes without enabling debug.
 */

export function ocrDebugVerbose() {
  const v = process.env.HERMES_OCR_DEBUG;
  return v === '1' || v === 'true';
}

const PREVIEW = 400;

function clip(s, n = PREVIEW) {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n)}…`;
}

/**
 * @param {string} event
 * @param {Record<string, unknown>} [fields]
 */
export function logOcr(event, fields = {}) {
  const line = { hermes_ocr: true, event, ...fields };
  console.log(JSON.stringify(line));
}

/**
 * @param {string} label
 * @param {string} [text]
 */
export function logOcrVerbose(label, text) {
  if (!ocrDebugVerbose()) return;
  console.log(`[Hermes OCR verbose] ${label} (${(text || '').length} chars):`);
  console.log(clip(text, 2000));
}
