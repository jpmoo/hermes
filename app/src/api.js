const BASE = (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '';
const API = `${BASE.replace(/\/$/, '')}/api`;

function getToken() {
  return localStorage.getItem('hermes_token');
}

function headers() {
  const t = getToken();
  return {
    'Content-Type': 'application/json',
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
  };
}

export async function login(username, password) {
  const r = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ username, password }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Login failed');
  return data;
}

export async function register(username, password) {
  const r = await fetch(`${API}/auth/register`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ username, password }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Registration failed');
  return data;
}

export async function getRoots(starredOnly = false) {
  const r = await fetch(`${API}/notes/roots?starred=${starredOnly}`, { headers: headers() });
  if (!r.ok) throw new Error('Failed to load feed');
  return r.json();
}

export async function getThread(id, starredOnly = false) {
  const r = await fetch(`${API}/notes/thread/${id}?starred=${starredOnly}`, { headers: headers() });
  if (!r.ok) throw new Error('Failed to load thread');
  return r.json();
}

export async function getNote(id) {
  const r = await fetch(`${API}/notes/${id}`, { headers: headers() });
  if (!r.ok) throw new Error('Note not found');
  return r.json();
}

export async function createNote({ content, parent_id, external_anchor }) {
  const r = await fetch(`${API}/notes`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ content, parent_id, external_anchor }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Failed to create note');
  return data;
}

export async function updateNote(id, patch) {
  const r = await fetch(`${API}/notes/${id}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(patch),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Failed to update note');
  return data;
}

export async function deleteNote(id) {
  const r = await fetch(`${API}/notes/${id}`, { method: 'DELETE', headers: headers() });
  if (!r.ok) throw new Error('Failed to delete note');
}

export async function starNote(id) {
  const r = await fetch(`${API}/notes/${id}/star`, { method: 'POST', headers: headers() });
  if (!r.ok) throw new Error('Failed to star');
  return r.json();
}

export async function unstarNote(id) {
  const r = await fetch(`${API}/notes/${id}/star`, { method: 'DELETE', headers: headers() });
  if (!r.ok) throw new Error('Failed to unstar');
  return r.json();
}

export async function getTags() {
  const r = await fetch(`${API}/tags`, { headers: headers() });
  if (!r.ok) throw new Error('Failed to load tags');
  return r.json();
}

export async function addNoteTag(noteId, { tag_id, name }) {
  const r = await fetch(`${API}/notes/${noteId}/tags`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(tag_id != null ? { tag_id } : { name }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Failed to add tag');
  return data;
}

export async function removeNoteTag(noteId, tagId) {
  const r = await fetch(`${API}/notes/${noteId}/tags/${tagId}`, { method: 'DELETE', headers: headers() });
  if (!r.ok) throw new Error('Failed to remove tag');
}

export { getToken };
