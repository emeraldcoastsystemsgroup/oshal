-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com | AUTH-03: an installer proof may be bound to one exact identity-provider issuer and subject, so an OIDC installation elects its first root from the local terminal's proof plus that exact signed-in identity. Both columns stay NULL for the local-account ceremony; the pair is all-or-nothing.
ALTER TABLE oshal_installer_root_setup ADD COLUMN IF NOT EXISTS bound_issuer TEXT;
ALTER TABLE oshal_installer_root_setup ADD COLUMN IF NOT EXISTS bound_sub TEXT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oshal_installer_root_setup_bound_pair'
    AND conrelid = 'oshal_installer_root_setup'::regclass) THEN
    ALTER TABLE oshal_installer_root_setup
      ADD CONSTRAINT oshal_installer_root_setup_bound_pair CHECK ((bound_issuer IS NULL) = (bound_sub IS NULL));
  END IF;
END $$;
