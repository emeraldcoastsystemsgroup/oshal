-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Data-lifecycle retained audit: one row per /api/me export or executed two-step delete, with the per-store outcomes JSON. The DELETE rows are the durable record that an account's data was removed and what each store reported — they deliberately SURVIVE the deletion itself (the exporter registry never includes this table). RLS owner-or-operator, mirroring 068-visual-response-artifacts.

BEGIN;

CREATE TABLE IF NOT EXISTS data_lifecycle_audit (
  id             BIGSERIAL PRIMARY KEY,
  user_sub       TEXT NOT NULL,                    -- whose data was exported/deleted (retained after deletion by design)
  user_email     TEXT,                             -- human-readable identity at execution time (the sub may become meaningless later)
  action         VARCHAR(16) NOT NULL CHECK (action IN ('export', 'delete')),
  outcomes       JSONB NOT NULL DEFAULT '[]'::jsonb, -- per-store results: [{store, action|ok, deleted|count, reason|error}]
  stores_deleted INTEGER NOT NULL DEFAULT 0,
  stores_skipped INTEGER NOT NULL DEFAULT 0,       -- export-only stores, honestly flagged with their reason in outcomes
  stores_failed  INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_data_lifecycle_audit_user
  ON data_lifecycle_audit (user_sub, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_lifecycle_audit_created
  ON data_lifecycle_audit (created_at DESC);

ALTER TABLE data_lifecycle_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_lifecycle_audit FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'data_lifecycle_audit_owner_or_operator'
      AND polrelid = 'data_lifecycle_audit'::regclass
  ) THEN
    CREATE POLICY data_lifecycle_audit_owner_or_operator ON data_lifecycle_audit
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
