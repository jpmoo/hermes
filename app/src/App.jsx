import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import Login from './Login';
import StreamPage from './StreamPage';
import OutlineView from './OutlineView';
import SearchView from './SearchView';
import OrphanFilesView from './OrphanFilesView';
import CalendarView from './CalendarView';
import CampusPage from './CampusPage';
import { NoteTypeFilterProvider } from './NoteTypeFilterContext';
import { NoteTypeColorProvider } from './NoteTypeColorContext';

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function LegacyThreadRedirect() {
  const { rootId } = useParams();
  return <Navigate to={{ pathname: '/', search: `?thread=${encodeURIComponent(rootId)}` }} replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <StreamPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/thread/:rootId"
        element={
          <PrivateRoute>
            <LegacyThreadRedirect />
          </PrivateRoute>
        }
      />
      <Route
        path="/outline/:rootId"
        element={<Navigate to="/outline" replace />}
      />
      <Route
        path="/outline"
        element={
          <PrivateRoute>
            <OutlineView />
          </PrivateRoute>
        }
      />
      <Route
        path="/campus"
        element={
          <PrivateRoute>
            <CampusPage />
          </PrivateRoute>
        }
      />
      <Route
        path="/calendar"
        element={
          <PrivateRoute>
            <CalendarView />
          </PrivateRoute>
        }
      />
      <Route
        path="/tags"
        element={
          <PrivateRoute>
            <Navigate to="/search" replace />
          </PrivateRoute>
        }
      />
      <Route
        path="/search"
        element={
          <PrivateRoute>
            <SearchView />
          </PrivateRoute>
        }
      />
      <Route
        path="/orphans"
        element={
          <PrivateRoute>
            <OrphanFilesView />
          </PrivateRoute>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter basename="/hermes">
        <NoteTypeColorProvider>
          <NoteTypeFilterProvider>
            <AppRoutes />
          </NoteTypeFilterProvider>
        </NoteTypeColorProvider>
      </BrowserRouter>
    </AuthProvider>
  );
}
