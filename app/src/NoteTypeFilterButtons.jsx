import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  triggerRef,
  menuRef,
  menuPos,
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
        ref={triggerRef}
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
        <svg
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="layout-toolbar-icon layout-type-filter-dropdown-icon"
          aria-hidden
          focusable="false"
        >
          <path
            d="M4 8V5C4 4.44772 4.44772 4 5 4H19C19.5523 4 20 4.44772 20 5V8M4 8H20M4 8L9.28632 14.728C9.42475 14.9042 9.5 15.1218 9.5 15.3459V18.4612C9.5 19.1849 10.2449 19.669 10.9061 19.375L13.4061 18.2639C13.7673 18.1034 14 17.7453 14 17.3501V15.3699C14 15.1312 14.0854 14.9004 14.2407 14.7191L20 8"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
        <span className="layout-type-filter-dropdown-count">{selectedCount}</span>
      </button>
      {open && !effectivelyDisabled && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              className="layout-type-filter-dropdown-menu"
              role="menu"
              aria-label="Type filters"
              style={{
                position: 'fixed',
                top: `${menuPos.top}px`,
                left: `${menuPos.left}px`,
                minWidth: `${menuPos.minWidth}px`,
              }}
            >
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
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

function NoteTypeFilterButtonsHeader({ disabled = false }) {
  const { visibleNoteTypes, toggleNoteType } = useNoteTypeFilter();
  const isMobileViewport = useMediaQuery(HERMES_COMPACT_VIEWPORT_QUERY);
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, minWidth: 220 });

  useEffect(() => {
    if (!open) return undefined;
    const updateMenuPos = () => {
      const r = triggerRef.current?.getBoundingClientRect?.();
      if (!r) return;
      const margin = 8;
      const menuWidth = Math.max(220, r.width * 1.2);
      const left = Math.max(margin, Math.min(window.innerWidth - menuWidth - margin, r.right - menuWidth));
      const top = Math.min(window.innerHeight - margin, r.bottom + 8);
      setMenuPos({ top, left, minWidth: menuWidth });
    };
    updateMenuPos();
    window.addEventListener('resize', updateMenuPos);
    window.addEventListener('scroll', updateMenuPos, true);
    return () => {
      window.removeEventListener('resize', updateMenuPos);
      window.removeEventListener('scroll', updateMenuPos, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onDocPointer = (ev) => {
      if (containerRef.current?.contains(ev.target)) return;
      if (menuRef.current?.contains(ev.target)) return;
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
      triggerRef,
      menuRef,
      menuPos,
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
