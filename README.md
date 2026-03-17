# Hermes — Personal Knowledge Messenger

A note-taking system built around conversation and tree structure. Specification: `hermes_spec.pdf`.

## Structure

- **`server/`** — Node.js API (Express), PostgreSQL (pgvector), JWT auth, embedding + AI tag pipeline, queue, semantic search. Serves the built web app and REST + WebSocket.
- **`app/`** — React (Vite) web app: Stream, Outline, Root feed, **Tag/Flat view**, **Approval queue**, All/Starred toggle, edit/delete notes, tags on notes.
- **`client/`** — Electron desktop app that loads the web app from the server (or dev Vite server).
- **`mcp/`** — MCP server for Claude: `hermes_create_note`, `hermes_get_thread`, `hermes_search_semantic`, `hermes_search_tags`, `hermes_get_queue`, `hermes_approve_tag`, `hermes_star_note`, `hermes_get_starred`, `hermes_get_root_feed`.
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
| Attachments + external_anchor in UI | Not yet |
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

Set `HERMES_API_URL` and `HERMES_MCP_TOKEN` (JWT from login). Run: `cd mcp && npm install && node server.js` (stdio). Add to Claude Desktop config as an MCP server.

## Telegram bot

`cd telegram && npm install`. Set `TELEGRAM_BOT_TOKEN` and `HERMES_API_URL`, `HERMES_MCP_TOKEN` (or token from login). Run `node bot.js`. Send a message to create a root note; `/thread Title` to start a thread; `/tags` to see pending queue.

## License

Private / unlicensed unless specified otherwise.
