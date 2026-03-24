import React from 'react';
import NoteTypeIcon from './NoteTypeIcon';
import { NOTE_TYPE_HEADER_ORDER } from './noteTypeFilter';
import { useNoteTypeFilter } from './NoteTypeFilterContext';
import { useSearchNoteTypeFilter } from './SearchNoteTypeFilterContext';

const TYPE_FILTER_LABELS = {
  note: 'Notes',
  event: 'Events',
  person: 'People',
  organization: 'Organizations',
};

const SCOPE_STREAM_OUTLINE = 'Stream and Outline';
const SCOPE_SEARCH = 'search results';

function renderTypeButtons({ visibleNoteTypes, toggleNoteType, effectivelyDisabled, scope, isSearch }) {
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

function NoteTypeFilterButtonsHeader({ disabled = false }) {
  const { visibleNoteTypes, toggleNoteType } = useNoteTypeFilter();
  return renderTypeButtons({
    visibleNoteTypes,
    toggleNoteType,
    effectivelyDisabled: disabled,
    scope: SCOPE_STREAM_OUTLINE,
    isSearch: false,
  });
}

function NoteTypeFilterButtonsSearchPanel() {
  const { visibleNoteTypes, toggleNoteType } = useSearchNoteTypeFilter();
  return renderTypeButtons({
    visibleNoteTypes,
    toggleNoteType,
    effectivelyDisabled: false,
    scope: SCOPE_SEARCH,
    isSearch: true,
  });
}

/**
 * @param {{ mode: 'header' | 'search', disabled?: boolean }} props
 */
export default function NoteTypeFilterButtons({ mode, disabled = false }) {
  if (mode === 'search') {
    return <NoteTypeFilterButtonsSearchPanel />;
  }
  return <NoteTypeFilterButtonsHeader disabled={disabled} />;
}
