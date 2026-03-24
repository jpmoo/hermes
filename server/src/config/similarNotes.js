/**
 * Default min trimmed body length before vector “similar notes” runs (env override).
 * 0 disables the gate. User account setting in settings_json.similarNotesMinChars overrides when set.
 */
export function similarNotesMinCharsEnvDefault() {
  const raw = process.env.HERMES_SIMILAR_NOTES_MIN_CHARS;
  if (raw === '0' || raw === '') return 0;
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  return 48;
}

/** Valid stored value for API/DB; undefined if absent or invalid. */
export function sanitizeSimilarNotesMinChars(input) {
  if (input === null || input === undefined) return undefined;
  const n = typeof input === 'string' ? parseInt(input, 10) : Number(input);
  if (!Number.isFinite(n)) return undefined;
  const r = Math.round(n);
  if (r < 0 || r > 500) return undefined;
  return r;
}
