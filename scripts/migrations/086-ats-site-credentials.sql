-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-site ATS account credentials, so the apply-operator can sign back in to an employer's careers portal. Workday/Lever/iCIMS require an ACCOUNT per company tenant, which is why WORKER_BRIEF parks them ("do NOT create accounts unattended"); with the Gmail `verify` verb able to read the activation link, signup is automatable and the remaining gate is somewhere safe to keep the password. Mirrors oshal_connections: the secret is an AES-256-GCM envelope (never plaintext), the row is user_sub-owned, and the table is FORCE-RLS'd with the owner-or-operator policy (073 pattern) so one user can never read another's site logins.

CREATE TABLE IF NOT EXISTS ats_site_credentials (
  credential_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub      TEXT NOT NULL,                    -- the OIDC sub that OWNS this login (isolation boundary)
  site          TEXT NOT NULL,                    -- ATS host the account lives on, e.g. acme.wd5.myworkdayjobs.com
  ats_family    VARCHAR(24),                      -- 'workday' | 'lever' | 'icims' | … (recipe selection; informational)
  username      TEXT NOT NULL,                    -- sign-in identity (the user's OWN email) — not a secret
  password_enc  TEXT NOT NULL,                    -- AES-256-GCM envelope iv:tag:ciphertext (same shape as oshal_connections)
  status        VARCHAR(16) NOT NULL DEFAULT 'active',  -- 'active' | 'locked' | 'retired'
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One login per (owner, site). Upsert target for `oshal-site-creds put`.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ats_site_cred_owner_site ON ats_site_credentials (user_sub, site);
CREATE INDEX IF NOT EXISTS idx_ats_site_cred_owner ON ats_site_credentials (user_sub, updated_at DESC);

ALTER TABLE ats_site_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE ats_site_credentials FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  t TEXT := 'ats_site_credentials';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = t || '_owner_or_operator' AND polrelid = t::regclass
  ) THEN
    EXECUTE format(
      'CREATE POLICY %I ON %I AS PERMISSIVE FOR ALL '
      || 'USING (user_sub = current_setting(''oshal.current_sub'', true) '
      || '  OR current_setting(''oshal.is_operator'', true) = ''on'') '
      || 'WITH CHECK (user_sub = current_setting(''oshal.current_sub'', true) '
      || '  OR current_setting(''oshal.is_operator'', true) = ''on'')',
      t || '_owner_or_operator', t);
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ats_site_credentials TO oshal_app';
  END IF;
END
$$;
