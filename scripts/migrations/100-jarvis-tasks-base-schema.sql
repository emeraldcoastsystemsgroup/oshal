-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com   | Record the lazy jarvis_tasks base table before additive migration 130 and before the role provisioner's final phase. The table was created only by ensureJarvisSchema (src/app/routes/jarvis-task-store.ts) on first use, so on a fresh database migration 060 skipped it with a NOTICE (absent table, no owner policy) and the governed bot contract could not name it: provision-app-role.mjs fails loud on any absent contract table. The bot-node recall tools now read it as oshal_bot, so it must exist, owner-policied, before provisioning. Columns, index and policy mirror ensureJarvisSchema and migration 060's user-private tier exactly; every statement is idempotent, and an existing policy is left untouched.

CREATE TABLE IF NOT EXISTS jarvis_tasks (
  id TEXT PRIMARY KEY,
  user_sub TEXT NOT NULL,
  session_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  error TEXT,
  kind TEXT DEFAULT 'simple',
  ticket_id TEXT,
  visual JSONB,
  delivered BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  summarize_started_at TIMESTAMPTZ
);

ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'simple';
ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS ticket_id TEXT;
ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS visual JSONB;
ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS delivered BOOLEAN DEFAULT FALSE;
ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS files JSONB;
ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS briefing_source_id TEXT;
ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS principal_issuer TEXT;
ALTER TABLE jarvis_tasks ADD COLUMN IF NOT EXISTS summarize_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_jarvis_tasks_user ON jarvis_tasks (user_sub, created_at DESC);

ALTER TABLE jarvis_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE jarvis_tasks FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'jarvis_tasks_owner_or_operator'
       AND polrelid = 'jarvis_tasks'::regclass
  ) THEN
    CREATE POLICY jarvis_tasks_owner_or_operator ON jarvis_tasks
      AS PERMISSIVE FOR ALL
      USING (
        user_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      )
      WITH CHECK (
        user_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      );
  END IF;
END
$$;
