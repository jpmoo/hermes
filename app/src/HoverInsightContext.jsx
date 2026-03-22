import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { fetchHoverInsight, addNoteTag, createNoteConnection, deleteNoteConnection } from './api';
import './HoverInsight.css';

const HoverInsightContext = createContext(null);

export function useHoverInsight() {
  return useContext(HoverInsightContext);
}

export function HoverInsightProvider({ children, onNoteUpdated }) {
  const [hover, setHover] = useState(null);
  const [insight, setInsight] = useState(null);
  const [loading, setLoading] = useState(false);
  const [linkedSimilar, setLinkedSimilar] = useState(null);
  const [dismissedKeys, setDismissedKeys] = useState(() => new Set());
  const [addingKey, setAddingKey] = useState(null);
  const leaveTimer = useRef(null);
  const fetchTimer = useRef(null);
  const reqId = useRef(0);
  const activeHoverId = useRef(null);

  const clearAll = useCallback(() => {
    activeHoverId.current = null;
    if (fetchTimer.current) clearTimeout(fetchTimer.current);
    setHover(null);
    setInsight(null);
    setLoading(false);
    setLinkedSimilar(null);
    setDismissedKeys(new Set());
    setAddingKey(null);
  }, []);

  const cancelLeave = useCallback(() => {
    if (leaveTimer.current) {
      clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  }, []);

  const scheduleClear = useCallback(() => {
    cancelLeave();
    leaveTimer.current = setTimeout(clearAll, 260);
  }, [cancelLeave, clearAll]);

  const onPanelPointerEnter = useCallback(() => {
    cancelLeave();
  }, [cancelLeave]);

  const startHover = useCallback(
    (note, anchorEl, depth) => {
      if (depth < 1 || !note?.id || !anchorEl) return;
      cancelLeave();
      const rect = anchorEl.getBoundingClientRect();
      const sameCard = activeHoverId.current === note.id;
      setHover({ note, rect });
      activeHoverId.current = note.id;
      if (sameCard) {
        return;
      }
      setLinkedSimilar(null);
      setDismissedKeys(new Set());
      if (fetchTimer.current) clearTimeout(fetchTimer.current);
      setInsight(null);
      setLoading(true);
      fetchTimer.current = setTimeout(() => {
        const id = ++reqId.current;
        fetchHoverInsight(note.id)
          .then((data) => {
            if (reqId.current !== id) return;
            setInsight(data);
          })
          .catch(() => {
            if (reqId.current !== id) return;
            setInsight({ tagSuggestions: [], similarNotes: [] });
          })
          .finally(() => {
            if (reqId.current === id) setLoading(false);
          });
      }, 220);
    },
    [cancelLeave]
  );

  const endHover = useCallback(() => {
    scheduleClear();
  }, [scheduleClear]);

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
    if (sn.persisted) {
      setLinkedSimilar(sn);
      return;
    }
    try {
      const row = await createNoteConnection(anchorId, sn.id);
      setLinkedSimilar(sn);
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
              persisted: true,
            },
          ],
          similarNotes: (p.similarNotes || []).filter((x) => x.id !== sn.id),
        };
      });
    } catch (e) {
      console.error(e);
    }
  }, []);

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
      setLinkedSimilar((cur) => (cur?.id === linkedNoteId ? null : cur));
    } catch (e) {
      console.error(e);
    }
  }, []);

  const value = useMemo(
    () => ({
      startHover,
      endHover,
      onPanelPointerEnter,
      hover,
      insight,
      loading,
      linkedSimilar,
      linkSimilar,
      unlinkPersisted,
      dismissedKeys,
      dismissTag,
      addTag,
      addingKey,
    }),
    [
      startHover,
      endHover,
      onPanelPointerEnter,
      hover,
      insight,
      loading,
      linkedSimilar,
      linkSimilar,
      unlinkPersisted,
      dismissedKeys,
      dismissTag,
      addTag,
      addingKey,
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
  const {
    hover,
    insight,
    loading,
    linkedSimilar,
    linkSimilar,
    unlinkPersisted,
    onPanelPointerEnter,
    endHover,
    dismissedKeys,
    dismissTag,
    addTag,
    addingKey,
  } = useHoverInsight() || {};

  if (!hover) return null;

  const tags = (insight?.tagSuggestions || []).filter((t) => !dismissedKeys.has(t.key));
  const similar = insight?.similarNotes || [];
  const persisted = insight?.persistedLinks || [];
  const { note, rect } = hover;

  return (
    <>
      <div
        className="hover-insight-margin hover-insight-margin--left"
        onMouseEnter={onPanelPointerEnter}
        onMouseLeave={endHover}
      >
        <div className={`hover-insight-panel hover-insight-panel--left ${loading ? 'hover-insight-panel--loading' : ''}`}>
          <p className="hover-insight-title">Tag suggestions</p>
          {loading && <p className="hover-insight-muted">Thinking…</p>}
          {!loading && tags.length === 0 && <p className="hover-insight-muted">No suggestions</p>}
          <ul className="hover-insight-tag-list">
            {tags.map((t) => (
              <li key={t.key} className="hover-insight-tag-row">
                <button
                  type="button"
                  className="hover-insight-icon-btn"
                  aria-label={`Dismiss ${t.name}`}
                  onClick={() => dismissTag(t.key)}
                >
                  ×
                </button>
                <span className="hover-insight-tag-name" title={t.source === 'similar' ? 'From similar note' : 'Model'}>
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
            ))}
          </ul>
        </div>
      </div>

      <div
        className="hover-insight-margin hover-insight-margin--right"
        onMouseEnter={onPanelPointerEnter}
        onMouseLeave={endHover}
      >
        <div className={`hover-insight-panel hover-insight-panel--right ${loading ? 'hover-insight-panel--loading' : ''}`}>
          {persisted.length > 0 && (
            <>
              <p className="hover-insight-title">Linked (saved)</p>
              <ul className="hover-insight-persisted-list">
                {persisted.map((pn) => (
                  <li key={pn.id} className="hover-insight-persisted-row">
                    <button
                      type="button"
                      className="hover-insight-persisted-snippet"
                      onClick={() => linkSimilar(pn)}
                      title="Show next to note"
                    >
                      {(pn.content || '—').slice(0, 90)}
                      {(pn.content?.length || 0) > 90 ? '…' : ''}
                    </button>
                    <button
                      type="button"
                      className="hover-insight-icon-btn hover-insight-unlink"
                      aria-label="Remove link"
                      onClick={(e) => {
                        e.stopPropagation();
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
          <p className="hover-insight-title">Similar notes</p>
          {!loading && similar.length === 0 && persisted.length === 0 && (
            <p className="hover-insight-muted">None above threshold</p>
          )}
          {!loading && similar.length === 0 && persisted.length > 0 && (
            <p className="hover-insight-muted">No new suggestions</p>
          )}
          <ul className="hover-insight-similar-list">
            {similar.map((sn) => (
              <li key={sn.id}>
                <button
                  type="button"
                  className="hover-insight-similar-btn"
                  onClick={() => linkSimilar(sn)}
                  title="Save link and show beside note"
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

      {linkedSimilar && (
        <div
          className="hover-insight-connection"
          style={{
            top: rect.top,
            left: rect.right + 6,
            maxHeight: rect.height,
          }}
        >
          <div className="hover-insight-connection-inner">
            <span className="hover-insight-connection-label">Linked</span>
            <p className="hover-insight-connection-text">
              {(linkedSimilar.content || '—').slice(0, 200)}
              {(linkedSimilar.content?.length || 0) > 200 ? '…' : ''}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
