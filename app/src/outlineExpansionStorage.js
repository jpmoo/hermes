const KEY = 'hermes.outlineExpansion';

export function readOutlineExpansion() {
  try {
    const raw = localStorage.getItem(KEY);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}

function writeOutlineExpansion(map) {
  try {
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** @param {string} noteId */
export function setOutlineExpanded(noteId, expanded) {
  if (!noteId) return;
  const m = readOutlineExpansion();
  m[noteId] = expanded;
  writeOutlineExpansion(m);
}

/** @param {string[]} noteIds */
export function setAllOutlineExpansion(noteIds, expanded) {
  const m = readOutlineExpansion();
  for (const id of noteIds) {
    if (id) m[id] = expanded;
  }
  writeOutlineExpansion(m);
}
