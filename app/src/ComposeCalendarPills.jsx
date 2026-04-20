import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchCalendarFeedEvents } from './api';
import { useNoteTypeColors } from './NoteTypeColorContext';
import { localCalendarLookoutBounds, normalizeCalendarLookoutDays } from './calendarLookoutDays';
import './ComposeCalendarPills.css';

export default function ComposeCalendarPills({ onPickEvent, disabled, variant = 'toolbar' }) {
  const { calendarFeeds, calendarLookoutDays } = useNoteTypeColors();
  const lookoutNorm = useMemo(() => normalizeCalendarLookoutDays(calendarLookoutDays), [calendarLookoutDays]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!Array.isArray(calendarFeeds) || calendarFeeds.length === 0) {
      setEvents([]);
      return;
    }
    setLoading(true);
    try {
      const { from, to } = localCalendarLookoutBounds(calendarLookoutDays);
      const data = await fetchCalendarFeedEvents(from, to);
      setEvents(Array.isArray(data.events) ? data.events : []);
    } catch (e) {
      console.error(e);
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, [calendarFeeds, calendarLookoutDays]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!calendarFeeds?.length) return undefined;
    const t = setInterval(() => load(), 5 * 60 * 1000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener('focus', onFocus);
    };
  }, [calendarFeeds, load]);

  if (!calendarFeeds?.length) return null;
  if (!loading && events.length === 0) return null;

  return (
    <div
      className={`compose-calendar-pills ${
        variant === 'modal' ? 'compose-calendar-pills--modal' : 'compose-calendar-pills--toolbar'
      }`}
      aria-label={lookoutNorm === 0 ? 'Today’s calendar events' : 'Calendar events in the selected date range'}
    >
      <div className="compose-calendar-pills-scroll">
        {loading && events.length === 0 ? (
          <span className="compose-calendar-pills-muted">Calendar…</span>
        ) : (
          events.map((ev, i) => {
            const feedName = typeof ev.feedName === 'string' ? ev.feedName.trim() : '';
            const chipLabel = feedName ? `${ev.title} (${feedName})` : ev.title;
            return (
            <button
              key={`${ev.start}-${ev.title}-${ev.feedUrl}-${i}`}
              type="button"
              className="compose-calendar-pill"
              disabled={disabled}
              title={
                ev.feedUrl
                  ? `${chipLabel}${ev.description ? `\n\n${ev.description.slice(0, 500)}${ev.description.length > 500 ? '…' : ''}` : ''}\n\n${ev.feedUrl}`
                  : chipLabel
              }
              onClick={() =>
                onPickEvent({
                  title: ev.title,
                  start: ev.start,
                  end: ev.end,
                  allDay: ev.allDay === true,
                  startDay: ev.startDay,
                  endDayInclusive: ev.endDayInclusive,
                  feedName: ev.feedName || '',
                  description: ev.description || '',
                  attendees: Array.isArray(ev.attendees) ? ev.attendees : [],
                })
              }
            >
              {chipLabel}
            </button>
            );
          })
        )}
      </div>
    </div>
  );
}
