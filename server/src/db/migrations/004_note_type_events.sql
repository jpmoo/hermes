-- Note kind (note | person | event) and optional event window. Run: psql "$DATABASE_URL" -f server/src/db/migrations/004_note_type_events.sql

ALTER TABLE notes
  ADD COLUMN IF NOT EXISTS note_type TEXT NOT NULL DEFAULT 'note'
    CHECK (note_type IN ('note', 'person', 'event')),
  ADD COLUMN IF NOT EXISTS event_start_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS event_end_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_notes_note_type ON notes(note_type);

CREATE OR REPLACE FUNCTION notes_updated()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content
     OR NEW.starred IS DISTINCT FROM OLD.starred
     OR NEW.external_anchor IS DISTINCT FROM OLD.external_anchor
     OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.note_type IS DISTINCT FROM OLD.note_type
     OR NEW.event_start_at IS DISTINCT FROM OLD.event_start_at
     OR NEW.event_end_at IS DISTINCT FROM OLD.event_end_at THEN
    NEW.updated_at = now();
    NEW.last_activity_at = now();
  ELSE
    NEW.updated_at = OLD.updated_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
