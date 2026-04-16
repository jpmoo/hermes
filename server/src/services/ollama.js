const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const TAG_MODEL = process.env.OLLAMA_TAG_MODEL || 'mistral';
/** Thread summaries, ingest OCR summaries, etc. Defaults to TAG_MODEL when unset. */
const SUMMARY_MODEL = process.env.OLLAMA_SUMMARY_MODEL || TAG_MODEL;
/** Vision OCR for JPEG/PNG in ingest (e.g. glm-ocr). Must be pulled in Ollama. */
const OCR_VISION_MODEL = process.env.HERMES_OCR_VISION_MODEL || 'glm-ocr';

/**
 * Nomic models are trained for asymmetric retrieval: index with search_document:,
 * query with search_query:. Plain text on both sides underperforms. Enable with
 * HERMES_EMBED_NOMIC_PREFIXES=1 and re-run note embeddings (see npm run reembed).
 */
export function useNomicTaskPrefixes() {
  if (process.env.HERMES_EMBED_LEGACY_PLAIN === '1' || process.env.HERMES_EMBED_LEGACY_PLAIN === 'true') {
    return false;
  }
  const on = process.env.HERMES_EMBED_NOMIC_PREFIXES === '1' || process.env.HERMES_EMBED_NOMIC_PREFIXES === 'true';
  if (on) return true;
  return false;
}

/** String sent to Ollama when embedding a note (stored in DB). */
export function inputForDocument(content) {
  const t = (content || '').trim();
  if (!t) return '';
  if (useNomicTaskPrefixes()) return `search_document: ${t}`;
  return t;
}

/** String sent to Ollama when embedding a search query. */
export function inputForQuery(query) {
  const t = (query || '').trim();
  if (!t) return '';
  if (useNomicTaskPrefixes()) return `search_query: ${t}`;
  return t;
}

export async function embed(text) {
  if (!text || !text.trim()) return null;
  try {
    const r = await fetch(`${OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: text.trim() }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    const vec = Array.isArray(data.embeddings?.[0])
      ? data.embeddings[0]
      : Array.isArray(data.embedding)
        ? data.embedding
        : null;
    return Array.isArray(vec) && vec.length > 0 ? vec : null;
  } catch (err) {
    console.error('Ollama embed error:', err.message);
    return null;
  }
}

const DEFAULT_VISION_OCR_PROMPT =
  'Transcribe all visible text in this image. Output plain text only; preserve line breaks where natural. ' +
  'Do not describe the scene or image—text only. If there is no readable text, output nothing.';

/**
 * OCR via a vision-capable Ollama model (e.g. GLM-OCR). Uses /api/chat with base64 image.
 * @param {Buffer} buffer Raw image bytes (JPEG/PNG).
 * @param {{ model?: string, prompt?: string, numPredict?: number }} [options]
 * @returns {Promise<string>} Extracted text (trimmed).
 */
export async function transcribeImageWithVisionOcr(buffer, options = {}) {
  const model = options.model ?? OCR_VISION_MODEL;
  const prompt = options.prompt ?? DEFAULT_VISION_OCR_PROMPT;
  const numPredict = options.numPredict ?? 16384;
  if (!buffer?.length) return '';
  const b64 = Buffer.from(buffer).toString('base64');
  const r = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: prompt,
          images: [b64],
        },
      ],
      stream: false,
      options: { temperature: options.temperature ?? 0.1, num_predict: numPredict },
    }),
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => '');
    const err = new Error(`Ollama vision OCR HTTP ${r.status}: ${errBody.slice(0, 500)}`);
    err.status = r.status;
    throw err;
  }
  const data = await r.json();
  const content = data.message?.content;
  const text = typeof content === 'string' ? content : '';
  return text.trim();
}

export async function generate(prompt, options = {}) {
  try {
    const model = options.model ?? TAG_MODEL;
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: options.temperature ?? 0.3, num_predict: options.num_predict ?? 200 },
      }),
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.response?.trim() || null;
  } catch (err) {
    console.error('Ollama generate error:', err.message);
    return null;
  }
}

export { OLLAMA_URL, EMBED_MODEL, TAG_MODEL, SUMMARY_MODEL, OCR_VISION_MODEL };
