import React, { createContext, useContext, useState, useEffect } from 'react';
import { getToken } from './api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = getToken();
    if (t) {
      try {
        const payload = JSON.parse(atob(t.split('.')[1]));
        setUser({ id: payload.userId, username: payload.username });
      } catch {
        localStorage.removeItem('hermes_token');
      }
    }
    setLoading(false);
  }, []);

  const login = (data) => {
    localStorage.setItem('hermes_token', data.token);
    setUser(data.user);
  };

  const logout = () => {
    localStorage.removeItem('hermes_token');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
