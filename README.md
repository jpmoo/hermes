# Hermes — Personal Knowledge Messenger

A note-taking system built around conversation and tree structure. Specification: `hermes_spec.pdf`.

## Structure

- **`server/`** — Node.js API (Express), PostgreSQL (pgvector), JWT auth, embedding + AI tag pipeline, queue, semantic search. Serves the built web app and REST + WebSocket.
- **`app/`** — React (Vite) web app: Stream, Outline, Root feed, **Tag/Flat view**, **Approval queue**, All/Starred toggle, edit/delete notes, tags on notes.
- **`client/`** — Electron desktop app that loads the web app from the server (or dev Vite server).
- **`mcp/`** — Optional stdio MCP for Claude Desktop. The main server also exposes **Streamable HTTP MCP** at **`/mcp`** (same tools).
- **`telegram/`** — Telegram bot (capture messages as notes; `/thread`, `/reply`, `/star`, `/tags`).
- **`deploy/`** — systemd unit and deployment notes for headless Ubuntu.

## Spec implementation (from hermes_spec.pdf)

| Feature | Status |
|--------|--------|
| Notes CRUD, threading, root feed | Done |
| Starred notes, All/Starred toggle | Done |
| Embedding pipeline (Ollama → pgvector) | Done |
| AI tag proposals on save (Ollama) | Done |
| Approval queue (API + UI: slider, approve/reject, context) | Done |
| Tag inheritance on approve + complement-triggered | Done |
| Tag relationships (exclusion, complement) API | Done |
| Flat / Tag view (filter by tags, AND/OR) | Done |
| Semantic search API | Done |
| Edit / delete notes (delete with confirm, cascade) | Done |
| MCP server for Claude | Done |
| Telegram bot (basic capture + commands) | Stub |
| Regions view (spatial clusters by embedding) | Not yet |
| Tag Canvas (graph of tags + edges) | Not yet |
| Attachments (BYTEA in DB, Stream upload, clickable URLs) | Done |
| external_anchor in UI | Not yet |
| Suggested threading / duplicate / orphan rescue | Not yet |

## Quick start (local)

1. **PostgreSQL + pgvector**

   Create a DB and run the schema:

   ```bash
   createdb hermes
   psql hermes -c 'CREATE EXTENSION IF NOT EXISTS vector;'
   # From repo root: create .env in server/ then migrate (migrate runs npm install in server)
   cp server/.env.example server/.env
   # Edit server/.env: set DATABASE_URL and JWT_SECRET
   npm run db:migrate
   # If you already migrated before: fix parent edited-time when replies are added
   psql "$DATABASE_URL" -f server/src/db/migrations/002_notes_updated_at.sql
   psql "$DATABASE_URL" -f server/src/db/migrations/003_note_file_blobs.sql
   ```

2. **Server**

   ```bash
   cd server && npm install && npm start
   ```

3. **Web app (dev)**

   ```bash
   cd app && npm install && npm run dev
   ```

   Open http://localhost:5173 (proxies API to :3000).

4. **Electron (optional)**

   With server and web app running (or server only on :3000 with app built):

   ```bash
   cd client && npm install && npm run dev
   ```

   In production, set `HERMES_SERVER_URL` to your server (e.g. `https://hermes.example.com`) so the client loads that origin.

## Headless Ubuntu server (as a service)

1. Install Node 18+, PostgreSQL with pgvector, and clone/copy the repo to e.g. `/opt/hermes`.

2. Create user and env:

   ```bash
   sudo useradd -r -s /bin/false hermes
   sudo mkdir -p /opt/hermes
   sudo cp -r server app client deploy /opt/hermes/
   sudo cp server/.env.example /opt/hermes/server/.env
   sudo nano /opt/hermes/server/.env   # set PORT, DATABASE_URL, JWT_SECRET
   sudo chown -R hermes:hermes /opt/hermes
   ```

3. Install dependencies and build app:

   ```bash
   cd /opt/hermes/server && sudo -u hermes npm install
   cd /opt/hermes/app && sudo -u hermes npm install && sudo -u hermes npm run build
   ```

4. Database:

   ```bash
   sudo -u postgres createuser hermes
   sudo -u postgres createdb -O hermes hermes
   sudo -u postgres psql hermes -c 'CREATE EXTENSION IF NOT EXISTS vector;'
   cd /opt/hermes/server && sudo -u hermes npm run db:migrate
   ```

5. Install and enable systemd service:

   ```bash
   sudo cp /opt/hermes/deploy/hermes.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable hermes
   sudo systemctl start hermes
   sudo systemctl status hermes
   ```

6. Put a reverse proxy (e.g. nginx) in front of `http://127.0.0.1:3000` for HTTPS and host the web app + API there. The Electron **client** runs on your desktop and points to that URL via `HERMES_SERVER_URL`.

## API (high level)

- `POST /api/auth/register` — `{ username, password }`
- `POST /api/auth/login` — `{ username, password }` → `{ token, user }`
- `GET /api/notes/roots?starred=true|false` — root feed (requires `Authorization: Bearer <token>`)
- `GET /api/notes/thread/:id?starred=` — full thread
- `POST /api/notes` — create note `{ content, parent_id?, external_anchor? }`
- `PATCH /api/notes/:id` — update `{ content?, starred?, external_anchor? }`
- `POST /api/notes/:id/star`, `DELETE /api/notes/:id/star`
- `GET /api/tags`, `POST /api/tags`, `GET /api/tags/relationships`, `POST /api/tags/relationships`
- `GET /api/notes/search-by-tags?tagIds=...&mode=and|or`, `GET /api/notes/search-semantic?q=...`
- `GET /api/queue?minConfidence=`, `GET /api/queue/count`, `POST /api/queue/:id/approve`, `POST /api/queue/:id/reject`

## MCP (Claude)

**Why a bare URL failed before:** Only **stdio** lived in `mcp/server.js`. Reverse-proxying to Hermes hit the web app, not MCP. The API server now serves **Streamable HTTP MCP** at **`/mcp`**.

**Remote URL (e.g. Tailscale + Caddy):** e.g.  
`https://home-server.tailxxxx.ts.net/hermes/mcp`  
(Caddy should strip `/hermes` so the backend path is `/mcp`.)

### Authenticating Hermes MCP (who am I when tools run?)

Tools call your Hermes REST API **as a specific user**. That user is determined by the JWT:

1. **`Authorization: Bearer <jwt>`** on each MCP HTTP request — if Claude’s connector lets you add **custom headers**, set this to the same token the web app uses after login.
2. **`HERMES_MCP_TOKEN` in `server/.env`** — if no `Authorization` header is sent, the server uses this JWT for all tool API calls. Easiest for connectors that only accept a URL: log in once in the browser, copy the token (see below), put it in `HERMES_MCP_TOKEN`, restart Hermes.

**Get a JWT from the web app:** Log in at Hermes → DevTools → Application → Local Storage → key **`hermes_token`** (or call `POST /api/auth/login` with your username/password and use `token` from the JSON).

**Security:** Anyone who can reach `/mcp` and present a valid token (or who hits your server while `HERMES_MCP_TOKEN` is set) can act as that user. Prefer Tailscale/restricted access; rotate the token by logging in again and updating env.

### If Claude “connects” but shows no Hermes tools

The MCP spec requires clients to send an `Accept` header listing both `application/json` and `text/event-stream`. Many clients send `*/*` only; the server now normalizes `Accept` and uses **JSON responses** for MCP POSTs so remote connectors can list tools reliably. **Redeploy/restart** the Hermes server after updating. Claude’s own `web_fetch` to your MCP URL will still fail — that’s normal; tools use the MCP channel, not a browser GET.

**Claude Desktop (local):** Set `HERMES_API_URL` and `HERMES_MCP_TOKEN`, then `cd mcp && npm install && node server.js` (stdio) and register that command in Claude’s MCP config.

## Telegram bot

`cd telegram && npm install`. Set `TELEGRAM_BOT_TOKEN` and `HERMES_API_URL`, `HERMES_MCP_TOKEN` (or token from login). Run `node bot.js`. Send a message to create a root note; `/thread Title` to start a thread; `/tags` to see pending queue.

## License

Private / unlicensed unless specified otherwise.
