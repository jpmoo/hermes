-- File attachments stored in PostgreSQL (BYTEA). Run: psql "$DATABASE_URL" -f server/src/db/migrations/003_note_file_blobs.sql

CREATE TABLE IF NOT EXISTS note_file_blobs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id    UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  mime_type  TEXT NOT NULL DEFAULT 'application/octet-stream',
  byte_size  BIGINT NOT NULL,
  data       BYTEA NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_note_file_blobs_note ON note_file_blobs(note_id);
CREATE INDEX IF NOT EXISTS idx_note_file_blobs_user ON note_file_blobs(user_id);
