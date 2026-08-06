/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | applyLockedSchema(): run a schema bootstrap under a transaction-scoped Postgres advisory lock so concurrent bootstrappers (many bot containers starting at once) cannot interleave a non-atomic DROP CONSTRAINT IF EXISTS / ADD CONSTRAINT pair and throw "constraint already exists". The lock auto-releases on COMMIT/ROLLBACK.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added workflowRun lock key for the workflow run-history schema bootstrap (workflow_runs / workflow_run_steps).
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added batchJobTelemetry lock key so concurrent one-shot Job pods serialize the oshal_batch_job_runs schema bootstrap.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added spatialScans lock key (ADR-111) so the Spaces scan store's lazy schema bootstrap serializes across concurrent api starts.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Reserve a distinct advisory-lock key for the durable remote-task journal so concurrent controller starts cannot interleave table, trigger, index, and RLS creation.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Per-statement savepoints, and report privilege-denied statements instead of losing the whole bootstrap to one of them. Under ADR-076 the runtime connects as oshal_app, which is deliberately NOT the schema owner, so owner-only DDL (CREATE OR REPLACE FUNCTION, CREATE POLICY, ALTER TABLE … ENABLE RLS) raises 42501. One transaction meant the FIRST such statement rolled back every statement before it and skipped every statement after it — on the remote-task journal that was the immutability trigger plus the owner-RLS policies for five tables, silently never attempted, while the caller caught the error and the app served traffic. Savepoints make each statement independently skippable, so a non-owner runtime applies everything it is entitled to and reports what it could not. Callers assert their requirements afterwards, so a genuinely missing schema still fails loudly rather than passing as "skipped".
 */

import type { Pool } from 'pg';

/** Postgres SQLSTATE for insufficient_privilege — the owner-only DDL case under an app role. */
const INSUFFICIENT_PRIVILEGE = '42501';

/** Outcome of a bootstrap: what ran, and what the current role was not entitled to run. */
export interface LockedSchemaResult {
  /** Statements the role could not execute (42501 only). Empty on an owner/dev connection. */
  privilegeDenied: string[];
}

/** Stable advisory-lock keys, one per shared schema, so different schemas don't serialize on each other. */
export const SCHEMA_LOCK_KEYS = {
  workItem: 47110001,
  ticket: 47110002,
  conversation: 47110003,
  workflowRun: 47110004,
  batchJobTelemetry: 47110005,
  spatialScans: 47110006,
  remoteTaskJournal: 47110007,
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
export async function applyLockedSchema(
  pool: Pool,
  lockKey: number,
  statements: string[],
): Promise<LockedSchemaResult> {
  const client = await pool.connect();
  const privilegeDenied: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
    for (const statement of statements) {
      // A failed statement aborts the whole transaction in Postgres — "catch and continue" is not
      // possible without a savepoint to roll back to. One savepoint per statement is what makes
      // an owner-only statement skippable instead of fatal to everything around it.
      await client.query('SAVEPOINT oshal_schema_stmt');
      try {
        await client.query(statement);
        await client.query('RELEASE SAVEPOINT oshal_schema_stmt');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT oshal_schema_stmt');
        // ONLY privilege is tolerated. A syntax error, a type mismatch, a missing dependency —
        // every other failure is a real defect and must still abort, exactly as before.
        if ((error as { code?: string }).code !== INSUFFICIENT_PRIVILEGE) throw error;
        privilegeDenied.push(statement);
      }
    }
    await client.query('COMMIT');
    return { privilegeDenied };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { /* best-effort */ });
    throw error;
  } finally {
    client.release();
  }
}
