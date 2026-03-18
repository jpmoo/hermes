/**
 * Shared fetch wrapper for Hermes REST from MCP (stdio + HTTP).
 * Throws on non-OK with err.status for clear 401 handling in callTool.
 */
export function hermesApiFetcher(baseUrl, getToken) {
  return async function api(path, options = {}) {
    const url = `${String(baseUrl).replace(/\/$/, '')}/api${path}`;
    const token = typeof getToken === 'function' ? getToken() : getToken;
    const headers = { ...options.headers, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const r = await fetch(url, { ...options, headers });
    if (r.status === 204) return {};
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(data.error || r.statusText || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return data;
  };
}
