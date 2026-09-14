-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com | Persist origin-bound one-use installation proof and root completion.
CREATE TABLE IF NOT EXISTS oshal_installer_root_setup (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  token_hash TEXT NOT NULL,
  origin TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_sub TEXT,
  completed_issuer TEXT,
  completed_at TIMESTAMPTZ
);
ALTER TABLE oshal_installer_root_setup ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_installer_root_setup FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oshal_installer_root_setup_system ON oshal_installer_root_setup;
CREATE POLICY oshal_installer_root_setup_system ON oshal_installer_root_setup FOR ALL
  USING (COALESCE(NULLIF(current_setting('oshal.is_operator', true), ''), 'off')::boolean)
  WITH CHECK (COALESCE(NULLIF(current_setting('oshal.is_operator', true), ''), 'off')::boolean);
