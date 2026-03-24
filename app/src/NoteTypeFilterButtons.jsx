import React from 'react';
import NoteTypeIcon from './NoteTypeIcon';
import { NOTE_TYPE_HEADER_ORDER } from './noteTypeFilter';
import { useNoteTypeFilter } from './NoteTypeFilterContext';

const TYPE_FILTER_LABELS = {
  note: 'Notes',
  event: 'Events',
  person: 'People',
  organization: 'Organizations',
};

const SCOPE_STREAM_OUTLINE = 'Stream and Outline';
const SCOPE_SEARCH = 'search results';

/**
 * @param {{ mode: 'header' | 'search', disabled?: boolean }} props
 * - header: Stream/Outline toolbar (Layout); use disabled on Search/Calendar.
 * - search: Search query panel only.
 */
export default function NoteTypeFilterButtons({ mode, disabled = false }) {
  const { visibleNoteTypes, toggleNoteType } = useNoteTypeFilter();
  const isSearch = mode === 'search';
  const effectivelyDisabled = mode === 'header' && disabled;
  const scope = isSearch ? SCOPE_SEARCH : SCOPE_STREAM_OUTLINE;

  return (
    <div
      className={`layout-type-filters ${isSearch ? 'note-type-filter-buttons--search' : ''}`}
      role="group"
      aria-label={
        isSearch
          ? 'Filter search results by note type'
          : 'Filter notes by type (Stream and Outline)'
      }
    >
      {NOTE_TYPE_HEADER_ORDER.map((t) => {
        const on = visibleNoteTypes.has(t);
        const label = TYPE_FILTER_LABELS[t] ?? t;
        return (
          <button
            key={t}
            type="button"
            disabled={effectivelyDisabled}
            className={`layout-toolbar-btn ${on ? 'layout-toolbar-btn--active' : ''}`}
            onClick={() => !effectivelyDisabled && toggleNoteType(t)}
            aria-pressed={!effectivelyDisabled ? on : undefined}
            aria-disabled={effectivelyDisabled}
            aria-label={
              effectivelyDisabled
                ? `${label} filter (available on ${SCOPE_STREAM_OUTLINE})`
                : on
                  ? `${label} visible — hide from ${scope}`
                  : `${label} hidden — show in ${scope}`
            }
            title={
              effectivelyDisabled
                ? `Type filters apply on ${SCOPE_STREAM_OUTLINE}`
                : on
                  ? `${label} visible — click to hide from ${scope}`
                  : `${label} hidden — click to show in ${scope}`
            }
          >
            <NoteTypeIcon type={t} className="layout-toolbar-icon" />
          </button>
        );
      })}
    </div>
  );
}
