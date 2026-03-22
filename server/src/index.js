import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import notesRoutes from './routes/notes.js';
import tagsRoutes from './routes/tags.js';
import noteFilesRoutes from './routes/noteFiles.js';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { existsSync } from 'fs';
import { mountMcpHttp } from './mcpHttp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Built app uses Vite base `/hermes/` → fetches `/hermes/api/...`; normalize to `/api/...` for routing
app.use((req, _res, next) => {
  if (req.url.startsWith('/hermes/api')) {
    req.url = req.url.slice('/hermes'.length);
  }
  next();
});

// Allow Vite/React app to load (inline styles and scripts); override strict CSP from proxies
app.use((_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self' data: https://fonts.gstatic.com;"
  );
  next();
});

// API
app.use('/api/auth', authRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/tags', tagsRoutes);
app.use('/api/note-files', noteFilesRoutes);

// Health for systemd and load balancers
app.get('/health', (_, res) => res.json({ status: 'ok' }));

mountMcpHttp(app, { port: PORT });

// Serve built web app (from ../app/dist when deployed)
const webDist = path.join(__dirname, '..', '..', 'app', 'dist');
const indexPath = path.join(webDist, 'index.html');
const indexExists = existsSync(indexPath);
console.log('Hermes web root:', webDist, indexExists ? '(index.html found)' : '(index.html MISSING – run npm run build in app/)');
app.use(express.static(webDist));
// Caddy strip_prefix /hermes can send path as "" for exact /hermes; ensure we serve the app
app.get(['/', ''], (_, res, next) => {
  if (!indexExists) return res.status(503).send('App not built. Run: npm run build');
  res.sendFile(indexPath, (err) => err && next(err));
});
app.get('*', (_, res, next) => {
  if (!indexExists) return res.status(503).send('App not built. Run: npm run build');
  res.sendFile(indexPath, (err) => err && next(err));
});

const server = createServer(app);

// Optional WebSocket for real-time updates (new notes, tag approvals)
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  ws.on('message', () => {});
});
export function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(msg); });
}

server.listen(PORT, () => {
  console.log(`Hermes server listening on http://localhost:${PORT}`);
});
