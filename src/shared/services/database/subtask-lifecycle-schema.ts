/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added subtask lifecycle persistence schema for durable parent→subtask tracking
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from './schema-bootstrap-policy';

const logger = createChildLogger({ module: 'subtask-lifecycle-schema' });

let schemaReadyPromise: Promise<void> | null = null;

/**
 * @description Ensures the subtask lifecycle persistence tables exist before stores execute queries.
 * @param pool - Postgres connection pool
 * @returns Promise resolved when the subtask lifecycle schema is ready
 */
export function ensureSubtaskLifecycleSchema(pool: Pool): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = applySubtaskLifecycleSchema(pool).catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }

  return schemaReadyPromise;
}

/**
 * @description Applies idempotent SQL statements for subtask lifecycle persistence.
 * @param pool - Postgres connection pool
 * @returns Promise resolved when all schema statements have been applied
 */
async function applySubtaskLifecycleSchema(pool: Pool): Promise<void> {
  logger.info('Ensuring subtask lifecycle persistence schema');
  const statements = buildSchemaStatements();
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'subtask-lifecycle',
    statements,
    requirements: [
      { table: 'subtask_lifecycle_parents', columns: ['parent_unit_id', 'parent_data'] },
      { table: 'subtask_lifecycle_subtasks', columns: ['subtask_unit_id', 'parent_unit_id', 'state'] },
    ],
  });

  logger.info({ statementCount: statements.length }, 'Subtask lifecycle persistence schema ready');
}

/**
 * @description Returns ordered SQL statements for subtask lifecycle tracking tables.
 * Each parent is stored as a row with its work unit JSONB, and subtasks are stored
 * as individual rows referencing the parent for efficient querying.
 * @returns SQL statements
 */
function buildSchemaStatements(): string[] {
  return [
    `
      CREATE TABLE IF NOT EXISTS subtask_lifecycle_parents (
        parent_unit_id TEXT PRIMARY KEY,
        parent_data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    `
      CREATE TABLE IF NOT EXISTS subtask_lifecycle_subtasks (
        subtask_unit_id TEXT PRIMARY KEY,
        parent_unit_id TEXT NOT NULL REFERENCES subtask_lifecycle_parents(parent_unit_id) ON DELETE CASCADE,
        work_unit JSONB NOT NULL,
        state TEXT NOT NULL DEFAULT 'subtask-pending',
        last_transition_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        execution_output TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    `CREATE INDEX IF NOT EXISTS idx_subtask_lifecycle_parent ON subtask_lifecycle_subtasks(parent_unit_id)`,
    `CREATE INDEX IF NOT EXISTS idx_subtask_lifecycle_state ON subtask_lifecycle_subtasks(state)`,
  ];
}
