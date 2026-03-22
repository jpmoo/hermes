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
  addNoteTag,
  deleteNoteConnection,
  getNoteThreadRoot,
} from './api';
import './HoverInsight.css';

const CONFIRM_UNLINK =
  'Remove the link between these two notes? The notes are not deleted—only the connection is removed.';

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
  return {
    ...data,
    tagSuggestions: Array.isArray(tags) ? tags : [],
    similarNotes: Array.isArray(similar) ? similar : [],
    persistedLinks: Array.isArray(persisted) ? persisted : [],
  };
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

const HoverInsightContext = createContext(null);

function tagSuggestionTitle(t) {
  if (t.source === 'neighbor') {
    return 'On parent, sibling, or direct reply; not on this note yet';
  }
  if (t.source === 'connected') return 'On a linked note; not on the selected note yet';
  return 'New tag from model (may create tag when added)';
}

function HoverInsightTagSection({
  title,
  tags,
  note,
  dismissTag,
  addTag,
  addingKey,
}) {
  if (tags.length === 0) return null;
  return (
    <div className="hover-insight-tag-section">
      <p className="hover-insight-tag-section-title">{title}</p>
      <ul className="hover-insight-tag-list">
        {tags.map((t) => {
          return (
            <li key={t.key} className="hover-insight-tag-row">
              <button
                type="button"
                className="hover-insight-icon-btn"
                aria-label={`Dismiss ${t.name}`}
                onClick={() => dismissTag(t.key)}
              >
                ×
              </button>
              <span className="hover-insight-tag-name" title={tagSuggestionTitle(t)}>
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
  /** Merge latest `threadPath` from insight after optimistic link + async fetch. */
  const connectionModalLinked = useMemo(() => {
    if (!connectionModal?.linked) return null;
    const l = connectionModal.linked;
    const fresh = insight?.persistedLinks?.find((x) => x.id === l.id);
    return fresh ? { ...l, threadPath: fresh.threadPath ?? l.threadPath } : l;
  }, [connectionModal, insight?.persistedLinks]);
  const fetchTimer = useRef(null);
  const reqId = useRef(0);
  const activeHoverId = useRef(null);
  /** Selected card element for layout (connection stack / scroll sync). */
  const insightAnchorRef = useRef(null);

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
      dismissTag,
      addTag,
      addingKey,
      connectionModal,
      setConnectionModal,
      navigateToConnection,
    }),
    [
      selectInsightNote,
      clearInsightSelection,
      hover,
      insight,
      loading,
      unlinkPersisted,
      dismissedKeys,
      dismissTag,
      addTag,
      addingKey,
      connectionModal,
      setConnectionModal,
      navigateToConnection,
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
    dismissTag,
    addTag,
    addingKey,
    connectionModal,
    setConnectionModal,
    navigateToConnection,
    insightAnchorRef,
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

  const tags = (insight?.tagSuggestions || []).filter((t) => !dismissedKeys.has(t.key));
  const similarNotes = insight?.similarNotes || [];
  const { neighbor: neighborTags, connected: connectedTags, novel: novelTags } = useMemo(
    () => partitionTagSuggestions(tags),
    [tags]
  );
  /** Linked peers: highest similarity first; unknown similarity last. */
  const persisted = [...(insight?.persistedLinks || [])].sort((a, b) => {
    const sa = a.similarity != null ? a.similarity : -1;
    const sb = b.similarity != null ? b.similarity : -1;
    if (sb !== sa) return sb - sa;
    return (a.content || '').localeCompare(b.content || '');
  });

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
            stackTopPx,
            spineX: left + stackW / 2,
          };
        })()
      : null;

  const connectionStackRef = useRef(null);
  const [connectionStackHeight, setConnectionStackHeight] = useState(0);
  useLayoutEffect(() => {
    if (!connectionLayout || persisted.length === 0) {
      setConnectionStackHeight(0);
      return undefined;
    }
    const el = connectionStackRef.current;
    if (!el) return undefined;
    const measure = () => {
      const kids = el.children;
      if (kids.length === 0) {
        setConnectionStackHeight(0);
        return;
      }
      const stackRect = el.getBoundingClientRect();
      const lastRect = kids[kids.length - 1].getBoundingClientRect();
      setConnectionStackHeight(Math.max(0, lastRect.bottom - stackRect.top));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [
    connectionLayout?.stackTopPx,
    connectionLayout?.stackStyle?.left,
    connectionLayout?.stackStyle?.width,
    persisted.length,
    layoutRev,
    note?.id,
  ]);

  const connectionSpinePath = useMemo(() => {
    if (!connectionLayout || persisted.length === 0) return null;
    const { stackTopPx, spineX } = connectionLayout;
    const estH = persisted.length * 92 + Math.max(0, persisted.length - 1) * 7 + 8;
    const contentH = connectionStackHeight > 0 ? connectionStackHeight : estH;
    const yEnd = stackTopPx + contentH;
    /* Single vertical at stack center (no horizontal segment along anchor bottom). */
    return `M ${spineX} ${stackTopPx} L ${spineX} ${yEnd}`;
  }, [connectionLayout, connectionStackHeight, persisted.length]);

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
                  />
                  <HoverInsightTagSection
                    title="Based on connected notes"
                    tags={connectedTags}
                    note={note}
                    dismissTag={dismissTag}
                    addTag={addTag}
                    addingKey={addingKey}
                  />
                  <HoverInsightTagSection
                    title="New tag suggestions"
                    tags={novelTags}
                    note={note}
                    dismissTag={dismissTag}
                    addTag={addTag}
                    addingKey={addingKey}
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
              {loading && <p className="hover-insight-muted">Thinking…</p>}
              {!loading && similarNotes.length === 0 && (
                <p className="hover-insight-muted">
                  No similar notes (needs embeddings, or nothing close enough yet).
                </p>
              )}
              {!loading && similarNotes.length > 0 && (
                <ul className="hover-insight-similar-list">
                  {similarNotes.map((sn) => (
                    <li key={sn.id}>
                      <button
                        type="button"
                        className="hover-insight-similar-btn"
                        onClick={() => navigateToConnection(sn)}
                      >
                        <span className="hover-insight-similar-snippet">
                          {(sn.content || '—').trim().replace(/\s+/g, ' ').slice(0, 120)}
                          {(sn.content?.length || 0) > 120 ? '…' : ''}
                        </span>
                        {sn.similarity != null && (
                          <span className="hover-insight-sim-pct">{Math.round(sn.similarity * 100)}%</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}

      {hover && rect && persisted.length > 0 && connectionLayout && note && (
        <>
          {connectionSpinePath ? (
            <svg className="hover-insight-connection-spine" aria-hidden data-insight-ui>
              <path d={connectionSpinePath} className="hover-insight-connection-spine-path" />
            </svg>
          ) : null}
        <div
          ref={connectionStackRef}
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
              Linked note
            </h2>
            <div className="hover-insight-modal-body">
              {connectionModalLinked?.threadPath ? (
                <p className="hover-insight-thread-path hover-insight-thread-path--modal" title={connectionModalLinked.threadPath}>
                  {connectionModalLinked.threadPath}
                </p>
              ) : null}
              <div className="hover-insight-modal-note-text">
                {connectionModalLinked?.content || '—'}
              </div>
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
