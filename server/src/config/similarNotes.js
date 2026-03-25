/**
 * Default min trimmed body length for vector “similar notes” (env override).
 * When > 0: the hovered note must be at least this long (after trim) to run the search (unreliable
 * embeddings on stubs). 0 disables that gate. Whether matches must meet the same length is controlled
 * by settings_json.similarNotesLimitResultsToMinChars (optional checkbox; default off).
 * User account setting similarNotesMinChars overrides the env default when set.
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
