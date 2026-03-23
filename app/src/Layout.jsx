import React, { useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { clearStreamNavMemory, getLastStreamSearch } from './streamNavMemory';
import './Layout.css';
import {
  LayoutNavIcon,
  hasLayoutNavIcon,
  NavIconStar,
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

const LAYOUT_THEME_COLOR = '#f4f3f0';

export default function Layout({
  title,
  starredOnly = false,
  onStarredOnlyChange,
  starFilterEnabled = false,
  noteTypeFilterEnabled = false,
  onLogout,
  viewLinks,
  children,
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const { visibleNoteTypes, toggleNoteType } = useNoteTypeFilter();

  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', LAYOUT_THEME_COLOR);
  }, [location.pathname]);

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
              <div className="layout-filters-cluster-star-gap" aria-hidden />
              <button
                type="button"
                className={`layout-toolbar-btn ${starFilterEnabled && starredOnly ? 'layout-toolbar-btn--active' : ''}`}
                disabled={!starFilterEnabled}
                onClick={() => starFilterEnabled && onStarredOnlyChange?.(!starredOnly)}
                aria-pressed={starFilterEnabled ? starredOnly : undefined}
                aria-label={
                  !starFilterEnabled
                    ? 'Starred filter (available on Stream)'
                    : starredOnly
                      ? 'Show all notes'
                      : 'Show starred only'
                }
                title={
                  !starFilterEnabled
                    ? 'Starred filter is available on Stream'
                    : starredOnly
                      ? 'Starred only — click to show all notes'
                      : 'All notes — click to show starred only'
                }
              >
                <NavIconStar className="layout-toolbar-icon" />
              </button>
            </div>
          </div>
          <div className="layout-header-end">
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
