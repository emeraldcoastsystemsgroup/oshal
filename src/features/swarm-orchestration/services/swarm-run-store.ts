/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added in-memory run store for swarm orchestration lifecycle tracking
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added structured logging across run-store public methods
 */

import { createChildLogger } from '@/shared/logger';
import type { IntakeProvider } from '@/shared/types';
import type { SwarmTicketLifecycleSnapshot } from './ticket-cycle-state-machine';

const logger = createChildLogger({ module: 'swarm-run-store' });

/**
 * @description Per-ticket result captured within one swarm processing run.
 */
export interface SwarmProcessedTicketResult {
  externalId: string;
  title: string;
  selectedAgentId?: string;
  selectedStrategy?: 'bid' | 'llm' | 'keyword' | 'score' | 'catch-all';
  workUnitCount: number;
  lifecycle: SwarmTicketLifecycleSnapshot;
  /** PM-decomposed subtasks from Phase 2 planning — used by QM to create Plane child tickets. */
  planningDecomposition?: Array<{ title: string; description: string; acceptanceCriteria: string[]; workType: string; labels: string[] }>;
  /** PM-suggested agent assignments for each subtask. */
  agentAssignments?: Array<{ subtaskTitle: string; suggestedRole: string; suggestedAgentId?: string }>;
}

/**
 * @description Processing run status values.
 */
export type SwarmRunStatus = 'in_progress' | 'completed' | 'failed';

/**
 * @description Summary record persisted for one swarm processing run.
 */
export interface SwarmRunRecord {
  runId: string;
  provider: IntakeProvider;
  status: SwarmRunStatus;
  startedAt: string;
  completedAt?: string;
  itemCount: number;
  processed: SwarmProcessedTicketResult[];
  error?: string;
}

/**
 * @description Persistence boundary for swarm run tracking.
 */
export interface SwarmRunStore {
  create(run: Omit<SwarmRunRecord, 'status' | 'processed' | 'itemCount'>): Promise<SwarmRunRecord>;
  complete(runId: string, processed: SwarmProcessedTicketResult[]): Promise<SwarmRunRecord>;
  fail(runId: string, error: Error, processed: SwarmProcessedTicketResult[]): Promise<SwarmRunRecord>;
  get(runId: string): Promise<SwarmRunRecord | null>;
  list(limit?: number): Promise<SwarmRunRecord[]>;
}

/**
 * @description In-memory swarm run store for local orchestration prototyping.
 */
export class InMemorySwarmRunStore implements SwarmRunStore {
  private readonly records = new Map<string, SwarmRunRecord>();

  /**
   * @description Creates a new in-progress run record.
   * @param run - Initial run metadata
   * @returns Stored in-progress run record
   */
  async create(run: Omit<SwarmRunRecord, 'status' | 'processed' | 'itemCount'>): Promise<SwarmRunRecord> {
    logger.info({ runId: run.runId, provider: run.provider }, 'Creating swarm run record');

    const record: SwarmRunRecord = {
      ...run,
      status: 'in_progress',
      itemCount: 0,
      processed: [],
    };

    this.records.set(run.runId, record);

    logger.info({ runId: run.runId }, 'Created swarm run record');
    return { ...record };
  }

  /**
   * @description Marks a run complete and stores processed results.
   * @param runId - Run identifier
   * @param processed - Final processed ticket results
   * @returns Updated completed run record
   */
  async complete(runId: string, processed: SwarmProcessedTicketResult[]): Promise<SwarmRunRecord> {
    logger.info({ runId, itemCount: processed.length }, 'Completing swarm run record');
    const updated = this.update(runId, {
      status: 'completed',
      processed,
      itemCount: processed.length,
      completedAt: new Date().toISOString(),
      error: undefined,
    });
    logger.info({ runId }, 'Completed swarm run record');
    return updated;
  }

  /**
   * @description Marks a run failed while preserving partial processed results.
   * @param runId - Run identifier
   * @param error - Failure cause
   * @param processed - Partial processed ticket results
   * @returns Updated failed run record
   */
  async fail(runId: string, error: Error, processed: SwarmProcessedTicketResult[]): Promise<SwarmRunRecord> {
    logger.error({ err: error, runId, itemCount: processed.length }, 'Failing swarm run record');
    return this.update(runId, {
      status: 'failed',
      processed,
      itemCount: processed.length,
      completedAt: new Date().toISOString(),
      error: error.message,
    });
  }

  /**
   * @description Retrieves a run record by identifier.
   * @param runId - Run identifier
   * @returns Run record when present, otherwise null
   */
  async get(runId: string): Promise<SwarmRunRecord | null> {
    logger.info({ runId }, 'Reading swarm run record');
    const record = this.records.get(runId);
    logger.info({ runId, found: Boolean(record) }, 'Read swarm run record');
    return record ? { ...record } : null;
  }

  /**
   * @description Lists recent swarm run records ordered by creation time (newest first).
   * @param limit - Maximum number of records to return
   * @returns Array of run records
   */
  async list(limit = 50): Promise<SwarmRunRecord[]> {
    logger.info({ limit }, 'Listing swarm run records');
    const records = [...this.records.values()]
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .slice(0, limit);
    return records.map((r) => ({ ...r }));
  }

  /**
   * @description Applies partial updates to an existing run record.
   * @param runId - Run identifier
   * @param patch - Partial run fields to merge
   * @returns Updated run record
   */
  private update(runId: string, patch: Partial<SwarmRunRecord>): SwarmRunRecord {
    const current = this.records.get(runId);
    if (!current) {
      throw new Error(`Swarm run not found: ${runId}`);
    }

    const updated: SwarmRunRecord = {
      ...current,
      ...patch,
    };

    this.records.set(runId, updated);
    return { ...updated };
  }
}
