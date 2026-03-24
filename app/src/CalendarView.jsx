import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { createNote, getEventsInRange } from './api';
import Layout from './Layout';
import NoteTypeEventFields from './NoteTypeEventFields';
import { eventFieldsToPayload, formatEventRange } from './noteEventUtils';
import {
  assignEventLanes,
  buildMonthWeeks,
  eventBarLabel,
  eventLocalDayRange,
  monthToIsoRange,
  segmentInWeek,
  weekOverlapsRange,
} from './calendarUtils';
import './CalendarView.css';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function todayYmd() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function CalendarView() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [cursor, setCursor] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  });
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [body, setBody] = useState('');
  const [startDate, setStartDate] = useState(todayYmd);
  const [startTime, setStartTime] = useState('');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('');

  const weeks = useMemo(() => buildMonthWeeks(cursor.y, cursor.m), [cursor.y, cursor.m]);

  const loadEvents = useCallback(async () => {
    const { from, to } = monthToIsoRange(cursor.y, cursor.m);
    setLoading(true);
    setError(null);
    try {
      const list = await getEventsInRange(from, to);
      setEvents(Array.isArray(list) ? list : []);
    } catch (e) {
      setEvents([]);
      setError(e.message || 'Failed to load events');
    } finally {
      setLoading(false);
    }
  }, [cursor.y, cursor.m]);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const weekSegments = useMemo(() => {
    return weeks.map((week) => {
      const raw = [];
      for (const ev of events) {
        const { startDay, endDay } = eventLocalDayRange(ev);
        if (!weekOverlapsRange(week, startDay, endDay)) continue;
        const seg = segmentInWeek(week, startDay, endDay);
        if (!seg) continue;
        raw.push({ ...seg, event: ev });
      }
      const withLanes = assignEventLanes(raw);
      const nLanes = withLanes.length ? Math.max(...withLanes.map((s) => s.lane)) + 1 : 0;
      return { week, bars: withLanes, nLanes };
    });
  }, [weeks, events]);

  const monthTitle = useMemo(
    () =>
      new Date(cursor.y, cursor.m, 1).toLocaleString(undefined, {
        month: 'long',
        year: 'numeric',
      }),
    [cursor.y, cursor.m]
  );

  const prevMonth = () => {
    setCursor(({ y, m }) => {
      if (m === 0) return { y: y - 1, m: 11 };
      return { y, m: m - 1 };
    });
  };

  const nextMonth = () => {
    setCursor(({ y, m }) => {
      if (m === 11) return { y: y + 1, m: 0 };
      return { y, m: m + 1 };
    });
  };

  const openModal = () => {
    setError(null);
    setBody('');
    setStartDate(todayYmd());
    setStartTime('');
    setEndDate('');
    setEndTime('');
    setModalOpen(true);
  };

  useEffect(() => {
    if (!modalOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setModalOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [modalOpen]);

  const goToEventInStream = (ev) => {
    const root = ev.thread_root_id;
    if (!root) return;
    navigate({
      pathname: '/',
      search: `?thread=${encodeURIComponent(root)}&focus=${encodeURIComponent(ev.id)}`,
    });
  };

  const handleCreateEvent = async (e) => {
    e.preventDefault();
    const meta = eventFieldsToPayload('event', { startDate, startTime, endDate, endTime });
    if (meta.error) {
      setError(meta.error);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await createNote({
        content: body.trim(),
        parent_id: null,
        note_type: meta.note_type,
        event_start_at: meta.event_start_at,
        event_end_at: meta.event_end_at,
      });
      setModalOpen(false);
      await loadEvents();
    } catch (err) {
      setError(err.message || 'Failed to create event');
    } finally {
      setSubmitting(false);
    }
  };

  const viewLinks = [
    { to: '/', label: 'Stream' },
    { to: '/outline', label: 'Outline' },
    { to: '/calendar', label: 'Calendar' },
    { to: '/search', label: 'Search' },
  ];

  return (
    <Layout title="Calendar" onLogout={logout} viewLinks={viewLinks}>
      <div className="calendar-view">
        <div className="calendar-view-toolbar">
          <h1 className="calendar-view-title">{monthTitle}</h1>
          <div className="calendar-view-nav">
            <button type="button" onClick={prevMonth} aria-label="Previous month">
              ← Prev
            </button>
            <button type="button" onClick={nextMonth} aria-label="Next month">
              Next →
            </button>
            <button type="button" className="calendar-view-add" onClick={openModal}>
              New event
            </button>
          </div>
        </div>

        {error && !modalOpen && <p className="calendar-view-error">{error}</p>}

        {loading ? (
          <p className="calendar-view-loading">Loading events…</p>
        ) : (
          <>
            <div className="calendar-dow-row" aria-hidden>
              {DOW.map((d) => (
                <div key={d} className="calendar-dow-cell">
                  {d}
                </div>
              ))}
            </div>
            {weekSegments.map(({ week, bars, nLanes }) => (
              <div key={week[0].key} className="calendar-week">
                <div className="calendar-week-days">
                  {week.map((cell) => (
                    <div
                      key={cell.key}
                      className={`calendar-day ${cell.inMonth ? '' : 'calendar-day--outside'}`}
                    >
                      <span className="calendar-day-num">{cell.date.getDate()}</span>
                    </div>
                  ))}
                </div>
                <div
                  className="calendar-week-bars"
                  style={{
                    gridTemplateRows: nLanes > 0 ? `repeat(${nLanes}, 1.28rem)` : 'minmax(0.5rem, auto)',
                  }}
                >
                  {bars.map((b) => (
                    <button
                      key={`${b.event.id}-${week[0].key}-${b.lane}-${b.colStart}`}
                      type="button"
                      className="calendar-event-bar"
                      style={{
                        gridColumn: `${b.colStart + 1} / span ${b.span}`,
                        gridRow: b.lane + 1,
                      }}
                      title={`${eventBarLabel(b.event)} — ${formatEventRange(b.event)}\nDouble-click to open in Stream`}
                      onDoubleClick={(ev) => {
                        ev.preventDefault();
                        goToEventInStream(b.event);
                      }}
                    >
                      {eventBarLabel(b.event)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <p className="calendar-view-hint">Double-click an event to open it in Stream (focused in the thread).</p>
          </>
        )}

        {modalOpen && (
          <div
            className="calendar-modal-overlay"
            role="presentation"
            onMouseDown={(ev) => {
              if (ev.target === ev.currentTarget) setModalOpen(false);
            }}
          >
            <div className="calendar-modal" role="dialog" aria-labelledby="calendar-modal-title" aria-modal="true">
              <h2 id="calendar-modal-title">New event</h2>
              {error && <p className="calendar-view-error">{error}</p>}
              <form onSubmit={handleCreateEvent}>
                <label className="calendar-modal-body-label" htmlFor="calendar-new-body">
                  Note
                </label>
                <textarea
                  id="calendar-new-body"
                  className="calendar-modal-body-input"
                  value={body}
                  onChange={(ev) => setBody(ev.target.value)}
                  placeholder="What is this event?"
                  rows={4}
                />
                <NoteTypeEventFields
                  idPrefix="calendar-new"
                  noteType="event"
                  onNoteTypeChange={() => {}}
                  hideTypeSelect
                  startDate={startDate}
                  onStartDateChange={setStartDate}
                  startTime={startTime}
                  onStartTimeChange={setStartTime}
                  endDate={endDate}
                  onEndDateChange={setEndDate}
                  endTime={endTime}
                  onEndTimeChange={setEndTime}
                  disabled={submitting}
                />
                <div className="calendar-modal-actions">
                  <button type="button" onClick={() => setModalOpen(false)} disabled={submitting}>
                    Cancel
                  </button>
                  <button type="submit" disabled={submitting}>
                    {submitting ? 'Creating…' : 'Create'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}
