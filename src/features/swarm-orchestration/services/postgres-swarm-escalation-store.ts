/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Postgres-backed swarm escalation store with in-memory fallback for durable escalation routing
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Re-attempt persistence instead of nulling the pool: the same shape that dropped the task, message and memory stores to in-memory for a whole process lifetime on the 2026-09-15 boot. Activation runs through the shared re-attemptable helper, the pool is kept so a retry has something to retry with, and the fallback is now a state the next operation can leave.
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import {
  createOptionalPostgresPool,
  createPersistenceActivation,
  ensureSwarmEscalationStoreSchema,
  type PersistenceActivation,
} from '@/shared/services/database';
import type { SwarmEscalationRecord, SwarmVerificationAttemptState } from './swarm-cycle-policy';
import { InMemorySwarmEscalationStore, type SwarmEscalationQuery, type SwarmEscalationStore } from './swarm-escalation-store';

const logger = createChildLogger({ module: 'postgres-swarm-escalation-store' });

interface SwarmEscalationRow {
  id: number;
  run_id: string;
  ticket_external_id: string;
  target: string;
  severity: string;
  retry_class: string;
  reason: string;
  attempt_state: SwarmVerificationAttemptState | string;
  created_at: string | Date;
}

/**
 * @description Swarm escalation store with Postgres persistence when available and in-memory fallback when it is not.
 */
export class PostgresSwarmEscalationStore implements SwarmEscalationStore {
  private readonly fallbackStore = new InMemorySwarmEscalationStore();
  private persistentMode = false;
  private readonly activation: PersistenceActivation;

  constructor(private readonly pool: Pool | null = createOptionalPostgresPool('swarm-escalation-store')) {
    this.activation = createPersistenceActivation({
      store: 'swarm-escalation-store',
      pool: this.pool,
      activate: ensureSwarmEscalationStoreSchema,
    });
    // Attempt activation at boot exactly as before. The difference is what a failure means:
    // it is observed here rather than cached, and the next operation re-attempts it.
    void this.activation.ready();
    logger.info({ hasPool: Boolean(this.pool) }, 'Postgres swarm escalation store initialized');
  }

  /**
   * @description Persists one escalation record.
   * @param record - Structured escalation record
   */
  async save(record: SwarmEscalationRecord): Promise<void> {
    await this.awaitInitialization();
    if (!this.persistentMode) {
      return this.fallbackStore.save(record);
    }
    await this.savePersistent(record);
  }

  /**
   * @description Lists escalation records matching query criteria.
   * @param query - Filter criteria
   * @returns Matching escalation records
   */
  async list(query: SwarmEscalationQuery): Promise<SwarmEscalationRecord[]> {
    await this.awaitInitialization();
    if (!this.persistentMode) {
      return this.fallbackStore.list(query);
    }
    return this.listPersistent(query);
  }

  /**
   * @description Returns all escalation records for one swarm run.
   * @param runId - Swarm run identifier
   * @returns Escalation records for the run
   */
  async getByRunId(runId: string): Promise<SwarmEscalationRecord[]> {
    return this.list({ runId });
  }

  /**
   * @description Settles persistence mode before an operation runs, re-attempting activation
   * when an earlier attempt failed and its cooldown has elapsed. Never throws: a store that
   * cannot reach Postgres answers from its in-memory fallback rather than refusing the caller.
   * @returns Promise resolved once the current persistence mode has settled
   */
  private async awaitInitialization(): Promise<void> {
    this.persistentMode = await this.activation.ready();
  }

  /**
   * @description Inserts one escalation record into Postgres.
   * @param record - Escalation record to persist
   */
  private async savePersistent(record: SwarmEscalationRecord): Promise<void> {
    const query = `
      INSERT INTO swarm_escalations (
        run_id, ticket_external_id, target, severity, retry_class, reason, attempt_state, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
    `;
    const params = [
      record.runId,
      record.ticketExternalId,
      record.target,
      record.severity,
      record.retryClass,
      record.reason,
      JSON.stringify(record.attemptState),
      record.createdAt,
    ];
    await this.pool!.query(query, params);
    logger.info(
      { runId: record.runId, ticketExternalId: record.ticketExternalId, target: record.target, severity: record.severity },
      'Persisted swarm escalation record',
    );
  }

  /**
   * @description Queries escalation records from Postgres with optional filters.
   * @param query - Filter criteria
   * @returns Matching escalation records
   */
  private async listPersistent(query: SwarmEscalationQuery): Promise<SwarmEscalationRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (query.runId) {
      conditions.push(`run_id = $${paramIndex++}`);
      params.push(query.runId);
    }
    if (query.ticketExternalId) {
      conditions.push(`ticket_external_id = $${paramIndex++}`);
      params.push(query.ticketExternalId);
    }
    if (query.target) {
      conditions.push(`target = $${paramIndex++}`);
      params.push(query.target);
    }
    if (query.severity) {
      conditions.push(`severity = $${paramIndex++}`);
      params.push(query.severity);
    }

    const limit = query.limit ?? 100;
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT id, run_id, ticket_external_id, target, severity, retry_class, reason, attempt_state, created_at
      FROM swarm_escalations
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIndex}
    `;
    params.push(limit);

    const result = await this.pool!.query<SwarmEscalationRow>(sql, params);
    return result.rows.map(mapEscalationRow);
  }
}

/**
 * @description Maps a database row into the swarm escalation domain type.
 * @param row - Database row
 * @returns Swarm escalation record
 */
function mapEscalationRow(row: SwarmEscalationRow): SwarmEscalationRecord {
  return {
    runId: row.run_id,
    ticketExternalId: row.ticket_external_id,
    target: row.target as SwarmEscalationRecord['target'],
    severity: row.severity as SwarmEscalationRecord['severity'],
    retryClass: row.retry_class as SwarmEscalationRecord['retryClass'],
    reason: row.reason,
    attemptState: parseAttemptState(row.attempt_state),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

/**
 * @description Normalizes attempt state from database JSON.
 * @param value - Raw database JSON or parsed object
 * @returns Typed attempt state
 */
function parseAttemptState(value: SwarmVerificationAttemptState | string): SwarmVerificationAttemptState {
  if (typeof value === 'string') {
    return JSON.parse(value) as SwarmVerificationAttemptState;
  }
  return { ...value };
}
