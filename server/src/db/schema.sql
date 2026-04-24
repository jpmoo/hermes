-- Hermes — PostgreSQL schema + pgvector
-- Run once: psql $DATABASE_URL -f server/src/db/schema.sql
-- Or use: npm run db:migrate (in server)

CREATE EXTENSION IF NOT EXISTS vector;

-- Optional: single-user v1; add users table if multi-user later
CREATE TABLE IF NOT EXISTS users (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username   TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Notes: atomic unit, optional parent for threading
CREATE TABLE IF NOT EXISTS notes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id       UUID REFERENCES notes(id) ON DELETE CASCADE,
  content         TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  last_activity_at TIMESTAMPTZ DEFAULT now(),
  starred         BOOLEAN DEFAULT false,
  external_anchor TEXT,
  note_type       TEXT NOT NULL DEFAULT 'note' CHECK (note_type IN ('note', 'person', 'event', 'organization')),
  event_start_at  TIMESTAMPTZ,
  event_end_at    TIMESTAMPTZ,
  stream_sibling_index INTEGER NULL,
  embedding       vector(768),  -- nomic-embed-text default dimension; adjust if different model
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notes_parent ON notes(parent_id);
CREATE INDEX IF NOT EXISTS idx_notes_parent_stream_sibling ON notes (parent_id, stream_sibling_index) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_last_activity ON notes(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_starred ON notes(starred) WHERE starred = true;
CREATE INDEX IF NOT EXISTS idx_notes_note_type ON notes(note_type);
-- ivfflat index for semantic search (create after table has rows, or use lists = 1 for empty)
-- CREATE INDEX idx_notes_embedding ON notes USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Attachments
CREATE TABLE IF NOT EXISTS attachments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id    UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  file_path  TEXT NOT NULL,
  mime_type  TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_attachments_note ON attachments(note_id);

-- In-DB file blobs per note (Stream attachments, etc.)
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

-- Optional account background image (Stream default / Canvas)
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

-- Tags (governed vocabulary)
CREATE TABLE IF NOT EXISTS tags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  approved   BOOLEAN DEFAULT true
);

-- Tag relationships: exclusion | complement
CREATE TABLE IF NOT EXISTS tag_relationships (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tag_a_id         UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  tag_b_id         UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('exclusion', 'complement')),
  UNIQUE(tag_a_id, tag_b_id)
);

-- Note–tag join with source and approval status
CREATE TABLE IF NOT EXISTS note_tags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id    UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  tag_id     UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source     TEXT NOT NULL CHECK (source IN ('user', 'ai', 'inherited', 'complement')),
  confidence FLOAT,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('approved', 'pending', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(note_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_note_tags_note ON note_tags(note_id);
CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_note_tags_status ON note_tags(status) WHERE status = 'pending';

-- Links between notes (stored as one directed row; API treats as undirected — each note sees the other)
CREATE TABLE IF NOT EXISTS note_connections (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  anchor_note_id   UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  linked_note_id   UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ DEFAULT now(),
  CHECK (anchor_note_id <> linked_note_id),
  UNIQUE (user_id, anchor_note_id, linked_note_id)
);

CREATE INDEX IF NOT EXISTS idx_note_connections_anchor ON note_connections(anchor_note_id);
CREATE INDEX IF NOT EXISTS idx_note_connections_linked ON note_connections(linked_note_id);
CREATE INDEX IF NOT EXISTS idx_note_connections_user ON note_connections(user_id);

-- Two rows per scrub transaction: skip activity propagation for the content UPDATE and for the
-- timestamp-restore UPDATE (connection/tag unlink body cleanup).
CREATE TABLE IF NOT EXISTS note_propagate_suppress (
  id BIGSERIAL PRIMARY KEY,
  note_id UUID NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_propagate_suppress_note_id ON note_propagate_suppress (note_id);

-- Trigger: bump updated_at only on real edits (not when ancestors get last_activity_at from replies)
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

DROP TRIGGER IF EXISTS notes_updated_trigger ON notes;
CREATE TRIGGER notes_updated_trigger
  BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE PROCEDURE notes_updated();

-- Bubble last_activity_at up to thread ancestors when a note changes in a user-visible way.
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

DROP TRIGGER IF EXISTS notes_activity_trigger ON notes;
CREATE TRIGGER notes_activity_trigger
  AFTER INSERT OR UPDATE ON notes
  FOR EACH ROW EXECUTE PROCEDURE notes_activity_propagate();

-- User preferences (e.g. note-type colors); see migrations/008_user_settings_json.sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS settings_json JSONB NOT NULL DEFAULT '{}'::jsonb;
