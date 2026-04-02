import { generate } from './ollama.js';

const TITLE_MAX = 200;
const PROMPT_NOTE_MAX = 12000;

/**
 * Ask Ollama for a short task title summarizing the note. Returns a single-line string.
 */
export async function suggestTaskTitleFromNoteContent(content) {
  const raw = String(content ?? '').trim();
  if (!raw) return 'Untitled task';
  const snippet = raw.length > PROMPT_NOTE_MAX ? `${raw.slice(0, PROMPT_NOTE_MAX)}\n…` : raw;
  const prompt = `You name tasks for a productivity app. Given the note text below, respond with ONE short task title only.
Rules: plain text, no quotes, no numbering, no explanation, max ${TITLE_MAX} characters. Use sentence case or title case.

Note:
${snippet}`;

  const out = await generate(prompt, { temperature: 0.2, num_predict: 120 });
  if (!out) return fallbackTitle(raw);
  const line = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  const cleaned = line.replace(/^["']|["']$/g, '').trim().slice(0, TITLE_MAX);
  return cleaned || fallbackTitle(raw);
}

function fallbackTitle(content) {
  const first = String(content ?? '')
    .split(/\n/)[0]
    .replace(/\r/g, '')
    .replace(/^\uFEFF/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (first || 'Hermes note').slice(0, TITLE_MAX);
}

/**
 * POST /api/external/tasks per Spaztick external API (see API_ACCESS.md).
 */
export async function createSpaztickExternalTask({ baseUrl, apiKey, title, notes }) {
  const base = String(baseUrl || '').trim().replace(/\/$/, '');
  const url = `${base}/api/external/tasks`;
  const body = {
    title: String(title || '').trim().slice(0, TITLE_MAX) || 'Task',
    notes: notes == null ? '' : String(notes),
  };
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': String(apiKey || ''),
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!r.ok) {
    const msg =
      typeof data.error === 'string'
        ? data.error
        : typeof data.detail === 'string'
          ? data.detail
          : text?.slice(0, 200) || r.statusText;
    const err = new Error(msg || `Spaztick HTTP ${r.status}`);
    err.status = r.status;
    err.body = data;
    throw err;
  }
  return data;
}
