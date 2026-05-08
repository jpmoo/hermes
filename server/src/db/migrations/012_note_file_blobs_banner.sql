-- Mark one image attachment per note as its banner/header image.
-- Run: psql "$DATABASE_URL" -f server/src/db/migrations/012_note_file_blobs_banner.sql

ALTER TABLE note_file_blobs
  ADD COLUMN IF NOT EXISTS is_banner BOOLEAN NOT NULL DEFAULT false;

-- Keep at most one banner attachment per note.
CREATE UNIQUE INDEX IF NOT EXISTS idx_note_file_blobs_one_banner_per_note
  ON note_file_blobs (note_id)
  WHERE is_banner = true;
