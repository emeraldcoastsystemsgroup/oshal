/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Add the locked runtime schema for durable remote tasks, their append-only event journal, 30-day terminal tombstones, and the transactional dispatch/settlement outbox.
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Persist remote-client owner bindings and atomic cost-effect receipts so owner changes cannot race task assignment and outbox replay cannot double bill.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { buildOwnerRlsPolicyStatements } from './owner-rls-policy';
import { runRuntimeSchemaBootstrap } from './schema-bootstrap-policy';
import { SCHEMA_LOCK_KEYS } from './schema-lock';

const logger = createChildLogger({ module: 'remote-task-journal-schema' });
let schemaReadyPromise: Promise<void> | null = null;

const CLIENT_OWNER_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS remote_task_journal_client_owners (
    client_id TEXT PRIMARY KEY CHECK (length(btrim(client_id)) > 0),
    owner_sub TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

const TASK_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS remote_task_journal_tasks (
    task_id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL CHECK (length(btrim(client_id)) > 0),
    owner_sub TEXT,
    correlation_id TEXT NOT NULL CHECK (length(btrim(correlation_id)) > 0),
    envelope JSONB NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
    status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'completed', 'failed')),
    claimed_by_client_id TEXT,
    claimed_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ,
    terminal_result JSONB,
    tombstone_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT remote_task_journal_state_shape CHECK (
      (status = 'queued' AND claimed_by_client_id IS NULL AND claimed_at IS NULL
        AND settled_at IS NULL AND terminal_result IS NULL AND tombstone_expires_at IS NULL)
      OR (status = 'claimed' AND claimed_by_client_id = client_id AND claimed_at IS NOT NULL
        AND settled_at IS NULL AND terminal_result IS NULL AND tombstone_expires_at IS NULL)
      OR (status IN ('completed', 'failed') AND claimed_by_client_id = client_id
        AND claimed_at IS NOT NULL AND settled_at IS NOT NULL
        AND terminal_result IS NOT NULL AND tombstone_expires_at IS NOT NULL)
    )
  )
`;

const EVENT_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS remote_task_journal_events (
    event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES remote_task_journal_tasks(task_id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    owner_sub TEXT,
    sequence_number INTEGER NOT NULL CHECK (sequence_number > 0),
    event_type TEXT NOT NULL CHECK (event_type IN (
      'task.queued', 'task.claimed', 'task.completed', 'task.failed'
    )),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT remote_task_journal_event_sequence UNIQUE (task_id, sequence_number)
  )
`;

const OUTBOX_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS remote_task_journal_outbox (
    outbox_id UUID PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES remote_task_journal_tasks(task_id) ON DELETE CASCADE,
    event_id BIGINT NOT NULL REFERENCES remote_task_journal_events(event_id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    owner_sub TEXT,
    topic TEXT NOT NULL CHECK (topic IN ('remote-task.dispatch', 'remote-task.settlement')),
    payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    CONSTRAINT remote_task_outbox_delivery_time CHECK (
      delivered_at IS NULL OR delivered_at >= created_at
    )
  )
`;

const COST_RECEIPT_TABLE_SQL = `
  -- No outbox FK: delivery locks the parent while its publisher commits this receipt separately.
  CREATE TABLE IF NOT EXISTS remote_task_cost_receipts (
    outbox_id UUID PRIMARY KEY,
    task_id TEXT NOT NULL,
    owner_sub TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

const IMMUTABLE_EVENT_TRIGGER_SQL = `
  CREATE OR REPLACE FUNCTION oshal_reject_remote_task_event_mutation()
  RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF TG_OP = 'UPDATE' OR pg_trigger_depth() = 1 THEN
      RAISE EXCEPTION 'remote task journal events are append-only';
    END IF;
    RETURN OLD;
  END
  $$
`;

const INSTALL_EVENT_TRIGGER_SQL = `
  DROP TRIGGER IF EXISTS remote_task_journal_events_immutable ON remote_task_journal_events;
  CREATE TRIGGER remote_task_journal_events_immutable
    BEFORE UPDATE OR DELETE ON remote_task_journal_events
    FOR EACH ROW EXECUTE FUNCTION oshal_reject_remote_task_event_mutation()
`;

/**
 * @description Ensures the durable task journal schema is present before the repository runs.
 * @param pool - PostgreSQL pool owned by the control plane.
 * @returns Promise resolved only when all required tables and columns are ready.
 */
export function ensureRemoteTaskJournalSchema(pool: Pool): Promise<void> {
  if (!schemaReadyPromise) {
    schemaReadyPromise = applyRemoteTaskJournalSchema(pool).catch((error) => {
      logger.error({ err: error }, 'Remote task journal schema bootstrap failed');
      schemaReadyPromise = null;
      throw error;
    });
  }
  return schemaReadyPromise;
}

/** @description Applies the ordered schema under its cross-process advisory lock. */
async function applyRemoteTaskJournalSchema(pool: Pool): Promise<void> {
  const startedAt = Date.now();
  logger.info('Ensuring remote task journal schema');
  const statements = buildSchemaStatements();
  await runRuntimeSchemaBootstrap({
    pool,
    moduleName: 'remote-task-journal',
    statements,
    lockKey: SCHEMA_LOCK_KEYS.remoteTaskJournal,
    requirements: schemaRequirements(),
  });
  logger.info({ statementCount: statements.length, durationMs: Date.now() - startedAt }, 'Remote task journal schema ready');
}

/** @description Returns the ordered, idempotent DDL for local runtime bootstrap. */
function buildSchemaStatements(): string[] {
  return [
    CLIENT_OWNER_TABLE_SQL,
    TASK_TABLE_SQL,
    EVENT_TABLE_SQL,
    OUTBOX_TABLE_SQL,
    COST_RECEIPT_TABLE_SQL,
    `CREATE INDEX IF NOT EXISTS idx_remote_task_queue ON remote_task_journal_tasks(client_id, created_at, task_id) WHERE status = 'queued'`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_remote_task_one_active_per_client ON remote_task_journal_tasks(client_id) WHERE status = 'claimed'`,
    `CREATE INDEX IF NOT EXISTS idx_remote_task_tombstones ON remote_task_journal_tasks(tombstone_expires_at) WHERE status IN ('completed', 'failed')`,
    `CREATE INDEX IF NOT EXISTS idx_remote_task_events_task ON remote_task_journal_events(task_id, sequence_number)`,
    `CREATE INDEX IF NOT EXISTS idx_remote_task_outbox_pending ON remote_task_journal_outbox(created_at, outbox_id) WHERE delivered_at IS NULL`,
    IMMUTABLE_EVENT_TRIGGER_SQL,
    INSTALL_EVENT_TRIGGER_SQL,
    ...buildOwnerRlsPolicyStatements('remote_task_journal_tasks', 'owner_sub'),
    ...buildOwnerRlsPolicyStatements('remote_task_journal_client_owners', 'owner_sub'),
    ...buildOwnerRlsPolicyStatements('remote_task_journal_events', 'owner_sub'),
    ...buildOwnerRlsPolicyStatements('remote_task_journal_outbox', 'owner_sub'),
    ...buildOwnerRlsPolicyStatements('remote_task_cost_receipts', 'owner_sub'),
  ];
}

/** @description Lists the minimum schema shape required by a validate-only runtime. */
function schemaRequirements(): Array<{ table: string; columns: string[] }> {
  return [
    { table: 'remote_task_journal_client_owners', columns: ['client_id', 'owner_sub', 'updated_at'] },
    { table: 'remote_task_journal_tasks', columns: ['task_id', 'client_id', 'status', 'tombstone_expires_at'] },
    { table: 'remote_task_journal_events', columns: ['event_id', 'task_id', 'sequence_number', 'event_type'] },
    { table: 'remote_task_journal_outbox', columns: ['outbox_id', 'event_id', 'topic', 'delivered_at'] },
    { table: 'remote_task_cost_receipts', columns: ['outbox_id', 'task_id', 'owner_sub'] },
  ];
}
