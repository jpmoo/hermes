import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  getNote,
  getNoteThreadPath,
  getNoteThreadRoot,
} from './api';
import './HoverInsight.css';

const CONFIRM_UNLINK =
  'Remove the link between these two notes? The notes are not deleted—only the connection is removed.';

const SIMILAR_MIN_LS_KEY = 'hermes.insightSimilarMinPct';

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
      }))
    : [];
  return {
    ...data,
    tagSuggestions: Array.isArray(tags) ? tags : [],
    similarNotes: similarNorm,
    persistedLinks: Array.isArray(persisted) ? persisted : [],
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
  const ragdollEnabledRef = useRef(false);
  const ragdollReqId = useRef(0);
  const [ragdollEnabled, setRagdollEnabled] = useState(false);
  const [ragdollLoading, setRagdollLoading] = useState(false);
  const [ragdollDocs, setRagdollDocs] = useState([]);
  const [ragdollError, setRagdollError] = useState(null);
  const [ragdollIncludeParent, setRagdollIncludeParent] = useState(false);
  const [ragdollIncludeSiblings, setRagdollIncludeSiblings] = useState(false);
  const [ragdollIncludeChildren, setRagdollIncludeChildren] = useState(false);
  const [ragdollIncludeConnected, setRagdollIncludeConnected] = useState(true);

  useEffect(() => {
    fetchRagdollConfig()
      .then((c) => {
        const en = !!c?.enabled;
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
    if (!ragdollEnabled) return;
    const nid = hover?.note?.id;
    if (!nid) return;
    const rid = ++ragdollReqId.current;
    setRagdollLoading(true);
    setRagdollError(null);
    setRagdollDocs([]);
    const opts = {
      includeParent: ragdollIncludeParent,
      includeSiblings: ragdollIncludeSiblings,
      includeChildren: ragdollIncludeChildren,
      includeConnected: ragdollIncludeConnected,
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
  ]);

  /** Clear insight selection (Stream: single-click mode). */
  const clearInsightSelection = useCallback(() => {
    activeHoverId.current = null;
    insightAnchorRef.current = null;
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
   * Single-click: show tag / connection UI for this note. Click again on the same note to dismiss.
   * @param {number} depth Stream depth (≥ 0 for insight-enabled cards).
   */
  const selectInsightNote = useCallback(
    (note, anchorEl, depth) => {
      if (depth < 0 || !note?.id || !anchorEl) return;
      if (activeHoverId.current === note.id) {
        clearInsightSelection();
        return;
      }
      insightAnchorRef.current = anchorEl;
      setHover({ note });
      activeHoverId.current = note.id;
      setDismissedKeys(new Set());
      setConnectionModal(null);
      if (fetchTimer.current) clearTimeout(fetchTimer.current);
      const id = ++reqId.current;
      setInsight({ tagSuggestions: [], similarNotes: [], persistedLinks: [] });
      setLoading(true);
      setRagdollDocs([]);
      setRagdollError(null);

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
          .then((data) => {
            if (reqId.current !== id) return;
            setInsight(normalizeHoverInsightPayload(data));
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

  /** Pointer / Escape: dismiss when clicking outside insight UI and the selected card. */
  useEffect(() => {
    if (!hover?.note) return undefined;
    const onPointerDown = (e) => {
      const t = e.target;
      if (t.closest?.('[data-insight-ui]')) return;
      if (t.closest?.('.note-card--insight-selected')) return;
      clearInsightSelection();
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') clearInsightSelection();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
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
            persistedLinks: (prev.persistedLinks || []).filter((x) => x.id !== linkedNoteId),
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
        const data = await fetchHoverInsight(anchorId);
        if (activeHoverId.current !== anchorId) return;
        setInsight(normalizeHoverInsightPayload(data));
      } catch (e) {
        console.error(e);
        window.alert(e?.message || 'Could not connect note');
        try {
          const data = await fetchHoverInsight(anchorId);
          if (activeHoverId.current === anchorId) {
            setInsight(normalizeHoverInsightPayload(data));
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
      connectSimilarNote,
      ragdollEnabled,
      ragdollLoading,
      ragdollDocs,
      ragdollError,
      ragdollIncludeParent,
      ragdollIncludeSiblings,
      ragdollIncludeChildren,
      ragdollIncludeConnected,
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
    connectSimilarNote,
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
  } = ctx;

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

  /** Peer shown in the modal: merge stack row with latest insight row (ids, threadPath updates). */
  const connectionModalLinked = useMemo(() => {
    if (!connectionModal?.linked) return null;
    const l = connectionModal.linked;
    const fresh = insight?.persistedLinks?.find((x) => x.id === l.id);
    return fresh ? { ...l, ...fresh, threadPath: fresh.threadPath ?? l.threadPath, content: fresh.content ?? l.content } : l;
  }, [connectionModal, insight?.persistedLinks]);

  /** Ancestor breadcrumb only (exclude linked note text) + authoritative body from API — stack payload can be stale/minimal. */
  const [connectionModalFetched, setConnectionModalFetched] = useState({
    threadPath: '',
    content: '',
    loading: false,
  });

  useEffect(() => {
    const linked = connectionModal?.linked;
    if (!linked?.id) {
      setConnectionModalFetched({ threadPath: '', content: '', loading: false });
      return undefined;
    }
    let cancelled = false;
    setConnectionModalFetched({
      threadPath: linked.threadPath || '',
      content: linked.content != null ? String(linked.content) : '',
      loading: true,
    });
    Promise.all([
      getNoteThreadPath(linked.id, { excludeLeaf: true }),
      getNote(linked.id).then((n) => (n?.content != null ? String(n.content) : '')),
    ])
      .then(([path, content]) => {
        if (cancelled) return;
        setConnectionModalFetched({
          threadPath: path || '',
          content: content,
          loading: false,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setConnectionModalFetched({
          threadPath: linked.threadPath || '',
          content: linked.content != null ? String(linked.content) : '',
          loading: false,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [connectionModal?.linked?.id]);

  const [layoutRev, setLayoutRev] = useState(0);
  const [similarMinPct, setSimilarMinPct] = useState(readStoredSimilarMinPct);

  useEffect(() => {
    try {
      localStorage.setItem(SIMILAR_MIN_LS_KEY, String(similarMinPct));
    } catch {
      /* ignore */
    }
  }, [similarMinPct]);

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
  const rect = insightAnchorRef.current?.getBoundingClientRect?.();

  const tags = (insight?.tagSuggestions || []).filter((t) => !dismissedKeys.has(t.key));
  const similarNotes = insight?.similarNotes || [];
  const similarMin = similarMinPct / 100;
  const filteredSimilarNotes = useMemo(() => {
    const filtered = similarNotes.filter(
      (sn) => sn.similarity == null || Number(sn.similarity) >= similarMin
    );
    return sortBySimilarityDesc(filtered);
  }, [similarNotes, similarMin]);
  const { neighbor: neighborTags, connected: connectedTags, novel: novelTags } = useMemo(
    () => partitionTagSuggestions(tags),
    [tags]
  );
  /** Linked peers: highest similarity first; unknown similarity last. */
  const persisted = useMemo(
    () => sortBySimilarityDesc(insight?.persistedLinks || []),
    [insight?.persistedLinks]
  );

  const note = hover?.note;

  /** Below the card; stack’s right edge aligns with note’s right + 60px (viewport coords). */
  const LINK_STACK_RIGHT_OUTSET = 60;
  const connectionLayout =
    rect && persisted.length > 0
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
      {hover && rect && (
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
              <div className="hover-insight-similar-panel-body">
                {loading && <p className="hover-insight-muted">Thinking…</p>}
                {!loading && similarNotes.length === 0 && (
                  <p className="hover-insight-muted">
                    No similar notes (needs embeddings, or nothing close enough yet).
                  </p>
                )}
                {!loading && similarNotes.length > 0 && (
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
                    {filteredSimilarNotes.length === 0 ? (
                      <p className="hover-insight-muted">No notes at or above this threshold.</p>
                    ) : (
                      <ul className="hover-insight-similar-list">
                        {filteredSimilarNotes.map((sn) => {
                          const raw = sn.content != null ? String(sn.content).trim().replace(/\s+/g, ' ') : '';
                          const path = sn.threadPath || sn.thread_path || '';
                          const snippet =
                            raw.length > 160 ? `${raw.slice(0, 160)}…` : raw || '—';
                          return (
                            <li key={sn.id}>
                              <button
                                type="button"
                                className="hover-insight-similar-btn"
                                title="Add as connected note to the selected card"
                                onClick={() => connectSimilarNote(sn.id)}
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
                                    {snippet}
                                  </p>
                                </span>
                                {sn.similarity != null && (
                                  <span className="hover-insight-sim-pct">{Math.round(sn.similarity * 100)}%</span>
                                )}
                              </button>
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

      {hover && rect && persisted.length > 0 && connectionLayout && note && (
        <>
        <div
          className="hover-insight-connection-stack"
          data-insight-ui
          style={connectionLayout.stackStyle}
        >
          {persisted.map((pn) => (
            <div key={pn.id} className="hover-insight-connection-card">
              <button
                type="button"
                className="hover-insight-connection-card-main"
                onClick={() => setConnectionModal({ linked: pn, anchorNoteId: note.id })}
                title="Open linked note"
              >
                <span className="hover-insight-connection-card-label">Linked</span>
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
                <p className="hover-insight-connection-card-snippet">
                  {(pn.content || '—').slice(0, 160)}
                  {(pn.content?.length || 0) > 160 ? '…' : ''}
                </p>
              </button>
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
            </div>
          ))}
        </div>
        </>
      )}

      {connectionModal && (
        <div
          className="hover-insight-modal-backdrop"
          data-insight-ui
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setConnectionModal(null);
          }}
        >
          <div
            className="hover-insight-modal"
            data-insight-ui
            role="dialog"
            aria-modal="true"
            aria-labelledby="hover-insight-modal-title"
          >
            <h2 id="hover-insight-modal-title" className="hover-insight-modal-title">
              Connected note
            </h2>
            <div className="hover-insight-modal-body">
              <p className="hover-insight-modal-section-label">Thread path</p>
              {connectionModalFetched.loading && !connectionModalFetched.threadPath ? (
                <p className="hover-insight-muted">Loading path…</p>
              ) : connectionModalFetched.threadPath ? (
                <p
                  className="hover-insight-thread-path hover-insight-thread-path--modal"
                  title={connectionModalFetched.threadPath}
                >
                  {connectionModalFetched.threadPath}
                </p>
              ) : (
                <p className="hover-insight-muted">No path</p>
              )}
              <p className="hover-insight-modal-section-label">Note</p>
              {connectionModalFetched.loading && !connectionModalFetched.content ? (
                <p className="hover-insight-muted">Loading note…</p>
              ) : (
                <div className="hover-insight-modal-note-text">
                  {connectionModalFetched.content?.trim()
                    ? connectionModalFetched.content
                    : connectionModalLinked?.content?.trim()
                      ? connectionModalLinked.content
                      : '—'}
                </div>
              )}
            </div>
            <div className="hover-insight-modal-actions">
              <button
                type="button"
                className="hover-insight-modal-btn hover-insight-modal-btn--danger"
                onClick={() => {
                  if (!window.confirm(CONFIRM_UNLINK)) return;
                  const anchorId = connectionModal.anchorNoteId;
                  const linkedId = connectionModal.linked?.id;
                  if (anchorId && linkedId) unlinkPersisted(anchorId, linkedId);
                  else setConnectionModal(null);
                }}
              >
                Disconnect
              </button>
              <div className="hover-insight-modal-actions-right">
                <button type="button" className="hover-insight-modal-btn hover-insight-modal-btn--secondary" onClick={() => setConnectionModal(null)}>
                  Close
                </button>
                <button
                  type="button"
                  className="hover-insight-modal-btn hover-insight-modal-btn--primary"
                  onClick={() => navigateToConnection(connectionModal.linked)}
                >
                  Go to note
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
