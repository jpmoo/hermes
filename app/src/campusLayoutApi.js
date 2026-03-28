/** Merge campus layout for one thread/focus context into settings patch payload. */

export function campusFocusKey(focusId) {
  return focusId ? String(focusId) : '__root__';
}

export function mergeCampusLayoutPatch(prevLayouts, threadRootId, focusKey, partial) {
  const tid = String(threadRootId);
  const fk = String(focusKey);
  const prev = prevLayouts && typeof prevLayouts === 'object' ? prevLayouts : {};
  const threadBlock = { ...(prev[tid] && typeof prev[tid] === 'object' ? prev[tid] : {}) };
  const cur = threadBlock[fk] && typeof threadBlock[fk] === 'object' ? threadBlock[fk] : {};
  const next = {
    ...cur,
    ...partial,
    view: { ...(cur.view || {}), ...(partial.view || {}) },
    cards: { ...(cur.cards || {}), ...(partial.cards || {}) },
  };
  return {
    ...prev,
    [tid]: {
      ...threadBlock,
      [fk]: next,
    },
  };
}
