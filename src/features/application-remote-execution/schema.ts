/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Persist remote execution provenance under forced controller-only row security.
 */
import type { Pool } from 'pg';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';

/** @description Idempotent migration132 schema, also used on runtime bootstrap. */
export const REMOTE_EXECUTION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS oshal_application_remote_executions (
    execution_id UUID PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
  'ALTER TABLE oshal_application_remote_executions ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE oshal_application_remote_executions FORCE ROW LEVEL SECURITY',
  'DROP POLICY IF EXISTS application_remote_execution_control ON oshal_application_remote_executions',
  `CREATE POLICY application_remote_execution_control ON oshal_application_remote_executions
    USING(current_setting('oshal.is_operator',true)='on') WITH CHECK(current_setting('oshal.is_operator',true)='on')`,
  `CREATE INDEX IF NOT EXISTS application_remote_execution_task ON oshal_application_remote_executions
    ((payload->'binding'->>'taskId'),(payload->'binding'->>'sub'),(payload->'binding'->>'issuer'))`,
  `CREATE INDEX IF NOT EXISTS application_remote_execution_workspace ON oshal_application_remote_executions
    ((payload->'binding'->>'workspaceId'),(payload->'binding'->>'sub'),(payload->'binding'->>'issuer'))`,
  `CREATE INDEX IF NOT EXISTS application_remote_execution_results ON oshal_application_remote_executions USING GIN ((payload->'resultTaskIds'))`,
];
/** @description Prepare durable provenance before any protected token leaves the controller.
 * @param pool Controller database pool. @returns Completion after schema verification.
 */
export async function ensureRemoteExecutionSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({ pool, moduleName: 'Application remote execution', lockKey: 7149132,
    statements: REMOTE_EXECUTION_SCHEMA,
    requirements: [{ table: 'oshal_application_remote_executions', columns: ['execution_id', 'payload', 'updated_at'] }],
  });
}
