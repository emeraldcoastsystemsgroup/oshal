/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added persistent escalation store interface and in-memory implementation for swarm policy routing
 */

import { createChildLogger } from '@/shared/logger';
import type { SwarmEscalationRecord, SwarmEscalationTarget, SwarmEscalationSeverity } from './swarm-cycle-policy';

const logger = createChildLogger({ module: 'swarm-escalation-store' });

/**
 * @description Filter criteria for querying persisted escalation records.
 */
export interface SwarmEscalationQuery {
  runId?: string;
  ticketExternalId?: string;
  target?: SwarmEscalationTarget;
  severity?: SwarmEscalationSeverity;
  limit?: number;
}

/**
 * @description Persistence boundary for swarm escalation records.
 */
export interface SwarmEscalationStore {
  /** @description Persists one escalation record. */
  save(record: SwarmEscalationRecord): Promise<void>;
  /** @description Lists escalation records matching query criteria. */
  list(query: SwarmEscalationQuery): Promise<SwarmEscalationRecord[]>;
  /** @description Returns all escalation records for one swarm run. */
  getByRunId(runId: string): Promise<SwarmEscalationRecord[]>;
}

/**
 * @description In-memory escalation store for local/test execution.
 */
export class InMemorySwarmEscalationStore implements SwarmEscalationStore {
  private readonly records: SwarmEscalationRecord[] = [];

  /**
   * @description Persists one escalation record to the in-memory store.
   * @param record - Structured escalation record
   * @returns Promise resolved after persistence
   */
  async save(record: SwarmEscalationRecord): Promise<void> {
    this.records.push(record);
    logger.info(
      {
        runId: record.runId,
        ticketExternalId: record.ticketExternalId,
        target: record.target,
        severity: record.severity,
        retryClass: record.retryClass,
      },
      'Persisted swarm escalation record',
    );
  }

  /**
   * @description Lists escalation records matching optional filter criteria.
   * @param query - Filter criteria
   * @returns Matching escalation records
   */
  async list(query: SwarmEscalationQuery): Promise<SwarmEscalationRecord[]> {
    const limit = query.limit ?? 100;
    const filtered = this.records.filter((record) => matchesQuery(record, query));
    return filtered.slice(0, limit);
  }

  /**
   * @description Returns all escalation records for one swarm run.
   * @param runId - Swarm run identifier
   * @returns Escalation records for the run
   */
  async getByRunId(runId: string): Promise<SwarmEscalationRecord[]> {
    return this.records.filter((record) => record.runId === runId);
  }
}

/**
 * @description Tests whether one escalation record matches query filter criteria.
 * @param record - Escalation record to test
 * @param query - Filter criteria
 * @returns True when the record matches all provided criteria
 */
function matchesQuery(record: SwarmEscalationRecord, query: SwarmEscalationQuery): boolean {
  if (query.runId && record.runId !== query.runId) {
    return false;
  }

  if (query.ticketExternalId && record.ticketExternalId !== query.ticketExternalId) {
    return false;
  }

  if (query.target && record.target !== query.target) {
    return false;
  }

  if (query.severity && record.severity !== query.severity) {
    return false;
  }

  return true;
}