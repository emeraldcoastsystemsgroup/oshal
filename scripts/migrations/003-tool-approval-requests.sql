/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial migration for tool approval requests table
 */

-- Tool Approval Requests table
-- Tracks approval workflow state for tools with auth_mode = 'ask'
CREATE TABLE IF NOT EXISTS tool_approval_requests (
  request_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       TEXT NOT NULL,
  agent_id      TEXT NOT NULL,
  tool_id       UUID NOT NULL REFERENCES tools(tool_id) ON DELETE CASCADE,
  tool_name     TEXT NOT NULL,
  tool_input    JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'timeout', 'error')),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ,
  resolved_by   TEXT,
  timeout_ms    INTEGER NOT NULL DEFAULT 60000,
  context       JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast lookup by task
CREATE INDEX IF NOT EXISTS idx_approval_requests_task_id ON tool_approval_requests(task_id);

-- Index for pending requests (approval workflow polling)
CREATE INDEX IF NOT EXISTS idx_approval_requests_pending ON tool_approval_requests(status) WHERE status = 'pending';

-- Trigger to auto-update updated_at
CREATE OR REPLACE FUNCTION update_approval_requests_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_approval_requests_updated_at ON tool_approval_requests;
CREATE TRIGGER trg_approval_requests_updated_at
  BEFORE UPDATE ON tool_approval_requests
  FOR EACH ROW
  EXECUTE FUNCTION update_approval_requests_updated_at();