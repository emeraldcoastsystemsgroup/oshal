/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | applyLockedSchema(): run a schema bootstrap under a transaction-scoped Postgres advisory lock so concurrent bootstrappers (many bot containers starting at once) cannot interleave a non-atomic DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT pair and throw "constraint already exists". The lock auto-releases on COMMIT/ROLLBACK.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added workflowRun lock key for the workflow run-history schema bootstrap (workflow_runs / workflow_run_steps).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added batchJobTelemetry lock key so concurrent one-shot Job pods serialize the oshal_batch_job_runs schema bootstrap.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added spatialScans lock key (ADR-111) so the Spaces scan store's lazy schema bootstrap serializes across concurrent api starts.
 */

import type { Pool } from 'pg';

/** Stable advisory-lock keys, one per shared schema, so different schemas don't serialize on each other. */
export const SCHEMA_LOCK_KEYS = {
  workItem: 47110001,
  ticket: 47110002,
  conversation: 47110003,
  workflowRun: 47110004,
  batchJobTelemetry: 47110005,
  spatialScans: 47110006,
} as const;

/**
 * @description Apply an ordered list of DDL statements inside a single transaction guarded by a
 * transaction-scoped Postgres advisory lock. Multiple processes (e.g. every bot container) call
 * the same schema bootstrap on startup; without serialization a `DROP CONSTRAINT IF EXISTS` from
 * one and an `ADD CONSTRAINT` from another interleave and the late `ADD` errors with
 * "constraint already exists". The advisory lock makes the whole sequence run one-at-a-time
 * across processes; it is released automatically when the transaction commits or rolls back.
 * @param pool - Postgres pool
 * @param lockKey - a stable 32/64-bit integer key (see SCHEMA_LOCK_KEYS)
 * @param statements - ordered DDL statements to apply
 */
export async function applyLockedSchema(pool: Pool, lockKey: number, statements: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { /* best-effort */ });
    throw error;
  } finally {
    client.release();
  }
}
