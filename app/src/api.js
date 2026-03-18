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
    body: JSON.stringify({ content: content ?? '', parent_id, external_anchor }),
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

/** @param {{ inUseOnly?: boolean }} opts - inUseOnly: tags that appear on at least one of your notes (approved) */
export async function getTags(opts = {}) {
  const q = opts.inUseOnly ? '?in_use=1' : '';
  const r = await fetch(`${API}/tags${q}`, { headers: headers() });
  if (!r.ok) throw new Error('Failed to load tags');
  return r.json();
}

export async function searchByTags(tagIds, mode = 'and', starredOnly = false) {
  const params = new URLSearchParams({ tagIds: tagIds.join(','), mode, starred: starredOnly });
  const r = await fetch(`${API}/notes/search-by-tags?${params}`, { headers: headers() });
  if (!r.ok) throw new Error('Failed to search');
  return r.json();
}

export async function searchSemantic(q, limit = 20) {
  const r = await fetch(`${API}/notes/search-semantic?q=${encodeURIComponent(q)}&limit=${limit}`, { headers: headers() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(data.error || 'Semantic search failed');
    err.code = data.code;
    throw err;
  }
  return Array.isArray(data) ? data : [];
}

export async function searchContent(q, limit = 40) {
  const r = await fetch(`${API}/notes/search-content?q=${encodeURIComponent(q)}&limit=${limit}`, { headers: headers() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Text search failed');
  return Array.isArray(data) ? data : [];
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

export async function getQueue(minConfidence = 0) {
  const r = await fetch(`${API}/queue?minConfidence=${minConfidence}`, { headers: headers() });
  if (!r.ok) throw new Error('Failed to load queue');
  return r.json();
}

export async function getQueueCount(minConfidence = 0) {
  const r = await fetch(`${API}/queue/count?minConfidence=${minConfidence}`, { headers: headers() });
  if (!r.ok) throw new Error('Failed to load count');
  return r.json();
}

export async function approveProposal(id) {
  const r = await fetch(`${API}/queue/${id}/approve`, { method: 'POST', headers: headers() });
  if (!r.ok) throw new Error('Failed to approve');
  return r.json();
}

export async function rejectProposal(id) {
  const r = await fetch(`${API}/queue/${id}/reject`, { method: 'POST', headers: headers() });
  if (!r.ok) throw new Error('Failed to reject');
  return r.json();
}

export async function uploadNoteFiles(noteId, files) {
  if (!files?.length) return [];
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  const t = getToken();
  const r = await fetch(`${API}/notes/${noteId}/attachments`, {
    method: 'POST',
    headers: t ? { Authorization: `Bearer ${t}` } : {},
    body: fd,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Upload failed');
  return Array.isArray(data) ? data : [];
}

export async function deleteNoteFile(attachmentId) {
  const r = await fetch(`${API}/note-files/${attachmentId}`, { method: 'DELETE', headers: headers() });
  if (!r.ok) throw new Error('Failed to delete file');
}

export async function getOrphanAttachments() {
  const r = await fetch(`${API}/note-files/orphans`, { headers: headers() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Failed to load orphan files');
  return Array.isArray(data) ? data : [];
}

export async function deleteOrphanAttachment(id) {
  const r = await fetch(`${API}/note-files/orphans/${id}`, { method: 'DELETE', headers: headers() });
  if (!r.ok) throw new Error('Failed to delete');
}

export { getToken };
