# Hermes — Personal Knowledge Messenger

A note-taking system built around conversation and tree structure. Specification: `hermes_spec.pdf`.

## Structure

- **`server/`** — Node.js API (Express), PostgreSQL (pgvector), JWT auth, embedding + AI tag pipeline, queue, semantic search. Serves the built web app and REST + WebSocket.
- **`app/`** — React (Vite) web app: **Stream** (thread list + in-thread view on one page, `?thread=`), Outline, Tag view, queue, search, etc.
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
| Inherit parent tags from note UI; complements on approve | Done |
| Tag relationships (exclusion, complement) API | Done |
| Flat / Tag view (filter by tags, AND/OR) | Done |
| Queue: resubmit tagless notes for AI suggestions | Done |
| Semantic search API | Done |
| Edit / delete notes (delete with confirm, cascade) | Done |
| MCP server for Claude | Done |
| Telegram bot (basic capture + commands) | Stub |
| Regions view (spatial clusters by embedding) | Not yet |
| Tag Canvas (graph of tags + edges) | Not yet |
| Attachments (BYTEA in DB, Stream upload, `POST /api/notes/:id/attachments` multipart) | Done |
| external_anchor (API field; optional link to ticket/URL outside Hermes) | API only; UI field not yet |
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

   **Check Ollama + embeddings on the host** (from `server/` with `.env` present):

   ```bash
   ./scripts/check-hermes-embeddings.sh
   ```

   Verifies Ollama is reachable, the embed model is installed, a live `/api/embed` call works, and how many notes have `embedding IS NOT NULL` vs missing. Needs `curl`, `psql`, and ideally `jq`.

   **Semantic search** combines **substring matches** with **vector similarity**, so exact words (e.g. “Yup”) still rank at the top even when dense embeddings alone would miss them. For **Nomic** models, optional **`HERMES_EMBED_NOMIC_PREFIXES=1`** uses `search_document:` / `search_query:` as intended; after turning that on, run once from `server/`: **`npm run reembed`** so existing note vectors match query embeddings.

3. **Web app (dev)**

   ```bash
   cd app && npm install && npm run dev
   ```

   Open http://localhost:5173 (proxies API to :3000). **Stream** is the home page: thread list + composer at bottom; open a thread with `?thread=<root-id>` (old `/thread/:id` URLs redirect there).

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
- **`POST /api/notes/:id/attachments`** — **multipart/form-data**, field name **`files`** (one or more parts, up to 20 per request). Same as the web Stream UI. **`Authorization: Bearer <jwt>`** required. Use this for **large images/PDFs**; no base64, streams straight into Postgres. Max size per file: `HERMES_MAX_ATTACHMENT_BYTES` (default 20MB).
- `PATCH /api/notes/:id` — update `{ content?, starred?, external_anchor? }`
- `POST /api/notes/:id/star`, `DELETE /api/notes/:id/star`
- `GET /api/tags` (all tags for typeahead), `GET /api/tags?in_use=1` (tags with ≥1 approved use on your notes — Tags page), `POST /api/tags`, relationships endpoints
- `GET /api/notes/search-by-tags?tagIds=...&mode=and|or`, `GET /api/notes/search-semantic?q=...` (hybrid text + semantic; 503 only if Ollama fails and nothing matches the substring)
- `GET /api/notes/search-content?q=...` — substring search in note text (no Ollama)
- `GET /api/queue?minConfidence=`, `GET /api/queue/count`, `POST /api/queue/:id/approve`, `POST /api/queue/:id/reject`
- `GET /api/note-files/orphans` — blobs with missing note; `DELETE /api/note-files/orphans/:id` — remove orphan (web: **Orphans**)

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

### Attachments (MCP vs REST)

**Why big uploads feel slow via MCP:** Tool arguments are **JSON**. Every file must be **base64** in that payload (Claude → MCP → Hermes). A 600KB image becomes ~800KB+ of text, parsed twice, and is the wrong shape for bulk binary. **Hermes already exposes the right path: direct HTTP multipart.**

**Recommended for images or files ≳100KB**

1. Create the note with MCP (**`hermes_create_note`**) text-only; copy the returned **`id`**.
2. Upload with **multipart** (not MCP), same JWT as the app:

```bash
export TOKEN="…"   # same JWT as hermes_token / HERMES_MCP_TOKEN
export NOTE_ID="uuid-from-step-1"
curl -sS -X POST "${HERMES_URL}/api/notes/${NOTE_ID}/attachments" \
  -H "Authorization: Bearer ${TOKEN}" \
  -F "files=@/path/to/photo.jpg"
```

**URL format (replace `{note_id}` with the UUID from `hermes_create_note`):**

| How you reach Hermes | Full upload URL |
|----------------------|-----------------|
| Web app at `https://HOST/hermes/` (default Vite base) | `https://HOST/hermes/api/notes/{note_id}/attachments` |
| API only on laptop | `http://127.0.0.1:3000/api/notes/{note_id}/attachments` |

There is **no** separate “upload microservice” path—only this route under `/api/notes/…`.

**Why Claude often can’t “just POST” the file:** Tools that run **inside Claude’s sandbox** (code execution, browser upload, etc.) usually have **no network** to your Tailscale host or `localhost`. Multipart from there will fail. **Workarounds:** run **`curl`** (or the web UI) **on your own machine**, or use **`hermes_attach_files`** for smaller files (MCP → Hermes server decodes base64; that path does not need Claude’s container to reach your API).

Optional: set **`HERMES_PUBLIC_API_URL`** in `server/.env` so MCP tool **`hermes_attachment_upload_help`** prints your exact base URL.

**Small files / automation-only:** **`hermes_attach_files`** / **`hermes_add_attachments`** — **`note_id`** + **`files`**: `[{ "base64": "…", "filename": "x.png", "mime_type": "image/png" }]` (up to 20). The server decodes and POSTs multipart internally; the slow part is still **getting** that base64 through MCP JSON.

**One-step with attachment in MCP:** **`hermes_create_note`** may include **`attachments`** / **`files`** (same base64 shape); fine for tiny assets, not ideal for large photos.

**Reading files:** **`hermes_get_thread`** / feed responses include per-note **`attachments`** (metadata: id, filename, mime_type, byte_size). Download uses the authenticated note-file API in the web app; MCP returns metadata only unless you add a dedicated fetch tool later.

**Orphan blobs** (note deleted but file row left): **`hermes_list_orphan_attachments`**, then **`hermes_delete_orphan_attachment`** with **`blob_id`** (same as web **Orphans** and `GET/DELETE /api/note-files/orphans`).

### external_anchor

Optional string on create/update note: **stable reference outside Hermes** (e.g. Jira ticket URL, Linear issue id, Google Doc id). It is stored and returned in JSON from the API and threads; the **web UI does not show a dedicated field yet** — useful for bots, MCP, or future UI.

**Tool for “what are my top-level notes?”** → **`hermes_get_root_feed`** (lists root threads like the Feed view). If Claude says “authorization error” on any Hermes tool, the JWT is missing or expired — set **`HERMES_MCP_TOKEN`** and restart (see above).

**Claude Desktop (local):** Set `HERMES_API_URL` and `HERMES_MCP_TOKEN`, then `cd mcp && npm install && node server.js` (stdio) and register that command in Claude’s MCP config.

## Telegram bot

`cd telegram && npm install`. Set `TELEGRAM_BOT_TOKEN` and `HERMES_API_URL`, `HERMES_MCP_TOKEN` (or token from login). Run `node bot.js`. Send a message to create a root note; `/thread Title` to start a thread; `/tags` to see pending queue.

## License

Private / unlicensed unless specified otherwise.
