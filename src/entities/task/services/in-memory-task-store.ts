/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — in-memory task store for dev/testing
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Honor caller-provided taskId to preserve traceability across message route, orchestrator, and task store updates
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added optional Postgres-backed persistence with fallback mode and task usage/cost telemetry aggregation
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Close the owned Postgres pool when persistence initialization fails before falling back to memory
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { createOptionalPostgresPool, ensureConversationStoreSchema } from '@/shared/services/database';
import type { CreateTaskInput, ModelUsageStats, StoredTask, TaskStatus, TaskUsageSummary } from '@/shared/types';
import type { ITaskStore } from '../types';

const logger = createChildLogger({ module: 'in-memory-task-store' });

interface TaskRow {
  task_id: string;
  title: string;
  status: TaskStatus;
  processing_mode: 'agentic' | 'direct';
  agent_id: string | null;
  provider_id: string | null;
  message_count: number;
  turn_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_input_cost: number;
  total_output_cost: number;
  total_cost: number;
  total_requests: number;
  cost_currency: string | null;
  usage_by_model: Record<string, ModelUsageStats> | string | null;
  metadata: Record<string, unknown> | string | null;
  owner_sub: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

/**
 * @description Task store with automatic Postgres persistence when configured.
 * Falls back to in-memory mode when Postgres is not configured or unavailable.
 */
export class InMemoryTaskStore implements ITaskStore {
  private readonly tasks: Map<string, StoredTask>;
  private pool: Pool | null;
  private persistentMode: boolean;
  private readonly initPromise: Promise<void>;

  constructor() {
    this.tasks = new Map();
    this.pool = createOptionalPostgresPool('task-store');
    this.persistentMode = false;
    this.initPromise = this.initializePersistence();
    logger.info({ hasPool: Boolean(this.pool) }, 'Task store initialized');
  }

  /**
   * @description Create a new task with timestamps and caller-controlled identity.
   *
   * @param input - Task creation payload
   * @returns The created or existing task
   */
  async create(input: CreateTaskInput): Promise<StoredTask> {
    await this.awaitInitialization();
    const taskId = input.taskId?.trim() || randomUUID();
    if (this.persistentMode) {
      return this.createPersistent(taskId, input);
    }
    return this.createInMemory(taskId, input);
  }

  /**
   * @description Get a task by identifier.
   *
   * @param taskId - Task identifier
   * @returns Stored task or null
   */
  async get(taskId: string): Promise<StoredTask | null> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      return this.getPersistent(taskId);
    }
    const task = this.tasks.get(taskId) ?? null;
    logger.debug({ taskId, found: Boolean(task) }, 'Task lookup (memory)');
    return task;
  }

  /**
   * @description Update task lifecycle status.
   *
   * @param taskId - Task identifier
   * @param status - New status
   */
  async updateStatus(taskId: string, status: TaskStatus): Promise<void> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      await this.updateStatusPersistent(taskId, status);
      return;
    }
    const task = this.tasks.get(taskId);
    if (!task) {
      logger.warn({ taskId }, 'Task not found for status update (memory)');
      return;
    }
    task.status = status;
    task.updatedAt = new Date().toISOString();
    logger.info({ taskId, status }, 'Task status updated (memory)');
  }

  /**
   * @description Increment message counter on a task.
   *
   * @param taskId - Task identifier
   */
  async incrementMessageCount(taskId: string): Promise<void> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      await this.incrementMessageCountPersistent(taskId);
      return;
    }
    const task = this.tasks.get(taskId);
    if (!task) {
      logger.warn({ taskId }, 'Task not found for message increment (memory)');
      return;
    }
    task.messageCount += 1;
    task.updatedAt = new Date().toISOString();
    logger.debug({ taskId, messageCount: task.messageCount }, 'Message count incremented (memory)');
  }

  /**
   * @description Increment turn counter on a task.
   *
   * @param taskId - Task identifier
   * @param amount - Number of turns to add
   */
  async incrementTurnCount(taskId: string, amount = 1): Promise<void> {
    await this.awaitInitialization();
    const delta = normalizeDelta(amount);
    if (delta === 0) {
      return;
    }
    if (this.persistentMode) {
      await this.incrementTurnCountPersistent(taskId, delta);
      return;
    }
    const task = this.tasks.get(taskId);
    if (!task) {
      logger.warn({ taskId }, 'Task not found for turn increment (memory)');
      return;
    }
    task.turnCount += delta;
    task.updatedAt = new Date().toISOString();
    logger.debug({ taskId, turnCount: task.turnCount, delta }, 'Turn count incremented (memory)');
  }

  /**
   * @description Merge request usage/cost metrics into task totals.
   *
   * @param taskId - Task identifier
   * @param usageSummary - Usage data to merge
   */
  async recordUsage(taskId: string, usageSummary: TaskUsageSummary): Promise<void> {
    await this.awaitInitialization();
    const normalized = normalizeUsageSummary(usageSummary);
    if (normalized.requestCount === 0) {
      return;
    }
    if (this.persistentMode) {
      await this.recordUsagePersistent(taskId, normalized);
      return;
    }
    const existing = this.tasks.get(taskId);
    if (!existing) {
      logger.warn({ taskId }, 'Task not found for usage update (memory)');
      return;
    }
    const merged = mergeTaskUsage(existing, normalized);
    this.tasks.set(taskId, merged);
    logger.info({ taskId, requests: normalized.requestCount }, 'Task usage recorded (memory)');
  }

  /**
   * @description Replace the full persisted task snapshot.
   *
   * @param task - Task snapshot to persist
   * @returns Persisted task snapshot
   */
  async replace(task: StoredTask): Promise<StoredTask> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      return this.replacePersistent(task);
    }
    this.tasks.set(task.taskId, {
      ...task,
      metadata: { ...(task.metadata || {}) },
      usageByModel: { ...(task.usageByModel || {}) },
    });
    logger.info({ taskId: task.taskId }, 'Task snapshot replaced (memory)');
    return this.tasks.get(task.taskId)!;
  }

  /**
   * @description List tasks in reverse chronological order.
   *
   * @param options - Optional filtering
   * @returns Matching tasks
   */
  async list(options?: { status?: TaskStatus; agentId?: string; ownerSub?: string; limit?: number }): Promise<StoredTask[]> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      return this.listPersistent(options);
    }
    let results = Array.from(this.tasks.values());
    if (options?.status) {
      results = results.filter((task) => task.status === options.status);
    }
    if (options?.agentId) {
      results = results.filter((task) => task.agentId === options.agentId);
    }
    if (options?.ownerSub) {
      results = results.filter((task) => task.ownerSub === options.ownerSub);
    }
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (options?.limit && options.limit > 0) {
      results = results.slice(0, options.limit);
    }
    logger.debug(
      { count: results.length, status: options?.status, agentId: options?.agentId, scoped: Boolean(options?.ownerSub) },
      'Tasks listed (memory)',
    );
    return results;
  }

  /**
   * @description Delete task record.
   *
   * @param taskId - Task identifier
   */
  async delete(taskId: string): Promise<void> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      await this.deletePersistent(taskId);
      return;
    }
    const existed = this.tasks.delete(taskId);
    logger.info({ taskId, existed }, 'Task deleted (memory)');
  }

  /**
   * @description Initialize persistence mode by validating Postgres connectivity and schema.
   */
  private async initializePersistence(): Promise<void> {
    if (!this.pool) {
      return;
    }
    const candidatePool = this.pool;
    try {
      await ensureConversationStoreSchema(candidatePool);
      this.persistentMode = true;
      logger.info('Task store persistence mode enabled (postgres)');
    } catch (error) {
      logger.error({ err: error }, 'Task store persistence init failed; falling back to memory');
      this.persistentMode = false;
      try {
        await candidatePool.end();
      } catch (cleanupError) {
        logger.warn({ err: cleanupError }, 'Failed to close task store Postgres pool after persistence init failure');
      }
      this.pool = null;
    }
  }

  /**
   * @description Wait for async persistence initialization to settle.
   */
  private async awaitInitialization(): Promise<void> {
    await this.initPromise;
  }

  /**
   * @description Create task in memory mode.
   */
  private createInMemory(taskId: string, input: CreateTaskInput): StoredTask {
    const existing = this.tasks.get(taskId);
    if (existing) {
      logger.warn({ taskId }, 'Task already exists during create (memory)');
      return existing;
    }
    const task = buildNewTask(taskId, input);
    this.tasks.set(taskId, task);
    logger.info({ taskId }, 'Task created (memory)');
    return task;
  }

  /**
   * @description Create task in Postgres persistence mode.
   */
  private async createPersistent(taskId: string, input: CreateTaskInput): Promise<StoredTask> {
    const existing = await this.getPersistent(taskId);
    if (existing) {
      logger.warn({ taskId }, 'Task already exists during create (postgres)');
      return existing;
    }
    const task = buildNewTask(taskId, input);
    const query = `
      INSERT INTO chat_tasks (
        task_id, title, status, processing_mode, agent_id, provider_id,
        message_count, turn_count, total_input_tokens, total_output_tokens,
        total_input_cost, total_output_cost, total_cost, total_requests,
        cost_currency, usage_by_model, metadata, owner_sub, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16::jsonb, $17::jsonb, $18, $19::timestamptz, $20::timestamptz
      )
      RETURNING *
    `;
    const params = [
      task.taskId,
      task.title,
      task.status,
      task.processingMode,
      task.agentId ?? null,
      task.providerId ?? null,
      task.messageCount,
      task.turnCount,
      task.totalInputTokens,
      task.totalOutputTokens,
      task.totalInputCost,
      task.totalOutputCost,
      task.totalCost,
      task.totalRequests,
      task.costCurrency,
      JSON.stringify(task.usageByModel),
      JSON.stringify(task.metadata),
      task.ownerSub ?? null,
      task.createdAt,
      task.updatedAt,
    ];
    const result = await this.pool!.query<TaskRow>(query, params);
    const created = mapTaskRow(result.rows[0]);
    logger.info({ taskId }, 'Task created (postgres)');
    return created;
  }

  /**
   * @description Get task by id from Postgres.
   */
  private async getPersistent(taskId: string): Promise<StoredTask | null> {
    const query = 'SELECT * FROM chat_tasks WHERE task_id = $1 LIMIT 1';
    const result = await this.pool!.query<TaskRow>(query, [taskId]);
    if (result.rows.length === 0) {
      logger.debug({ taskId, found: false }, 'Task lookup (postgres)');
      return null;
    }
    const task = mapTaskRow(result.rows[0]);
    logger.debug({ taskId, found: true }, 'Task lookup (postgres)');
    return task;
  }

  /**
   * @description Update task status in Postgres.
   */
  private async updateStatusPersistent(taskId: string, status: TaskStatus): Promise<void> {
    const query = 'UPDATE chat_tasks SET status = $2, updated_at = NOW() WHERE task_id = $1';
    const result = await this.pool!.query(query, [taskId, status]);
    if (result.rowCount === 0) {
      logger.warn({ taskId }, 'Task not found for status update (postgres)');
      return;
    }
    logger.info({ taskId, status }, 'Task status updated (postgres)');
  }

  /**
   * @description Increment task message count in Postgres.
   */
  private async incrementMessageCountPersistent(taskId: string): Promise<void> {
    const query = 'UPDATE chat_tasks SET message_count = message_count + 1, updated_at = NOW() WHERE task_id = $1';
    const result = await this.pool!.query(query, [taskId]);
    if (result.rowCount === 0) {
      logger.warn({ taskId }, 'Task not found for message increment (postgres)');
      return;
    }
    logger.debug({ taskId }, 'Message count incremented (postgres)');
  }

  /**
   * @description Increment task turn count in Postgres.
   */
  private async incrementTurnCountPersistent(taskId: string, amount: number): Promise<void> {
    const query = 'UPDATE chat_tasks SET turn_count = turn_count + $2, updated_at = NOW() WHERE task_id = $1';
    const result = await this.pool!.query(query, [taskId, amount]);
    if (result.rowCount === 0) {
      logger.warn({ taskId }, 'Task not found for turn increment (postgres)');
      return;
    }
    logger.debug({ taskId, amount }, 'Turn count incremented (postgres)');
  }

  /**
   * @description Record usage metrics in Postgres by merging against current task totals.
   */
  private async recordUsagePersistent(taskId: string, usageSummary: TaskUsageSummary): Promise<void> {
    const existing = await this.getPersistent(taskId);
    if (!existing) {
      logger.warn({ taskId }, 'Task not found for usage update (postgres)');
      return;
    }
    const merged = mergeTaskUsage(existing, usageSummary);
    const query = `
      UPDATE chat_tasks
      SET
        total_input_tokens = $2,
        total_output_tokens = $3,
        total_input_cost = $4,
        total_output_cost = $5,
        total_cost = $6,
        total_requests = $7,
        cost_currency = $8,
        usage_by_model = $9::jsonb,
        updated_at = NOW()
      WHERE task_id = $1
    `;
    const params = [
      taskId,
      merged.totalInputTokens,
      merged.totalOutputTokens,
      merged.totalInputCost,
      merged.totalOutputCost,
      merged.totalCost,
      merged.totalRequests,
      merged.costCurrency,
      JSON.stringify(merged.usageByModel),
    ];
    await this.pool!.query(query, params);
    logger.info({ taskId, requests: usageSummary.requestCount }, 'Task usage recorded (postgres)');
  }

  /**
   * @description List tasks from Postgres with optional status and limit filtering.
   */
  private async listPersistent(options?: { status?: TaskStatus; agentId?: string; ownerSub?: string; limit?: number }): Promise<StoredTask[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options?.status) {
      params.push(options.status);
      clauses.push(`status = $${params.length}`);
    }
    if (options?.agentId) {
      params.push(options.agentId);
      clauses.push(`agent_id = $${params.length}`);
    }
    if (options?.ownerSub) {
      params.push(options.ownerSub);
      clauses.push(`owner_sub = $${params.length}`);
    }
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limitClause = options?.limit && options.limit > 0 ? `LIMIT ${Math.trunc(options.limit)}` : '';
    const query = `SELECT * FROM chat_tasks ${whereClause} ORDER BY created_at DESC ${limitClause}`;
    const result = await this.pool!.query<TaskRow>(query, params);
    const tasks = result.rows.map(mapTaskRow);
    logger.debug(
      { count: tasks.length, status: options?.status, agentId: options?.agentId, scoped: Boolean(options?.ownerSub) },
      'Tasks listed (postgres)',
    );
    return tasks;
  }

  /**
   * @description Delete task from Postgres.
   */
  private async deletePersistent(taskId: string): Promise<void> {
    const query = 'DELETE FROM chat_tasks WHERE task_id = $1';
    const result = await this.pool!.query(query, [taskId]);
    logger.info({ taskId, deleted: result.rowCount }, 'Task deleted (postgres)');
  }

  /**
   * @description Replace one task snapshot in Postgres.
   *
   * @param task - Task snapshot to persist
   * @returns Persisted task snapshot
   */
  private async replacePersistent(task: StoredTask): Promise<StoredTask> {
    const query = `
      INSERT INTO chat_tasks (
        task_id, title, status, processing_mode, agent_id, provider_id,
        message_count, turn_count, total_input_tokens, total_output_tokens,
        total_input_cost, total_output_cost, total_cost, total_requests,
        cost_currency, usage_by_model, metadata, owner_sub, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12, $13, $14,
        $15, $16::jsonb, $17::jsonb, $18, $19::timestamptz, $20::timestamptz
      )
      ON CONFLICT (task_id)
      DO UPDATE SET
        title = EXCLUDED.title,
        status = EXCLUDED.status,
        processing_mode = EXCLUDED.processing_mode,
        agent_id = EXCLUDED.agent_id,
        provider_id = EXCLUDED.provider_id,
        message_count = EXCLUDED.message_count,
        turn_count = EXCLUDED.turn_count,
        total_input_tokens = EXCLUDED.total_input_tokens,
        total_output_tokens = EXCLUDED.total_output_tokens,
        total_input_cost = EXCLUDED.total_input_cost,
        total_output_cost = EXCLUDED.total_output_cost,
        total_cost = EXCLUDED.total_cost,
        total_requests = EXCLUDED.total_requests,
        cost_currency = EXCLUDED.cost_currency,
        usage_by_model = EXCLUDED.usage_by_model,
        metadata = EXCLUDED.metadata,
        owner_sub = COALESCE(chat_tasks.owner_sub, EXCLUDED.owner_sub),
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    `;
    const params = [
      task.taskId,
      task.title,
      task.status,
      task.processingMode,
      task.agentId ?? null,
      task.providerId ?? null,
      task.messageCount,
      task.turnCount,
      task.totalInputTokens,
      task.totalOutputTokens,
      task.totalInputCost,
      task.totalOutputCost,
      task.totalCost,
      task.totalRequests,
      task.costCurrency,
      JSON.stringify(task.usageByModel || {}),
      JSON.stringify(task.metadata || {}),
      task.ownerSub ?? null,
      task.createdAt,
      task.updatedAt,
    ];
    const result = await this.pool!.query<TaskRow>(query, params);
    const stored = mapTaskRow(result.rows[0]);
    logger.info({ taskId: task.taskId }, 'Task snapshot replaced (postgres)');
    return stored;
  }
}

/**
 * @description Build a new task record with telemetry defaults.
 *
 * @param taskId - Task identifier
 * @param input - Creation input
 * @returns Initialized task record
 */
function buildNewTask(taskId: string, input: CreateTaskInput): StoredTask {
  const now = new Date().toISOString();
  return {
    taskId,
    title: input.title ?? '',
    status: 'created',
    processingMode: input.processingMode ?? 'agentic',
    agentId: input.agentId,
    providerId: input.providerId,
    ownerSub: input.ownerSub,
    messageCount: 0,
    turnCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalInputCost: 0,
    totalOutputCost: 0,
    totalCost: 0,
    totalRequests: 0,
    costCurrency: 'USD',
    usageByModel: {},
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * @description Parse SQL row values into task domain type.
 *
 * @param row - Postgres row
 * @returns Task object
 */
function mapTaskRow(row: TaskRow): StoredTask {
  const usageByModel = parseJsonObject<Record<string, ModelUsageStats>>(row.usage_by_model, {});
  const metadata = parseJsonObject<Record<string, unknown>>(row.metadata, {});
  const totalInputTokens = normalizeNumber(row.total_input_tokens);
  const totalOutputTokens = normalizeNumber(row.total_output_tokens);
  return {
    taskId: row.task_id,
    title: row.title || '',
    status: row.status,
    processingMode: row.processing_mode,
    agentId: row.agent_id ?? undefined,
    providerId: row.provider_id ?? undefined,
    ownerSub: row.owner_sub ?? undefined,
    messageCount: normalizeNumber(row.message_count),
    turnCount: normalizeNumber(row.turn_count),
    totalInputTokens,
    totalOutputTokens,
    totalTokens: totalInputTokens + totalOutputTokens,
    totalInputCost: normalizeFloat(row.total_input_cost),
    totalOutputCost: normalizeFloat(row.total_output_cost),
    totalCost: normalizeFloat(row.total_cost),
    totalRequests: normalizeNumber(row.total_requests),
    costCurrency: row.cost_currency || 'USD',
    usageByModel,
    metadata,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

/**
 * @description Merge request usage into cumulative task usage totals.
 *
 * @param task - Existing task
 * @param usageSummary - Incoming usage summary
 * @returns Updated task
 */
function mergeTaskUsage(task: StoredTask, usageSummary: TaskUsageSummary): StoredTask {
  const mergedModels = mergeUsageByModel(task.usageByModel || {}, usageSummary.byModel || {});
  const nextInputTokens = normalizeNumber(task.totalInputTokens) + usageSummary.inputTokens;
  const nextOutputTokens = normalizeNumber(task.totalOutputTokens) + usageSummary.outputTokens;
  const nextInputCost = normalizeFloat(task.totalInputCost) + usageSummary.inputCost;
  const nextOutputCost = normalizeFloat(task.totalOutputCost) + usageSummary.outputCost;
  const nextTotalCost = normalizeFloat(task.totalCost) + usageSummary.totalCost;
  const nextTotalRequests = normalizeNumber(task.totalRequests) + usageSummary.requestCount;
  return {
    ...task,
    totalInputTokens: nextInputTokens,
    totalOutputTokens: nextOutputTokens,
    totalTokens: nextInputTokens + nextOutputTokens,
    totalInputCost: nextInputCost,
    totalOutputCost: nextOutputCost,
    totalCost: nextTotalCost,
    totalRequests: nextTotalRequests,
    costCurrency: usageSummary.currency || task.costCurrency || 'USD',
    usageByModel: mergedModels,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * @description Merge per-model usage maps.
 *
 * @param base - Existing model usage map
 * @param incoming - Incoming model usage map
 * @returns Merged model usage map
 */
function mergeUsageByModel(
  base: Record<string, ModelUsageStats>,
  incoming: Record<string, ModelUsageStats>,
): Record<string, ModelUsageStats> {
  const merged: Record<string, ModelUsageStats> = { ...base };
  for (const [model, stats] of Object.entries(incoming)) {
    const current = merged[model] || createEmptyModelUsage();
    merged[model] = {
      inputTokens: normalizeNumber(current.inputTokens) + normalizeNumber(stats.inputTokens),
      outputTokens: normalizeNumber(current.outputTokens) + normalizeNumber(stats.outputTokens),
      totalTokens: normalizeNumber(current.totalTokens) + normalizeNumber(stats.totalTokens),
      inputCost: normalizeFloat(current.inputCost) + normalizeFloat(stats.inputCost),
      outputCost: normalizeFloat(current.outputCost) + normalizeFloat(stats.outputCost),
      totalCost: normalizeFloat(current.totalCost) + normalizeFloat(stats.totalCost),
      requestCount: normalizeNumber(current.requestCount) + normalizeNumber(stats.requestCount),
    };
  }
  return merged;
}

/**
 * @description Normalize request usage summary values to non-negative numbers.
 *
 * @param usageSummary - Raw usage summary
 * @returns Normalized usage summary
 */
function normalizeUsageSummary(usageSummary: TaskUsageSummary): TaskUsageSummary {
  const inputTokens = normalizeNumber(usageSummary.inputTokens);
  const outputTokens = normalizeNumber(usageSummary.outputTokens);
  const totalTokens = normalizeNumber(usageSummary.totalTokens || inputTokens + outputTokens);
  const normalizedByModel: Record<string, ModelUsageStats> = {};
  for (const [model, stats] of Object.entries(usageSummary.byModel || {})) {
    normalizedByModel[model] = {
      inputTokens: normalizeNumber(stats.inputTokens),
      outputTokens: normalizeNumber(stats.outputTokens),
      totalTokens: normalizeNumber(stats.totalTokens),
      inputCost: normalizeFloat(stats.inputCost),
      outputCost: normalizeFloat(stats.outputCost),
      totalCost: normalizeFloat(stats.totalCost),
      requestCount: normalizeNumber(stats.requestCount),
    };
  }
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    inputCost: normalizeFloat(usageSummary.inputCost),
    outputCost: normalizeFloat(usageSummary.outputCost),
    totalCost: normalizeFloat(usageSummary.totalCost),
    currency: usageSummary.currency || 'USD',
    requestCount: normalizeNumber(usageSummary.requestCount),
    byModel: normalizedByModel,
  };
}

/**
 * @description Parse JSON-ish values from DB rows safely.
 *
 * @param rawValue - Raw row value
 * @param fallback - Fallback object
 * @returns Parsed object value
 */
function parseJsonObject<T>(rawValue: unknown, fallback: T): T {
  if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
    return rawValue as T;
  }
  if (typeof rawValue === 'string' && rawValue.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as T;
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to parse JSON object value from row');
    }
  }
  return fallback;
}

/**
 * @description Convert row date values into ISO strings.
 *
 * @param value - Date-like row value
 * @returns ISO-8601 datetime string
 */
function toIsoString(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/**
 * @description Normalize non-negative integer values.
 *
 * @param value - Raw number-like value
 * @returns Non-negative integer
 */
function normalizeNumber(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @description Normalize non-negative float values.
 *
 * @param value - Raw number-like value
 * @returns Non-negative float
 */
function normalizeFloat(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? 0));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * @description Normalize turn increment delta.
 *
 * @param amount - Requested increment amount
 * @returns Non-negative integer delta
 */
function normalizeDelta(amount: number): number {
  return normalizeNumber(amount);
}

/**
 * @description Create zeroed model usage record.
 *
 * @returns Empty model usage
 */
function createEmptyModelUsage(): ModelUsageStats {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputCost: 0,
    outputCost: 0,
    totalCost: 0,
    requestCount: 0,
  };
}
