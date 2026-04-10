import React, { useCallback, useEffect, useState } from 'react';
import { fetchCalendarFeedEvents } from './api';
import { useNoteTypeColors } from './NoteTypeColorContext';
import './ComposeCalendarPills.css';

function localDayIsoBounds() {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return { from: from.toISOString(), to: to.toISOString() };
}

export default function ComposeCalendarPills({ onPickEvent, disabled }) {
  const { calendarFeedUrls } = useNoteTypeColors();
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!Array.isArray(calendarFeedUrls) || calendarFeedUrls.length === 0) {
      setEvents([]);
      return;
    }
    setLoading(true);
    try {
      const { from, to } = localDayIsoBounds();
      const data = await fetchCalendarFeedEvents(from, to);
      setEvents(Array.isArray(data.events) ? data.events : []);
    } catch (e) {
      console.error(e);
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [calendarFeedUrls]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!calendarFeedUrls?.length) return undefined;
    const t = setInterval(() => load(), 5 * 60 * 1000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [calendarFeedUrls, load]);

  if (!calendarFeedUrls?.length) return null;
  if (!loading && events.length === 0) return null;

  return (
    <div className="compose-calendar-pills compose-calendar-pills--toolbar" aria-label="Today’s calendar events">
      <div className="compose-calendar-pills-scroll">
        {loading && events.length === 0 ? (
          <span className="compose-calendar-pills-muted">Calendar…</span>
        ) : (
          events.map((ev, i) => (
            <button
              key={`${ev.start}-${ev.title}-${i}`}
              type="button"
              className="compose-calendar-pill"
              disabled={disabled}
              title={ev.feedUrl ? `${ev.title}\n${ev.feedUrl}` : ev.title}
              onClick={() =>
                onPickEvent({
                  title: ev.title,
                  start: ev.start,
                  end: ev.end,
                  allDay: ev.allDay === true,
                  startDay: ev.startDay,
                  endDayInclusive: ev.endDayInclusive,
                })
              }
            >
              {ev.title}
            </button>
          ))
        )}
      </div>
    </div>
  );
}
