/** First line of note body for history preview (not a separate title field). */
export function firstLinePreview(s) {
  return (s || '').split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 72);
}

/** Main line in history menu: first-line body preview; falls back to path leaf if preview missing (e.g. legacy entries). */
export function historyPrimaryLabel(storedPreview, threadPath) {
  const t = (storedPreview || '').trim();
  if (t && t !== 'Untitled') return t;
  const path = (threadPath || '').trim();
  if (path) {
    const parts = path.split(/\s*>\s*/).filter(Boolean);
    const leaf = parts[parts.length - 1] || path;
    return leaf.slice(0, 72) || 'Note';
  }
  return 'Note';
}
