/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Postgres-backed swarm run store with in-memory fallback for durable orchestration tracking
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { createOptionalPostgresPool, ensureSwarmRunStoreSchema } from '@/shared/services/database';
import type { IntakeProvider } from '@/shared/types';
import {
  InMemorySwarmRunStore,
  type SwarmProcessedTicketResult,
  type SwarmRunRecord,
  type SwarmRunStatus,
  type SwarmRunStore,
} from './swarm-run-store';

const logger = createChildLogger({ module: 'postgres-swarm-run-store' });

type SwarmRunCreateInput = Omit<SwarmRunRecord, 'status' | 'processed' | 'itemCount'>;

interface SwarmRunRow {
  run_id: string;
  provider: IntakeProvider;
  status: SwarmRunStatus;
  started_at: string | Date;
  completed_at: string | Date | null;
  item_count: number;
  processed: SwarmProcessedTicketResult[] | string | null;
  error: string | null;
}

/**
 * @description Swarm run store with Postgres persistence when available and in-memory fallback when it is not.
 */
export class PostgresSwarmRunStore implements SwarmRunStore {
  private readonly fallbackStore = new InMemorySwarmRunStore();
  private persistentMode = false;
  private readonly initPromise: Promise<void>;

  constructor(private pool: Pool | null = createOptionalPostgresPool('swarm-run-store')) {
    this.initPromise = this.initializePersistence();
    logger.info({ hasPool: Boolean(this.pool) }, 'Postgres swarm run store initialized');
  }

  /**
   * @description Creates a new in-progress swarm run record.
   * @param run - Initial run metadata
   * @returns Stored run record
   */
  async create(run: SwarmRunCreateInput): Promise<SwarmRunRecord> {
    const startedAt = Date.now();
    logger.info({ runId: run.runId, provider: run.provider }, 'Creating swarm run record');

    try {
      await this.awaitInitialization();
      const record = this.persistentMode ? await this.createPersistent(run) : await this.fallbackStore.create(run);
      logger.info({ runId: run.runId, persistentMode: this.persistentMode, durationMs: Date.now() - startedAt }, 'Created swarm run record');
      return cloneRunRecord(record);
    } catch (error) {
      throw this.logFailure('create', error, { runId: run.runId, provider: run.provider });
    }
  }

  /**
   * @description Marks a swarm run complete and persists final results.
   * @param runId - Run identifier
   * @param processed - Final processed ticket results
   * @returns Updated completed run record
   */
  async complete(runId: string, processed: SwarmProcessedTicketResult[]): Promise<SwarmRunRecord> {
    const startedAt = Date.now();
    logger.info({ runId, itemCount: processed.length }, 'Completing swarm run record');

    try {
      await this.awaitInitialization();
      const record = this.persistentMode
        ? await this.updatePersistent(runId, 'completed', processed, undefined)
        : await this.fallbackStore.complete(runId, processed);
      logger.info({ runId, persistentMode: this.persistentMode, durationMs: Date.now() - startedAt }, 'Completed swarm run record');
      return cloneRunRecord(record);
    } catch (error) {
      throw this.logFailure('complete', error, { runId, itemCount: processed.length });
    }
  }

  /**
   * @description Marks a swarm run failed while preserving partial processed results.
   * @param runId - Run identifier
   * @param error - Failure cause
   * @param processed - Partial processed ticket results
   * @returns Updated failed run record
   */
  async fail(runId: string, error: Error, processed: SwarmProcessedTicketResult[]): Promise<SwarmRunRecord> {
    const startedAt = Date.now();
    logger.info({ runId, itemCount: processed.length }, 'Failing swarm run record');

    try {
      await this.awaitInitialization();
      const record = this.persistentMode
        ? await this.updatePersistent(runId, 'failed', processed, error.message)
        : await this.fallbackStore.fail(runId, error, processed);
      logger.info({ runId, persistentMode: this.persistentMode, durationMs: Date.now() - startedAt }, 'Failed swarm run record persisted');
      return cloneRunRecord(record);
    } catch (caughtError) {
      throw this.logFailure('fail', caughtError, { runId, itemCount: processed.length });
    }
  }

  /**
   * @description Retrieves a swarm run record by identifier.
   * @param runId - Run identifier
   * @returns Run record when present, otherwise null
   */
  async get(runId: string): Promise<SwarmRunRecord | null> {
    const startedAt = Date.now();
    logger.info({ runId }, 'Reading swarm run record');

    try {
      await this.awaitInitialization();
      const record = this.persistentMode ? await this.getPersistent(runId) : await this.fallbackStore.get(runId);
      logger.info({ runId, found: Boolean(record), persistentMode: this.persistentMode, durationMs: Date.now() - startedAt }, 'Read swarm run record');
      return record ? cloneRunRecord(record) : null;
    } catch (error) {
      throw this.logFailure('get', error, { runId });
    }
  }

  /**
   * @description Lists recent swarm run records ordered by creation time (newest first).
   * @param limit - Maximum number of records to return
   * @returns Array of run records
   */
  async list(limit = 50): Promise<SwarmRunRecord[]> {
    const startedAt = Date.now();
    logger.info({ limit }, 'Listing swarm run records');

    try {
      await this.awaitInitialization();
      if (!this.persistentMode) {
        return this.fallbackStore.list(limit);
      }
      const query = `
        SELECT run_id, provider, status, started_at, completed_at, item_count, processed, error
        FROM swarm_runs
        ORDER BY started_at DESC
        LIMIT $1
      `;
      const result = await this.pool!.query<SwarmRunRow>(query, [limit]);
      const records = result.rows.map(mapSwarmRunRow);
      logger.info({ count: records.length, durationMs: Date.now() - startedAt }, 'Listed swarm run records');
      return records;
    } catch (error) {
      throw this.logFailure('list', error, { limit });
    }
  }

  /**
   * @description Enables Postgres-backed persistence when the database is reachable and schema creation succeeds.
   * @returns Promise resolved once persistence mode is determined
   */
  private async initializePersistence(): Promise<void> {
    if (!this.pool) {
      return;
    }

    try {
      await ensureSwarmRunStoreSchema(this.pool);
      this.persistentMode = true;
      logger.info('Swarm run store persistence mode enabled (postgres)');
    } catch (error) {
      logger.error({ err: error }, 'Swarm run store persistence init failed; falling back to memory');
      this.persistentMode = false;
      this.pool = null;
    }
  }

  /**
   * @description Waits for asynchronous persistence initialization to complete.
   * @returns Promise resolved when initialization has settled
   */
  private async awaitInitialization(): Promise<void> {
    await this.initPromise;
  }

  /**
   * @description Inserts a new run record into Postgres.
   * @param run - Initial run metadata
   * @returns Stored run record
   */
  private async createPersistent(run: SwarmRunCreateInput): Promise<SwarmRunRecord> {
    const query = `
      INSERT INTO swarm_runs (
        run_id, provider, status, started_at, completed_at, item_count, processed, error, created_at, updated_at
      ) VALUES (
        $1, $2, 'in_progress', $3::timestamptz, NULL, 0, '[]'::jsonb, NULL, NOW(), NOW()
      )
      RETURNING run_id, provider, status, started_at, completed_at, item_count, processed, error
    `;
    const result = await this.pool!.query<SwarmRunRow>(query, [run.runId, run.provider, run.startedAt]);
    return mapSwarmRunRow(result.rows[0]);
  }

  /**
   * @description Updates a persisted run into a terminal state in Postgres.
   * @param runId - Run identifier
   * @param status - Terminal run status
   * @param processed - Processed ticket results to persist
   * @param errorMessage - Optional failure message
   * @returns Updated run record
   */
  private async updatePersistent(
    runId: string,
    status: 'completed' | 'failed',
    processed: SwarmProcessedTicketResult[],
    errorMessage?: string,
  ): Promise<SwarmRunRecord> {
    const query = `
      UPDATE swarm_runs
      SET
        status = $2,
        completed_at = $3::timestamptz,
        item_count = $4,
        processed = $5::jsonb,
        error = $6,
        updated_at = NOW()
      WHERE run_id = $1
      RETURNING run_id, provider, status, started_at, completed_at, item_count, processed, error
    `;
    const params = [runId, status, new Date().toISOString(), processed.length, JSON.stringify(processed), errorMessage ?? null];
    const result = await this.pool!.query<SwarmRunRow>(query, params);
    return requireRunRow(result.rows[0], runId);
  }

  /**
   * @description Retrieves one persisted run record from Postgres.
   * @param runId - Run identifier
   * @returns Run record or null
   */
  private async getPersistent(runId: string): Promise<SwarmRunRecord | null> {
    const query = `
      SELECT run_id, provider, status, started_at, completed_at, item_count, processed, error
      FROM swarm_runs
      WHERE run_id = $1
      LIMIT 1
    `;
    const result = await this.pool!.query<SwarmRunRow>(query, [runId]);
    return result.rows[0] ? mapSwarmRunRow(result.rows[0]) : null;
  }

  /**
   * @description Logs a public-operation store failure and normalizes the thrown error type.
   * @param action - Operation name
   * @param error - Unknown throwable
   * @param context - Structured log context
   * @returns Normalized error
   */
  private logFailure(action: string, error: unknown, context: Record<string, unknown>): Error {
    const normalizedError = toError(error);
    logger.error({ err: normalizedError, action, ...context }, 'Swarm run store operation failed');
    return normalizedError;
  }
}

/**
 * @description Maps a database row into the swarm run domain type.
 * @param row - Database row
 * @returns Swarm run record
 */
function mapSwarmRunRow(row: SwarmRunRow): SwarmRunRecord {
  return {
    runId: row.run_id,
    provider: row.provider,
    status: row.status,
    startedAt: toIsoString(row.started_at),
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
    itemCount: normalizeItemCount(row.item_count),
    processed: parseProcessedResults(row.processed),
    error: row.error ?? undefined,
  };
}

/**
 * @description Requires an updated row result and converts it into a swarm run record.
 * @param row - Optional row returned from an update query
 * @param runId - Run identifier used for the query
 * @returns Swarm run record
 * @throws Error when the run record does not exist
 */
function requireRunRow(row: SwarmRunRow | undefined, runId: string): SwarmRunRecord {
  if (!row) {
    throw new Error(`Swarm run not found: ${runId}`);
  }

  return mapSwarmRunRow(row);
}

/**
 * @description Normalizes processed ticket JSON into cloned typed records.
 * @param value - Raw database JSON payload
 * @returns Processed ticket results array
 */
function parseProcessedResults(value: SwarmRunRow['processed']): SwarmProcessedTicketResult[] {
  if (Array.isArray(value)) {
    return cloneProcessedResults(value);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    return cloneProcessedResults(JSON.parse(value) as SwarmProcessedTicketResult[]);
  }

  return [];
}

/**
 * @description Creates a defensive clone of processed ticket results.
 * @param processed - Processed ticket results
 * @returns Cloned ticket results
 */
function cloneProcessedResults(processed: SwarmProcessedTicketResult[]): SwarmProcessedTicketResult[] {
  return JSON.parse(JSON.stringify(processed)) as SwarmProcessedTicketResult[];
}

/**
 * @description Creates a defensive clone of a swarm run record.
 * @param record - Swarm run record
 * @returns Cloned run record
 */
function cloneRunRecord(record: SwarmRunRecord): SwarmRunRecord {
  return {
    ...record,
    processed: cloneProcessedResults(record.processed),
  };
}

/**
 * @description Converts database timestamps into ISO strings.
 * @param value - Timestamp value from the database
 * @returns ISO string
 */
function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * @description Normalizes item counts from database values.
 * @param value - Raw item count value
 * @returns Integer item count
 */
function normalizeItemCount(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * @description Normalizes unknown throwables to Error instances.
 * @param error - Unknown throwable
 * @returns Error instance
 */
function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === 'string' ? error : 'Unknown swarm run store error');
}
