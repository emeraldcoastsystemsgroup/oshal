/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial persistent oshal_batch_job_runs table for batch Job runtime/resource telemetry and operator reporting.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added FORCE RLS and the canonical owner/operator policy so migrated databases match runtime bootstrap security.
 */

CREATE TABLE IF NOT EXISTS oshal_batch_job_runs (
  job_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  owner_sub TEXT,
  agent_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  queue_name TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  duration_ms INTEGER,
  processor_count INTEGER,
  cpu_request_cores NUMERIC,
  cpu_limit_cores NUMERIC,
  cpu_usage_user_micros BIGINT,
  cpu_usage_system_micros BIGINT,
  memory_usage_bytes BIGINT,
  memory_rss_bytes BIGINT,
  backend_error TEXT,
  provider TEXT,
  model TEXT,
  cost_usd NUMERIC,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_batch_job_runs_started ON oshal_batch_job_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_batch_job_runs_ticket ON oshal_batch_job_runs(ticket_id);
CREATE INDEX IF NOT EXISTS idx_batch_job_runs_owner_started ON oshal_batch_job_runs(owner_sub, started_at DESC) WHERE owner_sub IS NOT NULL;

ALTER TABLE oshal_batch_job_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE oshal_batch_job_runs FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polname = 'oshal_batch_job_runs_owner_or_operator'
      AND polrelid = 'oshal_batch_job_runs'::regclass
  ) THEN
    CREATE POLICY oshal_batch_job_runs_owner_or_operator ON oshal_batch_job_runs
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
