# Hermes — Personal Knowledge Messenger

A note-taking system built around conversation and tree structure. Specification: `hermes_spec.pdf`.

## Structure

- **`server/`** — Node.js API (Express), PostgreSQL (pgvector), JWT auth. Serves the built web app and REST + WebSocket.
- **`app/`** — React (Vite) web app: Stream view, Outline view, Root feed, All/Starred toggle.
- **`client/`** — Electron desktop app that loads the web app from the server (or dev Vite server).
- **`deploy/`** — systemd unit and deployment notes for headless Ubuntu.

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

## License

Private / unlicensed unless specified otherwise.
