/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-118 Phase 2: add the FORCE-RLS per-user/per-app access assignment store with exact subjects, fixed tiers, operator-only mutation, and owner/operator reads.
 */

-- Migration 120 is the CORE-01 shared recap lease. The bootstrap runner owns the transaction.
CREATE TABLE IF NOT EXISTS oshal_app_access (
  user_sub TEXT NOT NULL
    CHECK (length(user_sub) > 0 AND octet_length(user_sub) <= 512),
  app_name VARCHAR(100) NOT NULL
    REFERENCES swarm_applications(name) ON DELETE CASCADE,
  tier TEXT NOT NULL
    CHECK (tier IN ('deny', 'viewer', 'editor', 'admin')),
  assigned_by_sub TEXT NOT NULL
    CHECK (length(assigned_by_sub) > 0 AND octet_length(assigned_by_sub) <= 512),
  reason TEXT NOT NULL
    CHECK (length(btrim(reason)) > 0 AND length(reason) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_sub, app_name)
);

CREATE INDEX IF NOT EXISTS idx_oshal_app_access_app_tier
  ON oshal_app_access (app_name, tier);

CREATE OR REPLACE FUNCTION touch_oshal_app_access_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_oshal_app_access_updated_at ON oshal_app_access;
CREATE TRIGGER trg_oshal_app_access_updated_at
  BEFORE UPDATE ON oshal_app_access
  FOR EACH ROW EXECUTE FUNCTION touch_oshal_app_access_updated_at();

ALTER TABLE oshal_app_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_app_access FORCE ROW LEVEL SECURITY;

-- A user may inspect only their own explicit doorway assignments. Operators need the same
-- SELECT policy for the management matrix and for UPDATE/DELETE row visibility.
DROP POLICY IF EXISTS oshal_app_access_owner_or_operator_read ON oshal_app_access;
CREATE POLICY oshal_app_access_owner_or_operator_read ON oshal_app_access
  AS PERMISSIVE FOR SELECT
  USING (
    user_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );

-- Packages/users never self-promote. All assignment mutation stays in the framework-owned,
-- operator-gated API; FORCE RLS keeps this true even for the table owner runtime role.
DROP POLICY IF EXISTS oshal_app_access_operator_write ON oshal_app_access;
CREATE POLICY oshal_app_access_operator_write ON oshal_app_access
  AS PERMISSIVE FOR ALL
  USING (current_setting('oshal.is_operator', true) = 'on')
  WITH CHECK (current_setting('oshal.is_operator', true) = 'on');
