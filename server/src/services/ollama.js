const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const TAG_MODEL = process.env.OLLAMA_TAG_MODEL || 'mistral';

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
    const vec = data.embeddings?.[0];
    return Array.isArray(vec) ? vec : null;
  } catch (err) {
    console.error('Ollama embed error:', err.message);
    return null;
  }
}

export async function generate(prompt, options = {}) {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: TAG_MODEL,
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

export { OLLAMA_URL, EMBED_MODEL, TAG_MODEL };
