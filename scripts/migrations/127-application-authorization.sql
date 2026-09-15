/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add ADR-149 application permission contracts, policy persistence and isolated enforcement verification.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Drop the top-level BEGIN;/COMMIT; pair: the migration runner wraps each file and its app_migrations history INSERT in one transaction on one client, so the file-level COMMIT ended that transaction early and left the history row outside it. Every statement here runs inside a transaction block, so no no-transaction pragma is needed.
 */
-- ADR-149 application authorization control plane. Apply as schema owner; no business-data grants.
CREATE TABLE IF NOT EXISTS oshal_authorization_state (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), revision BIGINT NOT NULL DEFAULT 0 CHECK(revision>=0));
INSERT INTO oshal_authorization_state(singleton,revision) VALUES(TRUE,0) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS oshal_authorization_assignments (id TEXT PRIMARY KEY, payload JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS oshal_authorization_previews (id TEXT PRIMARY KEY, payload JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS oshal_authorization_audit (id TEXT PRIMARY KEY, revision BIGINT NOT NULL, payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS oshal_authorization_applications (app_name TEXT PRIMARY KEY, protected BOOLEAN NOT NULL, agent_ids TEXT[] NOT NULL DEFAULT '{}', tool_names TEXT[] NOT NULL DEFAULT '{}');
ALTER TABLE oshal_authorization_applications ADD COLUMN IF NOT EXISTS tool_names TEXT[] NOT NULL DEFAULT '{}';
DO $policy$
DECLARE suffix TEXT;
BEGIN
  FOREACH suffix IN ARRAY ARRAY['state','assignments','previews','audit','applications'] LOOP
    EXECUTE format('ALTER TABLE oshal_authorization_%I ENABLE ROW LEVEL SECURITY', suffix);
    EXECUTE format('ALTER TABLE oshal_authorization_%I FORCE ROW LEVEL SECURITY', suffix);
    EXECUTE format('DROP POLICY IF EXISTS authorization_control_plane ON oshal_authorization_%I', suffix);
    EXECUTE format('CREATE POLICY authorization_control_plane ON oshal_authorization_%I USING (current_setting(''oshal.is_operator'',true)=''on'') WITH CHECK (current_setting(''oshal.is_operator'',true)=''on'')', suffix);
  END LOOP;
END
$policy$;
