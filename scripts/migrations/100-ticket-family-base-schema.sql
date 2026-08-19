-- CHANGE LOG
-- -----------------------------------------------------------------------------
-- SEQ | AUTHOR                                    | DESCRIPTION
-- -----------------------------------------------------------------------------
-- 1   | maintainer@emeraldcoastsystemsgroup.com   | Record ticket-schema's lazy base before 103/113. A fresh migration-only deployment otherwise reaches 113 without tickets, cannot create oshal_owns_ticket, and later lazy child creation misses derived FORCE RLS. No seed/data mutation; the runtime schema remains an idempotent mirror.

CREATE TABLE IF NOT EXISTS tickets (
  ticket_id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog'
    CHECK (status IN (
      'backlog', 'approved', 'in_process', 'in_process_discovery',
      'in_process_design', 'in_process_build', 'in_process_deploy',
      'in_process_test', 'in_process_release', 'approval_required',
      'customer_action', 'complete', 'escalated', 'dead_letter',
      'paused', 'cancelled'
    )),
  state_group TEXT NOT NULL DEFAULT 'backlog'
    CHECK (state_group IN (
      'backlog', 'approved', 'in_process', 'approval_required',
      'customer_action', 'complete', 'escalated', 'paused', 'cancelled'
    )),
  execution_phase TEXT
    CHECK (execution_phase IS NULL OR execution_phase IN (
      'discovery', 'design', 'build', 'deploy', 'test', 'release'
    )),
  priority TEXT NOT NULL DEFAULT 'none'
    CHECK (priority IN ('urgent', 'high', 'medium', 'low', 'none')),
  labels TEXT[] NOT NULL DEFAULT '{}'::text[],
  workspace_id UUID,
  assigned_agent_id TEXT,
  parent_ticket_id UUID REFERENCES tickets(ticket_id) ON DELETE SET NULL,
  external_provider TEXT,
  external_id TEXT,
  external_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  owner_sub TEXT,
  ticket_type TEXT NOT NULL DEFAULT 'build'
);

CREATE INDEX IF NOT EXISTS idx_tickets_owner_sub ON tickets(owner_sub) WHERE owner_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_type ON tickets(ticket_type);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_state_group ON tickets(state_group);
CREATE INDEX IF NOT EXISTS idx_tickets_workspace ON tickets(workspace_id) WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_assigned_agent ON tickets(assigned_agent_id) WHERE assigned_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_parent ON tickets(parent_ticket_id) WHERE parent_ticket_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_external ON tickets(external_id, external_provider) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_external_unique
  ON tickets(external_provider, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority) WHERE priority != 'none';

CREATE TABLE IF NOT EXISTS ticket_task_links (
  task_id TEXT NOT NULL REFERENCES chat_tasks(task_id) ON DELETE CASCADE,
  ticket_id UUID NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'primary'
    CHECK (role IN ('primary', 'review', 'subtask', 'swarm-execution')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, ticket_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_task_links_ticket ON ticket_task_links(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_task_links_task ON ticket_task_links(task_id);

CREATE TABLE IF NOT EXISTS ticket_workspace_links (
  ticket_id UUID NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticket_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_ticket_workspace_links_workspace ON ticket_workspace_links(workspace_id);

CREATE TABLE IF NOT EXISTS ticket_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  changed_by TEXT NOT NULL DEFAULT 'system',
  changed_by_label TEXT NOT NULL DEFAULT 'System',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ticket_status_history_ticket ON ticket_status_history(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_status_history_created ON ticket_status_history(created_at DESC);

CREATE TABLE IF NOT EXISTS ticket_agent_assignments (
  ticket_id UUID NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'executor',
  phase TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ticket_id, agent_id, role)
);
CREATE INDEX IF NOT EXISTS idx_ticket_agent_assignments_agent ON ticket_agent_assignments(agent_id);

ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polname = 'tickets_owner_or_operator'
       AND polrelid = 'tickets'::regclass
  ) THEN
    CREATE POLICY tickets_owner_or_operator ON tickets
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
END
$$;
