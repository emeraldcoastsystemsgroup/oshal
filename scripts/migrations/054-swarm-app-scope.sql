-- 054-swarm-app-scope.sql
-- Workflow scope model: a swarm application (an app IS a queue / a workflow) can be
-- private to a person, private to a tenant, or public. PUBLIC is the default so every
-- existing framework app stays globally visible after upgrade (no behaviour change).
--
-- Person-scoped apps are visible only to their owner_sub (+ operators); the route layer
-- filters listing using the same caller-identity / ownerSub pattern already used for
-- tickets and workspaces (see 052-workspace-owner-sub.sql) and personal data. The
-- tenant_id column is added now so tenant scoping is later a wiring job, not another
-- migration; tenant-wide filtering lands with the broader multi-tenant work.
--
-- Idempotent: safe to run more than once.

ALTER TABLE swarm_applications
  ADD COLUMN IF NOT EXISTS scope VARCHAR(20) NOT NULL DEFAULT 'public'
    CHECK (scope IN ('person', 'tenant', 'public'));

ALTER TABLE swarm_applications ADD COLUMN IF NOT EXISTS owner_sub TEXT;
ALTER TABLE swarm_applications ADD COLUMN IF NOT EXISTS tenant_id UUID;

CREATE INDEX IF NOT EXISTS idx_swarm_apps_scope ON swarm_applications(scope);
CREATE INDEX IF NOT EXISTS idx_swarm_apps_owner
  ON swarm_applications(owner_sub) WHERE owner_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_swarm_apps_tenant
  ON swarm_applications(tenant_id) WHERE tenant_id IS NOT NULL;
