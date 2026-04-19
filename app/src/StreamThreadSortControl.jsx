import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NavIconSort } from './icons/NavIcons';
import { migrateLegacySortMode } from './noteThreadSort';
import './StreamThreadSortControl.css';

const SORT_OPTIONS = [
  {
    value: 'datetime_asc',
    label: 'Last edit / start date and time (earliest to latest)',
  },
  {
    value: 'datetime_desc',
    label: 'Last edit / start date and time (latest to earliest)',
  },
  { value: 'alpha_asc', label: 'Alphabetical (A – Z)' },
  { value: 'alpha_desc', label: 'Alphabetical (Z – A)' },
];

function normalizeMode(v) {
  return migrateLegacySortMode(v);
}

export default function StreamThreadSortControl({ sortMode, starredFirst, onChange }) {
  const [open, setOpen] = useState(false);
  const [panelPos, setPanelPos] = useState(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);

  const updatePanelPos = useCallback(() => {
    if (!open) return;
    const el = triggerRef.current;
    if (!el || typeof window === 'undefined') return;
    const r = el.getBoundingClientRect();
    setPanelPos({
      top: r.bottom + 6,
      right: window.innerWidth - r.right,
    });
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPanelPos(null);
      return;
    }
    updatePanelPos();
    const el = triggerRef.current;
    const ro =
      el && typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => updatePanelPos())
        : null;
    if (el && ro) ro.observe(el);
    window.addEventListener('resize', updatePanelPos);
    window.addEventListener('scroll', updatePanelPos, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', updatePanelPos);
      window.removeEventListener('scroll', updatePanelPos, true);
    };
  }, [open, updatePanelPos]);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      const t = e.target;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
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

  const panel =
    open && panelPos ? (
      <div
        ref={panelRef}
        className="stream-thread-sort__panel stream-thread-sort__panel--portal"
        style={{ top: panelPos.top, right: panelPos.right }}
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
          Starred notes at the top (same order as above within each group)
        </label>
      </div>
    ) : null;

  return (
    <div className="stream-thread-sort">
      <button
        ref={triggerRef}
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
      {typeof document !== 'undefined' && panel ? createPortal(panel, document.body) : null}
    </div>
  );
}
