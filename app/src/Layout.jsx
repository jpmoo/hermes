import React, { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import './Layout.css';
import {
  LayoutNavIcon,
  hasLayoutNavIcon,
  NavIconStar,
  NavIconSignOut,
} from './icons/NavIcons.jsx';

const LAYOUT_THEME_COLOR = '#f4f3f0';

export default function Layout({
  title,
  starredOnly = false,
  onStarredOnlyChange,
  starFilterEnabled = false,
  onLogout,
  viewLinks,
  children,
}) {
  const location = useLocation();

  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', LAYOUT_THEME_COLOR);
  }, [location.pathname]);

  return (
    <div className="layout">
      <header className="layout-header">
        <div className="layout-header-inner">
          <Link to="/" className="layout-logo" aria-label="Hermes home">
            <img
              className="layout-logo-img"
              src={`${import.meta.env.BASE_URL}HermesLogoSmall.png`}
              alt=""
            />
          </Link>
          <nav className="layout-nav">
            {viewLinks?.map(({ to, label, tooltip }) => (
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
            ))}
          </nav>
          <div className="layout-actions">
            <button
              type="button"
              className={`layout-toggle ${starFilterEnabled && starredOnly ? 'layout-toggle--on' : ''}`}
              disabled={!starFilterEnabled}
              onClick={() => starFilterEnabled && onStarredOnlyChange?.(!starredOnly)}
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
              <NavIconStar className="layout-action-icon" />
            </button>
            <button
              type="button"
              className="layout-logout"
              onClick={onLogout}
              aria-label="Sign out"
              title="Sign out"
            >
              <NavIconSignOut className="layout-action-icon" />
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
