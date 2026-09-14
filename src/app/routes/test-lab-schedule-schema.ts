/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ | AUTHOR | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Persist disabled-by-default exact-principal schedules and one durable local batch lease.
 */
import type { Pool } from 'pg';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database';

export const TEST_LAB_SCHEDULE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS oshal_test_lab_schedules (
    id UUID PRIMARY KEY, issuer TEXT NOT NULL, user_sub TEXT NOT NULL, app_name TEXT NOT NULL,
    levels JSONB NOT NULL, cadence TEXT NOT NULL CHECK(cadence IN ('hourly','daily','weekly')),
    enabled BOOLEAN NOT NULL DEFAULT FALSE, revision INTEGER NOT NULL DEFAULT 1,
    next_run_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(issuer,user_sub,app_name), CHECK(revision>0))`,
  `CREATE TABLE IF NOT EXISTS oshal_test_lab_schedule_batches (
    id UUID PRIMARY KEY, schedule_id UUID NOT NULL REFERENCES oshal_test_lab_schedules(id), issuer TEXT NOT NULL,
    user_sub TEXT NOT NULL, request_id UUID NOT NULL, schedule_revision INTEGER NOT NULL, one_off BOOLEAN NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','completed','cancelled','interrupted')), summary JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_until TIMESTAMPTZ NOT NULL DEFAULT NOW()+INTERVAL '60 seconds', UNIQUE(issuer,user_sub,request_id))`,
  `CREATE UNIQUE INDEX IF NOT EXISTS test_lab_schedule_batch_capacity ON oshal_test_lab_schedule_batches((true)) WHERE state='running'`,
  `CREATE INDEX IF NOT EXISTS test_lab_schedule_due ON oshal_test_lab_schedules(next_run_at) WHERE enabled`,
  `CREATE INDEX IF NOT EXISTS test_lab_schedule_history ON oshal_test_lab_schedule_batches(issuer,user_sub,schedule_id,created_at DESC)`,
  ...['oshal_test_lab_schedules','oshal_test_lab_schedule_batches'].flatMap(table => [
    `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`, `ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`,
    `DROP POLICY IF EXISTS test_lab_schedule_control ON ${table}`,
    `CREATE POLICY test_lab_schedule_control ON ${table} USING(current_setting('oshal.is_operator',true)='on')
      WITH CHECK(current_setting('oshal.is_operator',true)='on')`,
  ]),
];

/** @description Initialize the scheduling control plane before enabling timers or accepting requests.
 * @param pool Trusted core pool. @returns Readiness or a failure which keeps schedules unavailable. */
export async function ensureTestLabScheduleSchema(pool: Pool): Promise<void> {
  await runRuntimeSchemaBootstrap({ pool, moduleName: 'Test Lab local schedules', lockKey: 7149137,
    statements: TEST_LAB_SCHEDULE_STATEMENTS, requirements: [
      { table: 'oshal_test_lab_schedules', columns: ['id','issuer','user_sub','app_name','levels','cadence','enabled','revision','next_run_at'] },
      { table: 'oshal_test_lab_schedule_batches', columns: ['id','schedule_id','issuer','user_sub','request_id','schedule_revision','one_off','state','summary','lease_until'] },
    ] });
}
