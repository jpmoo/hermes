import { useState, useEffect } from 'react';

/**
 * Subscribe to a CSS media query (e.g. `HERMES_COMPACT_VIEWPORT_QUERY` in `canvasLayoutApi.js`).
 */
export function useMediaQuery(query) {
  const getMatches = () => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  };
  const [matches, setMatches] = useState(getMatches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}
