/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added swarm escalation persistence schema bootstrap for durable escalation routing
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from './schema-bootstrap-policy';

const logger = createChildLogger({ module: 'swarm-escalation-schema' });

let schemaReadyPromise: Promise<void> | null = null;

/**
 * @description Ensures the swarm escalation persistence tables exist before escalation stores execute queries.
 * @param pool - Postgres connection pool
 * @returns Promise resolved when the swarm escalation schema is ready
 */
export function ensureSwarmEscalationStoreSchema(pool: Pool): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = applySwarmEscalationSchema(pool).catch((error) => {
      schemaReadyPromise = null;
      throw error;
    });
  }

  return schemaReadyPromise;
}

/**
 * @description Applies idempotent SQL statements for swarm escalation persistence.
 * @param pool - Postgres connection pool
 * @returns Promise resolved when all schema statements have been applied
 */
async function applySwarmEscalationSchema(pool: Pool): Promise<void> {
  logger.info('Ensuring swarm escalation persistence schema');
  const statements = buildSchemaStatements();
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'swarm-escalation',
    statements,
    requirements: [
      { table: 'swarm_escalations', columns: ['id', 'run_id', 'ticket_external_id', 'target', 'reason'] },
    ],
  });

  logger.info({ statementCount: statements.length }, 'Swarm escalation persistence schema ready');
}

/**
 * @description Returns ordered SQL statements required for durable swarm escalation tracking.
 * @returns SQL statements
 */
function buildSchemaStatements(): string[] {
  return [
    `
      CREATE TABLE IF NOT EXISTS swarm_escalations (
        id SERIAL PRIMARY KEY,
        run_id TEXT NOT NULL,
        ticket_external_id TEXT NOT NULL,
        target TEXT NOT NULL CHECK (target IN ('human_review', 'team_lead', 'ops_channel')),
        severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
        retry_class TEXT NOT NULL CHECK (retry_class IN ('transient', 'deterministic', 'timeout', 'resource')),
        reason TEXT NOT NULL,
        attempt_state JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    `CREATE INDEX IF NOT EXISTS idx_swarm_escalations_run_id ON swarm_escalations(run_id)`,
    `CREATE INDEX IF NOT EXISTS idx_swarm_escalations_target_severity ON swarm_escalations(target, severity, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_swarm_escalations_ticket ON swarm_escalations(ticket_external_id, created_at DESC)`,
  ];
}
