/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial batch-job telemetry store so one-shot Job pods persist runtime, resource, worker, and error data for later reports instead of only logging it.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { runRuntimeSchemaBootstrap } from '@/shared/services/database/schema-bootstrap-policy';
import { SCHEMA_LOCK_KEYS } from '@/shared/services/database/schema-lock';
import { buildOwnerRlsPolicyStatements } from '@/shared/services/database/owner-rls-policy';

const logger = createChildLogger({ module: 'batch-job-telemetry-store' });

export type BatchJobStatus = 'running' | 'succeeded' | 'failed';

export interface BatchJobTelemetryInput {
  jobId: string;
  ticketId: string;
  ownerSub?: string | null;
  agentId: string;
  phase: string;
  queueName: string;
  workerId: string;
  status: BatchJobStatus;
  startedAt: Date;
  endedAt?: Date | null;
  durationMs?: number | null;
  processorCount?: number | null;
  cpuRequestCores?: number | null;
  cpuLimitCores?: number | null;
  cpuUsageUserMicros?: number | null;
  cpuUsageSystemMicros?: number | null;
  memoryUsageBytes?: number | null;
  memoryRssBytes?: number | null;
  backendError?: string | null;
  provider?: string | null;
  model?: string | null;
  costUsd?: number | null;
  metadata?: Record<string, unknown>;
}

export interface BatchJobTelemetryRecord {
  jobId: string;
  ticketId: string;
  ownerSub: string | null;
  agentId: string;
  phase: string;
  queueName: string;
  workerId: string;
  status: BatchJobStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  processorCount: number | null;
  cpuRequestCores: number | null;
  cpuLimitCores: number | null;
  cpuUsageUserMicros: number | null;
  cpuUsageSystemMicros: number | null;
  memoryUsageBytes: number | null;
  memoryRssBytes: number | null;
  backendError: string | null;
  provider: string | null;
  model: string | null;
  costUsd: number | null;
  metadata: unknown;
}

export interface BatchTelemetryListOptions {
  ownerSub?: string;
  includeUnowned?: boolean;
  since?: Date;
  until?: Date;
  ticketId?: string;
  limit?: number;
}

export class BatchJobTelemetryStore {
  private schemaReady: Promise<void> | null = null;

  constructor(private readonly pool: Pool) {}

  /**
   * @description Persist a batch Job telemetry row. Non-throwing by design: a telemetry failure
   * must never fail the Job pod that just completed useful work.
   * @param input - Batch job runtime/resource telemetry.
   * @returns whether the row was persisted.
   */
  async record(input: BatchJobTelemetryInput): Promise<boolean> {
    try {
      await this.ensureSchema();
      await this.pool.query(
        `INSERT INTO oshal_batch_job_runs (
           job_id, ticket_id, owner_sub, agent_id, phase, queue_name, worker_id, status,
           started_at, ended_at, duration_ms, processor_count, cpu_request_cores, cpu_limit_cores,
           cpu_usage_user_micros, cpu_usage_system_micros, memory_usage_bytes, memory_rss_bytes,
           backend_error, provider, model, cost_usd, metadata
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23
         )
         ON CONFLICT (job_id) DO UPDATE SET
           status = EXCLUDED.status,
           ended_at = EXCLUDED.ended_at,
           duration_ms = EXCLUDED.duration_ms,
           cpu_usage_user_micros = EXCLUDED.cpu_usage_user_micros,
           cpu_usage_system_micros = EXCLUDED.cpu_usage_system_micros,
           memory_usage_bytes = EXCLUDED.memory_usage_bytes,
           memory_rss_bytes = EXCLUDED.memory_rss_bytes,
           backend_error = EXCLUDED.backend_error,
           provider = EXCLUDED.provider,
           model = EXCLUDED.model,
           cost_usd = EXCLUDED.cost_usd,
           metadata = oshal_batch_job_runs.metadata || EXCLUDED.metadata,
           updated_at = NOW()`,
        toInsertValues(input),
      );
      return true;
    } catch (error) {
      logger.warn({ err: error, jobId: input.jobId, ticketId: input.ticketId }, 'Failed to record batch job telemetry');
      return false;
    }
  }

  /**
   * @description List recent batch Job telemetry rows for reports.
   * @param options - Time window, owner scope, and optional ticket filter.
   * @returns recent records ordered newest first.
   */
  async listRecent(options: BatchTelemetryListOptions = {}): Promise<BatchJobTelemetryRecord[]> {
    await this.ensureSchema();
    const where: string[] = [];
    const values: unknown[] = [];
    addScope(where, values, options);
    if (options.since) {
      values.push(options.since);
      where.push(`started_at >= $${values.length}`);
    }
    if (options.until) {
      values.push(options.until);
      where.push(`started_at <= $${values.length}`);
    }
    if (options.ticketId) {
      values.push(options.ticketId);
      where.push(`ticket_id = $${values.length}`);
    }
    values.push(clampLimit(options.limit));
    const result = await this.pool.query(
      `SELECT * FROM oshal_batch_job_runs
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY started_at DESC
       LIMIT $${values.length}`,
      values,
    );
    return result.rows.map(mapRow);
  }

  private ensureSchema(): Promise<void> {
    if (!this.schemaReady) {
      this.schemaReady = runRuntimeSchemaBootstrap({
        pool: this.pool,
        moduleName: 'batch-job-telemetry',
        statements: buildBatchJobTelemetrySchema(),
        lockKey: SCHEMA_LOCK_KEYS.batchJobTelemetry,
        requirements: [
          { table: 'oshal_batch_job_runs', columns: ['job_id', 'ticket_id', 'status', 'started_at'] },
        ],
      }).then(() => undefined).catch((error) => {
        this.schemaReady = null;
        throw error;
      });
    }
    return this.schemaReady;
  }
}

/**
 * @description Build the runtime schema statements shared by lazy bootstrap and migration.
 * @returns ordered DDL statements.
 */
export function buildBatchJobTelemetrySchema(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS oshal_batch_job_runs (
      job_id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      owner_sub TEXT,
      agent_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      queue_name TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ,
      duration_ms INTEGER,
      processor_count INTEGER,
      cpu_request_cores NUMERIC,
      cpu_limit_cores NUMERIC,
      cpu_usage_user_micros BIGINT,
      cpu_usage_system_micros BIGINT,
      memory_usage_bytes BIGINT,
      memory_rss_bytes BIGINT,
      backend_error TEXT,
      provider TEXT,
      model TEXT,
      cost_usd NUMERIC,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE INDEX IF NOT EXISTS idx_batch_job_runs_started ON oshal_batch_job_runs(started_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_batch_job_runs_ticket ON oshal_batch_job_runs(ticket_id)`,
    `CREATE INDEX IF NOT EXISTS idx_batch_job_runs_owner_started ON oshal_batch_job_runs(owner_sub, started_at DESC) WHERE owner_sub IS NOT NULL`,
    ...buildOwnerRlsPolicyStatements('oshal_batch_job_runs', 'owner_sub'),
  ];
}

function toInsertValues(input: BatchJobTelemetryInput): unknown[] {
  return [
    input.jobId, input.ticketId, input.ownerSub ?? null, input.agentId, input.phase,
    input.queueName, input.workerId, input.status, input.startedAt, input.endedAt ?? null,
    input.durationMs ?? null, input.processorCount ?? null, input.cpuRequestCores ?? null,
    input.cpuLimitCores ?? null, input.cpuUsageUserMicros ?? null, input.cpuUsageSystemMicros ?? null,
    input.memoryUsageBytes ?? null, input.memoryRssBytes ?? null, input.backendError ?? null,
    input.provider ?? null, input.model ?? null, input.costUsd ?? null, input.metadata ?? {},
  ];
}

function addScope(where: string[], values: unknown[], options: BatchTelemetryListOptions): void {
  if (!options.ownerSub) return;
  values.push(options.ownerSub);
  const ownerClause = `owner_sub = $${values.length}`;
  where.push(options.includeUnowned ? `(${ownerClause} OR owner_sub IS NULL)` : ownerClause);
}

function clampLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return 100;
  return Math.min(Math.max(Math.trunc(limit ?? 100), 1), 500);
}

function mapRow(row: Record<string, unknown>): BatchJobTelemetryRecord {
  return {
    jobId: String(row.job_id),
    ticketId: String(row.ticket_id),
    ownerSub: row.owner_sub ? String(row.owner_sub) : null,
    agentId: String(row.agent_id),
    phase: String(row.phase),
    queueName: String(row.queue_name),
    workerId: String(row.worker_id),
    status: row.status as BatchJobStatus,
    startedAt: new Date(row.started_at as string).toISOString(),
    endedAt: row.ended_at ? new Date(row.ended_at as string).toISOString() : null,
    durationMs: numberOrNull(row.duration_ms),
    processorCount: numberOrNull(row.processor_count),
    cpuRequestCores: numberOrNull(row.cpu_request_cores),
    cpuLimitCores: numberOrNull(row.cpu_limit_cores),
    cpuUsageUserMicros: numberOrNull(row.cpu_usage_user_micros),
    cpuUsageSystemMicros: numberOrNull(row.cpu_usage_system_micros),
    memoryUsageBytes: numberOrNull(row.memory_usage_bytes),
    memoryRssBytes: numberOrNull(row.memory_rss_bytes),
    backendError: row.backend_error ? String(row.backend_error) : null,
    provider: row.provider ? String(row.provider) : null,
    model: row.model ? String(row.model) : null,
    costUsd: numberOrNull(row.cost_usd),
    metadata: row.metadata ?? {},
  };
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
