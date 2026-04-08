import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  fetchHoverInsight,
  fetchLinkedNotesQuick,
  fetchRagdollConfig,
  fetchRagdollRelevant,
  fetchRagdollSource,
  addNoteTag,
  createNoteConnection,
  deleteNoteConnection,
  getNoteThreadRoot,
} from './api';
import ConnectionNoteModal from './ConnectionNoteModal';
import NoteRichText from './NoteRichText';
import NoteTypeIcon from './NoteTypeIcon';
import { ALL_NOTE_TYPES, NOTE_TYPE_HEADER_ORDER } from './noteTypeFilter';
import { insightPointerPathShouldKeepOpen, pointerEventTargetElement } from './pointerEventUtils';
import { HERMES_COMPACT_VIEWPORT_QUERY } from './canvasLayoutApi';
import { useMediaQuery } from './useMediaQuery';
import HoverInsightMobileSheet from './HoverInsightMobileSheet';
import './HoverInsight.css';

const CONFIRM_UNLINK =
  'Remove the link between these two notes? The notes are not deleted—only the connection is removed.';

/** Compare note ids from API vs tree (string vs number). */
function noteIdSame(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

const SIMILAR_MIN_LS_KEY = 'hermes.insightSimilarMinPct';
const SIMILAR_TYPES_LS_KEY = 'hermes.insightSimilarVisibleTypes';
const RAGDOLL_CONTEXT_LS_KEY = 'hermes.ragdollContextOptions';
const RAGDOLL_QUERY_SIMILARITY_MIN_LS_KEY = 'hermes.ragdollQuerySimilarityMinPct';

const SIMILAR_TYPE_FILTER_LABELS = {
  note: 'Notes',
  event: 'Events',
  person: 'People',
  organization: 'Organizations',
};

const defaultRagdollContext = Object.freeze({
  includeParent: false,
  includeSiblings: false,
  includeChildren: false,
  includeConnected: true,
});

function readStoredRagdollContext() {
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

function readStoredSimilarMinPct() {
  try {
    const raw = localStorage.getItem(SIMILAR_MIN_LS_KEY);
    const n = raw != null ? parseInt(raw, 10) : 25;
    if (!Number.isFinite(n)) return 25;
    return Math.min(95, Math.max(5, n));
  } catch {
    return 25;
  }
}

/** Default 45% matches typical RAGDoll / env default of 0.45. */
function readStoredRagdollQuerySimilarityMinPct() {
  try {
    const raw = localStorage.getItem(RAGDOLL_QUERY_SIMILARITY_MIN_LS_KEY);
    const n = raw != null ? parseInt(raw, 10) : 45;
    if (!Number.isFinite(n)) return 45;
    return Math.min(95, Math.max(5, n));
  } catch {
    return 45;
  }
}

function readStoredSimilarVisibleTypes() {
  try {
    const raw = localStorage.getItem(SIMILAR_TYPES_LS_KEY);
    if (!raw) return new Set(ALL_NOTE_TYPES);
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length === 0) return new Set(ALL_NOTE_TYPES);
    const next = new Set();
    for (const t of arr) {
      if (typeof t === 'string' && ALL_NOTE_TYPES.has(t)) next.add(t);
    }
    if (next.size === 0) return new Set(ALL_NOTE_TYPES);
    return next;
  } catch {
    return new Set(ALL_NOTE_TYPES);
  }
}

/** Stable id + paths for persisted link rows (API may use snake_case or alternate keys). */
function normalizePersistedLinkItem(p) {
  if (!p || typeof p !== 'object') return null;
  const id = p.id ?? p.note_id ?? p.noteId;
  if (id == null || String(id).trim() === '') return null;
  return {
    ...p,
    id,
    threadPath: p.threadPath ?? p.thread_path ?? '',
    note_type: p.note_type ?? p.noteType ?? 'note',
  };
}

/** Union by note id; overlay `primary` fields onto `secondary` so hover-insight wins for detail. */
function mergePersistedLinksLists(primary, secondary) {
  const map = new Map();
  for (const raw of secondary || []) {
    const p = normalizePersistedLinkItem(raw);
    if (p) map.set(String(p.id).toLowerCase(), { ...p });
  }
  for (const raw of primary || []) {
    const p = normalizePersistedLinkItem(raw);
    if (!p) continue;
    const k = String(p.id).toLowerCase();
    const existing = map.get(k) || {};
    map.set(k, { ...existing, ...p });
  }
  return [...map.values()];
}

/** Ensure arrays exist (API / parse edge cases). Accept camelCase or snake_case keys. */
function normalizeHoverInsightPayload(data) {
  if (!data || typeof data !== 'object') {
    return {
      tagSuggestions: [],
      similarNotes: [],
      persistedLinks: [],
    };
  }
  const persisted = data.persistedLinks ?? data.persisted_links;
  const similar = data.similarNotes ?? data.similar_notes;
  const tags = data.tagSuggestions ?? data.tag_suggestions;
  const similarNorm = Array.isArray(similar)
    ? similar.map((s) => ({
        ...s,
        threadPath: s.threadPath ?? s.thread_path ?? '',
        note_type: s.note_type || s.noteType || 'note',
      }))
    : [];
  const persistedNorm = Array.isArray(persisted)
    ? persisted.map(normalizePersistedLinkItem).filter(Boolean)
    : [];
  const skippedShort =
    data.similarNotesSkippedShortNote === true || data.similar_notes_skipped_short_note === true;
  const minChars = data.similarNotesMinChars ?? data.similar_notes_min_chars;

  return {
    ...data,
    tagSuggestions: Array.isArray(tags) ? tags : [],
    similarNotes: similarNorm,
    persistedLinks: persistedNorm,
    similarNotesSkippedShortNote: skippedShort,
    similarNotesMinChars: typeof minChars === 'number' && Number.isFinite(minChars) ? minChars : undefined,
  };
}

/** Higher similarity first; null/unknown last; tie-break by content snippet. */
function sortBySimilarityDesc(list) {
  return [...list].sort((a, b) => {
    const sa = a.similarity != null ? Number(a.similarity) : -1;
    const sb = b.similarity != null ? Number(b.similarity) : -1;
    if (sb !== sa) return sb - sa;
    return (a.content || '').localeCompare(b.content || '');
  });
}

/** Compare note ids for DOM data-stream-note (UUID case can differ between React and pg). */
function noteIdAttrEq(attr, noteId) {
  const a = (attr != null ? String(attr) : '').trim().toLowerCase();
  const b = (noteId != null ? String(noteId) : '').trim().toLowerCase();
  return a.length > 0 && a === b;
}

/** Live <article> for Stream insight layout after React replaces nodes (focus / animations). */
function findInsightArticleEl(noteId) {
  if (noteId == null) return null;
  const scope = document.querySelector('.stream-page-scroll') ?? document;
  const lists = scope.querySelectorAll('ul.stream-page-list');
  for (const list of lists) {
    for (const li of list.querySelectorAll('li[data-stream-note]')) {
      if (!noteIdAttrEq(li.getAttribute('data-stream-note'), noteId)) continue;
      const art = li.querySelector(':scope > article');
      if (art && typeof art.getBoundingClientRect === 'function') return art;
    }
  }
  return null;
}

/** Split flat tag list: neighbor (thread SQL), connected (links SQL), novel (Ollama only). */
function partitionTagSuggestions(list) {
  const neighbor = [];
  const connected = [];
  const novel = [];
  for (const t of list) {
    if (t.source === 'neighbor') {
      neighbor.push(t);
    } else if (t.source === 'connected') {
      connected.push(t);
    } else if (t.source === 'ollama' && t.fromVocab !== true) {
      novel.push(t);
    }
  }
  return { neighbor, connected, novel };
}

/** Group RAG hits by collection; docs sorted by similarity desc; groups ordered by best hit first. */
function groupRagdollDocumentsByCollection(documents) {
  if (!Array.isArray(documents) || documents.length === 0) return [];
  const by = new Map();
  for (const d of documents) {
    const raw = d?.group;
    const g =
      raw != null && String(raw).trim() !== '' ? String(raw).trim() : '_other';
    if (!by.has(g)) by.set(g, []);
    by.get(g).push(d);
  }
  for (const docs of by.values()) {
    docs.sort((a, b) => Number(b?.similarity ?? 0) - Number(a?.similarity ?? 0));
  }
  const rows = [...by.entries()].map(([group, docs]) => {
    const maxSim = docs.reduce((m, x) => Math.max(m, Number(x?.similarity ?? 0)), 0);
    const label = group === '_other' ? 'Other' : group;
    return { group, label, docs, maxSim };
  });
  rows.sort((a, b) => b.maxSim - a.maxSim);
  return rows;
}

const HoverInsightContext = createContext(null);

function tagSuggestionTitle(t) {
  if (t.source === 'neighbor') {
    return 'On parent, sibling, or direct reply; not on this note yet';
  }
  if (t.source === 'connected') return 'On a linked note; not on the selected note yet';
  return 'New tag from model (may create tag when added)';
}

function HoverInsightTagSection({ title, tags, note, addTag, addingKey }) {
  if (tags.length === 0) return null;
  return (
    <div className="hover-insight-stack-section">
      <p className="hover-insight-stack-section-title">{title}</p>
      <ul className="hover-insight-stack-list">
        {tags.map((t) => {
          return (
            <li
              key={t.key}
              className="hover-insight-tag-row hover-insight-tag-row--no-dismiss hover-insight-stack-item-row"
            >
              <button
                type="button"
                className="hover-insight-icon-btn hover-insight-icon-btn--add"
                aria-label={`Add ${t.name}`}
                disabled={addingKey === t.key}
                onClick={() => addTag(note.id, t)}
              >
                +
              </button>
              <span className="hover-insight-tag-name" title={tagSuggestionTitle(t)}>
                {t.name}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function useHoverInsight() {
  return useContext(HoverInsightContext);
}

export function HoverInsightProvider({ children, onNoteUpdated, onGoToNote }) {
  const [hover, setHover] = useState(null);
  const [insight, setInsight] = useState(null);
  const [loading, setLoading] = useState(false);
  const [dismissedKeys, setDismissedKeys] = useState(() => new Set());
  const [addingKey, setAddingKey] = useState(null);
  const [connectionModal, setConnectionModal] = useState(null);
  const fetchTimer = useRef(null);
  const reqId = useRef(0);
  const activeHoverId = useRef(null);
  /** Selected card element for layout (connection stack / scroll sync). */
  const insightAnchorRef = useRef(null);
  /** Mirror of `hover?.note` for outside-dismiss (updated synchronously in select/clear). */
  const hoverNoteRef = useRef(null);
  const ragdollEnabledRef = useRef(false);
  const ragdollReqId = useRef(0);
  const [ragdollEnabled, setRagdollEnabled] = useState(false);
  const [ragdollLoading, setRagdollLoading] = useState(false);
  const [ragdollDocs, setRagdollDocs] = useState([]);
  const [ragdollError, setRagdollError] = useState(null);
  const [ragdollContext, setRagdollContext] = useState(readStoredRagdollContext);
  const ragdollIncludeParent = ragdollContext.includeParent;
  const ragdollIncludeSiblings = ragdollContext.includeSiblings;
  const ragdollIncludeChildren = ragdollContext.includeChildren;
  const ragdollIncludeConnected = ragdollContext.includeConnected;

  const setRagdollIncludeParent = useCallback((next) => {
    setRagdollContext((prev) => ({
      ...prev,
      includeParent: typeof next === 'function' ? next(prev.includeParent) : next,
    }));
  }, []);
  const setRagdollIncludeSiblings = useCallback((next) => {
    setRagdollContext((prev) => ({
      ...prev,
      includeSiblings: typeof next === 'function' ? next(prev.includeSiblings) : next,
    }));
  }, []);
  const setRagdollIncludeChildren = useCallback((next) => {
    setRagdollContext((prev) => ({
      ...prev,
      includeChildren: typeof next === 'function' ? next(prev.includeChildren) : next,
    }));
  }, []);
  const setRagdollIncludeConnected = useCallback((next) => {
    setRagdollContext((prev) => ({
      ...prev,
      includeConnected: typeof next === 'function' ? next(prev.includeConnected) : next,
    }));
  }, []);

  const [ragdollQuerySimilarityMinPct, setRagdollQuerySimilarityMinPct] = useState(
    readStoredRagdollQuerySimilarityMinPct
  );

  useEffect(() => {
    try {
      localStorage.setItem(RAGDOLL_CONTEXT_LS_KEY, JSON.stringify(ragdollContext));
    } catch {
      /* ignore */
    }
  }, [ragdollContext]);

  useEffect(() => {
    try {
      localStorage.setItem(RAGDOLL_QUERY_SIMILARITY_MIN_LS_KEY, String(ragdollQuerySimilarityMinPct));
    } catch {
      /* ignore */
    }
  }, [ragdollQuerySimilarityMinPct]);

  useEffect(() => {
    fetchRagdollConfig()
      .then((c) => {
        const en = c?.enabled === true;
        ragdollEnabledRef.current = en;
        setRagdollEnabled(en);
      })
      .catch(() => {
        ragdollEnabledRef.current = false;
        setRagdollEnabled(false);
      });
  }, []);

  /** RAGDoll search when a note is selected, options change, or feature becomes enabled. */
  useEffect(() => {
    if (!ragdollEnabled) {
      ragdollReqId.current += 1;
      setRagdollLoading(false);
      setRagdollError(null);
      setRagdollDocs([]);
      return;
    }
    const nid = hover?.note?.id;
    if (!nid) {
      ragdollReqId.current += 1;
      setRagdollLoading(false);
      setRagdollError(null);
      setRagdollDocs([]);
      return;
    }
    const rid = ++ragdollReqId.current;
    setRagdollLoading(true);
    setRagdollError(null);
    setRagdollDocs([]);
    const opts = {
      includeParent: ragdollIncludeParent,
      includeSiblings: ragdollIncludeSiblings,
      includeChildren: ragdollIncludeChildren,
      includeConnected: ragdollIncludeConnected,
      threshold: ragdollQuerySimilarityMinPct / 100,
    };
    fetchRagdollRelevant(nid, opts)
      .then((data) => {
        if (ragdollReqId.current !== rid) return;
        setRagdollDocs(Array.isArray(data?.documents) ? data.documents : []);
      })
      .catch((err) => {
        if (ragdollReqId.current !== rid) return;
        setRagdollError(err?.message || 'RAGDoll failed');
        setRagdollDocs([]);
      })
      .finally(() => {
        if (ragdollReqId.current === rid) setRagdollLoading(false);
      });
  }, [
    ragdollEnabled,
    hover?.note?.id,
    ragdollIncludeParent,
    ragdollIncludeSiblings,
    ragdollIncludeChildren,
    ragdollIncludeConnected,
    ragdollQuerySimilarityMinPct,
  ]);

  /** Clear insight selection (Stream: single-click mode). */
  const clearInsightSelection = useCallback(() => {
    activeHoverId.current = null;
    insightAnchorRef.current = null;
    hoverNoteRef.current = null;
    if (fetchTimer.current) clearTimeout(fetchTimer.current);
    setHover(null);
    setInsight(null);
    setLoading(false);
    setDismissedKeys(new Set());
    setAddingKey(null);
    setConnectionModal(null);
    setRagdollDocs([]);
    setRagdollLoading(false);
    setRagdollError(null);
    ragdollReqId.current += 1;
  }, []);

  /** Full reset (e.g. after navigating away). */
  const clearAll = useCallback(() => {
    clearInsightSelection();
  }, [clearInsightSelection]);

  /**
   * Single-click: show tag / connection UI for this note. Dismiss only via outside click (see
   * `insightPointerPathShouldKeepOpen`) — not by clicking this note again.
   * @param {number} depth Stream depth (≥ 0 for insight-enabled cards).
   */
  const selectInsightNote = useCallback(
    (note, anchorEl, depth) => {
      if (depth < 0 || !note?.id || !anchorEl) return;
      if (noteIdSame(activeHoverId.current, note.id)) {
        return;
      }
      if (fetchTimer.current) clearTimeout(fetchTimer.current);
      const id = ++reqId.current;

      insightAnchorRef.current = anchorEl;
      hoverNoteRef.current = note;
      setHover({ note });
      activeHoverId.current = note.id;
      setDismissedKeys(new Set());
      setConnectionModal(null);
      setInsight({ tagSuggestions: [], similarNotes: [], persistedLinks: [] });
      setLoading(true);
      setRagdollDocs([]);
      setRagdollError(null);

      /* Min character setting applies only to server-side vector “similar notes” (right panel), not to linked-peer cards. */

      fetchLinkedNotesQuick(note.id)
        .then((data) => {
          if (reqId.current !== id) return;
          const persistedLinks = Array.isArray(data?.persistedLinks)
            ? data.persistedLinks
            : Array.isArray(data?.persisted_links)
              ? data.persisted_links
              : [];
          setInsight((prev) => ({
            tagSuggestions: prev?.tagSuggestions ?? [],
            similarNotes: prev?.similarNotes ?? [],
            persistedLinks,
          }));
        })
        .catch((err) => {
          if (reqId.current !== id) return;
          console.error(err);
        });

      fetchTimer.current = setTimeout(() => {
        fetchHoverInsight(note.id)
          .then(async (data) => {
            if (reqId.current !== id) return;
            let quickPl = [];
            try {
              const q = await fetchLinkedNotesQuick(note.id);
              quickPl = Array.isArray(q?.persistedLinks)
                ? q.persistedLinks
                : Array.isArray(q?.persisted_links)
                  ? q.persisted_links
                  : [];
            } catch (e) {
              console.error(e);
            }
            setInsight(() => {
              const next = normalizeHoverInsightPayload(data);
              const mergedPl = mergePersistedLinksLists(next.persistedLinks, quickPl);
              return { ...next, persistedLinks: mergedPl };
            });
          })
          .catch(() => {
            if (reqId.current !== id) return;
            setInsight((prev) => ({
              tagSuggestions: [],
              similarNotes: [],
              persistedLinks: prev?.persistedLinks ?? [],
            }));
          })
          .finally(() => {
            if (reqId.current === id) setLoading(false);
          });
      }, 220);
    },
    [clearInsightSelection]
  );

  /**
   * Outside dismiss: **capture** on `document`. Only the selected card (`.note-card--insight-selected`),
   * insight UI, and compose keep insight open — clicks on other notes dismiss first.
   */
  useEffect(() => {
    if (!hover?.note) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') clearInsightSelection();
    };
    const onDocumentClickCapture = (e) => {
      if (!hoverNoteRef.current) return;
      if (insightPointerPathShouldKeepOpen(e)) return;
      clearInsightSelection();
      const t = pointerEventTargetElement(e);
      const card = t?.closest?.('.note-card');
      if (card && !card.classList.contains('note-card--insight-selected')) {
        e.stopImmediatePropagation();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('click', onDocumentClickCapture, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('click', onDocumentClickCapture, true);
    };
  }, [hover?.note, clearInsightSelection]);

  const dismissTag = useCallback((key) => {
    setDismissedKeys((prev) => new Set(prev).add(key));
  }, []);

  const addTag = useCallback(
    async (noteId, sug) => {
      const key = sug.key;
      setAddingKey(key);
      try {
        if (sug.tagId) {
          await addNoteTag(noteId, { tag_id: sug.tagId });
        } else {
          await addNoteTag(noteId, { name: sug.name });
        }
        dismissTag(key);
        onNoteUpdated?.();
      } catch (e) {
        console.error(e);
      } finally {
        setAddingKey(null);
      }
    },
    [dismissTag, onNoteUpdated]
  );

  const unlinkPersisted = useCallback(
    async (anchorNoteId, linkedNoteId) => {
      try {
        await deleteNoteConnection(anchorNoteId, linkedNoteId);
        setInsight((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            persistedLinks: (prev.persistedLinks || []).filter((x) => !noteIdSame(x.id, linkedNoteId)),
          };
        });
        setConnectionModal((cur) => {
          const linkedId = cur?.linked?.id ?? cur?.id;
          return linkedId === linkedNoteId ? null : cur;
        });
        onNoteUpdated?.();

        const rid = ++reqId.current;
        fetchHoverInsight(anchorNoteId)
          .then((data) => {
            if (reqId.current !== rid) return;
            setInsight(normalizeHoverInsightPayload(data));
          })
          .catch((err) => {
            if (reqId.current !== rid) return;
            console.error(err);
          });
      } catch (e) {
        console.error(e);
      }
    },
    [onNoteUpdated]
  );

  const navigateToConnection = useCallback(
    async (n) => {
      let root = n.threadRootId;
      try {
        if (!root) root = await getNoteThreadRoot(n.id);
      } catch (e) {
        console.error(e);
        return;
      }
      clearAll();
      onGoToNote?.({ noteId: n.id, threadRootId: root });
    },
    [clearAll, onGoToNote]
  );

  const openNoteFromRichText = useCallback(
    async (linkedId) => {
      try {
        const root = await getNoteThreadRoot(linkedId);
        clearAll();
        onGoToNote?.({ noteId: linkedId, threadRootId: root });
      } catch (e) {
        console.error(e);
      }
    },
    [clearAll, onGoToNote]
  );

  /** Connect a similar note: optimistic reorder (similar list + linked stack by similarity), then sync from API. */
  const connectSimilarNote = useCallback(
    async (similarNoteId) => {
      const anchorId = activeHoverId.current;
      if (!anchorId || !similarNoteId || String(anchorId) === String(similarNoteId)) return;

      setInsight((prev) => {
        if (!prev) return prev;
        const similar = [...(prev.similarNotes || [])];
        const hit = similar.find((x) => String(x.id) === String(similarNoteId));
        if (!hit) return prev;
        const without = similar.filter((x) => String(x.id) !== String(similarNoteId));
        const similarSorted = sortBySimilarityDesc(without);
        const pl = [...(prev.persistedLinks || [])];
        if (pl.some((p) => String(p.id) === String(similarNoteId))) {
          return { ...prev, similarNotes: similarSorted };
        }
        const link = {
          id: hit.id,
          content: hit.content,
          similarity: hit.similarity != null ? Number(hit.similarity) : null,
          threadRootId: hit.threadRootId ?? hit.thread_root_id,
          threadPath: hit.threadPath ?? hit.thread_path ?? '',
          tags: Array.isArray(hit.tags) ? hit.tags : [],
          persisted: true,
        };
        const persistedSorted = sortBySimilarityDesc([...pl, link]);
        return { ...prev, similarNotes: similarSorted, persistedLinks: persistedSorted };
      });

      try {
        await createNoteConnection(anchorId, similarNoteId);
        onNoteUpdated?.();
        const [data, quick] = await Promise.all([
          fetchHoverInsight(anchorId),
          fetchLinkedNotesQuick(anchorId).catch(() => ({})),
        ]);
        if (activeHoverId.current !== anchorId) return;
        const next = normalizeHoverInsightPayload(data);
        const quickPl = Array.isArray(quick?.persistedLinks)
          ? quick.persistedLinks
          : Array.isArray(quick?.persisted_links)
            ? quick.persisted_links
            : [];
        next.persistedLinks = mergePersistedLinksLists(next.persistedLinks, quickPl);
        setInsight(next);
      } catch (e) {
        console.error(e);
        window.alert(e?.message || 'Could not connect note');
        try {
          const [data, quick] = await Promise.all([
            fetchHoverInsight(anchorId),
            fetchLinkedNotesQuick(anchorId).catch(() => ({})),
          ]);
          if (activeHoverId.current === anchorId) {
            const next = normalizeHoverInsightPayload(data);
            const quickPl = Array.isArray(quick?.persistedLinks)
              ? quick.persistedLinks
              : Array.isArray(quick?.persisted_links)
                ? quick.persisted_links
                : [];
            next.persistedLinks = mergePersistedLinksLists(next.persistedLinks, quickPl);
            setInsight(next);
          }
        } catch (_) {
          /* ignore */
        }
      }
    },
    [onNoteUpdated]
  );

  const value = useMemo(
    () => ({
      selectInsightNote,
      clearInsightSelection,
      insightAnchorRef,
      hover,
      insight,
      loading,
      unlinkPersisted,
      dismissedKeys,
      addTag,
      addingKey,
      connectionModal,
      setConnectionModal,
      navigateToConnection,
      openNoteFromRichText,
      connectSimilarNote,
      ragdollEnabled,
      ragdollLoading,
      ragdollDocs,
      ragdollError,
      ragdollIncludeParent,
      setRagdollIncludeParent,
      ragdollIncludeSiblings,
      setRagdollIncludeSiblings,
      ragdollIncludeChildren,
      setRagdollIncludeChildren,
      ragdollIncludeConnected,
      setRagdollIncludeConnected,
      onNoteUpdated,
    }),
    [
      selectInsightNote,
      clearInsightSelection,
      hover,
      insight,
      loading,
      unlinkPersisted,
      dismissedKeys,
      addTag,
      addingKey,
      connectionModal,
      setConnectionModal,
      navigateToConnection,
      openNoteFromRichText,
      connectSimilarNote,
      ragdollEnabled,
      ragdollLoading,
      ragdollDocs,
      ragdollError,
      ragdollIncludeParent,
      ragdollIncludeSiblings,
      ragdollIncludeChildren,
      ragdollIncludeConnected,
      onNoteUpdated,
    ]
  );

  return (
    <HoverInsightContext.Provider value={value}>
      {children}
      <HoverInsightPanels />
    </HoverInsightContext.Provider>
  );
}

function HoverInsightPanels() {
  const ctx = useHoverInsight();
  if (!ctx) return null;

  const {
    hover,
    insight,
    loading,
    unlinkPersisted,
    dismissedKeys,
    addTag,
    addingKey,
    connectionModal,
    setConnectionModal,
    navigateToConnection,
    openNoteFromRichText,
    connectSimilarNote,
    clearInsightSelection,
    insightAnchorRef,
    ragdollEnabled,
    ragdollLoading,
    ragdollDocs,
    ragdollError,
    ragdollIncludeParent,
    setRagdollIncludeParent,
    ragdollIncludeSiblings,
    setRagdollIncludeSiblings,
    ragdollIncludeChildren,
    setRagdollIncludeChildren,
    ragdollIncludeConnected,
    setRagdollIncludeConnected,
    onNoteUpdated,
  } = ctx;

  const isNarrowStream = useMediaQuery(HERMES_COMPACT_VIEWPORT_QUERY);

  const openRagdollDoc = useCallback(async (sourcePath, label) => {
    try {
      const blob = await fetchRagdollSource(sourcePath);
      const url = URL.createObjectURL(blob);
      const w = window.open(url, '_blank', 'noopener');
      if (!w) {
        URL.revokeObjectURL(url);
        window.alert('Popup blocked — allow popups to view the document.');
        return;
      }
      setTimeout(() => URL.revokeObjectURL(url), 120000);
    } catch (e) {
      console.error(e);
      window.alert(e?.message || `Could not open ${label || 'document'}`);
    }
  }, []);

  const [layoutRev, setLayoutRev] = useState(0);
  const [similarMinPct, setSimilarMinPct] = useState(readStoredSimilarMinPct);
  const [similarVisibleTypes, setSimilarVisibleTypes] = useState(readStoredSimilarVisibleTypes);

  const toggleSimilarVisibleNoteType = useCallback((type) => {
    if (!ALL_NOTE_TYPES.has(type)) return;
    setSimilarVisibleTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        if (next.size <= 1) return prev;
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SIMILAR_MIN_LS_KEY, String(similarMinPct));
    } catch {
      /* ignore */
    }
  }, [similarMinPct]);

  useEffect(() => {
    try {
      localStorage.setItem(SIMILAR_TYPES_LS_KEY, JSON.stringify([...similarVisibleTypes].sort()));
    } catch {
      /* ignore */
    }
  }, [similarVisibleTypes]);

  useEffect(() => {
    if (!hover?.note || !isNarrowStream) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [hover?.note, isNarrowStream]);

  useEffect(() => {
    if (!hover?.note) return undefined;
    const bump = () => setLayoutRev((n) => n + 1);
    window.addEventListener('scroll', bump, true);
    window.addEventListener('resize', bump);
    const scroller = insightAnchorRef.current?.closest?.('.stream-page-scroll');
    scroller?.addEventListener('scroll', bump);
    const id = requestAnimationFrame(bump);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('scroll', bump, true);
      window.removeEventListener('resize', bump);
      scroller?.removeEventListener('scroll', bump);
    };
  }, [hover?.note?.id, insightAnchorRef]);
  void layoutRev;

  /**
   * Resolve the card <article> during render (not only via ref) so getBoundingClientRect runs on the
   * live node. Ref can point at a detached element after Stream re-renders; that made rect useless and
   * hid the connection stack even when persistedLinks loaded.
   */
  const layoutAnchorEl = useMemo(() => {
    if (hover?.note?.id == null) return null;
    return findInsightArticleEl(hover.note.id);
  }, [hover?.note?.id, layoutRev]);

  useLayoutEffect(() => {
    if (layoutAnchorEl) insightAnchorRef.current = layoutAnchorEl;
  }, [layoutAnchorEl]);

  const layoutEl = layoutAnchorEl ?? insightAnchorRef.current;
  const rect = layoutEl?.getBoundingClientRect?.();

  const tags = (insight?.tagSuggestions || []).filter((t) => !dismissedKeys.has(t.key));
  const similarNotes = insight?.similarNotes || [];
  const similarMin = similarMinPct / 100;
  const similarNotesAfterSimilarity = useMemo(
    () =>
      similarNotes.filter((sn) => sn.similarity == null || Number(sn.similarity) >= similarMin),
    [similarNotes, similarMin]
  );
  const filteredSimilarNotes = useMemo(() => {
    const filtered = similarNotesAfterSimilarity.filter((sn) =>
      similarVisibleTypes.has(sn.note_type || 'note')
    );
    return sortBySimilarityDesc(filtered);
  }, [similarNotesAfterSimilarity, similarVisibleTypes]);
  const { neighbor: neighborTags, connected: connectedTags, novel: novelTags } = useMemo(
    () => partitionTagSuggestions(tags),
    [tags]
  );
  /** Linked peers: highest similarity first; unknown similarity last. */
  const persisted = useMemo(
    () => sortBySimilarityDesc(insight?.persistedLinks || []),
    [insight?.persistedLinks]
  );

  /** SQL-backed links (body mentions, similar-panel connect, etc.) — used for disconnect + “Linked” label. */
  const persistedIdSet = useMemo(
    () => new Set(persisted.map((p) => String(p.id).toLowerCase())),
    [persisted]
  );

  /** Under-card stack: linked peers only. Similar notes appear only in the right panel (avoids reading as duplicate “connections”). */
  const connectionStackPeers = persisted;

  const ragdollByCollection = useMemo(
    () => groupRagdollDocumentsByCollection(ragdollDocs),
    [ragdollDocs]
  );

  const note = hover?.note;

  /** Below the card; stack’s right edge aligns with note’s right + 60px (viewport coords). */
  const LINK_STACK_RIGHT_OUTSET = 60;
  const connectionLayout =
    rect && connectionStackPeers.length > 0
      ? (() => {
          const gap = 6;
          const margin = 8;
          const stackW = Math.min(280, Math.max(200, rect.width), window.innerWidth - 2 * margin);
          const stackRight = rect.right + LINK_STACK_RIGHT_OUTSET;
          let left = stackRight - stackW;
          if (left + stackW > window.innerWidth - margin) {
            left = Math.max(margin, window.innerWidth - margin - stackW);
          }
          if (left < margin) left = margin;
          const stackTopPx = rect.bottom + gap;
          const roomBelow = window.innerHeight - stackTopPx - margin;
          return {
            stackStyle: {
              top: stackTopPx,
              left,
              width: stackW,
              maxHeight: `${Math.max(120, Math.min(roomBelow, window.innerHeight * 0.5))}px`,
            },
          };
        })()
      : null;

  return (
    <>
      {hover && isNarrowStream && note && (
        <HoverInsightMobileSheet
          onClose={clearInsightSelection}
          note={note}
          loading={loading}
          tags={tags}
          neighborTags={neighborTags}
          connectedTags={connectedTags}
          novelTags={novelTags}
          addTag={addTag}
          addingKey={addingKey}
          ragdollEnabled={ragdollEnabled}
          ragdollLoading={ragdollLoading}
          ragdollDocs={ragdollDocs}
          ragdollError={ragdollError}
          ragdollByCollection={ragdollByCollection}
          openRagdollDoc={openRagdollDoc}
          ragdollIncludeParent={ragdollIncludeParent}
          setRagdollIncludeParent={setRagdollIncludeParent}
          ragdollIncludeSiblings={ragdollIncludeSiblings}
          setRagdollIncludeSiblings={setRagdollIncludeSiblings}
          ragdollIncludeChildren={ragdollIncludeChildren}
          setRagdollIncludeChildren={setRagdollIncludeChildren}
          ragdollIncludeConnected={ragdollIncludeConnected}
          setRagdollIncludeConnected={setRagdollIncludeConnected}
          ragdollQuerySimilarityMinPct={ragdollQuerySimilarityMinPct}
          setRagdollQuerySimilarityMinPct={setRagdollQuerySimilarityMinPct}
          similarMinPct={similarMinPct}
          setSimilarMinPct={setSimilarMinPct}
          similarVisibleTypes={similarVisibleTypes}
          toggleSimilarVisibleNoteType={toggleSimilarVisibleNoteType}
          similarNotes={similarNotes}
          filteredSimilarNotes={filteredSimilarNotes}
          similarNotesAfterSimilarity={similarNotesAfterSimilarity}
          insight={insight}
          connectSimilarNote={connectSimilarNote}
          openNoteFromRichText={openNoteFromRichText}
          connectionStackPeers={connectionStackPeers}
          persistedIdSet={persistedIdSet}
          setConnectionModal={setConnectionModal}
          unlinkPersisted={unlinkPersisted}
        />
      )}

      {hover && rect && !isNarrowStream && (
        <>
          <div
            className={`hover-insight-margin hover-insight-margin--left ${ragdollEnabled ? 'hover-insight-margin--left-with-ragdoll' : ''}`}
            data-insight-ui
          >
            <div className="hover-insight-left-stack">
              <div className={`hover-insight-panel hover-insight-panel--left ${loading ? 'hover-insight-panel--loading' : ''}`}>
                <p className="hover-insight-title">Tag suggestions</p>
                {loading && <p className="hover-insight-muted">Thinking…</p>}
                {!loading && tags.length === 0 && <p className="hover-insight-muted">No suggestions</p>}
                {!loading && tags.length > 0 && (
                  <div className="hover-insight-tag-groups">
                    <HoverInsightTagSection
                      title="Based on neighbor notes"
                      tags={neighborTags}
                      note={note}
                      addTag={addTag}
                      addingKey={addingKey}
                    />
                    <HoverInsightTagSection
                      title="Based on connected notes"
                      tags={connectedTags}
                      note={note}
                      addTag={addTag}
                      addingKey={addingKey}
                    />
                    <HoverInsightTagSection
                      title="New tag suggestions"
                      tags={novelTags}
                      note={note}
                      addTag={addTag}
                      addingKey={addingKey}
                    />
                  </div>
                )}
              </div>
              {ragdollEnabled && (
                <div
                  className={`hover-insight-panel hover-insight-panel--ragdoll ${ragdollLoading ? 'hover-insight-panel--loading' : ''}`}
                >
                  <p className="hover-insight-title">RAG documents</p>
                  <p className="hover-insight-ragdoll-hint">
                    Selected note is always included. Choose extra context for RAGDoll search:
                  </p>
                  <div className="hover-insight-ragdoll-checkboxes" role="group" aria-label="RAG context">
                    <label className="hover-insight-ragdoll-check">
                      <input
                        type="checkbox"
                        checked={ragdollIncludeConnected}
                        onChange={(e) => setRagdollIncludeConnected(e.target.checked)}
                      />
                      <span>Connected notes</span>
                    </label>
                    <label className="hover-insight-ragdoll-check">
                      <input
                        type="checkbox"
                        checked={ragdollIncludeParent}
                        onChange={(e) => setRagdollIncludeParent(e.target.checked)}
                      />
                      <span>Parent</span>
                    </label>
                    <label className="hover-insight-ragdoll-check">
                      <input
                        type="checkbox"
                        checked={ragdollIncludeSiblings}
                        onChange={(e) => setRagdollIncludeSiblings(e.target.checked)}
                      />
                      <span>Siblings</span>
                    </label>
                    <label className="hover-insight-ragdoll-check">
                      <input
                        type="checkbox"
                        checked={ragdollIncludeChildren}
                        onChange={(e) => setRagdollIncludeChildren(e.target.checked)}
                      />
                      <span>Children</span>
                    </label>
                  </div>
                  <div className="hover-insight-similar-slider-wrap hover-insight-ragdoll-threshold-slider">
                    <div className="hover-insight-similar-slider-label">
                      <span>Min. similarity</span>
                      <span className="hover-insight-similar-slider-value">{ragdollQuerySimilarityMinPct}%</span>
                    </div>
                    <input
                      type="range"
                      className="hover-insight-similar-slider"
                      min={5}
                      max={95}
                      step={5}
                      value={ragdollQuerySimilarityMinPct}
                      onChange={(e) => setRagdollQuerySimilarityMinPct(Number(e.target.value))}
                      aria-label="Minimum similarity for RAG document search"
                    />
                    <div className="hover-insight-similar-slider-ticks" aria-hidden>
                      <span>5%</span>
                      <span>25%</span>
                      <span>50%</span>
                      <span>75%</span>
                      <span>95%</span>
                    </div>
                  </div>
                  <div className="hover-insight-ragdoll-results">
                    {ragdollLoading && <p className="hover-insight-muted">Searching library…</p>}
                    {!ragdollLoading && ragdollError && (
                      <p className="hover-insight-muted" title={ragdollError}>
                        {ragdollError}
                      </p>
                    )}
                    {!ragdollLoading && !ragdollError && ragdollDocs.length === 0 && (
                      <p className="hover-insight-muted">No matching documents.</p>
                    )}
                    {!ragdollLoading && ragdollByCollection.length > 0 && (
                      <div className="hover-insight-ragdoll-grouped">
                        {ragdollByCollection.map(({ group, label, docs }) => (
                          <div key={group} className="hover-insight-stack-section">
                            <p className="hover-insight-stack-section-title">{label}</p>
                            <ul className="hover-insight-stack-list hover-insight-ragdoll-list">
                              {docs.map((d, i) => (
                                <li key={`${group}|${d.source_url || d.source_name || 'doc'}|${i}`}>
                                  <button
                                    type="button"
                                    className="hover-insight-ragdoll-link"
                                    title={d.source_summary || d.source_name}
                                    onClick={() => openRagdollDoc(d.source_url, d.source_name)}
                                  >
                                    <span className="hover-insight-ragdoll-name">{d.source_name}</span>
                                    {d.similarity != null && (
                                      <span className="hover-insight-ragdoll-sim">
                                        {Math.round(Number(d.similarity) * 100)}%
                                      </span>
                                    )}
                                  </button>
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <div
            className="hover-insight-margin hover-insight-margin--right"
            data-insight-ui
          >
            <div className={`hover-insight-panel hover-insight-panel--right ${loading ? 'hover-insight-panel--loading' : ''}`}>
              <p className="hover-insight-title hover-insight-similar-panel-heading">Similar notes</p>
              <div
                className="hover-insight-similar-type-filters"
                role="group"
                aria-label="Filter similar notes by type"
              >
                {NOTE_TYPE_HEADER_ORDER.map((t) => {
                  const on = similarVisibleTypes.has(t);
                  const label = SIMILAR_TYPE_FILTER_LABELS[t] ?? t;
                  return (
                    <button
                      key={t}
                      type="button"
                      className={`hover-insight-similar-type-btn ${on ? 'hover-insight-similar-type-btn--on' : ''}`}
                      aria-pressed={on}
                      aria-label={
                        on
                          ? `${label} visible in similar notes — click to hide`
                          : `${label} hidden from similar notes — click to show`
                      }
                      title={
                        on
                          ? `${label} shown — click to hide from similar notes`
                          : `${label} hidden — click to show in similar notes`
                      }
                      onClick={() => toggleSimilarVisibleNoteType(t)}
                    >
                      <NoteTypeIcon type={t} className="hover-insight-similar-type-icon" />
                    </button>
                  );
                })}
              </div>
              <div className="hover-insight-similar-panel-body">
                {loading && <p className="hover-insight-muted">Thinking…</p>}
                {!loading && (
                  <>
                    <div className="hover-insight-similar-slider-wrap">
                      <div className="hover-insight-similar-slider-label">
                        <span>Min. similarity</span>
                        <span className="hover-insight-similar-slider-value">{similarMinPct}%</span>
                      </div>
                      <input
                        type="range"
                        className="hover-insight-similar-slider"
                        min={5}
                        max={95}
                        step={5}
                        value={similarMinPct}
                        onChange={(e) => setSimilarMinPct(Number(e.target.value))}
                        aria-label="Minimum similarity for similar notes"
                      />
                      <div className="hover-insight-similar-slider-ticks" aria-hidden>
                        <span>5%</span>
                        <span>25%</span>
                        <span>50%</span>
                        <span>75%</span>
                        <span>95%</span>
                      </div>
                    </div>
                    {similarNotes.length === 0 ? (
                      <p className="hover-insight-muted">
                        {insight?.similarNotesSkippedShortNote
                          ? 'This note is too short for this feature. Adjust the minimum character length of notes for similiarity analysis in settings.'
                          : 'No similar notes (needs embeddings, or nothing close enough yet).'}
                      </p>
                    ) : filteredSimilarNotes.length === 0 ? (
                      <p className="hover-insight-muted">
                        {similarNotesAfterSimilarity.length === 0
                          ? 'No notes at or above this similarity threshold.'
                          : 'No similar notes match the selected types.'}
                      </p>
                    ) : (
                      <ul className="hover-insight-similar-list">
                        {filteredSimilarNotes.map((sn) => {
                          const raw = sn.content != null ? String(sn.content).trim() : '';
                          const path = sn.threadPath || sn.thread_path || '';
                          const tagNames = Array.isArray(sn.tags) ? sn.tags.map((t) => t.name || t) : [];
                          const simType = sn.note_type || 'note';
                          const simTypeClass =
                            simType === 'organization'
                              ? 'hover-insight-similar-btn--type-organization'
                              : simType === 'person'
                                ? 'hover-insight-similar-btn--type-person'
                                : simType === 'event'
                                  ? 'hover-insight-similar-btn--type-event'
                                  : simType === 'note'
                                    ? 'hover-insight-similar-btn--type-note'
                                    : '';
                          return (
                            <li key={sn.id}>
                              <div
                                role="button"
                                tabIndex={0}
                                className={['hover-insight-similar-btn', simTypeClass].filter(Boolean).join(' ')}
                                title="Add as connected note to the selected card"
                                onClick={() => connectSimilarNote(sn.id)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    connectSimilarNote(sn.id);
                                  }
                                }}
                              >
                                <span className="hover-insight-similar-btn-main">
                                  {path ? (
                                    <p
                                      className="hover-insight-thread-path hover-insight-thread-path--card hover-insight-similar-thread-path"
                                      title={path}
                                    >
                                      {path}
                                    </p>
                                  ) : (
                                    <p className="hover-insight-thread-path hover-insight-thread-path--card hover-insight-similar-thread-path hover-insight-muted">
                                      (Thread root)
                                    </p>
                                  )}
                                  <p
                                    className="hover-insight-connection-card-snippet hover-insight-similar-note-snippet"
                                    title={raw || undefined}
                                  >
                                    {raw ? (
                                      <NoteRichText
                                        text={raw.slice(0, 900)}
                                        tagNames={tagNames}
                                        className="hover-insight-card-rich-text"
                                        onNoteClick={openNoteFromRichText}
                                      />
                                    ) : (
                                      '—'
                                    )}
                                  </p>
                                </span>
                                {sn.similarity != null && (
                                  <span className="hover-insight-sim-pct">{Math.round(sn.similarity * 100)}%</span>
                                )}
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {hover && rect && !isNarrowStream && connectionStackPeers.length > 0 && connectionLayout && note && (
        <>
        <div
          className="hover-insight-connection-stack"
          data-insight-ui
          style={connectionLayout.stackStyle}
        >
          <div className="hover-insight-connection-stack-inner">
          {connectionStackPeers.map((pn) => {
            const body = pn.content != null ? String(pn.content).trim() : '';
            const tagNames = Array.isArray(pn.tags) ? pn.tags.map((t) => t.name || t) : [];
            const connType = pn.note_type || 'note';
            const connTypeClass =
              connType === 'organization'
                ? 'hover-insight-connection-card--type-organization'
                : connType === 'person'
                  ? 'hover-insight-connection-card--type-person'
                  : connType === 'event'
                    ? 'hover-insight-connection-card--type-event'
                    : connType === 'note'
                      ? 'hover-insight-connection-card--type-note'
                      : '';
            const isDbLinked = persistedIdSet.has(String(pn.id).toLowerCase());
            const openModal = () =>
              setConnectionModal({
                linked: pn,
                anchorNoteId: note.id,
                hideDisconnect: !isDbLinked,
              });
            return (
            <div
              key={pn.id}
              className={['hover-insight-connection-card', connTypeClass].filter(Boolean).join(' ')}
            >
              <div
                role="button"
                tabIndex={0}
                className="hover-insight-connection-card-main"
                onClick={openModal}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openModal();
                  }
                }}
                title={isDbLinked ? 'Open linked note' : 'Open similar note'}
              >
                <span className="hover-insight-connection-card-label">
                  {isDbLinked ? 'Linked' : 'Similar'}
                </span>
                {pn.similarity != null && (
                  <span className="hover-insight-connection-card-sim">
                    {Math.round(pn.similarity * 100)}%
                  </span>
                )}
                {pn.threadPath ? (
                  <p className="hover-insight-thread-path hover-insight-thread-path--card" title={pn.threadPath}>
                    {pn.threadPath}
                  </p>
                ) : null}
                <p className="hover-insight-connection-card-snippet" title={body || undefined}>
                  {body ? (
                    <NoteRichText
                      text={body.slice(0, 900)}
                      tagNames={tagNames}
                      className="hover-insight-card-rich-text"
                      onNoteClick={openNoteFromRichText}
                    />
                  ) : (
                    '—'
                  )}
                </p>
              </div>
              {isDbLinked ? (
                <button
                  type="button"
                  className="hover-insight-icon-btn hover-insight-connection-unlink"
                  aria-label="Disconnect linked note"
                  title="Disconnect link (confirm)"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!window.confirm(CONFIRM_UNLINK)) return;
                    unlinkPersisted(note.id, pn.id);
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
            );
          })}
          </div>
        </div>
        </>
      )}

      {connectionModal?.linked && connectionModal.anchorNoteId && (
        <ConnectionNoteModal
          linked={connectionModal.linked}
          anchorNoteId={connectionModal.anchorNoteId}
          hideDisconnect={connectionModal.hideDisconnect === true}
          onClose={() => setConnectionModal(null)}
          unlinkPersisted={unlinkPersisted}
          navigateToConnection={navigateToConnection}
          onNoteUpdated={onNoteUpdated}
        />
      )}
    </>
  );
}
