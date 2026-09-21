/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added persistent escalation store interface and in-memory implementation for swarm policy routing
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | ADR-163: this store holds a swarm run's verification-attempt state, not the canonical escalation log - that is the `escalated` transition in ticket_status_history, which every escalating path writes. A run id is therefore part of what a record IS (target, retryClass and the attempt snapshot are the run policy's own outputs, and run_id is NOT NULL), so a save without one is refused instead of writing a row that claims to be a run's attempt state while naming no run.
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
 * @description Refuses a record that names no swarm run.
 *
 * ADR-163 D2: this store is a RUN-SCOPED verification-attempt record. Its `target`, `retryClass`
 * and `attemptState` are what a run's execution policy produced when it gave up, and `run_id` is
 * `NOT NULL` in the table — so a record without a run id is not a poorer escalation record, it is
 * a different thing wearing this one's shape. Refusing it keeps the store's contents answerable:
 * every row belongs to a run, and an escalation with no row means no run gave up on that ticket.
 * @param record - Structured escalation record about to be persisted.
 * @throws Error when the record carries no non-blank run identifier.
 */
export function assertRunScopedEscalation(record: SwarmEscalationRecord): void {
  if (typeof record?.runId === 'string' && record.runId.trim().length > 0) {
    return;
  }

  throw new Error(
    'SwarmEscalationStore.save requires a runId: swarm_escalations is a run-scoped attempt record (ADR-163). '
    + 'An escalation raised outside a swarm run is recorded by its ticket_status_history transition.',
  );
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
   * @throws Error when the record names no swarm run (ADR-163 D2).
   */
  async save(record: SwarmEscalationRecord): Promise<void> {
    assertRunScopedEscalation(record);
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