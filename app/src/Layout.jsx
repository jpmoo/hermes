import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import './Layout.css';

export default function Layout({ title, starredOnly, onStarredOnlyChange, onLogout, viewLinks, children }) {
  const location = useLocation();

  return (
    <div className="layout">
      <header className="layout-header">
        <div className="layout-header-inner">
          <Link to="/" className="layout-logo">Hermes</Link>
          <nav className="layout-nav">
            {viewLinks?.map(({ to, label }) => (
              <Link
                key={to}
                to={to}
                className={`layout-nav-link ${location.pathname === to || (to !== '/' && location.pathname.startsWith(to)) ? 'layout-nav-link--active' : ''}`}
              >
                {label}
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
