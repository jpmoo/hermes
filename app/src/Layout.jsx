import React, { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { clearStreamNavMemory, getLastStreamSearch } from './streamNavMemory';
import './Layout.css';
import {
  LayoutNavIcon,
  hasLayoutNavIcon,
  NavIconTheme,
  NavIconSignOut,
} from './icons/NavIcons.jsx';
import NoteTypeIcon from './NoteTypeIcon';
import { NOTE_TYPE_HEADER_ORDER } from './noteTypeFilter';
import { useNoteTypeFilter } from './NoteTypeFilterContext';

const TYPE_FILTER_LABELS = {
  note: 'Notes',
  event: 'Events',
  person: 'People',
  organization: 'Organizations',
};

const THEME_STORAGE_KEY = 'hermes.theme';
const THEME_META = {
  light: '#f4f3f0',
  dark: '#15181c',
};

export default function Layout({
  title,
  noteTypeFilterEnabled = false,
  onLogout,
  viewLinks,
  children,
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { visibleNoteTypes, toggleNoteType } = useNoteTypeFilter();
  const [theme, setTheme] = useState(() => {
    try {
      const v = localStorage.getItem(THEME_STORAGE_KEY);
      return v === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      /* ignore storage failures */
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_META[theme]);
  }, [theme, location.pathname]);

  return (
    <div className="layout">
      <header className="layout-header">
        <div className="layout-header-inner">
          <div className="layout-header-start">
            <Link
              to="/"
              className="layout-logo"
              aria-label="Hermes home — Stream root"
              title="Stream root (all threads)"
              onClick={() => {
                clearStreamNavMemory();
              }}
            >
              <img
                className="layout-logo-img"
                src={`${import.meta.env.BASE_URL}HermesLogoSmall.png`}
                alt=""
              />
            </Link>
          </div>
          <div className="layout-header-middle">
            <nav className="layout-nav" aria-label="Main views">
              {viewLinks?.map(({ to, label, tooltip }) =>
                to === '/' ? (
                  <Link
                    key={to}
                    to="/"
                    className={`layout-nav-link ${
                      location.pathname === '/' ? 'layout-nav-link--active' : ''
                    }`}
                    aria-label={label}
                    title={tooltip ?? 'Return to last Stream level'}
                    onClick={(e) => {
                      e.preventDefault();
                      const s = getLastStreamSearch();
                      navigate(s ? { pathname: '/', search: s } : { pathname: '/' });
                    }}
                  >
                    {hasLayoutNavIcon(to) ? <LayoutNavIcon to={to} /> : label}
                  </Link>
                ) : (
                  <Link
                    key={to}
                    to={to}
                    className={`layout-nav-link ${
                      location.pathname === to || (to !== '/' && location.pathname.startsWith(to))
                        ? 'layout-nav-link--active'
                        : ''
                    }`}
                    aria-label={label}
                    title={tooltip ?? label}
                  >
                    {hasLayoutNavIcon(to) ? <LayoutNavIcon to={to} /> : label}
                  </Link>
                )
              )}
            </nav>
            <div className="layout-filters-cluster">
              <div className="layout-type-filters" role="group" aria-label="Filter notes by type">
                {NOTE_TYPE_HEADER_ORDER.map((t) => {
                  const on = visibleNoteTypes.has(t);
                  const label = TYPE_FILTER_LABELS[t] ?? t;
                  return (
                    <button
                      key={t}
                      type="button"
                      disabled={!noteTypeFilterEnabled}
                      className={`layout-toolbar-btn ${on ? 'layout-toolbar-btn--active' : ''}`}
                      onClick={() => noteTypeFilterEnabled && toggleNoteType(t)}
                      aria-pressed={noteTypeFilterEnabled ? on : undefined}
                      aria-disabled={!noteTypeFilterEnabled}
                      aria-label={
                        !noteTypeFilterEnabled
                          ? `${label} filter (available on Stream and Outline)`
                          : on
                            ? `${label} visible — hide from Stream and Outline`
                            : `${label} hidden — show in Stream and Outline`
                      }
                      title={
                        !noteTypeFilterEnabled
                          ? 'Type filters apply on Stream and Outline'
                          : on
                            ? `${label} visible — click to hide from Stream and Outline`
                            : `${label} hidden — click to show`
                      }
                    >
                      <NoteTypeIcon type={t} className="layout-toolbar-icon" />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="layout-header-end">
            <button
              type="button"
              className="layout-logout"
              onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              <NavIconTheme className="layout-toolbar-icon" />
            </button>
            <button
              type="button"
              className="layout-logout"
              onClick={() => {
                if (!window.confirm('Sign out of Hermes?')) return;
                onLogout?.();
              }}
              aria-label="Sign out"
              title="Sign out"
            >
              <NavIconSignOut className="layout-toolbar-icon" />
            </button>
          </div>
        </div>
      </header>
      <main className="layout-main">
        {children}
      </main>
    </div>
  );
}
