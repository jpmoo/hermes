-- One optional full-screen background image per user (Stream fallback / Canvas). Run:
-- psql "$DATABASE_URL" -f server/src/db/migrations/009_user_background_blobs.sql

CREATE TABLE IF NOT EXISTS user_background_blobs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  mime_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  byte_size  BIGINT NOT NULL,
  data       BYTEA NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_background_blobs_user ON user_background_blobs(user_id);
