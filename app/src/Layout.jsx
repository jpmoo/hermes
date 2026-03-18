import React, { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import './Layout.css';
import { LayoutNavIcon, hasLayoutNavIcon } from './icons/NavIcons.jsx';

const LAYOUT_THEME_COLOR = '#f4f3f0';

export default function Layout({ title, starredOnly, onStarredOnlyChange, onLogout, viewLinks, children }) {
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
            {viewLinks?.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                className={`layout-nav-link ${
                  location.pathname === to || (to !== '/' && location.pathname.startsWith(to))
                    ? 'layout-nav-link--active'
                    : ''
                }`}
                aria-label={label}
                title={label}
              >
                {hasLayoutNavIcon(to) ? <LayoutNavIcon to={to} /> : label}
              </Link>
            ))}
          </nav>
          <div className="layout-actions">
            <button
              type="button"
              className={`layout-toggle ${starredOnly ? 'layout-toggle--on' : ''}`}
              onClick={() => onStarredOnlyChange?.(!starredOnly)}
            >
              {starredOnly ? 'Starred' : 'All'}
            </button>
            <Link
              to="/orphans"
              className={`layout-orphans-link${location.pathname === '/orphans' ? ' layout-orphans-link--active' : ''}`}
              title="Attachments whose note was deleted"
            >
              Orphans
            </Link>
            <button type="button" className="layout-logout" onClick={onLogout}>
              Sign out
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
