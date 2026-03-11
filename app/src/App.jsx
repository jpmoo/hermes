import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './AuthContext';
import Login from './Login';
import RootFeed from './RootFeed';
import StreamView from './StreamView';
import OutlineView from './OutlineView';

function PrivateRoute({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading">Loading…</div>;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <PrivateRoute>
            <RootFeed />
          </PrivateRoute>
        }
      />
      <Route
        path="/thread/:rootId"
        element={
          <PrivateRoute>
            <StreamView />
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
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AuthProvider>
  );
}
