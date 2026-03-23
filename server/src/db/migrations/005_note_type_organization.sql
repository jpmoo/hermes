-- Add note_type value 'organization'. Run: psql "$DATABASE_URL" -f server/src/db/migrations/005_note_type_organization.sql

ALTER TABLE notes DROP CONSTRAINT IF EXISTS notes_note_type_check;
ALTER TABLE notes
  ADD CONSTRAINT notes_note_type_check
  CHECK (note_type IN ('note', 'person', 'event', 'organization'));
