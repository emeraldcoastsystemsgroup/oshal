/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added work item repository for Postgres-backed swarm work unit persistence
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added listRecent query for operator visibility dashboard
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added 2-level hierarchical subtask support: parent linking, children queries, active cap, completion check
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Added idempotent work-item lookup and routing-failure status persistence for Session 140 completion hardening
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Preserved work-item agent assignment on status-only updates.
 */

import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { ensureWorkItemSchema } from '@/shared/services/database';
import {
  ACTIVE_SUBTASK_STATUSES,
  MAX_ACTIVE_SUBTASKS_PER_PARENT,
  SUBTASK_STATUSES,
  type CreateWorkItemInput,
  type WorkItem,
  type WorkItemStatus,
} from '../types';

const logger = createChildLogger({ module: 'work-item-repository' });

/**
 * @description Repository for persisting and querying swarm work items in Postgres.
 */
export class WorkItemRepository {
  private readonly schemaReady: Promise<void>;

  constructor(private readonly pool: Pool) {
    this.schemaReady = ensureWorkItemSchema(pool).catch((error) => {
      logger.error({ err: error }, 'Work item schema bootstrap failed; queries will attempt without guarantee');
    });
  }

  /**
   * @description Inserts a new work item from a decomposed work unit.
   * @param input - Work item creation input
   * @returns Persisted work item record
   */
  async create(input: CreateWorkItemInput): Promise<WorkItem> {
    await this.schemaReady;
    const existing = await this.findByIdentity(input.externalId, input.provider, input.unitId);
    if (existing) {
      logger.warn(
        {
          workItemId: existing.workItemId,
          externalId: input.externalId,
          provider: input.provider,
          unitId: input.unitId,
          status: existing.status,
        },
        'Skipping duplicate work item creation — returning existing record',
      );
      return existing;
    }

    const workItemId = randomUUID();
    const now = new Date().toISOString();

    const depth = input.depth ?? 0;
    const parentId = input.parentId ?? null;
    const defaultStatus = depth > 0 ? 'subtask-pending' : 'pending';

    await this.pool.query(
      `INSERT INTO work_items
        (work_item_id, swarm_run_id, external_id, provider, unit_id,
         title, description, acceptance_criteria, labels, priority,
         parent_id, depth, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,NOW(),NOW())`,
      [
        workItemId, input.swarmRunId, input.externalId, input.provider,
        input.unitId, input.title, input.description,
        JSON.stringify(input.acceptanceCriteria),
        input.labels, input.priority ?? null,
        parentId, depth, defaultStatus,
      ],
    );

    logger.info({ workItemId, swarmRunId: input.swarmRunId, unitId: input.unitId, parentId, depth }, 'Work item created');

    return {
      workItemId, ...input,
      parentId, depth,
      assignedAgentId: undefined, status: defaultStatus,
      executionOutput: undefined, verificationResult: undefined,
      metadata: {}, createdAt: now, updatedAt: now,
    };
  }

  /**
   * @description Reads one work item by its idempotent identity tuple.
   *
   * @param externalId - Ticket identifier associated with the work item
   * @param provider - Intake provider that owns the work item
   * @param unitId - Deterministic work-unit identifier
   * @returns Existing work item when found, otherwise null
   */
  async findByIdentity(externalId: string, provider: string, unitId: string): Promise<WorkItem | null> {
    const startedAt = Date.now();
    logger.info({ externalId, provider, unitId }, 'Looking up work item by identity');
    await this.schemaReady;
    const result = await this.pool.query(
      `SELECT * FROM work_items WHERE external_id=$1 AND provider=$2 AND unit_id=$3 ORDER BY created_at DESC LIMIT 1`,
      [externalId, provider, unitId],
    );
    const workItem = result.rows[0] ? mapRow(result.rows[0]) : null;
    logger.info(
      { externalId, provider, unitId, found: Boolean(workItem), durationMs: Date.now() - startedAt },
      'Completed work item identity lookup',
    );
    return workItem;
  }

  /**
   * @description Updates the status and optional agent assignment of a work item.
   * @param workItemId - Work item identifier
   * @param status - New status
   * @param assignedAgentId - Optional agent identifier
   */
  async updateStatus(workItemId: string, status: WorkItemStatus, assignedAgentId?: string): Promise<void> {
    await this.schemaReady;
    await this.pool.query(
      `UPDATE work_items
       SET status=$1,
           assigned_agent_id=COALESCE(NULLIF($2, ''), assigned_agent_id),
           updated_at=NOW()
       WHERE work_item_id=$3`,
      [status, assignedAgentId ?? null, workItemId],
    );
    logger.info({ workItemId, status, assignedAgentId }, 'Work item status updated');
  }

  /**
   * @description Merges new metadata into a work item's existing metadata JSONB column.
   *
   * @param workItemId - Work item identifier
   * @param metadata - Metadata object to merge (shallow merge via || operator)
   */
  async updateMetadata(workItemId: string, metadata: Record<string, unknown>): Promise<void> {
    await this.schemaReady;
    await this.pool.query(
      `UPDATE work_items SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_at=NOW() WHERE work_item_id=$2`,
      [JSON.stringify(metadata), workItemId],
    );
    logger.info({ workItemId, metadataKeys: Object.keys(metadata) }, 'Work item metadata updated');
  }

  /**
   * @description Marks a work item as routing-failed and stores structured failure context.
   *
   * @param workItemId - Work item identifier
   * @param reason - Human-readable reason for the routing failure
   * @param details - Optional structured details captured by the watchdog/circuit breaker
   * @returns Promise resolved after the persistence update completes
   */
  async markRoutingFailed(
    workItemId: string,
    reason: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.schemaReady;
    const startedAt = Date.now();
    logger.info({ workItemId, reason, details }, 'Marking work item as routing_failed');
    const detectedAt = new Date().toISOString();
    const routingFailure = {
      routingFailure: {
        reason,
        detectedAt,
        ...details,
      },
    };

    await this.pool.query(
      `UPDATE work_items
       SET
         status='routing_failed',
         metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
         execution_output = COALESCE(execution_output, '{}'::jsonb) || $1::jsonb,
         updated_at=NOW()
       WHERE work_item_id=$2`,
      [JSON.stringify(routingFailure), workItemId],
    );

    logger.warn(
      { workItemId, reason, detectedAt, details, durationMs: Date.now() - startedAt },
      'Work item marked as routing_failed',
    );
  }

  /**
   * @description Stores execution output on a work item.
   * @param workItemId - Work item identifier
   * @param output - Execution output payload
   */
  async setExecutionOutput(workItemId: string, output: unknown): Promise<void> {
    await this.schemaReady;
    await this.pool.query(
      `UPDATE work_items SET execution_output=$1, updated_at=NOW() WHERE work_item_id=$2`,
      [JSON.stringify(output), workItemId],
    );
    logger.info({ workItemId }, 'Work item execution output stored');
  }

  /**
   * @description Stores verification result on a work item.
   * @param workItemId - Work item identifier
   * @param result - Verification result payload
   */
  async setVerificationResult(workItemId: string, result: unknown): Promise<void> {
    await this.schemaReady;
    await this.pool.query(
      `UPDATE work_items SET verification_result=$1, updated_at=NOW() WHERE work_item_id=$2`,
      [JSON.stringify(result), workItemId],
    );
    logger.info({ workItemId }, 'Work item verification result stored');
  }

  /**
   * @description Queries work items by swarm run ID.
   * @param swarmRunId - Run identifier
   * @returns Array of work item records
   */
  async findByRunId(swarmRunId: string): Promise<WorkItem[]> {
    await this.schemaReady;
    const result = await this.pool.query(
      `SELECT * FROM work_items WHERE swarm_run_id=$1 ORDER BY created_at`,
      [swarmRunId],
    );
    return result.rows.map(mapRow);
  }

  /**
   * @description Lists the most recent work items across all runs.
   * @param limit - Maximum number of records to return
   * @returns Array of recent work item records
   */
  async listRecent(limit = 100): Promise<WorkItem[]> {
    await this.schemaReady;
    const result = await this.pool.query(
      `SELECT * FROM work_items ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(mapRow);
  }

  /**
   * @description Queries work items by external ticket ID and provider.
   * @param externalId - External ticket identifier
   * @param provider - Intake provider key
   * @returns Array of work item records
   */
  async findByExternalId(externalId: string, provider: string): Promise<WorkItem[]> {
    await this.schemaReady;
    const result = await this.pool.query(
      `SELECT * FROM work_items WHERE external_id=$1 AND provider=$2 ORDER BY created_at`,
      [externalId, provider],
    );
    return result.rows.map(mapRow);
  }

  /**
   * @description Queries work items by external ticket ID across all providers.
   * @param externalId - External ticket identifier
   * @returns Array of work item records
   */
  async findByExternalIdAnyProvider(externalId: string): Promise<WorkItem[]> {
    await this.schemaReady;
    const result = await this.pool.query(
      `SELECT * FROM work_items WHERE external_id=$1 ORDER BY created_at`,
      [externalId],
    );
    return result.rows.map(mapRow);
  }

  // ─── Subtask / Hierarchical Queries ───────────────────────────────────

  /**
   * @description Queries direct children of a parent work item.
   * @param parentId - Parent work item UUID
   * @returns Child work items ordered by creation time
   */
  async findChildren(parentId: string): Promise<WorkItem[]> {
    await this.schemaReady;
    const result = await this.pool.query(
      `SELECT * FROM work_items WHERE parent_id=$1 ORDER BY created_at`,
      [parentId],
    );
    return result.rows.map(mapRow);
  }

  /**
   * @description Counts active (non-terminal) children of a parent work item.
   * Active means subtask-pending, subtask-assigned, or subtask-executing.
   * @param parentId - Parent work item UUID
   * @returns Number of active children
   */
  async countActiveChildren(parentId: string): Promise<number> {
    await this.schemaReady;
    const result = await this.pool.query(
      `SELECT COUNT(*) AS cnt FROM work_items WHERE parent_id=$1 AND status = ANY($2)`,
      [parentId, ACTIVE_SUBTASK_STATUSES],
    );
    return parseInt(result.rows[0]?.cnt ?? '0', 10);
  }

  /**
   * @description Returns the number of subtask slots available for a parent.
   * A parent can have at most MAX_ACTIVE_SUBTASKS_PER_PARENT active children.
   * @param parentId - Parent work item UUID
   * @returns Number of available slots (0 means cap reached)
   */
  async availableSubtaskSlots(parentId: string): Promise<number> {
    const active = await this.countActiveChildren(parentId);
    return Math.max(0, MAX_ACTIVE_SUBTASKS_PER_PARENT - active);
  }

  /**
   * @description Checks whether all children of a parent are in terminal states.
   * @param parentId - Parent work item UUID
   * @returns { allDone, total, completed, failed }
   */
  async checkChildCompletion(parentId: string): Promise<{
    allDone: boolean;
    total: number;
    completed: number;
    failed: number;
  }> {
    await this.schemaReady;
    const result = await this.pool.query(
      `SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'subtask-completed') AS completed,
        COUNT(*) FILTER (WHERE status = 'subtask-failed') AS failed
       FROM work_items WHERE parent_id=$1`,
      [parentId],
    );
    const row = result.rows[0];
    const total = parseInt(row?.total ?? '0', 10);
    const completed = parseInt(row?.completed ?? '0', 10);
    const failed = parseInt(row?.failed ?? '0', 10);
    return {
      allDone: total > 0 && (completed + failed) === total,
      total,
      completed,
      failed,
    };
  }

  /**
   * @description Lists root-level work items only (depth=0, excludes subtask statuses).
   * This is the "main queue" — subtasks are excluded.
   * @param swarmRunId - Run identifier
   * @returns Root work items for the given run
   */
  async findRootsByRunId(swarmRunId: string): Promise<WorkItem[]> {
    await this.schemaReady;
    const result = await this.pool.query(
      `SELECT * FROM work_items WHERE swarm_run_id=$1 AND depth=0 AND status != ALL($2) ORDER BY created_at`,
      [swarmRunId, SUBTASK_STATUSES],
    );
    return result.rows.map(mapRow);
  }

  /**
   * @description Finds parents in 'in-review' status that may be ready for completion.
   * @param swarmRunId - Run identifier
   * @returns Work items in review state
   */
  async findParentsInReview(swarmRunId: string): Promise<WorkItem[]> {
    await this.schemaReady;
    const result = await this.pool.query(
      `SELECT * FROM work_items WHERE swarm_run_id=$1 AND status='in-review' ORDER BY created_at`,
      [swarmRunId],
    );
    return result.rows.map(mapRow);
  }
}

/**
 * @description Maps a Postgres row to a WorkItem record.
 * @param row - Raw database row
 * @returns Normalized work item record
 */
function mapRow(row: Record<string, unknown>): WorkItem {
  return {
    workItemId: row.work_item_id as string,
    swarmRunId: row.swarm_run_id as string,
    externalId: row.external_id as string,
    provider: row.provider as string,
    unitId: row.unit_id as string,
    title: row.title as string,
    description: (row.description as string) ?? '',
    acceptanceCriteria: (row.acceptance_criteria as string[]) ?? [],
    labels: (row.labels as string[]) ?? [],
    priority: row.priority as string | undefined,
    assignedAgentId: row.assigned_agent_id as string | undefined,
    parentId: (row.parent_id as string) ?? null,
    depth: typeof row.depth === 'number' ? row.depth : 0,
    status: row.status as WorkItem['status'],
    executionOutput: row.execution_output,
    verificationResult: row.verification_result,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: (row.created_at as Date)?.toISOString?.() ?? '',
    updatedAt: (row.updated_at as Date)?.toISOString?.() ?? '',
  };
}
