/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add exact native-external business membership facts and control-plane previews.
 */
BEGIN;
CREATE TABLE IF NOT EXISTS oshal_external_tenant_memberships (
  issuer TEXT NOT NULL CHECK(issuer NOT LIKE 'urn:oshal:%'), user_sub TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES oshal_tenants(tenant_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(issuer,user_sub,tenant_id));
CREATE TABLE IF NOT EXISTS oshal_external_tenant_previews (id UUID PRIMARY KEY, payload JSONB NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS external_tenant_preview_idempotency ON oshal_external_tenant_previews
  ((payload #>> '{actor,issuer}'),(payload #>> '{actor,sub}'),(payload ->> 'idempotencyKey')) WHERE payload ? 'idempotencyKey';
DO $policy$
DECLARE suffix TEXT;
BEGIN
  FOREACH suffix IN ARRAY ARRAY['memberships','previews'] LOOP
    EXECUTE format('ALTER TABLE oshal_external_tenant_%I ENABLE ROW LEVEL SECURITY',suffix);
    EXECUTE format('ALTER TABLE oshal_external_tenant_%I FORCE ROW LEVEL SECURITY',suffix);
    EXECUTE format('DROP POLICY IF EXISTS external_tenant_control_plane ON oshal_external_tenant_%I',suffix);
    EXECUTE format('CREATE POLICY external_tenant_control_plane ON oshal_external_tenant_%I
      USING(current_setting(''oshal.is_operator'',true)=''on'') WITH CHECK(current_setting(''oshal.is_operator'',true)=''on'')',suffix);
  END LOOP;
END
$policy$;
COMMIT;
