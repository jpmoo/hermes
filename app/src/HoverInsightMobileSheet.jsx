import React, { useEffect, useState } from 'react';
import NoteRichText from './NoteRichText';
import NoteTypeIcon from './NoteTypeIcon';
import { NOTE_TYPE_HEADER_ORDER } from './noteTypeFilter';

const SIMILAR_TYPE_FILTER_LABELS = {
  note: 'Notes',
  event: 'Events',
  person: 'People',
  organization: 'Organizations',
};

function tagSuggestionTitle(t) {
  if (t.source === 'neighbor') {
    return 'On parent, sibling, or direct reply; not on this note yet';
  }
  if (t.source === 'connected') return 'On a linked note; not on the selected note yet';
  return 'New tag from model (may create tag when added)';
}

function InsightTagSection({ title, tags, note, addTag, addingKey }) {
  if (tags.length === 0) return null;
  return (
    <div className="hover-insight-stack-section">
      <p className="hover-insight-stack-section-title">{title}</p>
      <ul className="hover-insight-stack-list">
        {tags.map((t) => (
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
        ))}
      </ul>
    </div>
  );
}

const CONFIRM_UNLINK =
  'Remove the link between these two notes? The notes are not deleted—only the connection is removed.';

/**
 * Full-screen insight UI for narrow viewports (phones). iPad/desktop use fixed side panels instead.
 */
export default function HoverInsightMobileSheet({
  onClose,
  note,
  loading,
  tags,
  neighborTags,
  connectedTags,
  novelTags,
  addTag,
  addingKey,
  ragdollEnabled,
  ragdollLoading,
  ragdollDocs,
  ragdollError,
  ragdollByCollection,
  openRagdollDoc,
  ragdollIncludeParent,
  setRagdollIncludeParent,
  ragdollIncludeSiblings,
  setRagdollIncludeSiblings,
  ragdollIncludeChildren,
  setRagdollIncludeChildren,
  ragdollIncludeConnected,
  setRagdollIncludeConnected,
  ragdollQuerySimilarityMinPct,
  setRagdollQuerySimilarityMinPct,
  similarMinPct,
  setSimilarMinPct,
  similarVisibleTypes,
  toggleSimilarVisibleNoteType,
  similarNotes,
  filteredSimilarNotes,
  similarNotesAfterSimilarity,
  insight,
  connectSimilarNote,
  openNoteFromRichText,
  connectionStackPeers,
  persistedIdSet,
  setConnectionModal,
  unlinkPersisted,
}) {
  const [activeTab, setActiveTab] = useState('tags');

  useEffect(() => {
    setActiveTab('tags');
  }, [note?.id]);

  useEffect(() => {
    if (!ragdollEnabled && activeTab === 'documents') setActiveTab('tags');
  }, [ragdollEnabled, activeTab]);

  const showDocumentsTab = Boolean(ragdollEnabled);
  const tabIds = {
    tags: 'hover-insight-mobile-tab-tags',
    similar: 'hover-insight-mobile-tab-similar',
    documents: 'hover-insight-mobile-tab-documents',
  };
  const panelIds = {
    tags: 'hover-insight-mobile-panel-tags',
    similar: 'hover-insight-mobile-panel-similar',
    documents: 'hover-insight-mobile-panel-documents',
  };

  return (
    <div className="hover-insight-mobile-root">
      <button
        type="button"
        className="hover-insight-mobile-backdrop"
        aria-label="Close insight"
        onClick={onClose}
      />
      <div
        className="hover-insight-mobile-sheet"
        data-insight-ui
        role="dialog"
        aria-modal="true"
        aria-labelledby="hover-insight-mobile-title"
      >
        <header className="hover-insight-mobile-header">
          <h2 id="hover-insight-mobile-title" className="hover-insight-mobile-title">
            Insight
          </h2>
          <button type="button" className="hover-insight-mobile-close" onClick={onClose}>
            Close
          </button>
        </header>
        <nav className="hover-insight-mobile-tabs" role="tablist" aria-label="Insight sections">
          <button
            type="button"
            id={tabIds.tags}
            role="tab"
            aria-selected={activeTab === 'tags'}
            aria-controls={panelIds.tags}
            className={`hover-insight-mobile-tab ${activeTab === 'tags' ? 'hover-insight-mobile-tab--active' : ''}`}
            onClick={() => setActiveTab('tags')}
          >
            Suggested Tags
          </button>
          <button
            type="button"
            id={tabIds.similar}
            role="tab"
            aria-selected={activeTab === 'similar'}
            aria-controls={panelIds.similar}
            className={`hover-insight-mobile-tab ${activeTab === 'similar' ? 'hover-insight-mobile-tab--active' : ''}`}
            onClick={() => setActiveTab('similar')}
          >
            Similar Notes
          </button>
          {showDocumentsTab ? (
            <button
              type="button"
              id={tabIds.documents}
              role="tab"
              aria-selected={activeTab === 'documents'}
              aria-controls={panelIds.documents}
              className={`hover-insight-mobile-tab ${activeTab === 'documents' ? 'hover-insight-mobile-tab--active' : ''}`}
              onClick={() => setActiveTab('documents')}
            >
              Related Documents
            </button>
          ) : null}
        </nav>
        <div className="hover-insight-mobile-body">
          <div
            id={panelIds.tags}
            role="tabpanel"
            aria-labelledby={tabIds.tags}
            hidden={activeTab !== 'tags'}
            className="hover-insight-mobile-tab-panel"
          >
            <section className="hover-insight-mobile-section">
              <div className={`hover-insight-panel hover-insight-panel--left ${loading ? 'hover-insight-panel--loading' : ''}`}>
                {loading && <p className="hover-insight-muted">Thinking…</p>}
                {!loading && tags.length === 0 && <p className="hover-insight-muted">No suggestions</p>}
                {!loading && tags.length > 0 && (
                  <div className="hover-insight-tag-groups">
                    <InsightTagSection title="Based on neighbor notes" tags={neighborTags} note={note} addTag={addTag} addingKey={addingKey} />
                    <InsightTagSection title="Based on connected notes" tags={connectedTags} note={note} addTag={addTag} addingKey={addingKey} />
                    <InsightTagSection title="New tag suggestions" tags={novelTags} note={note} addTag={addTag} addingKey={addingKey} />
                  </div>
                )}
              </div>
            </section>
          </div>

          <div
            id={panelIds.similar}
            role="tabpanel"
            aria-labelledby={tabIds.similar}
            hidden={activeTab !== 'similar'}
            className="hover-insight-mobile-tab-panel"
          >
            <section className="hover-insight-mobile-section">
              <div className={`hover-insight-panel hover-insight-panel--right ${loading ? 'hover-insight-panel--loading' : ''}`}>
                <div className="hover-insight-similar-type-filters" role="group" aria-label="Filter similar notes by type">
                  {NOTE_TYPE_HEADER_ORDER.map((t) => {
                    const on = similarVisibleTypes.has(t);
                    const label = SIMILAR_TYPE_FILTER_LABELS[t] ?? t;
                    return (
                      <button
                        key={t}
                        type="button"
                        className={`hover-insight-similar-type-btn ${on ? 'hover-insight-similar-type-btn--on' : ''}`}
                        aria-pressed={on}
                        aria-label={on ? `${label} visible in similar notes — click to hide` : `${label} hidden from similar notes — click to show`}
                        title={on ? `${label} shown — click to hide from similar notes` : `${label} hidden — click to show in similar notes`}
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
                            const tagNames = Array.isArray(sn.tags) ? sn.tags.map((x) => x.name || x) : [];
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
                                      <p className="hover-insight-thread-path hover-insight-thread-path--card hover-insight-similar-thread-path" title={path}>
                                        {path}
                                      </p>
                                    ) : (
                                      <p className="hover-insight-thread-path hover-insight-thread-path--card hover-insight-similar-thread-path hover-insight-muted">
                                        (Thread root)
                                      </p>
                                    )}
                                    <p className="hover-insight-connection-card-snippet hover-insight-similar-note-snippet" title={raw || undefined}>
                                      {raw ? (
                                        <NoteRichText text={raw.slice(0, 900)} tagNames={tagNames} className="hover-insight-card-rich-text" onNoteClick={openNoteFromRichText} sourceNoteId={sn.id} />
                                      ) : (
                                        '—'
                                      )}
                                    </p>
                                  </span>
                                  {sn.similarity != null && <span className="hover-insight-sim-pct">{Math.round(sn.similarity * 100)}%</span>}
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
            </section>

            {connectionStackPeers.length > 0 ? (
              <section className="hover-insight-mobile-section hover-insight-mobile-section--connections">
                <p className="hover-insight-title">Linked &amp; similar</p>
                <div className="hover-insight-mobile-connection-list">
                  {connectionStackPeers.map((pn) => {
                    const body = pn.content != null ? String(pn.content).trim() : '';
                    const tagNames = Array.isArray(pn.tags) ? pn.tags.map((x) => x.name || x) : [];
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
                      <div key={pn.id} className={['hover-insight-connection-card', connTypeClass].filter(Boolean).join(' ')}>
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
                          <span className="hover-insight-connection-card-label">{isDbLinked ? 'Linked' : 'Similar'}</span>
                          {pn.similarity != null && (
                            <span className="hover-insight-connection-card-sim">{Math.round(pn.similarity * 100)}%</span>
                          )}
                          {pn.threadPath ? (
                            <p className="hover-insight-thread-path hover-insight-thread-path--card" title={pn.threadPath}>
                              {pn.threadPath}
                            </p>
                          ) : null}
                          <p className="hover-insight-connection-card-snippet" title={body || undefined}>
                            {body ? (
                              <NoteRichText text={body.slice(0, 900)} tagNames={tagNames} className="hover-insight-card-rich-text" onNoteClick={openNoteFromRichText} sourceNoteId={pn.id} />
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
              </section>
            ) : null}
          </div>

          {showDocumentsTab ? (
            <div
              id={panelIds.documents}
              role="tabpanel"
              aria-labelledby={tabIds.documents}
              hidden={activeTab !== 'documents'}
              className="hover-insight-mobile-tab-panel"
            >
              <section className="hover-insight-mobile-section">
                <div className={`hover-insight-panel hover-insight-panel--ragdoll ${ragdollLoading ? 'hover-insight-panel--loading' : ''}`}>
                  <p className="hover-insight-ragdoll-hint">
                    Selected note is always included. Choose extra context for RAGDoll search:
                  </p>
                  <div className="hover-insight-ragdoll-checkboxes" role="group" aria-label="RAG context">
                    <label className="hover-insight-ragdoll-check">
                      <input type="checkbox" checked={ragdollIncludeConnected} onChange={(e) => setRagdollIncludeConnected(e.target.checked)} />
                      <span>Connected notes</span>
                    </label>
                    <label className="hover-insight-ragdoll-check">
                      <input type="checkbox" checked={ragdollIncludeParent} onChange={(e) => setRagdollIncludeParent(e.target.checked)} />
                      <span>Parent</span>
                    </label>
                    <label className="hover-insight-ragdoll-check">
                      <input type="checkbox" checked={ragdollIncludeSiblings} onChange={(e) => setRagdollIncludeSiblings(e.target.checked)} />
                      <span>Siblings</span>
                    </label>
                    <label className="hover-insight-ragdoll-check">
                      <input type="checkbox" checked={ragdollIncludeChildren} onChange={(e) => setRagdollIncludeChildren(e.target.checked)} />
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
                                      <span className="hover-insight-ragdoll-sim">{Math.round(Number(d.similarity) * 100)}%</span>
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
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
