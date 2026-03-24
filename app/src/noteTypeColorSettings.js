/** Persisted hex picks for the four note types; drive --note-type-* CSS variables app-wide. */

export const NOTE_TYPE_COLOR_KEYS = ['note', 'event', 'person', 'organization'];

/** Shown in the color picker when the user has not saved a custom value for that type. */
export const NOTE_TYPE_COLOR_DEFAULTS = {
  note: '#8a6d0a',
  event: '#5f9b76',
  person: '#6fa9dc',
  organization: '#b89a3a',
};

const STORAGE_KEY = 'hermes.noteTypeColors';

/** Parse API / storage object into a clean map of type → hex. */
export function parseNoteTypeColorsObject(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const k of NOTE_TYPE_COLOR_KEYS) {
    const h = normalizeNoteTypeHex(obj[k]);
    if (h) out[k] = h;
  }
  return out;
}

export function normalizeNoteTypeHex(input) {
  if (input == null || typeof input !== 'string') return null;
  const s = input.trim();
  if (!/^#[0-9A-Fa-f]{3}([0-9A-Fa-f]{3})?$/.test(s)) return null;
  if (s.length === 4) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`.toLowerCase();
  }
  return s.toLowerCase();
}

export function loadNoteTypeColorsFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out = {};
    for (const k of NOTE_TYPE_COLOR_KEYS) {
      const hex = normalizeNoteTypeHex(parsed[k]);
      if (hex) out[k] = hex;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveNoteTypeColorsToStorage(colors) {
  try {
    if (!colors || Object.keys(colors).length === 0) {
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(colors));
  } catch {
    /* ignore quota / private mode */
  }
}

const CSS_VAR_SUFFIXES = NOTE_TYPE_COLOR_KEYS.flatMap((t) => [
  `--note-type-icon-${t}`,
  `--note-type-bg-${t}`,
  `--note-type-bg-${t}-hover`,
]);

export function clearNoteTypeColorVarOverrides() {
  const root = document.documentElement;
  for (const p of CSS_VAR_SUFFIXES) {
    root.style.removeProperty(p);
  }
}

/**
 * Apply user picks to :root inline styles (overrides index.css). Omitted types keep theme defaults.
 * @param {Record<string, string>} colors keyed by note type → hex
 */
export function applyNoteTypeColorVars(colors) {
  const root = document.documentElement;
  clearNoteTypeColorVarOverrides();
  if (!colors) return;
  for (const t of NOTE_TYPE_COLOR_KEYS) {
    const h = normalizeNoteTypeHex(colors[t]);
    if (!h) continue;
    root.style.setProperty(
      `--note-type-icon-${t}`,
      `color-mix(in srgb, ${h} 58%, var(--text-muted))`
    );
    root.style.setProperty(
      `--note-type-bg-${t}`,
      `color-mix(in srgb, ${h} 26%, var(--bg-card))`
    );
    root.style.setProperty(
      `--note-type-bg-${t}-hover`,
      `color-mix(in srgb, ${h} 22%, var(--bg-card-hover))`
    );
  }
}
