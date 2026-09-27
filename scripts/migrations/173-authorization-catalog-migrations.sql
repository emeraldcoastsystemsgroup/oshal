/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | AUTH-07 reviewed catalog migration control plane. oshal_authorization_catalogs records the catalog each application activated with, keyed by the catalog revision it hashes to, so an upgrade can classify the change against the catalog its assignments were granted under after the old package files are gone. oshal_authorization_catalog_migrations holds the reviewable migration an installation refusal creates and its approval. Both are forced under the same operator-only control-plane policy as the other oshal_authorization_* tables. Runner-owned transaction: no top-level BEGIN/COMMIT.
 */
-- Mirrors the runtime bootstrap statements in src/features/application-authorization/store.ts.
CREATE TABLE IF NOT EXISTS oshal_authorization_catalogs (catalog_revision TEXT PRIMARY KEY, app_name TEXT NOT NULL, payload JSONB NOT NULL, recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE IF NOT EXISTS oshal_authorization_catalog_migrations (id TEXT PRIMARY KEY, app_name TEXT NOT NULL, payload JSONB NOT NULL);
DO $policy$
DECLARE suffix TEXT;
BEGIN
  FOREACH suffix IN ARRAY ARRAY['catalogs','catalog_migrations'] LOOP
    EXECUTE format('ALTER TABLE oshal_authorization_%I ENABLE ROW LEVEL SECURITY', suffix);
    EXECUTE format('ALTER TABLE oshal_authorization_%I FORCE ROW LEVEL SECURITY', suffix);
    EXECUTE format('DROP POLICY IF EXISTS authorization_control_plane ON oshal_authorization_%I', suffix);
    EXECUTE format('CREATE POLICY authorization_control_plane ON oshal_authorization_%I USING (current_setting(''oshal.is_operator'',true)=''on'') WITH CHECK (current_setting(''oshal.is_operator'',true)=''on'')', suffix);
  END LOOP;
END
$policy$;
