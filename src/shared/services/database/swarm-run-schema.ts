/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added swarm run persistence schema bootstrap for durable orchestration run tracking
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from './schema-bootstrap-policy';

const logger = createChildLogger({ module: 'swarm-run-schema' });

let schemaReadyPromise: Promise<void> | null = null;

/**
 * @description Ensures the swarm run persistence tables exist before swarm run stores execute queries.
 * @param pool - Postgres connection pool
 * @returns Promise resolved when the swarm run schema is ready
 */
export function ensureSwarmRunStoreSchema(pool: Pool): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = applySwarmRunSchema(pool).catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }

  return schemaReadyPromise;
}

/**
 * @description Applies idempotent SQL statements for swarm run persistence.
 * @param pool - Postgres connection pool
 * @returns Promise resolved when all schema statements have been applied
 */
async function applySwarmRunSchema(pool: Pool): Promise<void> {
  logger.info('Ensuring swarm run persistence schema');
  const statements = buildSchemaStatements();
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'swarm-run',
    statements,
    requirements: [
      { table: 'swarm_runs', columns: ['run_id', 'provider', 'status', 'updated_at'] },
    ],
  });

  logger.info({ statementCount: statements.length }, 'Swarm run persistence schema ready');
}

/**
 * @description Returns ordered SQL statements required for durable swarm run tracking.
 * @returns SQL statements
 */
function buildSchemaStatements(): string[] {
  return [
    `
      CREATE TABLE IF NOT EXISTS swarm_runs (
        run_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'in_progress'
          CHECK (status IN ('in_progress', 'completed', 'failed')),
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ,
        item_count INTEGER NOT NULL DEFAULT 0,
        processed JSONB NOT NULL DEFAULT '[]'::jsonb,
        error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    `CREATE INDEX IF NOT EXISTS idx_swarm_runs_provider_started ON swarm_runs(provider, started_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_swarm_runs_status_updated ON swarm_runs(status, updated_at DESC)`,
  ];
}
