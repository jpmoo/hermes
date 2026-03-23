import React from 'react';
import { NOTE_TYPE_OPTIONS } from './noteEventUtils';
import './NoteTypeEventFields.css';

export default function NoteTypeEventFields({
  idPrefix = 'note',
  noteType,
  onNoteTypeChange,
  hideTypeSelect = false,
  startDate,
  onStartDateChange,
  startTime,
  onStartTimeChange,
  endDate,
  onEndDateChange,
  endTime,
  onEndTimeChange,
  disabled = false,
}) {
  return (
    <div className="note-type-event-fields">
      {!hideTypeSelect && (
        <label className="note-type-event-fields-type">
          <span className="note-type-event-fields-label">Type</span>
          <select
            id={`${idPrefix}-type`}
            value={noteType || 'note'}
            onChange={(e) => onNoteTypeChange(e.target.value)}
            disabled={disabled}
          >
            {NOTE_TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {noteType === 'event' && (
        <div className="note-type-event-fields-event">
          <div className="note-type-event-fields-row">
            <span className="note-type-event-fields-label">Starts</span>
            <div className="note-type-event-fields-datetime">
              <input
                id={`${idPrefix}-start-date`}
                type="date"
                value={startDate}
                onChange={(e) => onStartDateChange(e.target.value)}
                disabled={disabled}
              />
              <input
                id={`${idPrefix}-start-time`}
                type="time"
                value={startTime}
                onChange={(e) => onStartTimeChange(e.target.value)}
                disabled={disabled}
                aria-label="Start time (optional)"
              />
            </div>
          </div>
          <p className="note-type-event-fields-time-hint">Time is optional (all-day uses start/end of that date).</p>
          <div className="note-type-event-fields-row">
            <span className="note-type-event-fields-label">Ends</span>
            <div className="note-type-event-fields-datetime">
              <input
                id={`${idPrefix}-end-date`}
                type="date"
                value={endDate}
                onChange={(e) => onEndDateChange(e.target.value)}
                disabled={disabled}
              />
              <input
                id={`${idPrefix}-end-time`}
                type="time"
                value={endTime}
                onChange={(e) => onEndTimeChange(e.target.value)}
                disabled={disabled}
                aria-label="End time (optional)"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
