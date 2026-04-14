/**
 * Device-local defaults for Hover Insight (used to seed the account on first sync).
 * Kept separate from HoverInsightContext so NoteTypeColorContext can migrate them to the server.
 */
import { ALL_NOTE_TYPES, NOTE_TYPE_FILTER_ORDER } from './noteTypeFilter';

const RAGDOLL_CONTEXT_LS_KEY = 'hermes.ragdollContextOptions';
const SIMILAR_MIN_LS_KEY = 'hermes.insightSimilarMinPct';
const RAGDOLL_QUERY_SIMILARITY_MIN_LS_KEY = 'hermes.ragdollQuerySimilarityMinPct';
const SIMILAR_TYPES_LS_KEY = 'hermes.insightSimilarVisibleTypes';

export const defaultRagdollContext = Object.freeze({
  includeParent: false,
  includeSiblings: false,
  includeChildren: false,
  includeConnected: true,
});

export function readRagdollContextFromLocalStorage() {
  try {
    const raw = localStorage.getItem(RAGDOLL_CONTEXT_LS_KEY);
    if (!raw) return { ...defaultRagdollContext };
    const o = JSON.parse(raw);
    if (!o || typeof o !== 'object') return { ...defaultRagdollContext };
    return {
      includeParent: Boolean(o.includeParent),
      includeSiblings: Boolean(o.includeSiblings),
      includeChildren: Boolean(o.includeChildren),
      includeConnected: o.includeConnected !== false,
    };
  } catch {
    return { ...defaultRagdollContext };
  }
}

export function readSimilarMinPctFromLocalStorage() {
  try {
    const raw = localStorage.getItem(SIMILAR_MIN_LS_KEY);
    const n = raw != null ? parseInt(raw, 10) : 25;
    if (!Number.isFinite(n)) return 25;
    return Math.min(95, Math.max(5, n));
  } catch {
    return 25;
  }
}

export function readRagdollQuerySimilarityMinPctFromLocalStorage() {
  try {
    const raw = localStorage.getItem(RAGDOLL_QUERY_SIMILARITY_MIN_LS_KEY);
    const n = raw != null ? parseInt(raw, 10) : 45;
    if (!Number.isFinite(n)) return 45;
    return Math.min(95, Math.max(5, n));
  } catch {
    return 45;
  }
}

export function readSimilarVisibleTypesFromLocalStorage() {
  try {
    const raw = localStorage.getItem(SIMILAR_TYPES_LS_KEY);
    if (!raw) return [...NOTE_TYPE_FILTER_ORDER];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return [...NOTE_TYPE_FILTER_ORDER];
    const next = [];
    for (const t of arr) {
      if (typeof t === 'string' && ALL_NOTE_TYPES.has(t)) next.push(t);
    }
    if (next.length === 0) return [...NOTE_TYPE_FILTER_ORDER];
    return next;
  } catch {
    return [...NOTE_TYPE_FILTER_ORDER];
  }
}

/** Full payload to PATCH as `hoverInsight` when migrating from device-only storage. */
export function readHoverInsightLocalSeed() {
  return {
    ragdollContext: readRagdollContextFromLocalStorage(),
    ragdollQuerySimilarityMinPct: readRagdollQuerySimilarityMinPctFromLocalStorage(),
    similarMinPct: readSimilarMinPctFromLocalStorage(),
    similarVisibleTypes: readSimilarVisibleTypesFromLocalStorage(),
  };
}

/** Defaults matching the server when no account-stored value exists. */
export function defaultHoverInsightForAccount() {
  return {
    ragdollContext: { ...defaultRagdollContext },
    ragdollQuerySimilarityMinPct: 45,
    similarMinPct: 25,
    similarVisibleTypes: ['note', 'event', 'person', 'organization'],
  };
}

export function readThemeFromLocalStorage() {
  try {
    const v = localStorage.getItem('hermes.theme');
    return v === 'dark' ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}
