import bcrypt from 'bcryptjs';
import pool from '../db/pool.js';

/**
 * Authenticate `Authorization: Bearer <key>` or `X-Hermes-Ingest-Key: <key>`
 * against stored bcrypt hashes (settings_json.ingestApiKeyHash).
 */
export async function requireIngestAuth(req, res, next) {
  const auth = req.headers.authorization;
  let token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) {
    const h = req.headers['x-hermes-ingest-key'];
    token = typeof h === 'string' ? h.trim() : null;
  }
  if (!token) {
    return res.status(401).json({
      error: 'Missing ingest API key (Authorization: Bearer … or X-Hermes-Ingest-Key)',
    });
  }
  try {
    const r = await pool.query(
      `SELECT id, settings_json FROM users
       WHERE settings_json ? 'ingestApiKeyHash'
         AND NULLIF(trim(settings_json->>'ingestApiKeyHash'), '') IS NOT NULL`
    );
    for (const row of r.rows) {
      const hash = row.settings_json?.ingestApiKeyHash;
      if (typeof hash !== 'string' || !hash) continue;
      const ok = await bcrypt.compare(token, hash);
      if (ok) {
        req.userId = row.id;
        return next();
      }
    }
    return res.status(401).json({ error: 'Invalid ingest API key' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Ingest authentication failed' });
  }
}
