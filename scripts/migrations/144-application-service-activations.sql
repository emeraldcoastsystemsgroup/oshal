/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | ADR-157: one row per activated scheduled application service. Nothing runs by declaration; this table is what says a person turned a declared job on, under which principal class, with which permissions, and when it was revoked or suspended. No top-level BEGIN;/COMMIT;: the migration runner wraps each file and its app_migrations history INSERT in one transaction on one client, and every statement here is transaction-safe.
 */
CREATE TABLE IF NOT EXISTS oshal_application_service_activations (
  id TEXT PRIMARY KEY,
  app TEXT NOT NULL,
  schedule_id TEXT NOT NULL,
  runs_as TEXT NOT NULL CHECK (runs_as IN ('system','user')),
  -- The person a user service runs as. NULL for a system service, which acts as the
  -- application and therefore matches no person's row under row-level security.
  target_sub TEXT,
  target_issuer TEXT,
  tenant_id TEXT,
  -- The permissions recorded AT ACTIVATION, with the catalog revision they were read from.
  -- Current rights are still rechecked on every tick; this never freezes a permission.
  requires TEXT[] NOT NULL DEFAULT '{}',
  catalog_revision TEXT NOT NULL,
  activated_by_sub TEXT NOT NULL,
  activated_by_issuer TEXT NOT NULL,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_by_sub TEXT,
  revoked_by_issuer TEXT,
  revoked_at TIMESTAMPTZ,
  -- Set when a tick was denied after rights changed; the panel shows it and the job skips
  -- until a fresh activation clears it.
  suspended_reason TEXT,
  suspended_at TIMESTAMPTZ,
  CHECK ((runs_as = 'user') = (target_sub IS NOT NULL)),
  CHECK ((target_sub IS NULL) = (target_issuer IS NULL))
);
-- At most one LIVE activation per schedule per principal: a system service has one, a user
-- service has one per person. A revoked row stays for the audit trail.
CREATE UNIQUE INDEX IF NOT EXISTS application_service_activation_live
  ON oshal_application_service_activations (app, schedule_id, COALESCE(target_sub,''), COALESCE(target_issuer,''))
  WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS application_service_activation_app
  ON oshal_application_service_activations (app, schedule_id);
ALTER TABLE oshal_application_service_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_application_service_activations FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'oshal_application_service_activations_owner_or_operator'
      AND polrelid = 'oshal_application_service_activations'::regclass
  ) THEN
    CREATE POLICY oshal_application_service_activations_owner_or_operator
      ON oshal_application_service_activations
      AS PERMISSIVE FOR ALL
      USING (
        target_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      )
      WITH CHECK (
        target_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      );
  END IF;
END $$;
