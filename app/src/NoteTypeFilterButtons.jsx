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
 * Note-type toggles for Stream/Outline toolbars or the Search query panel.
 * @param {{ mode: 'search' | 'streamOutline' }} props
 */
export default function NoteTypeFilterButtons({ mode }) {
  const { visibleNoteTypes, toggleNoteType } = useNoteTypeFilter();
  const isSearch = mode === 'search';
  const scope = isSearch ? SCOPE_SEARCH : SCOPE_STREAM_OUTLINE;

  return (
    <div
      className={`layout-type-filters ${isSearch ? 'note-type-filter-buttons--search' : 'note-type-filter-buttons--stream-outline'}`}
      role="group"
      aria-label={isSearch ? 'Filter search results by note type' : 'Filter Stream and Outline by note type'}
    >
      {NOTE_TYPE_HEADER_ORDER.map((t) => {
        const on = visibleNoteTypes.has(t);
        const label = TYPE_FILTER_LABELS[t] ?? t;
        return (
          <button
            key={t}
            type="button"
            className={`layout-toolbar-btn ${on ? 'layout-toolbar-btn--active' : ''}`}
            onClick={() => toggleNoteType(t)}
            aria-pressed={on}
            aria-label={
              on
                ? `${label} visible — hide from ${scope}`
                : `${label} hidden — show in ${scope}`
            }
            title={
              on
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
