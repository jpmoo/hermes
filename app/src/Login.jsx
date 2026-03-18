import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from './AuthContext';
import { login, register } from './api';
import './Login.css';

export default function Login() {
  const [mode, setMode] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const { login: setAuth } = useAuth();
  const navigate = useNavigate();

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      const fn = mode === 'login' ? login : register;
      const data = await fn(username, password);
      setAuth(data);
      navigate('/', { replace: true });
    } catch (err) {
      setError(err.message || 'Something went wrong');
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <img
          className="login-logo-full"
          src={`${import.meta.env.BASE_URL}HermesLogo.png`}
          alt="Hermes"
        />
        <p className="login-subtitle">Personal Knowledge Messenger</p>
        <form onSubmit={submit} className="login-form">
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
          />
          {error && <p className="login-error">{error}</p>}
          <button type="submit">{mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        <button type="button" className="login-toggle" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'Create an account' : 'Already have an account? Sign in'}
        </button>
      </div>
    </div>
  );
}
