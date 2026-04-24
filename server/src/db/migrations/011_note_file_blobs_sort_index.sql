-- Per-note display order for file attachments (Stream / NoteCard thumbnails).
-- Run: psql "$DATABASE_URL" -f server/src/db/migrations/011_note_file_blobs_sort_index.sql

ALTER TABLE note_file_blobs ADD COLUMN IF NOT EXISTS sort_index INTEGER NOT NULL DEFAULT 0;

UPDATE note_file_blobs f
SET sort_index = s.rn
FROM (
  SELECT id, (ROW_NUMBER() OVER (PARTITION BY note_id ORDER BY created_at ASC, id ASC) - 1)::int AS rn
  FROM note_file_blobs
) s
WHERE f.id = s.id;
