-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ                 | AUTHOR                      | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1 | maintainer@emeraldcoastsystemsgroup.com   | Added work_items table for internal swarm work unit persistence
-- 2 | maintainer@emeraldcoastsystemsgroup.com   | Added 2-level hierarchical decomposition: parent_id, depth, subtask statuses

CREATE TABLE IF NOT EXISTS work_items (
  work_item_id UUID PRIMARY KEY,
  swarm_run_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  acceptance_criteria JSONB NOT NULL DEFAULT '[]'::jsonb,
  labels TEXT[] NOT NULL DEFAULT '{}'::text[],
  priority TEXT,
  assigned_agent_id TEXT,
  parent_id UUID REFERENCES work_items(work_item_id) ON DELETE CASCADE,
  depth SMALLINT NOT NULL DEFAULT 0 CHECK (depth >= 0 AND depth <= 1),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'assigned', 'executing', 'completed', 'failed', 'escalated',
      'in-review',
      'subtask-pending', 'subtask-assigned', 'subtask-executing',
      'subtask-completed', 'subtask-failed'
    )),
  execution_output JSONB,
  verification_result JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_work_items_run
  ON work_items(swarm_run_id);

CREATE INDEX IF NOT EXISTS idx_work_items_agent_status
  ON work_items(assigned_agent_id, status);

CREATE INDEX IF NOT EXISTS idx_work_items_external
  ON work_items(external_id, provider);

CREATE INDEX IF NOT EXISTS idx_work_items_parent
  ON work_items(parent_id) WHERE parent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_work_items_depth_status
  ON work_items(depth, status);
