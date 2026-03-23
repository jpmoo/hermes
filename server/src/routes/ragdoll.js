import { Router } from 'express';
import pool from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';
import { buildRagdollThreadContextText } from '../services/ragdollContext.js';

const router = Router();
router.use(requireAuth);

function ragdollBaseUrl() {
  const full = process.env.RAGDOLL_BASE_URL?.trim();
  if (full) return full.replace(/\/$/, '');
  const host = process.env.RAGDOLL_HOST?.trim() || 'localhost';
  const port = process.env.RAGDOLL_PORT?.trim() || '9042';
  return `http://${host}:${port}`;
}

function ragdollCollectionGroups() {
  const raw = process.env.RAGDOLL_COLLECTIONS?.trim();
  if (!raw) return null;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

function ragdollEnabledUsernames() {
  const raw = process.env.RAGDOLL_ENABLED_USERNAMES;
  if (raw === undefined || raw === null) {
    return ['jpmoo'];
  }
  return String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

async function userMayUseRagdoll(userId) {
  const r = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
  const u = r.rows[0]?.username?.toLowerCase();
  if (!u) return false;
  return ragdollEnabledUsernames().includes(u);
}

/** RAGDoll /fetch paths only: /fetch/{group}/... no traversal */
function safeRagdollFetchPath(path) {
  if (!path || typeof path !== 'string') return null;
  const p = path.trim();
  if (!p.startsWith('/fetch/')) return null;
  if (p.includes('..') || p.includes('\0')) return null;
  const rest = p.slice('/fetch/'.length);
  if (!rest || rest.startsWith('/')) return null;
  return p;
}

router.get('/config', async (req, res) => {
  try {
    const enabled = await userMayUseRagdoll(req.userId);
    res.json({
      enabled,
      hasCollectionsOverride: ragdollCollectionGroups() != null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read RAGDoll config' });
  }
});

router.post('/relevant', async (req, res) => {
  try {
    if (!(await userMayUseRagdoll(req.userId))) {
      return res.status(403).json({ error: 'RAGDoll is not enabled for this user' });
    }
    const noteId = req.body?.noteId;
    if (!noteId) return res.status(400).json({ error: 'noteId required' });

    const includeOpts = {
      includeParent: req.body?.includeParent === true,
      includeSiblings: req.body?.includeSiblings === true,
      includeChildren: req.body?.includeChildren === true,
      includeConnected: req.body?.includeConnected !== false,
    };

    const context = await buildRagdollThreadContextText(noteId, req.userId, includeOpts);
    if (context == null) return res.status(404).json({ error: 'Note not found' });

    const base = ragdollBaseUrl();
    const groups = ragdollCollectionGroups();
    const thresholdRaw = process.env.RAGDOLL_QUERY_THRESHOLD;
    const threshold =
      thresholdRaw != null && thresholdRaw !== '' ? Number.parseFloat(thresholdRaw, 10) : undefined;

    const scopeBits = ['the selected note'];
    if (includeOpts.includeConnected) scopeBits.push('linked (connected) notes');
    if (includeOpts.includeParent) scopeBits.push('parent');
    if (includeOpts.includeSiblings) scopeBits.push('siblings');
    if (includeOpts.includeChildren) scopeBits.push('direct replies (children)');
    const scopeLine = `Included context: ${scopeBits.join(', ')}.`;

    const prompt = [
      'You are helping find reference documents related to the following short notes from a personal knowledge base.',
      scopeLine,
      'Find sources that would help understand, extend, or fact-check this material.',
      '',
      context,
    ].join('\n');

    const body = { prompt };
    if (groups?.length) body.group = groups;
    if (Number.isFinite(threshold)) body.threshold = threshold;

    const r = await fetch(`${base}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });

    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('RAGDoll query failed', r.status, t.slice(0, 500));
      return res.status(502).json({ error: 'RAGDoll query failed', status: r.status });
    }

    const data = await r.json();
    const documents = Array.isArray(data.documents) ? data.documents : [];
    const seen = new Map();
    for (const d of documents) {
      if (!d || typeof d !== 'object') continue;
      const url = d.source_url;
      const name = d.source_name || 'Untitled';
      const group = d.group || '';
      if (!url || typeof url !== 'string') continue;
      const key = `${group}\0${url}`;
      let best = 0;
      const samples = Array.isArray(d.samples) ? d.samples : [];
      for (const s of samples) {
        const sim = s?.similarity != null ? Number(s.similarity) : 0;
        if (sim > best) best = sim;
      }
      if (!seen.has(key) || best > seen.get(key).similarity) {
        seen.set(key, {
          group,
          source_name: name,
          source_url: url,
          source_summary: d.source_summary ?? null,
          similarity: best,
          sample_count: d.sample_count ?? samples.length,
        });
      }
    }
    const list = [...seen.values()].sort((a, b) => b.similarity - a.similarity);
    res.json({
      query: data.query,
      count: list.length,
      documents: list,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || 'RAGDoll request failed' });
  }
});

router.get('/fetch', async (req, res) => {
  try {
    if (!(await userMayUseRagdoll(req.userId))) {
      return res.status(403).send('Forbidden');
    }
    const path = safeRagdollFetchPath(req.query.path);
    if (!path) return res.status(400).send('Invalid path');

    const base = ragdollBaseUrl();
    const target = `${base}${path}`;
    const r = await fetch(target, { method: 'GET' });
    if (!r.ok) {
      return res.status(r.status).send(await r.text().catch(() => ''));
    }
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    const disp = r.headers.get('content-disposition');
    res.setHeader('Content-Type', ct);
    if (disp) res.setHeader('Content-Disposition', disp);
    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch (err) {
    console.error(err);
    res.status(500).send('Proxy failed');
  }
});

export default router;
