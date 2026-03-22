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
  addNoteTag,
  createNoteConnection,
  deleteNoteConnection,
  getNoteThreadRoot,
} from './api';
import './HoverInsight.css';

const CONFIRM_UNLINK =
  'Remove the link between these two notes? The notes are not deleted—only the connection is removed.';

/** Last “min. similarity” for Stream insight; persists across sessions after the user moves the slider. */
const SIMILARITY_STORAGE_KEY = 'hermes_insight_similarity_min';
const SIM_SLIDER_MIN = 0.1;
const SIM_SLIDER_MAX = 0.9;
const SIM_SLIDER_STEP = 0.05;
const SIM_SLIDER_DEFAULT = 0.5;

function clampSimilaritySlider(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return SIM_SLIDER_DEFAULT;
  const s =
    Math.round(Math.min(SIM_SLIDER_MAX, Math.max(SIM_SLIDER_MIN, n)) / SIM_SLIDER_STEP) * SIM_SLIDER_STEP;
  return s;
}

function readStoredSimilarityMin() {
  try {
    const v = parseFloat(localStorage.getItem(SIMILARITY_STORAGE_KEY) ?? '', 10);
    if (Number.isFinite(v)) return clampSimilaritySlider(v);
  } catch (_) {
    /* ignore */
  }
  return SIM_SLIDER_DEFAULT;
}

/** Ensure arrays exist (API / parse edge cases). Accept camelCase or snake_case keys. */
function normalizeHoverInsightPayload(data) {
  if (!data || typeof data !== 'object') {
    return {
      tagSuggestions: [],
      similarNotes: [],
      persistedLinks: [],
      similarityMin: SIM_SLIDER_DEFAULT,
    };
  }
  const persisted = data.persistedLinks ?? data.persisted_links;
  const similar = data.similarNotes ?? data.similar_notes;
  const tags = data.tagSuggestions ?? data.tag_suggestions;
  return {
    ...data,
    tagSuggestions: Array.isArray(tags) ? tags : [],
    similarNotes: Array.isArray(similar) ? similar : [],
    persistedLinks: Array.isArray(persisted) ? persisted : [],
  };
}

/** Split flat tag list into neighbor / similar / new (ollama) groups. */
function partitionTagSuggestions(list) {
  const neighbor = [];
  const similar = [];
  const novel = [];
  for (const t of list) {
    if (t.source === 'similar') {
      similar.push(t);
    } else if (t.source === 'ollama') {
      if (t.fromVocab === true) neighbor.push(t);
      else if (t.fromVocab === false) novel.push(t);
      else if (t.tagId) neighbor.push(t);
      else novel.push(t);
    }
  }
  return { neighbor, similar, novel };
}

/** Whether a tag suggestion matches an approved tag on a connection (similar / linked) note. */
function tagSuggestionMatchesNoteTags(suggestion, noteTags) {
  if (!noteTags?.length) return false;
  if (suggestion.tagId && noteTags.some((t) => t.id === suggestion.tagId)) return true;
  const name = (suggestion.name || '').trim().toLowerCase();
  if (!name) return false;
  return noteTags.some((t) => (t.name || '').trim().toLowerCase() === name);
}

const HoverInsightContext = createContext(null);

function tagSuggestionTitle(t, highlightConnection) {
  if (highlightConnection) return 'Also on the connection note you highlighted';
  if (t.source === 'similar') return 'From similar notes in your library';
  if (t.fromVocab === true) return 'From thread context (parent, siblings, replies) using your tags';
  return 'New tag from model (may create tag when added)';
}

function HoverInsightTagSection({
  title,
  tags,
  note,
  dismissTag,
  addTag,
  addingKey,
  connectionTagSourceId,
  connectionHighlightTags,
}) {
  if (tags.length === 0) return null;
  return (
    <div className="hover-insight-tag-section">
      <p className="hover-insight-tag-section-title">{title}</p>
      <ul className="hover-insight-tag-list">
        {tags.map((t) => {
          const highlightConnection =
            !!connectionTagSourceId && tagSuggestionMatchesNoteTags(t, connectionHighlightTags);
          return (
            <li
              key={t.key}
              className={`hover-insight-tag-row${highlightConnection ? ' hover-insight-tag-row--connection-highlight' : ''}`}
              data-connection-highlight={highlightConnection ? 'true' : undefined}
            >
              <button
                type="button"
                className="hover-insight-icon-btn"
                aria-label={`Dismiss ${t.name}`}
                onClick={() => dismissTag(t.key)}
              >
                ×
              </button>
              <span className="hover-insight-tag-name" title={tagSuggestionTitle(t, highlightConnection)}>
                {t.name}
              </span>
              <button
                type="button"
                className="hover-insight-icon-btn hover-insight-icon-btn--add"
                aria-label={`Add ${t.name}`}
                disabled={addingKey === t.key}
                onClick={() => addTag(note.id, t)}
              >
                +
              </button>
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
  const [connectionTagSourceId, setConnectionTagSourceId] = useState(null);
  const [similarityMin, setSimilarityMin] = useState(() => readStoredSimilarityMin());
  const fetchTimer = useRef(null);
  const sliderInsightTimerRef = useRef(null);
  const reqId = useRef(0);
  const activeHoverId = useRef(null);
  /** Selected card element for layout (connection stack / scroll sync). */
  const insightAnchorRef = useRef(null);

  /** Clear insight selection (Stream: single-click mode). */
  const clearInsightSelection = useCallback(() => {
    activeHoverId.current = null;
    insightAnchorRef.current = null;
    if (fetchTimer.current) clearTimeout(fetchTimer.current);
    if (sliderInsightTimerRef.current) clearTimeout(sliderInsightTimerRef.current);
    sliderInsightTimerRef.current = null;
    setHover(null);
    setInsight(null);
    setLoading(false);
    setDismissedKeys(new Set());
    setAddingKey(null);
    setConnectionModal(null);
    setConnectionTagSourceId(null);
  }, []);

  /** Full reset (e.g. after navigating away). */
  const clearAll = useCallback(() => {
    clearInsightSelection();
  }, [clearInsightSelection]);

  /** Update slider state and write to localStorage (survives reloads / new tabs on same origin). */
  const persistSimilarityMin = useCallback((raw) => {
    const c = clampSimilaritySlider(raw);
    setSimilarityMin(c);
    try {
      localStorage.setItem(SIMILARITY_STORAGE_KEY, String(c));
    } catch (_) {
      /* private mode / quota */
    }
    return c;
  }, []);

  const onSimilaritySliderChange = useCallback(
    (rawValue) => {
      const c = persistSimilarityMin(rawValue);
      const noteId = activeHoverId.current;
      if (!noteId) return;
      if (sliderInsightTimerRef.current) clearTimeout(sliderInsightTimerRef.current);
      sliderInsightTimerRef.current = setTimeout(() => {
        sliderInsightTimerRef.current = null;
        const id = ++reqId.current;
        setLoading(true);
        fetchHoverInsight(noteId, c)
          .then((data) => {
            if (reqId.current !== id) return;
            setInsight(normalizeHoverInsightPayload(data));
          })
          .catch(() => {
            if (reqId.current !== id) return;
            setInsight({ tagSuggestions: [], similarNotes: [], persistedLinks: [] });
          })
          .finally(() => {
            if (reqId.current === id) setLoading(false);
          });
      }, 320);
    },
    [persistSimilarityMin]
  );

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
      if (sliderInsightTimerRef.current) {
        clearTimeout(sliderInsightTimerRef.current);
        sliderInsightTimerRef.current = null;
      }
      insightAnchorRef.current = anchorEl;
      setHover({ note });
      activeHoverId.current = note.id;
      setDismissedKeys(new Set());
      setConnectionModal(null);
      setConnectionTagSourceId(null);
      if (fetchTimer.current) clearTimeout(fetchTimer.current);
      setInsight(null);
      setLoading(true);
      const minSim = similarityMin;
      fetchTimer.current = setTimeout(() => {
        const id = ++reqId.current;
        fetchHoverInsight(note.id, minSim)
          .then((data) => {
            if (reqId.current !== id) return;
            setInsight(normalizeHoverInsightPayload(data));
          })
          .catch(() => {
            if (reqId.current !== id) return;
            setInsight({ tagSuggestions: [], similarNotes: [], persistedLinks: [] });
          })
          .finally(() => {
            if (reqId.current === id) setLoading(false);
          });
      }, 220);
    },
    [clearInsightSelection, similarityMin]
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

  const linkSimilar = useCallback(async (sn) => {
    const anchorId = activeHoverId.current;
    if (!anchorId) return;
    if (sn.persisted) return;
    try {
      const row = await createNoteConnection(anchorId, sn.id);
      setInsight((prev) => {
        const p = prev || { tagSuggestions: [], similarNotes: [], persistedLinks: [] };
        if ((p.persistedLinks || []).some((x) => x.id === sn.id)) {
          return { ...p, similarNotes: (p.similarNotes || []).filter((x) => x.id !== sn.id) };
        }
        return {
          ...p,
          persistedLinks: [
            ...(p.persistedLinks || []),
            {
              connectionId: row.id,
              id: sn.id,
              content: sn.content,
              parent_id: sn.parent_id,
              threadRootId: null,
              similarity: sn.similarity != null ? Number(sn.similarity) : null,
              persisted: true,
              tags: sn.tags || [],
            },
          ],
          similarNotes: (p.similarNotes || []).filter((x) => x.id !== sn.id),
        };
      });
      onNoteUpdated?.();
    } catch (e) {
      console.error(e);
    }
  }, [onNoteUpdated]);

  const unlinkPersisted = useCallback(async (anchorNoteId, linkedNoteId) => {
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
      setConnectionTagSourceId((cur) => (cur === linkedNoteId ? null : cur));
      onNoteUpdated?.();
    } catch (e) {
      console.error(e);
    }
  }, [onNoteUpdated]);

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

  const value = useMemo(
    () => ({
      selectInsightNote,
      clearInsightSelection,
      insightAnchorRef,
      hover,
      insight,
      loading,
      linkSimilar,
      unlinkPersisted,
      dismissedKeys,
      dismissTag,
      addTag,
      addingKey,
      connectionModal,
      setConnectionModal,
      navigateToConnection,
      connectionTagSourceId,
      setConnectionTagSourceId,
      similarityMin,
      onSimilaritySliderChange,
    }),
    [
      selectInsightNote,
      clearInsightSelection,
      hover,
      insight,
      loading,
      linkSimilar,
      unlinkPersisted,
      dismissedKeys,
      dismissTag,
      addTag,
      addingKey,
      connectionModal,
      setConnectionModal,
      navigateToConnection,
      connectionTagSourceId,
      setConnectionTagSourceId,
      similarityMin,
      onSimilaritySliderChange,
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
    linkSimilar,
    unlinkPersisted,
    dismissedKeys,
    dismissTag,
    addTag,
    addingKey,
    connectionModal,
    setConnectionModal,
    navigateToConnection,
    connectionTagSourceId,
    setConnectionTagSourceId,
    insightAnchorRef,
    similarityMin,
    onSimilaritySliderChange,
  } = ctx;

  const [layoutRev, setLayoutRev] = useState(0);
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

  const connectionHighlightTags = useMemo(() => {
    if (!connectionTagSourceId || !insight) return [];
    const fromSimilar = insight.similarNotes?.find((x) => x.id === connectionTagSourceId);
    if (fromSimilar?.tags?.length) return fromSimilar.tags;
    const fromLinked = insight.persistedLinks?.find((x) => x.id === connectionTagSourceId);
    return fromLinked?.tags || [];
  }, [connectionTagSourceId, insight]);

  const tags = (insight?.tagSuggestions || []).filter((t) => !dismissedKeys.has(t.key));
  const { neighbor: neighborTags, similar: similarTags, novel: novelTags } = useMemo(
    () => partitionTagSuggestions(tags),
    [tags]
  );
  const similar = insight?.similarNotes || [];
  const persisted = [...(insight?.persistedLinks || [])].sort((a, b) => {
    const sa = a.similarity != null ? a.similarity : -1;
    const sb = b.similarity != null ? b.similarity : -1;
    return sb - sa;
  });

  const note = hover?.note;

  return (
    <>
      {hover && rect && (
        <>
          <div
            className="hover-insight-margin hover-insight-margin--left"
            data-insight-ui
          >
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
                    dismissTag={dismissTag}
                    addTag={addTag}
                    addingKey={addingKey}
                    connectionTagSourceId={connectionTagSourceId}
                    connectionHighlightTags={connectionHighlightTags}
                  />
                  <HoverInsightTagSection
                    title="Based on similar notes"
                    tags={similarTags}
                    note={note}
                    dismissTag={dismissTag}
                    addTag={addTag}
                    addingKey={addingKey}
                    connectionTagSourceId={connectionTagSourceId}
                    connectionHighlightTags={connectionHighlightTags}
                  />
                  <HoverInsightTagSection
                    title="New tag suggestions"
                    tags={novelTags}
                    note={note}
                    dismissTag={dismissTag}
                    addTag={addTag}
                    addingKey={addingKey}
                    connectionTagSourceId={connectionTagSourceId}
                    connectionHighlightTags={connectionHighlightTags}
                  />
                </div>
              )}
            </div>
          </div>

          <div
            className="hover-insight-margin hover-insight-margin--right"
            data-insight-ui
          >
            <div className={`hover-insight-panel hover-insight-panel--right ${loading ? 'hover-insight-panel--loading' : ''}`}>
              <p className="hover-insight-title">Similar notes</p>
              {!loading && persisted.length > 0 && (
                <>
                  <p className="hover-insight-section-title">Linked</p>
                  <ul className="hover-insight-persisted-list" data-insight-ui>
                    {persisted.map((pn) => (
                      <li key={pn.id} className="hover-insight-persisted-row">
                        <button
                          type="button"
                          className="hover-insight-persisted-snippet"
                          onMouseEnter={() => setConnectionTagSourceId(pn.id)}
                          onClick={() => setConnectionModal({ linked: pn, anchorNoteId: note.id })}
                          title="Open linked note"
                        >
                          <span className="hover-insight-linked-snippet-text">
                            {(pn.content || '—').slice(0, 120)}
                            {(pn.content?.length || 0) > 120 ? '…' : ''}
                          </span>
                          {pn.similarity != null && (
                            <span className="hover-insight-linked-sim">
                              {Math.round(pn.similarity * 100)}%
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className="hover-insight-icon-btn hover-insight-unlink"
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
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div
                className="hover-insight-similar-slider-wrap"
                data-insight-ui
                title="Default 50% until you change it; your choice is saved in this browser."
              >
                <label className="hover-insight-similar-slider-label" htmlFor="hover-insight-similarity-slider">
                  Min. similarity{' '}
                  <span className="hover-insight-similar-slider-value">
                    {Math.round(similarityMin * 100)}%
                  </span>
                </label>
                <input
                  id="hover-insight-similarity-slider"
                  type="range"
                  className="hover-insight-similar-slider"
                  min={SIM_SLIDER_MIN}
                  max={SIM_SLIDER_MAX}
                  step={SIM_SLIDER_STEP}
                  value={similarityMin}
                  onChange={(e) => onSimilaritySliderChange(parseFloat(e.target.value, 10))}
                />
                <div className="hover-insight-similar-slider-ticks" aria-hidden>
                  <span>10%</span>
                  <span>90%</span>
                </div>
              </div>
              {!loading && similar.length === 0 && (
                <p className="hover-insight-muted">
                  None above {Math.round(similarityMin * 100)}% similarity
                </p>
              )}
              <ul className="hover-insight-similar-list">
                {similar.map((sn) => (
                  <li key={sn.id}>
                    <button
                      type="button"
                      className="hover-insight-similar-btn"
                      onMouseEnter={() => setConnectionTagSourceId(sn.id)}
                      onClick={() => linkSimilar(sn)}
                      title="Save link — shows under Linked in this panel"
                    >
                      <span className="hover-insight-similar-snippet">
                        {(sn.content || '—').slice(0, 100)}
                        {(sn.content?.length || 0) > 100 ? '…' : ''}
                      </span>
                      <span className="hover-insight-sim-pct">
                        {Math.round((sn.similarity || 0) * 100)}%
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
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
              Linked note
            </h2>
            <div className="hover-insight-modal-body">
              {connectionModal.linked.content || '—'}
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
