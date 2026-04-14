import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { clearStreamNavMemory, getLastStreamSearch } from './streamNavMemory';
import { useNoteTypeColors } from './NoteTypeColorContext';
import './Layout.css';
import {
  LayoutNavIcon,
  hasLayoutNavIcon,
  NavIconTheme,
  NavIconSettings,
  NavIconSignOut,
} from './icons/NavIcons.jsx';
import NoteTypeFilterButtons from './NoteTypeFilterButtons';
import SettingsModal from './SettingsModal';

export default function Layout({
  title,
  noteTypeFilterEnabled = false,
  onLogout,
  viewLinks,
  children,
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { theme, setTheme } = useNoteTypeColors();

  return (
    <div className="layout">
      <header className="layout-header">
        <div className="layout-header-inner">
          <div className="layout-header-start">
            <Link
              to="/"
              className="layout-logo"
              aria-label="Hermes home"
              title="Home (default start page from Settings)"
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
                to === '/stream' || to === '/canvas' ? (
                  <Link
                    key={to}
                    to={to}
                    className={`layout-nav-link ${
                      location.pathname === to ? 'layout-nav-link--active' : ''
                    }`}
                    aria-label={label}
                    title={
                      tooltip ??
                      (to === '/stream'
                        ? 'Return to last Stream level'
                        : 'Infinite canvas — last thread')
                    }
                    onClick={(e) => {
                      e.preventDefault();
                      const s = getLastStreamSearch();
                      navigate(s ? { pathname: to, search: s } : { pathname: to });
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
              <NoteTypeFilterButtons mode="header" disabled={!noteTypeFilterEnabled} />
            </div>
          </div>
          <div className="layout-header-end">
            <button
              type="button"
              className="layout-logout"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
            >
              <NavIconTheme className="layout-toolbar-icon" />
            </button>
            <button
              type="button"
              className="layout-logout"
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              title="Settings"
            >
              <NavIconSettings className="layout-toolbar-icon" />
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
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <main className="layout-main">
        {children}
      </main>
    </div>
  );
}
