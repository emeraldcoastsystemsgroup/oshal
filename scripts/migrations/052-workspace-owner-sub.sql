-- 052-workspace-owner-sub.sql
-- Security hardening (IDOR fix): per-user workspace isolation.
-- Adds an owner_sub column so workspace get/update/delete/list can be scoped to
-- the creating user (enforced at the route layer via canAccessResource). Existing
-- rows keep owner_sub = NULL and remain accessible only while
-- OSHAL_ALLOW_LEGACY_UNOWNED is not 'false'; backfill before flipping that off.
-- Idempotent: safe to run more than once.
--
-- 2026-07-04 (A1.2 fresh-boot fix): create the table first. workspaces is otherwise
-- only created by the LAZY in-app DDL (src/shared/services/database/workspace-schema.ts,
-- runs on first workspace use), so on a FRESH database this migration failed with
-- 'relation "workspaces" does not exist' and the abort-on-first-failure runner then
-- blocked every later migration (053-061, including the 060 RLS tenancy pass).
-- DDL mirrors workspace-schema.ts exactly; both sides are idempotent so whichever
-- runs first wins and the other no-ops.

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  project_name TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_name ON workspaces(name);
CREATE INDEX IF NOT EXISTS idx_workspaces_project
  ON workspaces(project_name) WHERE project_name IS NOT NULL;

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS owner_sub TEXT;

CREATE INDEX IF NOT EXISTS idx_workspaces_owner
  ON workspaces(owner_sub) WHERE owner_sub IS NOT NULL;

-- RLS enforce policy (2026-07-04, A1.2): since this migration now CREATEs the
-- table, it also owns its policies — the in-app chokepoint (workspace-schema.ts)
-- only fires on first workspace use, which on a fresh deploy may be never, and a
-- created-but-policy-less table is exactly the gap A1.2 closes. Create-if-absent
-- (no drop) so re-runs never open a deny window; shape mirrors
-- docs/governance/rls-policies-enforce.sql. Inert for superuser runtimes.
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'workspaces_owner_or_operator'
      AND polrelid = 'workspaces'::regclass
  ) THEN
    CREATE POLICY workspaces_owner_or_operator ON workspaces
      AS PERMISSIVE FOR ALL
      USING (
        owner_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      )
      WITH CHECK (
        owner_sub = current_setting('oshal.current_sub', true)
        OR current_setting('oshal.is_operator', true) = 'on'
      );
  END IF;
END $$;
