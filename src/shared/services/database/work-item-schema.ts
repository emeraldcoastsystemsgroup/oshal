/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added work item persistence schema bootstrap for internal swarm work unit tracking
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added 2-level hierarchical decomposition: parent_id, depth, subtask statuses
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Session 140: Added routing_failed to CHECK constraint (C2)
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added idempotent constraint refresh so existing work_items tables accept routing_failed during startup migration
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from './schema-bootstrap-policy';
import { SCHEMA_LOCK_KEYS } from './schema-lock';

const logger = createChildLogger({ module: 'work-item-schema' });

let schemaReadyPromise: Promise<void> | null = null;

/**
 * @description Ensures the work items table exists before repository queries execute.
 * @param pool - Postgres connection pool
 * @returns Promise resolved when the work item schema is ready
 */
export function ensureWorkItemSchema(pool: Pool): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = applyWorkItemSchema(pool).catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }
  return schemaReadyPromise;
}

/**
 * @description Applies idempotent SQL statements for work item persistence.
 * @param pool - Postgres connection pool
 * @returns Promise resolved when all schema statements have been applied
 */
async function applyWorkItemSchema(pool: Pool): Promise<void> {
  logger.info('Ensuring work item persistence schema');
  const statements = buildSchemaStatements();
  // Serialize concurrent bootstrappers (every bot starts at once) so the DROP/ADD CONSTRAINT
  // pair can't interleave across connections and throw "constraint already exists".
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'work-item',
    statements,
    lockKey: SCHEMA_LOCK_KEYS.workItem,
    requirements: [
      {
        table: 'work_items',
        columns: ['work_item_id', 'swarm_run_id', 'assigned_agent_id', 'run_id', 'status', 'metadata'],
      },
    ],
  });
  logger.info({ statementCount: statements.length }, 'Work item persistence schema ready');
}

/**
 * @description Returns ordered SQL statements for the work_items table.
 * @returns SQL statements
 */
function buildSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS work_items (
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
          'subtask-completed', 'subtask-failed',
          'routing_failed'
        )),
      run_id TEXT,
      execution_output JSONB,
      verification_result JSONB,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    /* ── work_items: idempotent add run_id for existing tables ──── */
    `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS run_id TEXT`,
    `ALTER TABLE work_items DROP CONSTRAINT IF EXISTS work_items_status_check`,
    `ALTER TABLE work_items ADD CONSTRAINT work_items_status_check CHECK (status IN (
      'pending', 'assigned', 'executing', 'completed', 'failed', 'escalated',
      'in-review',
      'subtask-pending', 'subtask-assigned', 'subtask-executing',
      'subtask-completed', 'subtask-failed',
      'routing_failed'
    ))`,
    `CREATE INDEX IF NOT EXISTS idx_work_items_run ON work_items(swarm_run_id)`,
    `CREATE INDEX IF NOT EXISTS idx_work_items_agent_status ON work_items(assigned_agent_id, status)`,
    `CREATE INDEX IF NOT EXISTS idx_work_items_external ON work_items(external_id, provider)`,
    `CREATE INDEX IF NOT EXISTS idx_work_items_parent ON work_items(parent_id) WHERE parent_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_work_items_depth_status ON work_items(depth, status)`,
  ];
}
