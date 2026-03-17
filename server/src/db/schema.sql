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
  embedding       vector(768),  -- nomic-embed-text default dimension; adjust if different model
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notes_parent ON notes(parent_id);
CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_last_activity ON notes(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_starred ON notes(starred) WHERE starred = true;
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

-- Trigger: bump updated_at only on real edits (not when ancestors get last_activity_at from replies)
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

DROP TRIGGER IF EXISTS notes_updated_trigger ON notes;
CREATE TRIGGER notes_updated_trigger
  BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE PROCEDURE notes_updated();

-- Bubble last_activity_at up to root for root-feed ordering
CREATE OR REPLACE FUNCTION notes_activity_propagate()
RETURNS TRIGGER AS $$
DECLARE
  pid UUID;
BEGIN
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
