-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com   | Make the connector/token-key base schema migration-owned on a fresh install. Migration 060 historically skipped these lazy-runtime tables, leaving them without FORCE RLS; 101 then assumed oshal_connections already existed. This canonical base sorts before 101, includes the multi-account ownership columns its policy needs, and applies the exact tier-1/tier-2 policies from 060.

CREATE TABLE IF NOT EXISTS oshal_connections (
  connection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_sub TEXT NOT NULL,
  user_email TEXT,
  provider VARCHAR(40) NOT NULL,
  account_email TEXT,
  account_id TEXT,
  scopes TEXT,
  access_token TEXT,
  refresh_token TEXT,
  expiry TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'connected',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tenant_id UUID,
  connected_by_sub TEXT,
  label TEXT,
  account_key TEXT,
  is_default BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS oshal_user_deks (
  user_sub TEXT PRIMARY KEY,
  wrapped_dek TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Exact tier-2 personal-or-tenant policy from migration 060. FORCE matters:
-- oshal_app owns the relation after provisioning and must still be scoped.
ALTER TABLE oshal_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oshal_connections_personal_or_tenant ON oshal_connections;
CREATE POLICY oshal_connections_personal_or_tenant ON oshal_connections
  AS PERMISSIVE FOR ALL
  USING (
    current_setting('oshal.is_operator', true) = 'on'
    OR (tenant_id IS NULL AND user_sub = current_setting('oshal.current_sub', true))
    OR (tenant_id IS NOT NULL AND oshal_is_tenant_member(tenant_id::text))
  )
  WITH CHECK (
    current_setting('oshal.is_operator', true) = 'on'
    OR (tenant_id IS NULL AND user_sub = current_setting('oshal.current_sub', true))
    OR (tenant_id IS NOT NULL AND oshal_is_tenant_member(tenant_id::text))
  );

-- Exact tier-1 owner-or-operator policy from migration 060.
ALTER TABLE oshal_user_deks ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_user_deks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS oshal_user_deks_owner_or_operator ON oshal_user_deks;
CREATE POLICY oshal_user_deks_owner_or_operator ON oshal_user_deks
  AS PERMISSIVE FOR ALL
  USING (
    user_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (
    user_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );
