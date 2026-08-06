/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add the PostgreSQL-authoritative Apply V2 run ledger, compare-and-set state machine, exact Career claim binding, confirmation provenance, active-run uniqueness, and owner-or-operator RLS.
 */

CREATE TABLE IF NOT EXISTS apply_runs (
  run_id UUID PRIMARY KEY,
  ticket_id TEXT NOT NULL CHECK (length(btrim(ticket_id)) > 0),
  owner_sub TEXT NOT NULL CHECK (length(btrim(owner_sub)) > 0),
  posting_id BIGINT NOT NULL CHECK (posting_id > 0),
  claim_token UUID NOT NULL UNIQUE,
  task_id TEXT UNIQUE,
  worker_client_id TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'claimed', 'queued_to_worker', 'acknowledged', 'running',
    'submitted_verified', 'manual_mark', 'failed', 'abandoned', 'unknown_outcome'
  )),
  claimed_at TIMESTAMPTZ NOT NULL,
  dispatched_at TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  last_progress_at TIMESTAMPTZ,
  timeout_at TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ,
  result JSONB,
  failure_code TEXT,
  failure_detail TEXT,
  confirmation_path TEXT,
  confirmation_sha256 TEXT CHECK (
    confirmation_sha256 IS NULL OR confirmation_sha256 ~ '^[0-9a-f]{64}$'
  ),
  metadata JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT apply_runs_metadata_shape CHECK (
    jsonb_typeof(metadata) = 'object'
    AND metadata ? 'trigger'
    AND metadata ? 'initiatedBySub'
    AND metadata ? 'automationSettingsVersion'
  ),
  CONSTRAINT apply_runs_state_shape CHECK (
    (state = 'claimed' AND task_id IS NULL AND worker_client_id IS NULL
      AND dispatched_at IS NULL AND finished_at IS NULL)
    OR (state IN ('queued_to_worker', 'acknowledged', 'running')
      AND task_id IS NOT NULL AND worker_client_id IS NOT NULL
      AND dispatched_at IS NOT NULL AND finished_at IS NULL)
    OR (state IN ('submitted_verified', 'unknown_outcome')
      AND task_id IS NOT NULL AND worker_client_id IS NOT NULL
      AND dispatched_at IS NOT NULL AND finished_at IS NOT NULL)
    OR (state IN ('manual_mark', 'failed', 'abandoned') AND finished_at IS NOT NULL)
  ),
  CONSTRAINT apply_runs_verified_evidence CHECK (
    state <> 'submitted_verified'
    OR (confirmation_path IS NOT NULL AND confirmation_sha256 IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_apply_runs_active_owner_posting
  ON apply_runs (owner_sub, posting_id)
  WHERE state IN ('claimed', 'queued_to_worker', 'acknowledged', 'running');

CREATE INDEX IF NOT EXISTS idx_apply_runs_task
  ON apply_runs (task_id) WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_apply_runs_recovery
  ON apply_runs (timeout_at)
  WHERE state IN ('claimed', 'queued_to_worker', 'acknowledged', 'running');

CREATE INDEX IF NOT EXISTS idx_apply_runs_owner_recent
  ON apply_runs (owner_sub, created_at DESC);

ALTER TABLE apply_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE apply_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS apply_runs_owner_or_operator ON apply_runs;
CREATE POLICY apply_runs_owner_or_operator ON apply_runs
  AS PERMISSIVE FOR ALL
  USING (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  )
  WITH CHECK (
    owner_sub = current_setting('oshal.current_sub', true)
    OR current_setting('oshal.is_operator', true) = 'on'
  );

