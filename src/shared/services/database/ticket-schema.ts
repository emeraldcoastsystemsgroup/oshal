/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial ticket persistence schema: tickets, ticket_task_links, ticket_workspace_links tables
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Process tracker: added ticket_status_history table to record every status transition with actor and timestamp
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | ticket_cost_rollup_with_children view — recursive parent-child cost aggregation so parent tickets show aggregate costs across all descendants
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | A1.2: append owner-or-operator RLS policy statements so a fresh database enforces ticket isolation at table-create time (chokepoint fix; shapes mirror rls-policies-enforce.sql)
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Admit terminal 'dead_letter' in BOTH tickets.status CHECK lists (CREATE + the every-boot DROP/ADD re-assert) — queue DLQ quarantine (migration 081, DeadLetterService). state_group is unchanged: dead_letter groups under 'escalated'.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from './schema-bootstrap-policy';
import { SCHEMA_LOCK_KEYS } from './schema-lock';
import { buildOwnerRlsPolicyStatements } from './owner-rls-policy';

const logger = createChildLogger({ module: 'ticket-schema' });

let schemaReadyPromise: Promise<void> | null = null;

/**
 * @description Ensures the tickets, ticket_task_links, and ticket_workspace_links tables exist
 * before ticket store queries execute. Uses a shared process-level promise so bootstrap runs
 * once per process.
 * @param pool - Postgres connection pool
 * @returns Promise resolved when the ticket schema is ready
 */
export function ensureTicketSchema(pool: Pool): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = applyTicketSchema(pool).catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }
  return schemaReadyPromise;
}

/**
 * @description Applies idempotent SQL statements for ticket persistence.
 * @param pool - Postgres connection pool
 * @returns Promise resolved when all schema statements have been applied
 */
async function applyTicketSchema(pool: Pool): Promise<void> {
  const maxAttempts = 10;
  const delayMs = 2000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      logger.info({ attempt }, 'Ensuring ticket persistence schema');
      const statements = buildSchemaStatements();
      // Serialize concurrent bootstrappers so the DROP/ADD CONSTRAINT pairs can't interleave
      // across connections and throw "constraint already exists".
      await runRuntimeSchemaBootstrap({
        pool,
        moduleName: 'ticket',
        statements,
        lockKey: SCHEMA_LOCK_KEYS.ticket,
        requirements: [
          { table: 'tickets', columns: ['ticket_id', 'owner_sub', 'ticket_type', 'status', 'metadata'] },
          { table: 'ticket_task_links', columns: ['task_id', 'ticket_id', 'role'] },
          { table: 'ticket_workspace_links', columns: ['ticket_id', 'workspace_id'] },
          { table: 'ticket_status_history', columns: ['ticket_id', 'to_status', 'metadata'] },
          { table: 'ticket_agent_assignments', columns: ['ticket_id', 'agent_id', 'role'] },
        ],
      });
      logger.info({ statementCount: statements.length }, 'Ticket persistence schema ready');
      return;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts && msg.includes('does not exist')) {
        logger.warn({ attempt, maxAttempts, delayMs, err: msg }, 'Ticket schema depends on tables not yet created by migrations — retrying');
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } else {
        throw error;
      }
    }
  }
}

/**
 * @description Returns ordered SQL statements for the tickets and link tables.
 * @returns SQL statements
 */
function buildSchemaStatements(): string[] {
  return [
    /* ── tickets table ─────────────────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS tickets (
      ticket_id UUID PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'backlog'
        CHECK (status IN (
          'backlog', 'approved',
          'in_process',
          'in_process_discovery',
          'in_process_design', 'in_process_build', 'in_process_deploy',
          'in_process_test', 'in_process_release',
          'approval_required', 'customer_action', 'complete', 'escalated',
          'dead_letter',
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
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    /* ── tickets indexes ───────────────────────────────────────────── */
    `DO $$ BEGIN
       ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_status_check;
       ALTER TABLE tickets ADD CONSTRAINT tickets_status_check
         CHECK (status IN (
           'backlog', 'approved',
           'in_process',
           'in_process_discovery',
           'in_process_design', 'in_process_build', 'in_process_deploy',
           'in_process_test', 'in_process_release',
           'approval_required', 'customer_action', 'complete', 'escalated',
           'dead_letter',
           'paused', 'cancelled'
         ));
     EXCEPTION WHEN duplicate_object THEN NULL;
     END $$`,
    `DO $$ BEGIN
       ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_state_group_check;
       ALTER TABLE tickets ADD CONSTRAINT tickets_state_group_check
         CHECK (state_group IN (
           'backlog', 'approved', 'in_process', 'approval_required',
           'customer_action', 'complete', 'escalated', 'paused', 'cancelled'
         ));
     EXCEPTION WHEN duplicate_object THEN NULL;
     END $$`,
    `DO $$ BEGIN
       ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_execution_phase_check;
       ALTER TABLE tickets ADD CONSTRAINT tickets_execution_phase_check
         CHECK (execution_phase IS NULL OR execution_phase IN (
           'discovery', 'design', 'build', 'deploy', 'test', 'release'
         ));
     EXCEPTION WHEN duplicate_object THEN NULL;
     END $$`,
    /* ── per-user ownership (additive; existing tickets keep NULL owner) ─── */
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS owner_sub TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_owner_sub ON tickets(owner_sub) WHERE owner_sub IS NOT NULL`,

    /* ── workflow routing (additive; canonical home for ticket_type).
       Migration 018 also adds this, but the tickets table is created here at
       runtime AFTER migrations run, so a fresh DB depends on this statement —
       018 is guarded to be a no-op when the table is absent. ─── */
    `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_type TEXT NOT NULL DEFAULT 'build'`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_type ON tickets(ticket_type)`,

    `CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_state_group ON tickets(state_group)`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_workspace ON tickets(workspace_id) WHERE workspace_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_assigned_agent ON tickets(assigned_agent_id) WHERE assigned_agent_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_parent ON tickets(parent_ticket_id) WHERE parent_ticket_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_external ON tickets(external_id, external_provider) WHERE external_id IS NOT NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_tickets_external_unique ON tickets(external_provider, external_id) WHERE external_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_tickets_priority ON tickets(priority) WHERE priority != 'none'`,

    /* ── ticket_task_links table ───────────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS ticket_task_links (
      task_id TEXT NOT NULL REFERENCES chat_tasks(task_id) ON DELETE CASCADE,
      ticket_id UUID NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'primary'
        CHECK (role IN ('primary', 'review', 'subtask', 'swarm-execution')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (task_id, ticket_id)
    )`,

    /* ── ticket_task_links: idempotent constraint refresh (swarm-execution role) ── */
    `DO $$ BEGIN
       ALTER TABLE ticket_task_links DROP CONSTRAINT IF EXISTS ticket_task_links_role_check;
       ALTER TABLE ticket_task_links ADD CONSTRAINT ticket_task_links_role_check
         CHECK (role IN ('primary', 'review', 'subtask', 'swarm-execution'));
     EXCEPTION WHEN duplicate_object THEN NULL;
     END $$`,

    /* ── ticket_task_links indexes ─────────────────────────────────── */
    `CREATE INDEX IF NOT EXISTS idx_ticket_task_links_ticket ON ticket_task_links(ticket_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_task_links_task ON ticket_task_links(task_id)`,

    /* ── ticket_workspace_links table ──────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS ticket_workspace_links (
      ticket_id UUID NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
      workspace_id UUID NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (ticket_id, workspace_id)
    )`,

    /* ── ticket_workspace_links indexes ────────────────────────────── */
    `CREATE INDEX IF NOT EXISTS idx_ticket_workspace_links_workspace ON ticket_workspace_links(workspace_id)`,

    /* ── ticket_status_history table ───────────────────────────────── */
    `CREATE TABLE IF NOT EXISTS ticket_status_history (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id UUID NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
      from_status TEXT,
      to_status TEXT NOT NULL,
      changed_by TEXT NOT NULL DEFAULT 'system',
      changed_by_label TEXT NOT NULL DEFAULT 'System',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    /* ── ticket_status_history indexes ─────────────────────────────── */
    `CREATE INDEX IF NOT EXISTS idx_ticket_status_history_ticket ON ticket_status_history(ticket_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_status_history_created ON ticket_status_history(created_at DESC)`,

    /* ── ticket_agent_assignments: tracks every agent that works a ticket ── */
    `CREATE TABLE IF NOT EXISTS ticket_agent_assignments (
      ticket_id UUID NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'executor',
      phase TEXT,
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (ticket_id, agent_id, role)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_ticket_agent_assignments_agent ON ticket_agent_assignments(agent_id)`,

    /* ── ticket_agent_summary: aggregated view of agents per ticket ── */
    `CREATE OR REPLACE VIEW ticket_agent_summary AS
     SELECT
       t.ticket_id,
       COALESCE(array_agg(DISTINCT taa.agent_id) FILTER (WHERE taa.agent_id IS NOT NULL), '{}') AS agent_ids,
       COALESCE(array_agg(DISTINCT a.name) FILTER (WHERE a.name IS NOT NULL), '{}') AS agent_names,
       COUNT(DISTINCT taa.agent_id) AS agent_count
     FROM tickets t
     LEFT JOIN ticket_agent_assignments taa ON taa.ticket_id = t.ticket_id
     LEFT JOIN agents a ON a.agent_id::text = taa.agent_id
     GROUP BY t.ticket_id`,

    /* ── ticket_cost_rollup view (direct costs only) ────────────── */
    `CREATE OR REPLACE VIEW ticket_cost_rollup AS
     SELECT
       ttl.ticket_id,
       COALESCE(SUM(ct.total_cost), 0) AS total_cost,
       COALESCE(SUM(ct.total_input_tokens + ct.total_output_tokens), 0) AS total_tokens,
       COALESCE(SUM(ct.total_requests), 0) AS total_requests,
       COUNT(DISTINCT ttl.task_id) AS task_count,
       COUNT(DISTINCT ct.agent_id) AS agent_count
     FROM ticket_task_links ttl
     JOIN chat_tasks ct ON ct.task_id = ttl.task_id
     GROUP BY ttl.ticket_id`,

    /* ── ticket_cost_rollup_with_children view (recursive, deduped) ── */
    `CREATE OR REPLACE VIEW ticket_cost_rollup_with_children AS
     WITH RECURSIVE ticket_tree AS (
       SELECT ticket_id, ticket_id AS root_id FROM tickets WHERE parent_ticket_id IS NULL
       UNION ALL
       SELECT c.ticket_id, tt.root_id
       FROM tickets c
       JOIN ticket_tree tt ON c.parent_ticket_id = tt.ticket_id
     ),
     unique_tree_tasks AS (
       SELECT DISTINCT ON (tt.root_id, ttl.task_id) tt.root_id, ttl.task_id
       FROM ticket_tree tt
       JOIN ticket_task_links ttl ON ttl.ticket_id = tt.ticket_id
     ),
     child_counts AS (
       SELECT root_id, COUNT(*) - 1 AS child_ticket_count
       FROM ticket_tree
       GROUP BY root_id
     ),
     tree_costs AS (
       SELECT
         utt.root_id AS ticket_id,
         COALESCE(SUM(ct.total_cost), 0) AS total_cost,
         COALESCE(SUM(ct.total_input_tokens + ct.total_output_tokens), 0) AS total_tokens,
         COALESCE(SUM(ct.total_requests), 0) AS total_requests,
         COUNT(DISTINCT utt.task_id) AS task_count,
         COUNT(DISTINCT ct.agent_id) AS agent_count
       FROM unique_tree_tasks utt
       LEFT JOIN chat_tasks ct ON ct.task_id = utt.task_id
       GROUP BY utt.root_id
     ),
     all_roots AS (
       SELECT ticket_id FROM tickets WHERE parent_ticket_id IS NULL
     )
     SELECT
       ar.ticket_id,
       COALESCE(tc.total_cost, 0) AS total_cost,
       COALESCE(tc.total_tokens, 0) AS total_tokens,
       COALESCE(tc.total_requests, 0) AS total_requests,
       COALESCE(tc.task_count, 0) AS task_count,
       COALESCE(tc.agent_count, 0) AS agent_count,
       COALESCE(cc.child_ticket_count, 0) AS child_ticket_count
     FROM all_roots ar
     LEFT JOIN tree_costs tc ON tc.ticket_id = ar.ticket_id
     LEFT JOIN child_counts cc ON cc.root_id = ar.ticket_id`,

    /* ── owner-scoped RLS (A1.2): applied at the lazy-DDL chokepoint so a
       fresh database enforces isolation the moment this table is created,
       instead of waiting for the governance enforce script. Inert while the
       runtime connects as a superuser role. ─────────────────────────────── */
    ...buildOwnerRlsPolicyStatements('tickets', 'owner_sub'),
  ];
}
