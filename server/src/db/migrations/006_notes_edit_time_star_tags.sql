-- Star / tag-only changes must not move note edit time (updated_at).
-- Automated body scrubs (strip #tag / mentions) restore prior timestamps via a second UPDATE.
-- Run: psql "$DATABASE_URL" -f server/src/db/migrations/006_notes_edit_time_star_tags.sql

CREATE OR REPLACE FUNCTION notes_updated()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content
     OR NEW.external_anchor IS DISTINCT FROM OLD.external_anchor
     OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
     OR NEW.note_type IS DISTINCT FROM OLD.note_type
     OR NEW.event_start_at IS DISTINCT FROM OLD.event_start_at
     OR NEW.event_end_at IS DISTINCT FROM OLD.event_end_at THEN
    NEW.updated_at = now();
    NEW.last_activity_at = now();
  ELSE
    IF NEW.updated_at IS DISTINCT FROM OLD.updated_at
       OR NEW.last_activity_at IS DISTINCT FROM OLD.last_activity_at THEN
      NULL;
    ELSE
      NEW.updated_at := OLD.updated_at;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
