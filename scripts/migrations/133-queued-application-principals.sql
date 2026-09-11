/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Retain controller-owned immutable queue initiators independently from ticket edits.
 */
BEGIN;
CREATE TABLE IF NOT EXISTS oshal_queued_application_principals (
  ticket_id TEXT PRIMARY KEY, actor JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE oshal_queued_application_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_queued_application_principals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS queued_application_principal_control ON oshal_queued_application_principals;
CREATE POLICY queued_application_principal_control ON oshal_queued_application_principals
  USING(current_setting('oshal.is_operator',true)='on') WITH CHECK(current_setting('oshal.is_operator',true)='on');
COMMIT;
