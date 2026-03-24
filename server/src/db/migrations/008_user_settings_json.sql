-- Per-user UI preferences (JSON). Safe to run multiple times.
ALTER TABLE users ADD COLUMN IF NOT EXISTS settings_json JSONB NOT NULL DEFAULT '{}'::jsonb;
