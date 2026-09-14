/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Add verified provider-qualified inventory without importing ambiguous historical subjects or changing accounts.
 */
BEGIN;
CREATE TABLE IF NOT EXISTS oshal_verified_principals (
  issuer TEXT NOT NULL, user_sub TEXT NOT NULL, provider TEXT NOT NULL,
  email TEXT, email_verified BOOLEAN NOT NULL DEFAULT FALSE, display_name TEXT,
  canonical_local_sub TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(issuer,user_sub)
);
ALTER TABLE oshal_verified_principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_verified_principals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS verified_principal_control_plane ON oshal_verified_principals;
CREATE POLICY verified_principal_control_plane ON oshal_verified_principals
  USING (current_setting('oshal.is_operator',true)='on') WITH CHECK(current_setting('oshal.is_operator',true)='on');
COMMIT;
