-- First-page PDF thumbnails for attachment tiles (Stream, etc.).
-- Run: cd server && npm run db:apply-migrations
-- Or: psql "$DATABASE_URL" -f server/src/db/migrations/013_note_file_blobs_pdf_thumbnail.sql

ALTER TABLE note_file_blobs
  ADD COLUMN IF NOT EXISTS thumbnail_mime TEXT,
  ADD COLUMN IF NOT EXISTS thumbnail_data BYTEA;
