import React, { useEffect, useMemo, useRef, useState } from 'react';
import NoteTypeIcon from './NoteTypeIcon';
import { NOTE_TYPE_HEADER_ORDER } from './noteTypeFilter';
import { useNoteTypeFilter } from './NoteTypeFilterContext';
import { useSearchNoteTypeFilter } from './SearchNoteTypeFilterContext';
import { useMediaQuery } from './useMediaQuery';
import { HERMES_COMPACT_VIEWPORT_QUERY } from './canvasLayoutApi';

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

function renderMobileDropdown({
  visibleNoteTypes,
  toggleNoteType,
  effectivelyDisabled,
  scope,
  open,
  setOpen,
  containerRef,
}) {
  const selectedCount = NOTE_TYPE_HEADER_ORDER.reduce(
    (count, t) => count + (visibleNoteTypes.has(t) ? 1 : 0),
    0
  );
  return (
    <div
      ref={containerRef}
      className="layout-type-filters layout-type-filters--mobile-dropdown"
      aria-label="Filter notes by type (Stream and Outline)"
    >
      <button
        type="button"
        className={`layout-toolbar-btn layout-type-filter-dropdown-trigger ${
          open ? 'layout-toolbar-btn--active' : ''
        }`}
        disabled={effectivelyDisabled}
        onClick={() => !effectivelyDisabled && setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          effectivelyDisabled
            ? `${SCOPE_STREAM_OUTLINE} type filters are disabled`
            : `Type filters: ${selectedCount} selected`
        }
        title={
          effectivelyDisabled
            ? `Type filters apply on ${SCOPE_STREAM_OUTLINE}`
            : `Type filters: ${selectedCount} selected`
        }
      >
        <img
          src={`${import.meta.env.BASE_URL}assets/filter.svg`}
          alt=""
          className="layout-toolbar-icon"
          draggable={false}
        />
        <span className="layout-type-filter-dropdown-count">{selectedCount}</span>
      </button>
      {open && !effectivelyDisabled ? (
        <div className="layout-type-filter-dropdown-menu" role="menu" aria-label="Type filters">
          {NOTE_TYPE_HEADER_ORDER.map((t) => {
            const on = visibleNoteTypes.has(t);
            const label = TYPE_FILTER_LABELS[t] ?? t;
            return (
              <label key={t} className="layout-type-filter-dropdown-item" role="menuitemcheckbox" aria-checked={on}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggleNoteType(t)}
                  className="layout-type-filter-dropdown-checkbox"
                />
                <NoteTypeIcon type={t} className="layout-toolbar-icon" />
                <span>{label}</span>
              </label>
            );
          })}
          <p className="layout-type-filter-dropdown-hint">Applies to {scope}</p>
        </div>
      ) : null}
    </div>
  );
}

function NoteTypeFilterButtonsHeader({ disabled = false }) {
  const { visibleNoteTypes, toggleNoteType } = useNoteTypeFilter();
  const isMobileViewport = useMediaQuery(HERMES_COMPACT_VIEWPORT_QUERY);
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDocPointer = (ev) => {
      if (containerRef.current?.contains(ev.target)) return;
      setOpen(false);
    };
    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDocPointer, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const shouldUseMobileDropdown = useMemo(() => isMobileViewport, [isMobileViewport]);
  if (shouldUseMobileDropdown) {
    return renderMobileDropdown({
      visibleNoteTypes,
      toggleNoteType,
      effectivelyDisabled: disabled,
      scope: SCOPE_STREAM_OUTLINE,
      open,
      setOpen,
      containerRef,
    });
  }
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
