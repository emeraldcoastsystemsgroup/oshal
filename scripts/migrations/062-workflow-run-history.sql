-- ===========================================================================
-- 062-workflow-run-history.sql
-- Workflow Studio run history: one row per graph-workflow execution
-- (workflow_runs) + one row per executed node (workflow_run_steps).
--
-- WHAT THIS DOES
--   Persists what the ProcessDefinitionExecutionEngine actually did for each
--   'graph'-pipeline ticket so the studio's Runs panel / run inspector can show
--   past runs and per-step status, timing, agent, and input/output summaries.
--   Writers are the dispatch-graph-worker recording hooks (fire-and-forget —
--   a write failure never breaks a run); readers are the auth-gated
--   /api/workflow-studio/runs routes.
--
-- NOTES
--   - No FK to tickets(ticket_id): the tickets table is created by the runtime
--     schema bootstrap (ticket-schema.ts) AFTER migrations on a fresh database,
--     and run history should survive ticket deletion for audit value.
--   - input_summary/output_summary are REDACTED + truncated before insert
--     (see workflow-run-history-store.ts redactRunPayload) — never raw payloads.
--   - owner_sub is denormalized onto steps so the owner-or-operator RLS policy
--     (A1.2 chokepoint pattern) applies to both tables identically.
--   - Idempotent: safe to re-run. Mirrors the runtime lazy-DDL in
--     src/features/workflow-studio/services/workflow-run-history-store.ts.
-- ===========================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS workflow_runs (
  run_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL,
  owner_sub TEXT,
  ticket_type TEXT NOT NULL DEFAULT '',
  workflow_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'suspended', 'completed', 'escalated', 'error')),
  outcome TEXT,
  reason TEXT,
  resumed_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_ticket ON workflow_runs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_owner ON workflow_runs(owner_sub) WHERE owner_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_workflow_runs_started ON workflow_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(status);

CREATE TABLE IF NOT EXISTS workflow_run_steps (
  step_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
  owner_sub TEXT,
  seq BIGSERIAL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  node_title TEXT NOT NULL DEFAULT '',
  agent_id TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('completed', 'terminal', 'jump', 'skipped', 'escalated', 'suspended')),
  input_summary JSONB,
  output_summary JSONB,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run ON workflow_run_steps(run_id, seq);

-- Owner-scoped RLS (A1.2 chokepoint pattern) — same shape as
-- buildOwnerRlsPolicyStatements / docs/governance/rls-policies-enforce.sql.
-- Inert while the runtime connects as a superuser role (ADR-076).
ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_runs FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'workflow_runs_owner_or_operator' AND polrelid = 'workflow_runs'::regclass
  ) THEN
    CREATE POLICY workflow_runs_owner_or_operator ON workflow_runs
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

ALTER TABLE workflow_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow_run_steps FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'workflow_run_steps_owner_or_operator' AND polrelid = 'workflow_run_steps'::regclass
  ) THEN
    CREATE POLICY workflow_run_steps_owner_or_operator ON workflow_run_steps
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
