/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add durable owner-scoped image artifacts for fact-locked visual responses.
 */

BEGIN;

CREATE TABLE IF NOT EXISTS visual_response_artifacts (
  artifact_id UUID PRIMARY KEY,
  user_sub TEXT NOT NULL,
  source_surface TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  alt_text TEXT NOT NULL,
  content BYTEA NOT NULL,
  content_sha256 TEXT NOT NULL,
  provenance JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_sub, source_surface, source_job_id)
);

CREATE INDEX IF NOT EXISTS visual_response_artifacts_session
  ON visual_response_artifacts (user_sub, source_session_id, created_at DESC);

ALTER TABLE visual_response_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE visual_response_artifacts FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'visual_response_artifacts_owner_or_operator'
      AND polrelid = 'visual_response_artifacts'::regclass
  ) THEN
    CREATE POLICY visual_response_artifacts_owner_or_operator ON visual_response_artifacts
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
END $$;

COMMIT;
