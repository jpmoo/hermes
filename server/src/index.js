import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import authRoutes from './routes/auth.js';
import notesRoutes from './routes/notes.js';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// API
app.use('/api/auth', authRoutes);
app.use('/api/notes', notesRoutes);

// Health for systemd and load balancers
app.get('/health', (_, res) => res.json({ status: 'ok' }));

// Serve built web app (from ../app/dist when deployed)
const webDist = path.join(__dirname, '..', '..', 'app', 'dist');
app.use(express.static(webDist));
app.get('*', (_, res) => {
  res.sendFile(path.join(webDist, 'index.html'));
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
