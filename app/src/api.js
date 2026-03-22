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

/** Connect two notes (server stores one row; link is bidirectional in the UI). */
export async function createNoteConnection(anchorNoteId, linkedNoteId) {
  const r = await fetch(`${API}/notes/${anchorNoteId}/connections`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ linkedNoteId }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Failed to create connection');
  return data;
}

/** Remove connection between two notes (either stored anchor/linked direction). */
export async function deleteNoteConnection(anchorNoteId, linkedNoteId) {
  const r = await fetch(`${API}/notes/${anchorNoteId}/connections/${linkedNoteId}`, {
    method: 'DELETE',
    headers: headers(),
  });
  if (r.ok) return;
  const data = await r.json().catch(() => ({}));
  throw new Error(data.error || 'Failed to remove connection');
}

export async function getNoteConnections(noteId) {
  const r = await fetch(`${API}/notes/${noteId}/connections`, { headers: headers() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Failed to load connections');
  return data;
}

/** Walk parent chain to thread root id (for Stream navigation). */
export async function getNoteThreadRoot(noteId) {
  const r = await fetch(`${API}/notes/${noteId}/thread-root`, { headers: headers() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Could not resolve thread');
  return data.thread_root_id;
}

/** Root → note breadcrumb (truncated snippets, " > " separators). */
export async function getNoteThreadPath(noteId, { excludeLeaf = true } = {}) {
  const q = excludeLeaf ? '?excludeLeaf=1' : '';
  const r = await fetch(`${API}/notes/${noteId}/thread-path${q}`, { headers: headers() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Could not load thread path');
  return data.threadPath || '';
}

/** Linked notes for Stream insight (immediate paint; no tag/similar work). */
export async function fetchLinkedNotesQuick(noteId) {
  const r = await fetch(`${API}/notes/${noteId}/linked-notes`, { headers: headers() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Failed to load linked notes');
  return data;
}

export async function fetchHoverInsight(noteId, minSimilarity = 0.5) {
  const r = await fetch(`${API}/notes/hover-insight`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      noteId: noteId != null ? String(noteId) : noteId,
      minSimilarity,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Failed to load suggestions');
  return data;
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

/** Approved tags on a note (for parent lookup when inheriting). */
export async function getNoteTags(noteId) {
  const r = await fetch(`${API}/notes/${noteId}/tags`, { headers: headers() });
  if (!r.ok) return [];
  const data = await r.json().catch(() => []);
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
