import React, { useEffect, useState } from 'react';
import { NOTE_TYPE_OPTIONS } from './noteEventUtils';
import { NOTE_TYPE_COLOR_DEFAULTS } from './noteTypeColorSettings';
import { useNoteTypeColors } from './NoteTypeColorContext';
import { getRoots } from './api';
import './SettingsModal.css';

export default function SettingsModal({ onClose }) {
  const {
    colors,
    setTypeColor,
    resetAllTypeColors,
    similarNotesMinChars,
    similarNotesLimitResultsToMinChars,
    similarNotesMinDefault,
    setSimilarNotesMinChars,
    setSimilarNotesLimitResultsToMinChars,
    inboxThreadRootId,
    setInboxThreadRootId,
  } = useNoteTypeColors();
  const [rootThreads, setRootThreads] = useState([]);

  const effectiveSimilarMin =
    similarNotesMinChars != null ? similarNotesMinChars : similarNotesMinDefault;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const roots = await getRoots(false);
        if (!cancelled) setRootThreads(Array.isArray(roots) ? roots : []);
      } catch (e) {
        console.error(e);
        if (!cancelled) setRootThreads([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const inboxValue = typeof inboxThreadRootId === 'string' ? inboxThreadRootId : '';
  const hasInboxValue = inboxValue.length > 0;
  const inboxExistsInRoots = hasInboxValue && rootThreads.some((n) => n.id === inboxValue);

  return (
    <div
      className="settings-modal-overlay"
      role="presentation"
      onMouseDown={(ev) => {
        if (ev.target === ev.currentTarget) onClose();
      }}
    >
      <div
        className="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
      >
        <h2 id="settings-modal-title">Settings</h2>

        <section className="settings-modal-section" aria-labelledby="settings-note-type-colors-heading">
          <h3 id="settings-note-type-colors-heading" className="settings-modal-section-title">
            Note type colors
          </h3>
          <p className="settings-modal-section-lead">
            These colors tint type icons and card backgrounds across Stream, Outline, Search, and hover panels.
            They follow light and dark theme surfaces automatically. Choices are saved to your account so they
            apply on every device after you sign in.
          </p>
          <ul className="settings-modal-type-colors">
            {NOTE_TYPE_OPTIONS.map(({ value, label }) => {
              const custom = colors[value];
              const displayHex = custom ?? NOTE_TYPE_COLOR_DEFAULTS[value];
              return (
                <li key={value} className="settings-modal-type-color-row">
                  <span className="settings-modal-type-color-label">{label}</span>
                  <input
                    type="color"
                    className="settings-modal-type-color-input"
                    value={displayHex}
                    aria-label={`Color for ${label} notes`}
                    onChange={(e) => setTypeColor(value, e.target.value)}
                  />
                  <button
                    type="button"
                    className="settings-modal-type-color-reset"
                    disabled={!custom}
                    onClick={() => setTypeColor(value, null)}
                  >
                    Reset
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="settings-modal-type-colors-footer">
            <button type="button" className="settings-modal-linkish" onClick={resetAllTypeColors}>
              Reset all to app defaults
            </button>
          </p>
        </section>

        <section className="settings-modal-section" aria-labelledby="settings-similar-notes-heading">
          <h3 id="settings-similar-notes-heading" className="settings-modal-section-title">
            Similar notes (hover)
          </h3>
          <p className="settings-modal-section-lead">
            Vector similar notes run only when the <strong>hovered</strong> note body is at least this many
            characters (after trimming), so tiny stubs are not sent for embedding comparison. Use <strong>0</strong>{' '}
            to always run similar notes. Leave the field empty to use the server default ({similarNotesMinDefault}
            ); your account can override it here. Optionally require the same minimum length for{' '}
            <strong>results</strong> using the checkbox below.
          </p>
          <div className="settings-modal-similar-notes-row">
            <label className="settings-modal-similar-notes-label" htmlFor="settings-similar-min-chars">
              Min characters (hovered note)
            </label>
            <input
              id="settings-similar-min-chars"
              className="settings-modal-similar-notes-input"
              type="number"
              min={0}
              max={500}
              step={1}
              placeholder={`Default (${similarNotesMinDefault})`}
              value={similarNotesMinChars == null ? '' : String(similarNotesMinChars)}
              aria-describedby="settings-similar-min-hint settings-similar-limit-label"
              onChange={(e) => {
                const t = e.target.value.trim();
                if (t === '') {
                  setSimilarNotesMinChars(null);
                  return;
                }
                const n = parseInt(t, 10);
                if (!Number.isFinite(n)) return;
                const v = Math.min(500, Math.max(0, n));
                setSimilarNotesMinChars(v);
                if (v === 0) setSimilarNotesLimitResultsToMinChars(false);
              }}
            />
            <button
              type="button"
              className="settings-modal-type-color-reset"
              disabled={similarNotesMinChars == null}
              onClick={() => setSimilarNotesMinChars(null)}
            >
              Use default
            </button>
          </div>
          <div className="settings-modal-similar-notes-checkbox-row">
            <input
              id="settings-similar-limit-results"
              type="checkbox"
              className="settings-modal-similar-notes-checkbox"
              checked={similarNotesLimitResultsToMinChars}
              disabled={effectiveSimilarMin === 0}
              onChange={(e) => setSimilarNotesLimitResultsToMinChars(e.target.checked)}
              aria-describedby="settings-similar-min-hint"
            />
            <label
              id="settings-similar-limit-label"
              className="settings-modal-similar-notes-checkbox-label"
              htmlFor="settings-similar-limit-results"
            >
              Limit results to the same number of characters.
            </label>
          </div>
          <p id="settings-similar-min-hint" className="settings-modal-similar-notes-hint">
            Effective minimum for the hovered note: <strong>{effectiveSimilarMin}</strong> characters.
            {effectiveSimilarMin > 0 && similarNotesLimitResultsToMinChars
              ? ' Similar-note results must also be at least that long (after trimming).'
              : effectiveSimilarMin > 0
                ? ' Matches are not filtered by length unless the checkbox is on.'
                : ' With minimum 0, the checkbox has no effect.'}
          </p>
        </section>

        <section className="settings-modal-section" aria-labelledby="settings-inbox-thread-heading">
          <h3 id="settings-inbox-thread-heading" className="settings-modal-section-title">
            Inbox thread for new @ notes
          </h3>
          <p className="settings-modal-section-lead">
            Choose a root thread where auto-created notes from @ mention links should land. Leave blank to keep
            creating them as replies at the current thread level.
          </p>
          <div className="settings-modal-inbox-row">
            <label className="settings-modal-similar-notes-label" htmlFor="settings-inbox-thread-select">
              Inbox root thread
            </label>
            <select
              id="settings-inbox-thread-select"
              className="settings-modal-inbox-select"
              value={inboxExistsInRoots ? inboxValue : hasInboxValue ? '__custom__' : ''}
              onChange={(e) => {
                const v = e.target.value;
                if (v === '' || v === '__custom__') return;
                setInboxThreadRootId(v);
              }}
            >
              <option value="">(none)</option>
              {rootThreads.map((n) => {
                const label =
                  (n.content || '').split(/\n/)[0].replace(/\s+/g, ' ').trim().slice(0, 72) || 'Untitled thread';
                return (
                  <option key={n.id} value={n.id}>
                    {label}
                  </option>
                );
              })}
              {!inboxExistsInRoots && hasInboxValue && (
                <option value="__custom__">Current value is not in root threads list</option>
              )}
            </select>
            <button
              type="button"
              className="settings-modal-type-color-reset"
              disabled={!hasInboxValue}
              onClick={() => setInboxThreadRootId('')}
            >
              Clear
            </button>
          </div>
        </section>

        <div className="settings-modal-actions">
          <button type="button" className="settings-modal-btn settings-modal-btn--primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
