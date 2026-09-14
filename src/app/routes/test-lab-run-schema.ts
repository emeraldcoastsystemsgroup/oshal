/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Bootstrap durable Test Lab run evidence behind the existing control-plane RLS fence.
 */
import type { Pool } from 'pg';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';

export const TEST_LAB_RUN_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS oshal_test_lab_runs (
    id UUID PRIMARY KEY, issuer TEXT NOT NULL, user_sub TEXT NOT NULL, request_id UUID NOT NULL,
    app_name TEXT NOT NULL, case_id TEXT NOT NULL, state TEXT NOT NULL,
    test JSONB NOT NULL, result JSONB, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), lease_until TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '60 seconds',
    UNIQUE(issuer,user_sub,request_id), CHECK(state IN ('queued','running','cancelling','passed','failed','pending','cancelled','interrupted')))`,
  `CREATE INDEX IF NOT EXISTS test_lab_run_history ON oshal_test_lab_runs(issuer,user_sub,created_at DESC,id DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS test_lab_run_active ON oshal_test_lab_runs(issuer,user_sub,case_id)
    WHERE state IN ('queued','running','cancelling')`,
  `CREATE UNIQUE INDEX IF NOT EXISTS test_lab_run_capacity ON oshal_test_lab_runs((true)) WHERE state IN ('queued','running','cancelling')`,
  'ALTER TABLE oshal_test_lab_runs ENABLE ROW LEVEL SECURITY',
  'ALTER TABLE oshal_test_lab_runs FORCE ROW LEVEL SECURITY',
  'DROP POLICY IF EXISTS test_lab_control_plane ON oshal_test_lab_runs',
  `CREATE POLICY test_lab_control_plane ON oshal_test_lab_runs USING(current_setting('oshal.is_operator',true)='on')
    WITH CHECK(current_setting('oshal.is_operator',true)='on')`,
];

/** @description Initialize versioned run evidence before accepting execution.
 * @param pool Trusted core PostgreSQL pool under system identity.
 * @returns Schema readiness, or a failure that keeps the runner unavailable.
 */
export async function ensureTestLabRunSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({ pool, moduleName: 'Test Lab run history', lockKey: 7149136,
    statements: TEST_LAB_RUN_STATEMENTS, requirements: [{ table: 'oshal_test_lab_runs',
      columns: ['id','issuer','user_sub','request_id','app_name','case_id','state','test','result','created_at','updated_at','lease_until'] }] });
}
