-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Per-user connector enablement OVERRIDE store (BACKLOG.md:2718). Connector enablement was deployment-global only (output/connector-marketplace-state.json); this table layers a per-user override on top of the per-user credential layer (resolveBotCreds). NON-BREAKING semantics: a connector is usable for a user when it is deployment-enabled AND NOT explicitly user-disabled — absence of a row = allowed, so every existing user who pasted a credential but never toggled keeps working. An enabled=false row blocks the connector for THAT user only; an enabled=true row is an explicit opt-in/surface marker. FORCE-RLS'd + owner-or-operator policy (086/062 pattern) so one user can never read or flip another's enablement. Runtime lazy-ensure lives in src/app/connectors/runtime/user-enablement-store.ts (mirrors this file).

CREATE TABLE IF NOT EXISTS oshal_connector_user_enablement (
  user_sub   TEXT        NOT NULL,                 -- the OIDC sub that OWNS this override (isolation boundary)
  provider   TEXT        NOT NULL,                 -- connector provider slug (marketplace entry id / cred provider)
  enabled    BOOLEAN     NOT NULL,                 -- false = block for this user; true = explicit per-user opt-in
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_sub, provider)
);

-- Owner lookups (the broker + my-enablement route both read every row for one caller).
CREATE INDEX IF NOT EXISTS idx_connector_user_enablement_user ON oshal_connector_user_enablement (user_sub);

-- Owner-scoped RLS (A1.2 chokepoint pattern) — same shape as
-- buildOwnerRlsPolicyStatements / docs/governance/rls-policies-enforce.sql.
-- Inert while the runtime connects as a superuser role (ADR-076); enforced under oshal_app.
ALTER TABLE oshal_connector_user_enablement ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_connector_user_enablement FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'oshal_connector_user_enablement_owner_or_operator'
      AND polrelid = 'oshal_connector_user_enablement'::regclass
  ) THEN
    CREATE POLICY oshal_connector_user_enablement_owner_or_operator ON oshal_connector_user_enablement
      AS PERMISSIVE FOR ALL
      USING (
        user_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      )
      WITH CHECK (
        user_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      );
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oshal_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON oshal_connector_user_enablement TO oshal_app';
  END IF;
END $$;
