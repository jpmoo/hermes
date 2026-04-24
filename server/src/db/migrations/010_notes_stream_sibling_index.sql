-- Manual sibling order for Stream / Outline (nullable = fall back within manual mode)
ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS stream_sibling_index INTEGER NULL;

CREATE INDEX IF NOT EXISTS idx_notes_parent_stream_sibling
  ON notes (parent_id, stream_sibling_index)
  WHERE parent_id IS NOT NULL;
