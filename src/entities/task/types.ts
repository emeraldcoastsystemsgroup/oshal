/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — task store interface ported from any-bot TaskStore.js
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added usage telemetry persistence contract and variable turn increment support
 */

import type { StoredTask, CreateTaskInput, TaskStatus, TaskUsageSummary } from '@/shared/types';

/**
 * @description Interface for task persistence operations.
 * Abstracted from any-bot's SQLite-backed TaskStore.
 * Implementations may use SQLite, PostgreSQL, or in-memory storage.
 */
export interface ITaskStore {
  /**
   * @description Create a new task.
   * @param input - Task creation input
   * @returns The created task record
   */
  create(input: CreateTaskInput): Promise<StoredTask>;

  /**
   * @description Get a task by ID.
   * @param taskId - Task identifier
   * @returns Task record or null
   */
  get(taskId: string): Promise<StoredTask | null>;

  /**
   * @description Update a task's status.
   * @param taskId - Task identifier
   * @param status - New status
   */
  updateStatus(taskId: string, status: TaskStatus): Promise<void>;

  /**
   * @description Increment the message count for a task.
   * @param taskId - Task identifier
   */
  incrementMessageCount(taskId: string): Promise<void>;

  /**
   * @description Increment the turn count for a task.
   * @param taskId - Task identifier
   * @param amount - Number of turns to add (defaults to 1)
   */
  incrementTurnCount(taskId: string, amount?: number): Promise<void>;

  /**
   * @description Record task usage/cost statistics for one orchestration result.
   * @param taskId - Task identifier
   * @param usageSummary - Usage summary to merge into persisted task totals
   */
  recordUsage(taskId: string, usageSummary: TaskUsageSummary): Promise<void>;

  /**
   * @description Replace the full persisted task snapshot.
   * Used by checkpoint restore flows that need exact task-state recovery.
   * @param task - Full task snapshot to persist
   * @returns Persisted task record
   */
  replace(task: StoredTask): Promise<StoredTask>;

  /**
   * @description List tasks with optional filtering.
   * @param options - Filter options
   * @returns Array of matching tasks
   */
  list(options?: { status?: TaskStatus; agentId?: string; ownerSub?: string; limit?: number }): Promise<StoredTask[]>;

  /**
   * @description Delete a task and its associated messages.
   * @param taskId - Task identifier
   */
  delete(taskId: string): Promise<void>;
}
