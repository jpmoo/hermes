import React, { useEffect, useState, useCallback, useRef } from 'react';
import { NOTE_TYPE_OPTIONS } from './noteEventUtils';
import { NOTE_TYPE_COLOR_DEFAULTS } from './noteTypeColorSettings';
import { useNoteTypeColors } from './NoteTypeColorContext';
import { DEFAULT_START_PAGE_OPTIONS } from './defaultStartPage';
import {
  CALENDAR_LOOKOUT_MAX,
  CALENDAR_LOOKOUT_MIN,
  normalizeCalendarLookoutDays,
} from './calendarLookoutDays';
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
    spaztickApiUrl,
    setSpaztickApiUrl,
    spaztickApiKeySet,
    saveSpaztickApiKey,
    ingestApiKeySet,
    saveIngestApiKey,
    calendarFeeds,
    setCalendarFeeds,
    calendarLookoutDays,
    setCalendarLookoutDays,
    defaultStartPage,
    setDefaultStartPage,
    defaultStartPagePhone,
    setDefaultStartPagePhone,
    markdownListAlternatingShades,
    setMarkdownListAlternatingShades,
    streamThreadImageBgEnabled,
    setStreamThreadImageBgEnabled,
    streamThreadImageBgOpacity,
    setStreamThreadImageBgOpacity,
    streamBackgroundAnimate,
    setStreamBackgroundAnimate,
    streamBackgroundCrtEffect,
    setStreamBackgroundCrtEffect,
    streamRootBackgroundPresent,
    streamRootBackgroundOpacity,
    setStreamRootBackgroundOpacity,
    canvasUseStreamRootBackground,
    setCanvasUseStreamRootBackground,
    uploadStreamRootBackgroundFile,
    removeStreamRootBackgroundFile,
  } = useNoteTypeColors();
  const rootBackgroundFileRef = useRef(null);
  const [rootBgUploadBusy, setRootBgUploadBusy] = useState(false);
  const [rootThreads, setRootThreads] = useState([]);
  const [spaztickKeyInput, setSpaztickKeyInput] = useState('');
  const [ingestKeyInput, setIngestKeyInput] = useState('');
  const [newCalendarFeedUrl, setNewCalendarFeedUrl] = useState('');
  const [newCalendarFeedName, setNewCalendarFeedName] = useState('');
  const [calendarLookoutDraft, setCalendarLookoutDraft] = useState(() => String(calendarLookoutDays));

  useEffect(() => {
    setCalendarLookoutDraft(String(calendarLookoutDays));
  }, [calendarLookoutDays]);

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

  const handleSaveSpaztickKey = useCallback(async () => {
    try {
      await saveSpaztickApiKey(spaztickKeyInput.trim() || null);
      setSpaztickKeyInput('');
    } catch (e) {
      console.error(e);
      window.alert(e?.message || 'Could not save API key');
    }
  }, [saveSpaztickApiKey, spaztickKeyInput]);

  const handleSaveIngestKey = useCallback(async () => {
    try {
      await saveIngestApiKey(ingestKeyInput.trim() || null);
      setIngestKeyInput('');
    } catch (e) {
      console.error(e);
      window.alert(e?.message || 'Could not save ingest API key');
    }
  }, [saveIngestApiKey, ingestKeyInput]);

  const handleClearIngestKey = useCallback(async () => {
    if (!window.confirm('Remove the file-ingest API key? Scripts (e.g. Hazel) will no longer be able to call the ingest API.')) {
      return;
    }
    try {
      await saveIngestApiKey(null);
      setIngestKeyInput('');
    } catch (e) {
      console.error(e);
      window.alert(e?.message || 'Could not remove API key');
    }
  }, [saveIngestApiKey]);

  const handleClearSpaztickKey = useCallback(async () => {
    if (!window.confirm('Remove the stored Spaztick API key from Hermes?')) return;
    try {
      await saveSpaztickApiKey(null);
      setSpaztickKeyInput('');
    } catch (e) {
      console.error(e);
      window.alert(e?.message || 'Could not remove API key');
    }
  }, [saveSpaztickApiKey]);

  const feeds = Array.isArray(calendarFeeds) ? calendarFeeds : [];

  const tryAddCalendarFeed = useCallback(() => {
    let raw = newCalendarFeedUrl.trim();
    if (!raw) return;
    if (raw.toLowerCase().startsWith('webcal://')) {
      raw = `https://${raw.slice('webcal://'.length)}`;
    }
    let u;
    try {
      u = new URL(raw);
    } catch {
      window.alert('Enter a valid URL (for example an https://… webcal or iCal link).');
      return;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      window.alert('Only http and https calendar URLs are supported.');
      return;
    }
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1') {
      window.alert('Hermes cannot fetch calendar feeds from localhost (server restriction). Use a public HTTPS iCal URL.');
      return;
    }
    if (feeds.some((x) => x.url === u.href)) {
      setNewCalendarFeedUrl('');
      setNewCalendarFeedName('');
      return;
    }
    if (feeds.length >= 12) {
      window.alert('You can add at most 12 calendar feeds.');
      return;
    }
    const name = newCalendarFeedName.trim().slice(0, 80);
    setCalendarFeeds([...feeds, { url: u.href, name }]);
    setNewCalendarFeedUrl('');
    setNewCalendarFeedName('');
  }, [newCalendarFeedUrl, newCalendarFeedName, feeds, setCalendarFeeds]);

  const removeCalendarFeed = useCallback(
    (url) => {
      setCalendarFeeds(feeds.filter((x) => x.url !== url));
    },
    [feeds, setCalendarFeeds]
  );

  const updateCalendarFeedName = useCallback(
    (url, name) => {
      setCalendarFeeds(
        feeds.map((f) => (f.url === url ? { ...f, name: name.slice(0, 80) } : f))
      );
    },
    [feeds, setCalendarFeeds]
  );

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

        <section className="settings-modal-section" aria-labelledby="settings-start-page-heading">
          <h3 id="settings-start-page-heading" className="settings-modal-section-title">
            Default start page
          </h3>
          <p className="settings-modal-section-lead">
            When you open Hermes or use the logo to go home, which main view opens first. Stream, Canvas, and
            other views stay available from the header. Desktop and tablet share one default; compact phone
            layouts use the other.
          </p>
          <div className="settings-modal-similar-notes-row">
            <label className="settings-modal-similar-notes-label" htmlFor="settings-default-start-page">
              Desktop &amp; tablet
            </label>
            <select
              id="settings-default-start-page"
              className="settings-modal-similar-notes-input"
              value={defaultStartPage}
              onChange={(e) => setDefaultStartPage(e.target.value)}
            >
              {DEFAULT_START_PAGE_OPTIONS.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-modal-similar-notes-row">
            <label className="settings-modal-similar-notes-label" htmlFor="settings-default-start-page-phone">
              Phone
            </label>
            <select
              id="settings-default-start-page-phone"
              className="settings-modal-similar-notes-input"
              value={defaultStartPagePhone}
              onChange={(e) => setDefaultStartPagePhone(e.target.value)}
            >
              {DEFAULT_START_PAGE_OPTIONS.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="settings-modal-section" aria-labelledby="settings-stream-thread-bg-heading">
          <h3 id="settings-stream-thread-bg-heading" className="settings-modal-section-title">
            Stream &amp; canvas backgrounds
          </h3>
          <p className="settings-modal-section-lead">
            Optional backgrounds behind Stream and Canvas. Thread images take priority over the uploaded
            default when both apply.
          </p>
          <h4 className="settings-modal-subsection-title">Thread head image</h4>
          <p className="settings-modal-section-lead settings-modal-subsection-lead">
            In a thread, when this is on, the first image attached to the <strong>focused</strong> note (the
            thread head you are viewing) is drawn behind the message list. It slowly pans and picks a new
            direction when it reaches the edge.
          </p>
          <div className="settings-modal-similar-notes-checkbox-row settings-modal-list-alternating-row">
            <input
              id="settings-stream-thread-image-bg"
              type="checkbox"
              className="settings-modal-similar-notes-checkbox"
              checked={streamThreadImageBgEnabled}
              onChange={(e) => setStreamThreadImageBgEnabled(e.target.checked)}
              aria-describedby="settings-stream-thread-image-bg-hint"
            />
            <label
              className="settings-modal-similar-notes-checkbox-label"
              htmlFor="settings-stream-thread-image-bg"
            >
              Use first image on focused note as thread background
            </label>
          </div>
          <div className="settings-modal-similar-notes-row">
            <label className="settings-modal-similar-notes-label" htmlFor="settings-stream-thread-image-bg-opacity">
              Image visibility
            </label>
            <input
              id="settings-stream-thread-image-bg-opacity"
              type="range"
              className="settings-modal-similar-notes-input"
              min={0}
              max={100}
              step={1}
              value={Math.round(streamThreadImageBgOpacity * 100)}
              disabled={!streamThreadImageBgEnabled}
              onChange={(e) => setStreamThreadImageBgOpacity(Number(e.target.value) / 100)}
              aria-valuetext={`${Math.round(streamThreadImageBgOpacity * 100)} percent`}
            />
          </div>
          <p id="settings-stream-thread-image-bg-hint" className="settings-modal-similar-notes-hint">
            0% is invisible; 100% is full strength. Saved to your account.
          </p>
          <div className="settings-modal-similar-notes-checkbox-row settings-modal-list-alternating-row">
            <input
              id="settings-stream-bg-animate"
              type="checkbox"
              className="settings-modal-similar-notes-checkbox"
              checked={streamBackgroundAnimate}
              onChange={(e) => setStreamBackgroundAnimate(e.target.checked)}
              aria-describedby="settings-stream-bg-animate-hint"
            />
            <label
              className="settings-modal-similar-notes-checkbox-label"
              htmlFor="settings-stream-bg-animate"
            >
              Animate background (slow drift)
            </label>
          </div>
          <p id="settings-stream-bg-animate-hint" className="settings-modal-similar-notes-hint">
            When off, the image stays centered and scaled to cover the viewport (no motion). Applies to
            Stream and Canvas. Saved to your account.
          </p>
          <div className="settings-modal-similar-notes-checkbox-row settings-modal-list-alternating-row">
            <input
              id="settings-stream-bg-crt"
              type="checkbox"
              className="settings-modal-similar-notes-checkbox"
              checked={streamBackgroundCrtEffect}
              onChange={(e) => setStreamBackgroundCrtEffect(e.target.checked)}
              aria-describedby="settings-stream-bg-crt-hint"
            />
            <label
              className="settings-modal-similar-notes-checkbox-label"
              htmlFor="settings-stream-bg-crt"
            >
              CRT scanlines (horizontal transparent lines)
            </label>
          </div>
          <p id="settings-stream-bg-crt-hint" className="settings-modal-similar-notes-hint">
            Adds alternating fully transparent horizontal stripes over the background image so the page
            color shows through (CRT-style). Applies to Stream and Canvas. Saved to your account.
          </p>

          <h4 className="settings-modal-subsection-title">Default thread background</h4>
          <p className="settings-modal-section-lead settings-modal-subsection-lead">
            Upload an image to use behind threads that do not already use a head image (root list, or any
            thread whose focused note has no image attachment). Same file can appear on Canvas if you enable
            that below.
          </p>
          <div className="settings-modal-similar-notes-row settings-modal-root-bg-row">
            <input
              ref={rootBackgroundFileRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp,image/avif,image/bmp"
              className="settings-modal-file-input-hidden"
              aria-hidden
              tabIndex={-1}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                setRootBgUploadBusy(true);
                try {
                  await uploadStreamRootBackgroundFile(file);
                } catch (err) {
                  console.error(err);
                  window.alert(err?.message || 'Upload failed');
                } finally {
                  setRootBgUploadBusy(false);
                }
              }}
            />
            <button
              type="button"
              className="settings-modal-btn"
              disabled={rootBgUploadBusy}
              onClick={() => rootBackgroundFileRef.current?.click()}
            >
              {streamRootBackgroundPresent ? 'Replace image…' : 'Upload image…'}
            </button>
            <button
              type="button"
              className="settings-modal-btn"
              disabled={rootBgUploadBusy || !streamRootBackgroundPresent}
              onClick={async () => {
                if (!streamRootBackgroundPresent) return;
                if (
                  !window.confirm(
                    'Remove the default background image from your account? Stream and Canvas will stop using it.'
                  )
                ) {
                  return;
                }
                setRootBgUploadBusy(true);
                try {
                  await removeStreamRootBackgroundFile();
                } catch (err) {
                  console.error(err);
                  window.alert(err?.message || 'Remove failed');
                } finally {
                  setRootBgUploadBusy(false);
                }
              }}
            >
              Remove
            </button>
          </div>
          <div className="settings-modal-similar-notes-row">
            <label className="settings-modal-similar-notes-label" htmlFor="settings-stream-root-bg-opacity">
              Default background visibility
            </label>
            <input
              id="settings-stream-root-bg-opacity"
              type="range"
              className="settings-modal-similar-notes-input"
              min={0}
              max={100}
              step={1}
              value={Math.round(streamRootBackgroundOpacity * 100)}
              disabled={!streamRootBackgroundPresent}
              onChange={(e) => setStreamRootBackgroundOpacity(Number(e.target.value) / 100)}
              aria-valuetext={`${Math.round(streamRootBackgroundOpacity * 100)} percent`}
            />
          </div>
          <p className="settings-modal-similar-notes-hint">
            Applies to the default image only. Saved to your account.
          </p>
          <div className="settings-modal-similar-notes-checkbox-row settings-modal-list-alternating-row">
            <input
              id="settings-canvas-use-root-bg"
              type="checkbox"
              className="settings-modal-similar-notes-checkbox"
              checked={canvasUseStreamRootBackground}
              onChange={(e) => setCanvasUseStreamRootBackground(e.target.checked)}
              disabled={!streamRootBackgroundPresent}
              aria-describedby="settings-canvas-use-root-bg-hint"
            />
            <label className="settings-modal-similar-notes-checkbox-label" htmlFor="settings-canvas-use-root-bg">
              Also use default background on Canvas
            </label>
          </div>
          <p id="settings-canvas-use-root-bg-hint" className="settings-modal-similar-notes-hint">
            When enabled, the same image and visibility slider apply behind the canvas workspace (cards and
            grid stay readable). Requires an uploaded default image.
          </p>
        </section>

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
          <div className="settings-modal-similar-notes-checkbox-row settings-modal-list-alternating-row">
            <input
              id="settings-markdown-list-alternating"
              type="checkbox"
              className="settings-modal-similar-notes-checkbox"
              checked={markdownListAlternatingShades}
              onChange={(e) => setMarkdownListAlternatingShades(e.target.checked)}
              aria-describedby="settings-markdown-list-alternating-hint"
            />
            <label
              className="settings-modal-similar-notes-checkbox-label"
              htmlFor="settings-markdown-list-alternating"
            >
              Alternating row shading for checklists
            </label>
          </div>
          <p id="settings-markdown-list-alternating-hint" className="settings-modal-similar-notes-hint">
            When on, odd checklist rows are slightly darker than the note-type background from the colors above
            (same tint as the card). Saved to your account.
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

        <section className="settings-modal-section" aria-labelledby="settings-spaztick-heading">
          <h3 id="settings-spaztick-heading" className="settings-modal-section-title">
            Spaztick
          </h3>
          <p className="settings-modal-section-lead">
            Connect Hermes to your Spaztick instance using the external API (
            <code className="settings-modal-code">/api/external/...</code>
            ). Set the base URL (for example <code className="settings-modal-code">http://localhost:8081</code>) and
            the same API key you configured in Spaztick&apos;s config. See{' '}
            <code className="settings-modal-code">API_ACCESS.md</code> for details.
          </p>
          <div className="settings-modal-spaztick-field">
            <label className="settings-modal-similar-notes-label" htmlFor="settings-spaztick-url">
              API base URL
            </label>
            <input
              id="settings-spaztick-url"
              className="settings-modal-spaztick-url-input"
              type="url"
              autoComplete="off"
              placeholder="http://localhost:8081"
              value={typeof spaztickApiUrl === 'string' ? spaztickApiUrl : ''}
              onChange={(e) => setSpaztickApiUrl(e.target.value)}
            />
          </div>
          <div className="settings-modal-spaztick-field">
            <label className="settings-modal-similar-notes-label" htmlFor="settings-spaztick-key">
              API key
            </label>
            <input
              id="settings-spaztick-key"
              className="settings-modal-spaztick-url-input"
              type="password"
              autoComplete="off"
              placeholder={spaztickApiKeySet ? '•••••••• (enter new key to replace)' : 'Required for /api/external/…'}
              value={spaztickKeyInput}
              onChange={(e) => setSpaztickKeyInput(e.target.value)}
            />
          </div>
          <div className="settings-modal-spaztick-actions">
            <button
              type="button"
              className="settings-modal-btn"
              onClick={handleSaveSpaztickKey}
              disabled={!spaztickKeyInput.trim()}
            >
              Save API key
            </button>
            <button
              type="button"
              className="settings-modal-type-color-reset"
              disabled={!spaztickApiKeySet}
              onClick={handleClearSpaztickKey}
            >
              Remove API key
            </button>
          </div>
        </section>

        <section className="settings-modal-section" aria-labelledby="settings-calendar-feeds-heading">
          <h3 id="settings-calendar-feeds-heading" className="settings-modal-section-title">
            Calendar feeds
          </h3>
          <p className="settings-modal-section-lead">
            Subscribe to published iCal / ICS feeds (for example a &quot;secret&quot; or public calendar URL from Google
            Calendar, Fastmail, or similar). Hermes fetches them on the server and shows today&apos;s remaining events
            above the reply box. Add the HTTPS link to the raw <code className="settings-modal-code">.ics</code> feed.
            Give each feed a short name; it appears after the event title in parentheses on the chips.
          </p>
          <div className="settings-modal-spaztick-field">
            <label className="settings-modal-similar-notes-label" htmlFor="settings-calendar-feed-new-name">
              Name (optional)
            </label>
            <input
              id="settings-calendar-feed-new-name"
              className="settings-modal-spaztick-url-input"
              type="text"
              autoComplete="off"
              placeholder="Work, Family, …"
              maxLength={80}
              value={newCalendarFeedName}
              onChange={(e) => setNewCalendarFeedName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  tryAddCalendarFeed();
                }
              }}
            />
          </div>
          <div className="settings-modal-spaztick-field">
            <label className="settings-modal-similar-notes-label" htmlFor="settings-calendar-feed-new">
              Add feed URL
            </label>
            <input
              id="settings-calendar-feed-new"
              className="settings-modal-spaztick-url-input"
              type="url"
              autoComplete="off"
              placeholder="https://calendar.example.com/…/basic.ics"
              value={newCalendarFeedUrl}
              onChange={(e) => setNewCalendarFeedUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  tryAddCalendarFeed();
                }
              }}
            />
          </div>
          <div className="settings-modal-spaztick-actions">
            <button type="button" className="settings-modal-btn" onClick={tryAddCalendarFeed}>
              Add feed
            </button>
          </div>
          {feeds.length > 0 ? (
            <ul className="settings-modal-type-colors" style={{ marginTop: '0.65rem' }}>
              {feeds.map((feed) => (
                <li key={feed.url} className="settings-modal-calendar-feed-row">
                  <input
                    type="text"
                    className="settings-modal-calendar-feed-name-input"
                    aria-label={`Name for calendar ${feed.url}`}
                    placeholder="Name"
                    maxLength={80}
                    value={feed.name}
                    onChange={(e) => updateCalendarFeedName(feed.url, e.target.value)}
                  />
                  <span className="settings-modal-calendar-feed-url">{feed.url}</span>
                  <button
                    type="button"
                    className="settings-modal-type-color-reset settings-modal-calendar-feed-remove"
                    onClick={() => removeCalendarFeed(feed.url)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings-modal-similar-notes-hint" style={{ marginTop: '0.35rem' }}>
              No feeds yet. Events from feeds appear as chips above the composer when there is something in your
              selected calendar window (see below).
            </p>
          )}
          <div className="settings-modal-similar-notes-row" style={{ marginTop: '0.85rem' }}>
            <label className="settings-modal-similar-notes-label" htmlFor="settings-calendar-lookout-days">
              Days to look out
            </label>
            <input
              id="settings-calendar-lookout-days"
              type="number"
              min={CALENDAR_LOOKOUT_MIN}
              max={CALENDAR_LOOKOUT_MAX}
              step={1}
              className="settings-modal-similar-notes-input"
              style={{ maxWidth: '5rem' }}
              value={calendarLookoutDraft}
              onChange={(e) => {
                const raw = e.target.value;
                setCalendarLookoutDraft(raw);
                if (raw === '' || raw === '-' || raw === '+') return;
                setCalendarLookoutDays(raw);
              }}
              onBlur={() => {
                const n = normalizeCalendarLookoutDays(calendarLookoutDraft);
                setCalendarLookoutDays(n);
                setCalendarLookoutDraft(String(n));
              }}
            />
          </div>
          <p className="settings-modal-similar-notes-hint" style={{ marginTop: '0.35rem' }}>
            <strong>0</strong> shows today only (local date). Use negative values to include past days and positive
            values to extend further ahead (each step is one calendar day, range {CALENDAR_LOOKOUT_MIN} to{' '}
            {CALENDAR_LOOKOUT_MAX}).
          </p>
        </section>

        <section className="settings-modal-section" aria-labelledby="settings-inbox-thread-heading">
          <h3 id="settings-inbox-thread-heading" className="settings-modal-section-title">
            Inbox thread for new @ notes
          </h3>
          <p className="settings-modal-section-lead">
            Choose a root thread where auto-created notes from @ mention links should land, and where the file ingest
            API places new notes when <code className="settings-modal-code">parent_id</code> is omitted. Leave blank to
            keep creating @-mention notes as replies at the current thread level (ingest API still requires an inbox if
            you do not pass <code className="settings-modal-code">parent_id</code>).
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

        <section className="settings-modal-section" aria-labelledby="settings-ingest-api-heading">
          <h3 id="settings-ingest-api-heading" className="settings-modal-section-title">
            File ingest API (Hazel, scripts)
          </h3>
          <p className="settings-modal-section-lead">
            Set a long secret (16+ characters). Use{' '}
            <code className="settings-modal-code">Authorization: Bearer &lt;secret&gt;</code> or header{' '}
            <code className="settings-modal-code">X-Hermes-Ingest-Key</code> on requests to{' '}
            <code className="settings-modal-code">POST …/api/ingest/notes</code> with JSON (
            <code className="settings-modal-code">content</code>, optional{' '}
            <code className="settings-modal-code">parent_id</code>) or multipart (
            <code className="settings-modal-code">file</code> / <code className="settings-modal-code">files</code>
            — PDFs and images are OCR&apos;d and summarized when possible; each upload creates a note plus attachment)
            and{' '}
            <code className="settings-modal-code">POST …/api/ingest/notes/&lt;id&gt;/attachments</code> (multipart
            field <code className="settings-modal-code">files</code>
            — if that note&apos;s body is still empty, PDFs/images get the same OCR pipeline as the main API). If you omit{' '}
            <code className="settings-modal-code">
              parent_id
            </code>
            , new notes are created as replies under your <strong>Inbox root thread</strong> above—set that first.
          </p>
          <div className="settings-modal-spaztick-field">
            <label className="settings-modal-similar-notes-label" htmlFor="settings-ingest-key">
              Ingest API key
            </label>
            <input
              id="settings-ingest-key"
              type="password"
              autoComplete="new-password"
              className="settings-modal-spaztick-url-input"
              placeholder={ingestApiKeySet ? '(key is set — enter a new value to replace)' : 'Min. 16 characters'}
              value={ingestKeyInput}
              onChange={(e) => setIngestKeyInput(e.target.value)}
            />
          </div>
          <div className="settings-modal-spaztick-actions">
            <button
              type="button"
              className="settings-modal-btn"
              onClick={handleSaveIngestKey}
              disabled={!ingestKeyInput.trim()}
            >
              Save key
            </button>
            <button
              type="button"
              className="settings-modal-type-color-reset"
              disabled={!ingestApiKeySet}
              onClick={handleClearIngestKey}
            >
              Remove key
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
