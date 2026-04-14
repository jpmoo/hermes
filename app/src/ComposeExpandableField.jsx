import React from 'react';

/**
 * Wraps the stream/canvas composer textarea with a lower-right triangle control
 * to toggle a taller writing/inking area.
 */
export default function ComposeExpandableField({ expanded, onToggle, disabled, children }) {
  return (
    <div
      className={`stream-page-compose-field${expanded ? ' stream-page-compose-field--expanded' : ''}`}
    >
      {children}
      <button
        type="button"
        className="stream-page-compose-expand"
        onClick={(e) => {
          e.preventDefault();
          onToggle();
        }}
        disabled={disabled}
        aria-label={expanded ? 'Shrink composer' : 'Expand composer for more writing space'}
        aria-pressed={expanded}
        title={expanded ? 'Shrink composer' : 'Expand composer'}
      >
        <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
          <polygon points="12,12 12,0 0,12" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}
