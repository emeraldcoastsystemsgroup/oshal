/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Persist reviewed composite role lifecycle and provenance receipts under existing operator-only control-plane RLS. Runner owns the transaction.
 */
CREATE TABLE IF NOT EXISTS oshal_authorization_composite_assignments (id TEXT PRIMARY KEY, payload JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS oshal_authorization_composite_previews (id TEXT PRIMARY KEY, payload JSONB NOT NULL);
DO $policy$
DECLARE suffix TEXT;
BEGIN
  FOREACH suffix IN ARRAY ARRAY['composite_assignments','composite_previews'] LOOP
    EXECUTE format('ALTER TABLE oshal_authorization_%I ENABLE ROW LEVEL SECURITY', suffix);
    EXECUTE format('ALTER TABLE oshal_authorization_%I FORCE ROW LEVEL SECURITY', suffix);
    EXECUTE format('DROP POLICY IF EXISTS authorization_control_plane ON oshal_authorization_%I', suffix);
    EXECUTE format('CREATE POLICY authorization_control_plane ON oshal_authorization_%I USING (current_setting(''oshal.is_operator'',true)=''on'') WITH CHECK (current_setting(''oshal.is_operator'',true)=''on'')', suffix);
  END LOOP;
END
$policy$;
