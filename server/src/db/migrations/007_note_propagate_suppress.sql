-- Skip bubbling last_activity_at for automated body scrubs (two UPDATEs per note) and for embedding-only updates.
-- Run: psql "$DATABASE_URL" -f server/src/db/migrations/007_note_propagate_suppress.sql

DROP TABLE IF EXISTS note_propagate_suppress;
CREATE TABLE note_propagate_suppress (
  id BIGSERIAL PRIMARY KEY,
  note_id UUID NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_propagate_suppress_note_id ON note_propagate_suppress (note_id);

CREATE OR REPLACE FUNCTION notes_activity_propagate()
RETURNS TRIGGER AS $$
DECLARE
  pid UUID;
  suppressed_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.content IS NOT DISTINCT FROM OLD.content
       AND NEW.parent_id IS NOT DISTINCT FROM OLD.parent_id
       AND NEW.external_anchor IS NOT DISTINCT FROM OLD.external_anchor
       AND NEW.note_type IS NOT DISTINCT FROM OLD.note_type
       AND NEW.event_start_at IS NOT DISTINCT FROM OLD.event_start_at
       AND NEW.event_end_at IS NOT DISTINCT FROM OLD.event_end_at
       AND NEW.starred IS NOT DISTINCT FROM OLD.starred
       AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at
       AND NEW.last_activity_at IS NOT DISTINCT FROM OLD.last_activity_at
       AND NEW.embedding IS DISTINCT FROM OLD.embedding THEN
      RETURN NEW;
    END IF;

    DELETE FROM note_propagate_suppress
    WHERE id = (SELECT id FROM note_propagate_suppress WHERE note_id = NEW.id ORDER BY id LIMIT 1)
    RETURNING note_id INTO suppressed_id;
    IF suppressed_id IS NOT NULL THEN
      RETURN NEW;
    END IF;
  END IF;

  pid := NEW.parent_id;
  WHILE pid IS NOT NULL LOOP
    UPDATE notes SET last_activity_at = now() WHERE id = pid;
    SELECT parent_id INTO pid FROM notes WHERE id = pid;
  END LOOP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
