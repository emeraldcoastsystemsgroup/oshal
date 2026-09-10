-- CHANGE LOG
-- SEQ | AUTHOR | DESCRIPTION
-- 1 | Codex | Dedicated Home display preferences on the existing owner-RLS preference table.
ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS home_dashboard JSONB NOT NULL DEFAULT '{"version":1}'::jsonb,
  ADD COLUMN IF NOT EXISTS home_revision INTEGER NOT NULL DEFAULT 0;
