import React, { useEffect } from 'react';
import { NOTE_TYPE_OPTIONS } from './noteEventUtils';
import { NOTE_TYPE_COLOR_DEFAULTS } from './noteTypeColorSettings';
import { useNoteTypeColors } from './NoteTypeColorContext';
import './SettingsModal.css';

export default function SettingsModal({ onClose }) {
  const {
    colors,
    setTypeColor,
    resetAllTypeColors,
    similarNotesMinChars,
    similarNotesMinDefault,
    setSimilarNotesMinChars,
  } = useNoteTypeColors();

  const effectiveSimilarMin =
    similarNotesMinChars != null ? similarNotesMinChars : similarNotesMinDefault;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
            Vector similar-note suggestions are hidden when the hovered note body is shorter than this many
            characters (after trimming), so tiny stubs do not surface misleading matches. Use{' '}
            <strong>0</strong> to always show similar notes. Leave the field empty to follow the server default
            ({similarNotesMinDefault}); your account can override it here.
          </p>
          <div className="settings-modal-similar-notes-row">
            <label className="settings-modal-similar-notes-label" htmlFor="settings-similar-min-chars">
              Min characters
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
              aria-describedby="settings-similar-min-hint"
              onChange={(e) => {
                const t = e.target.value.trim();
                if (t === '') {
                  setSimilarNotesMinChars(null);
                  return;
                }
                const n = parseInt(t, 10);
                if (!Number.isFinite(n)) return;
                setSimilarNotesMinChars(Math.min(500, Math.max(0, n)));
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
          <p id="settings-similar-min-hint" className="settings-modal-similar-notes-hint">
            Effective threshold: <strong>{effectiveSimilarMin}</strong> characters.
          </p>
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
