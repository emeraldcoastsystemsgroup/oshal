-- CHANGE LOG: 1 | maintainer@emeraldcoastsystemsgroup.com | Register exact directory metadata without granting identity or permissions.
BEGIN;
CREATE TABLE IF NOT EXISTS oshal_principal_registrations (
    issuer TEXT NOT NULL, user_sub TEXT NOT NULL, display_name TEXT NOT NULL, email TEXT,
    source TEXT NOT NULL CHECK(source IN ('manual','directory-snapshot')), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(issuer,user_sub));
CREATE TABLE IF NOT EXISTS oshal_roster_state (singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), revision BIGINT NOT NULL DEFAULT 0);
INSERT INTO oshal_roster_state(singleton) VALUES(TRUE) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS oshal_roster_previews (id UUID PRIMARY KEY, actor_issuer TEXT NOT NULL, actor_sub TEXT NOT NULL,
    revision BIGINT NOT NULL, payload JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL, receipt JSONB);
CREATE TABLE IF NOT EXISTS oshal_roster_audit (id UUID PRIMARY KEY, revision BIGINT UNIQUE NOT NULL,
    actor_issuer TEXT NOT NULL, actor_sub TEXT NOT NULL, reason TEXT NOT NULL, entries JSONB NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
ALTER TABLE oshal_principal_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_principal_registrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roster_control_plane ON oshal_principal_registrations;
CREATE POLICY roster_control_plane ON oshal_principal_registrations USING (current_setting('oshal.is_operator',true)='on')
      WITH CHECK(current_setting('oshal.is_operator',true)='on');
ALTER TABLE oshal_roster_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_roster_state FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roster_control_plane ON oshal_roster_state;
CREATE POLICY roster_control_plane ON oshal_roster_state USING (current_setting('oshal.is_operator',true)='on')
      WITH CHECK(current_setting('oshal.is_operator',true)='on');
ALTER TABLE oshal_roster_previews ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_roster_previews FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roster_control_plane ON oshal_roster_previews;
CREATE POLICY roster_control_plane ON oshal_roster_previews USING (current_setting('oshal.is_operator',true)='on')
      WITH CHECK(current_setting('oshal.is_operator',true)='on');
ALTER TABLE oshal_roster_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_roster_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS roster_control_plane ON oshal_roster_audit;
CREATE POLICY roster_control_plane ON oshal_roster_audit USING (current_setting('oshal.is_operator',true)='on')
      WITH CHECK(current_setting('oshal.is_operator',true)='on');
COMMIT;
