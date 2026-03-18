import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, useParams } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import Login from './Login';
import StreamPage from './StreamPage';
import OutlineView from './OutlineView';
import QueueView from './QueueView';
import TagView from './TagView';
import SearchView from './SearchView';
import OrphanFilesView from './OrphanFilesView';

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
        path="/outline/:rootId?"
        element={
          <PrivateRoute>
            <OutlineView />
          </PrivateRoute>
        }
      />
      <Route
        path="/queue"
        element={
          <PrivateRoute>
            <QueueView />
          </PrivateRoute>
        }
      />
      <Route
        path="/tags"
        element={
          <PrivateRoute>
            <TagView />
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
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
