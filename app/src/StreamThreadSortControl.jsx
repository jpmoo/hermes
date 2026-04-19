import React, { useEffect, useRef, useState } from 'react';
import { NavIconSort } from './icons/NavIcons';
import { STREAM_THREAD_SORT_MODES } from './noteThreadSort';
import './StreamThreadSortControl.css';

const SORT_OPTIONS = [
  { value: 'edit_asc', label: 'Last edit (oldest first)' },
  { value: 'edit_desc', label: 'Last edit (newest first)' },
  { value: 'schedule_asc', label: 'Schedule / event date (earliest first)' },
  { value: 'schedule_desc', label: 'Schedule / event date (latest first)' },
  { value: 'alpha_asc', label: 'Alphabetical by first word (A → Z)' },
  { value: 'alpha_desc', label: 'Alphabetical by first word (Z → A)' },
];

function normalizeMode(v) {
  return typeof v === 'string' && STREAM_THREAD_SORT_MODES.includes(v) ? v : 'schedule_asc';
}

export default function StreamThreadSortControl({ sortMode, starredFirst, onChange }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (rootRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  const mode = normalizeMode(sortMode);

  return (
    <div className="stream-thread-sort" ref={rootRef}>
      <button
        type="button"
        className="stream-thread-sort__trigger"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Sort replies in this thread"
        title="Sort replies in this thread"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <NavIconSort className="stream-thread-sort__icon" />
      </button>
      {open ? (
        <div
          className="stream-thread-sort__panel"
          role="dialog"
          aria-label="Thread reply order"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <label className="stream-thread-sort__label" htmlFor="stream-thread-sort-select">
            Order replies by
          </label>
          <select
            id="stream-thread-sort-select"
            className="stream-thread-sort__select"
            value={mode}
            onChange={(e) => {
              const next = normalizeMode(e.target.value);
              onChange({ sortMode: next, starredFirst });
            }}
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <label className="stream-thread-sort__check">
            <input
              type="checkbox"
              checked={starredFirst}
              onChange={(e) => onChange({ sortMode: mode, starredFirst: e.target.checked })}
            />
            Starred notes first (same order within each group)
          </label>
        </div>
      ) : null}
    </div>
  );
}
