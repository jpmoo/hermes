-- Run once on existing DBs: psql $DATABASE_URL -f server/src/db/migrations/002_notes_updated_at.sql
CREATE OR REPLACE FUNCTION notes_updated()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content
     OR NEW.starred IS DISTINCT FROM OLD.starred
     OR NEW.external_anchor IS DISTINCT FROM OLD.external_anchor
     OR NEW.parent_id IS DISTINCT FROM OLD.parent_id THEN
    NEW.updated_at = now();
    NEW.last_activity_at = now();
  ELSE
    NEW.updated_at = OLD.updated_at;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
