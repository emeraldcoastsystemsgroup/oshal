/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add exact-principal briefing preferences and durable source ownership/announcement cursors.
 */
BEGIN;
CREATE TABLE IF NOT EXISTS jarvis_briefing_sources (
  source_id TEXT PRIMARY KEY, app TEXT NOT NULL, session_id TEXT NOT NULL UNIQUE,
  definition JSONB NOT NULL, active BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS jarvis_briefing_preferences (
  principal_issuer TEXT NOT NULL, user_sub TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES jarvis_briefing_sources(source_id),
  preference JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(principal_issuer,user_sub,source_id)
);
CREATE TABLE IF NOT EXISTS jarvis_briefing_cursors (
  principal_issuer TEXT NOT NULL, user_sub TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES jarvis_briefing_sources(source_id),
  last_announced_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(principal_issuer,user_sub,source_id)
);
ALTER TABLE jarvis_briefing_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE jarvis_briefing_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE jarvis_briefing_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE jarvis_briefing_preferences FORCE ROW LEVEL SECURITY;
ALTER TABLE jarvis_briefing_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE jarvis_briefing_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS briefing_source_control_plane ON jarvis_briefing_sources;
CREATE POLICY briefing_source_control_plane ON jarvis_briefing_sources USING (current_setting('oshal.is_operator',true)='on') WITH CHECK(current_setting('oshal.is_operator',true)='on');
DROP POLICY IF EXISTS briefing_preference_control_plane ON jarvis_briefing_preferences;
CREATE POLICY briefing_preference_control_plane ON jarvis_briefing_preferences USING (current_setting('oshal.is_operator',true)='on') WITH CHECK(current_setting('oshal.is_operator',true)='on');
DROP POLICY IF EXISTS briefing_cursor_control_plane ON jarvis_briefing_cursors;
CREATE POLICY briefing_cursor_control_plane ON jarvis_briefing_cursors USING (current_setting('oshal.is_operator',true)='on') WITH CHECK(current_setting('oshal.is_operator',true)='on');
ALTER TABLE IF EXISTS jarvis_tasks ADD COLUMN IF NOT EXISTS briefing_source_id TEXT;
ALTER TABLE IF EXISTS jarvis_tasks ADD COLUMN IF NOT EXISTS principal_issuer TEXT;
COMMIT;
