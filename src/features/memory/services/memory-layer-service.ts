/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added non-swarm memory layer service for checkpoints, per-agent memory, and knowledge memory persistence
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed row mapping and snapshot helper logic into memory-layer-utils to keep the service within governance limits
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Persist owner_sub on knowledge documents and make listKnowledgeDocuments permission-aware (agent filter + operator-or-owner scope) so the Settings RAG visibility surface never lists another user's private docs
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Close the owned Postgres pool when persistence initialization fails before falling back to memory
 */

import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { createOptionalPostgresPool, ensureConversationStoreSchema } from '@/shared/services/database';
import type {
  AgentMemoryRecord,
  CreateCheckpointInput,
  KnowledgeMemoryDocument,
  RecordKnowledgeMemoryInput,
  StoredTask,
  TaskCheckpoint,
  UpsertAgentMemoryInput,
} from '@/shared/types';
import type { ITaskStore } from '@/entities/task';
import type { IMessageStore } from '@/entities/message';
import {
  type AgentMemoryRow,
  type KnowledgeListOptions,
  type KnowledgeMemoryRow,
  type TaskCheckpointRow,
  type TaskOutcomeInput,
  addToIndex,
  applyLimit,
  buildAgentMemoryInput,
  buildAgentMemoryRecord,
  buildCheckpoint,
  buildCheckpointLabel,
  buildKnowledgeMemoryDocument,
  buildRestoredTask,
  collectKnowledgeByCollection,
  knowledgeDocumentVisible,
  mapAgentMemoryRow,
  mapCheckpointRow,
  mapKnowledgeMemoryRow,
  normalizeLimit,
  removeFromIndex,
  summarizeCheckpoint,
} from './memory-layer-utils';

const logger = createChildLogger({ module: 'memory-layer-service' });

/**
 * @description Persists the three non-swarm memory layers that sit on top of
 * durable task/message history: checkpoints, per-agent local memory, and
 * knowledge-memory document metadata for RAG ingestion.
 */
export class MemoryLayerService {
  private readonly checkpoints = new Map<string, TaskCheckpoint>();
  private readonly checkpointIndex = new Map<string, string[]>();
  private readonly agentMemories = new Map<string, AgentMemoryRecord>();
  private readonly agentMemoryIndex = new Map<string, string[]>();
  private readonly knowledgeDocuments = new Map<string, KnowledgeMemoryDocument>();
  private readonly knowledgeIndex = new Map<string, string[]>();
  private pool: Pool | null;
  private persistentMode: boolean;
  private readonly initPromise: Promise<void>;

  constructor(
    private readonly taskStore: ITaskStore,
    private readonly messageStore: IMessageStore,
  ) {
    this.pool = createOptionalPostgresPool('memory-layer-service');
    this.persistentMode = false;
    this.initPromise = this.initializePersistence();
    logger.info({ hasPool: Boolean(this.pool) }, 'Memory layer service initialized');
  }

  /**
   * @description Capture task-level memory artifacts after one orchestration cycle.
   *
   * @param taskId - Task identifier
   * @param input - Outcome details used to populate checkpoint and agent memory
   */
  async captureTaskOutcome(taskId: string, input: TaskOutcomeInput): Promise<void> {
    await this.awaitInitialization();
    const task = await this.taskStore.get(taskId);
    if (!task) {
      logger.warn({ taskId }, 'Skipping memory capture for missing task');
      return;
    }
    const messages = await this.messageStore.getByTask(taskId);
    await this.captureCheckpoint(task, messages, input);
    const effectiveAgentId = input.agentId || task.agentId;
    if (effectiveAgentId) {
      await this.upsertAgentMemory(buildAgentMemoryInput(task, messages, effectiveAgentId, input));
    }
  }

  /**
   * @description Create a full task checkpoint containing task and message snapshots.
   *
   * @param taskId - Task identifier
   * @param input - Optional checkpoint metadata
   * @returns Persisted checkpoint snapshot
   */
  async createCheckpoint(taskId: string, input: Partial<CreateCheckpointInput> = {}): Promise<TaskCheckpoint> {
    await this.awaitInitialization();
    const task = await this.requireTask(taskId);
    const messages = await this.messageStore.getByTask(taskId);
    const checkpoint = buildCheckpoint(task, messages, input);
    return this.persistCheckpoint(checkpoint);
  }

  /**
   * @description List checkpoints for one task in reverse chronological order.
   *
   * @param taskId - Task identifier
   * @returns Checkpoint list
   */
  async listCheckpoints(taskId: string): Promise<TaskCheckpoint[]> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      return this.listCheckpointsPersistent(taskId);
    }
    const ids = [...(this.checkpointIndex.get(taskId) || [])].reverse();
    return ids
      .map((checkpointId) => this.checkpoints.get(checkpointId))
      .filter((checkpoint): checkpoint is TaskCheckpoint => Boolean(checkpoint));
  }

  /**
   * @description Load one checkpoint snapshot.
   *
   * @param checkpointId - Checkpoint identifier
   * @returns Checkpoint or null
   */
  async getCheckpoint(checkpointId: string): Promise<TaskCheckpoint | null> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      return this.getCheckpointPersistent(checkpointId);
    }
    return this.checkpoints.get(checkpointId) || null;
  }

  /**
   * @description Restore a task and its messages from a checkpoint snapshot.
   *
   * @param checkpointId - Checkpoint identifier
   * @returns Restored task snapshot
   */
  async restoreCheckpoint(checkpointId: string): Promise<StoredTask> {
    await this.awaitInitialization();
    const checkpoint = await this.getCheckpoint(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }
    const restoredTask = buildRestoredTask(checkpoint);
    await this.taskStore.replace(restoredTask);
    await this.messageStore.replaceTaskMessages(restoredTask.taskId, checkpoint.messagesSnapshot);
    await this.createCheckpoint(restoredTask.taskId, {
      label: `Restore of ${checkpoint.label || checkpoint.checkpointId}`,
      summary: `Restored task from checkpoint ${checkpoint.checkpointId}`,
      trigger: 'restore',
      metadata: { restoredFromCheckpointId: checkpoint.checkpointId },
    });
    logger.info({ checkpointId, taskId: restoredTask.taskId }, 'Checkpoint restored');
    return restoredTask;
  }

  /**
   * @description Delete one checkpoint snapshot.
   *
   * @param checkpointId - Checkpoint identifier
   * @returns True when a checkpoint was deleted
   */
  async deleteCheckpoint(checkpointId: string): Promise<boolean> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      return this.deleteCheckpointPersistent(checkpointId);
    }
    const existing = this.checkpoints.get(checkpointId);
    if (!existing) {
      return false;
    }
    this.checkpoints.delete(checkpointId);
    removeFromIndex(this.checkpointIndex, existing.taskId, checkpointId);
    logger.info({ checkpointId, taskId: existing.taskId }, 'Checkpoint deleted (memory)');
    return true;
  }

  /**
   * @description Upsert one per-agent memory record keyed by agent and task.
   *
   * @param input - Agent memory payload
   * @returns Persisted agent memory record
   */
  async upsertAgentMemory(input: UpsertAgentMemoryInput): Promise<AgentMemoryRecord> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      return this.upsertAgentMemoryPersistent(input);
    }
    return this.upsertAgentMemoryInMemory(input);
  }

  /**
   * @description List agent memory records for one bot identifier.
   *
   * @param agentId - Agent identifier
   * @param limit - Optional max row count
   * @returns Ordered agent memories
   */
  async listAgentMemories(agentId: string, limit?: number): Promise<AgentMemoryRecord[]> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      return this.listAgentMemoriesPersistent(agentId, limit);
    }
    const ids = [...(this.agentMemoryIndex.get(agentId) || [])].reverse();
    const rows = ids
      .map((memoryId) => this.agentMemories.get(memoryId))
      .filter((record): record is AgentMemoryRecord => Boolean(record));
    return applyLimit(rows, limit);
  }

  /**
   * @description Record one knowledge-memory document produced by RAG ingestion.
   *
   * @param input - Knowledge-memory payload
   * @returns Persisted knowledge-memory document
   */
  async recordKnowledgeDocument(input: RecordKnowledgeMemoryInput): Promise<KnowledgeMemoryDocument> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      return this.recordKnowledgeDocumentPersistent(input);
    }
    const document = buildKnowledgeMemoryDocument(input);
    this.knowledgeDocuments.set(document.knowledgeId, document);
    addToIndex(this.knowledgeIndex, document.collection, document.knowledgeId);
    logger.info({ collection: document.collection, knowledgeId: document.knowledgeId }, 'Knowledge memory recorded (memory)');
    return document;
  }

  /**
   * @description List knowledge-memory documents with optional collection/agent filters and an
   * optional permission scope. When `visibleTo` is supplied for a non-operator, only shared
   * documents (owner_sub IS NULL) and the caller's own private documents are returned — the same
   * boundary the permission-aware RAG retrieval enforces at chunk level, applied here at the
   * catalog level so the Settings knowledge surface never lists another user's private docs.
   *
   * @param options - Optional collection/agent filters, permission scope, and result limit
   * @returns Ordered knowledge-memory documents the caller may see
   */
  async listKnowledgeDocuments(options: KnowledgeListOptions = {}): Promise<KnowledgeMemoryDocument[]> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      return this.listKnowledgeDocumentsPersistent(options);
    }
    const base = options.collection
      ? collectKnowledgeByCollection(this.knowledgeIndex, this.knowledgeDocuments, options.collection)
      : Array.from(this.knowledgeDocuments.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const filtered = base.filter((doc) => knowledgeDocumentVisible(doc, options));
    return applyLimit(filtered, options.limit);
  }

  private async initializePersistence(): Promise<void> {
    if (!this.pool) {
      return;
    }
    const candidatePool = this.pool;
    try {
      await ensureConversationStoreSchema(candidatePool);
      this.persistentMode = true;
      logger.info('Memory layer persistence mode enabled (postgres)');
    } catch (error) {
      logger.error({ err: error }, 'Memory layer persistence init failed; falling back to memory');
      this.persistentMode = false;
      try {
        await candidatePool.end();
      } catch (cleanupError) {
        logger.warn({ err: cleanupError }, 'Failed to close memory layer Postgres pool after persistence init failure');
      }
      this.pool = null;
    }
  }

  private async awaitInitialization(): Promise<void> {
    await this.initPromise;
  }

  private async requireTask(taskId: string): Promise<StoredTask> {
    const task = await this.taskStore.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }
    return task;
  }

  private async captureCheckpoint(task: StoredTask, messages: Awaited<ReturnType<IMessageStore['getByTask']>>, input: TaskOutcomeInput): Promise<void> {
    const checkpoint = buildCheckpoint(task, messages, {
      label: buildCheckpointLabel(task, input.completionType),
      summary: summarizeCheckpoint(messages, input.assistantResponse),
      trigger: input.checkpointTrigger || 'auto',
      metadata: {
        completionType: input.completionType || 'natural',
        toolsUsed: input.toolsUsed || [],
        source: input.source || 'task_result',
      },
    });
    await this.persistCheckpoint(checkpoint);
  }

  private async persistCheckpoint(checkpoint: TaskCheckpoint): Promise<TaskCheckpoint> {
    const stored = this.persistentMode
      ? await this.createCheckpointPersistent(checkpoint)
      : this.createCheckpointInMemory(checkpoint);
    await this.persistLatestCheckpointReference(stored);
    return stored;
  }

  private createCheckpointInMemory(checkpoint: TaskCheckpoint): TaskCheckpoint {
    this.checkpoints.set(checkpoint.checkpointId, checkpoint);
    addToIndex(this.checkpointIndex, checkpoint.taskId, checkpoint.checkpointId);
    logger.info({ taskId: checkpoint.taskId, checkpointId: checkpoint.checkpointId }, 'Checkpoint created (memory)');
    return checkpoint;
  }

  private async createCheckpointPersistent(checkpoint: TaskCheckpoint): Promise<TaskCheckpoint> {
    const result = await this.pool!.query<TaskCheckpointRow>(
      `
        INSERT INTO task_checkpoints (
          checkpoint_id, task_id, agent_id, label, summary, trigger,
          message_count, task_snapshot, messages_snapshot, metadata, created_at
        ) VALUES (
          $1::uuid, $2, $3, $4, $5, $6,
          $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::timestamptz
        )
        RETURNING *
      `,
      [
        checkpoint.checkpointId,
        checkpoint.taskId,
        checkpoint.agentId ?? null,
        checkpoint.label ?? null,
        checkpoint.summary ?? null,
        checkpoint.trigger,
        checkpoint.messageCount,
        JSON.stringify(checkpoint.taskSnapshot),
        JSON.stringify(checkpoint.messagesSnapshot),
        JSON.stringify(checkpoint.metadata || {}),
        checkpoint.createdAt,
      ],
    );
    const stored = mapCheckpointRow(result.rows[0]);
    logger.info({ taskId: stored.taskId, checkpointId: stored.checkpointId }, 'Checkpoint created (postgres)');
    return stored;
  }

  private async listCheckpointsPersistent(taskId: string): Promise<TaskCheckpoint[]> {
    const result = await this.pool!.query<TaskCheckpointRow>(
      'SELECT * FROM task_checkpoints WHERE task_id = $1 ORDER BY created_at DESC',
      [taskId],
    );
    return result.rows.map(mapCheckpointRow);
  }

  private async getCheckpointPersistent(checkpointId: string): Promise<TaskCheckpoint | null> {
    const result = await this.pool!.query<TaskCheckpointRow>(
      'SELECT * FROM task_checkpoints WHERE checkpoint_id = $1::uuid LIMIT 1',
      [checkpointId],
    );
    return result.rows[0] ? mapCheckpointRow(result.rows[0]) : null;
  }

  private async deleteCheckpointPersistent(checkpointId: string): Promise<boolean> {
    const result = await this.pool!.query(
      'DELETE FROM task_checkpoints WHERE checkpoint_id = $1::uuid',
      [checkpointId],
    );
    logger.info({ checkpointId, deleted: result.rowCount }, 'Checkpoint deleted (postgres)');
    return (result.rowCount || 0) > 0;
  }

  private async upsertAgentMemoryPersistent(input: UpsertAgentMemoryInput): Promise<AgentMemoryRecord> {
    const existing = await this.findAgentMemoryPersistent(input.agentId, input.taskId);
    const record = buildAgentMemoryRecord(input, existing || undefined);
    const result = await this.pool!.query<AgentMemoryRow>(
      `
        INSERT INTO agent_memories (
          memory_id, agent_id, task_id, title, summary, last_user_message,
          last_assistant_message, tool_names, keywords, message_count, turn_count,
          total_tokens, total_cost, cost_currency, source, metadata, created_at, updated_at
        ) VALUES (
          $1::uuid, $2, $3, $4, $5, $6,
          $7, $8::text[], $9::text[], $10, $11,
          $12, $13, $14, $15, $16::jsonb, $17::timestamptz, $18::timestamptz
        )
        ON CONFLICT (agent_id, task_id)
        DO UPDATE SET
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          last_user_message = EXCLUDED.last_user_message,
          last_assistant_message = EXCLUDED.last_assistant_message,
          tool_names = EXCLUDED.tool_names,
          keywords = EXCLUDED.keywords,
          message_count = EXCLUDED.message_count,
          turn_count = EXCLUDED.turn_count,
          total_tokens = EXCLUDED.total_tokens,
          total_cost = EXCLUDED.total_cost,
          cost_currency = EXCLUDED.cost_currency,
          source = EXCLUDED.source,
          metadata = EXCLUDED.metadata,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `,
      [
        record.memoryId,
        record.agentId,
        record.taskId,
        record.title,
        record.summary,
        record.lastUserMessage ?? null,
        record.lastAssistantMessage ?? null,
        record.toolNames,
        record.keywords,
        record.messageCount,
        record.turnCount,
        record.totalTokens,
        record.totalCost,
        record.costCurrency,
        record.source,
        JSON.stringify(record.metadata || {}),
        record.createdAt,
        record.updatedAt,
      ],
    );
    const stored = mapAgentMemoryRow(result.rows[0]);
    logger.info({ agentId: stored.agentId, taskId: stored.taskId }, 'Agent memory upserted (postgres)');
    return stored;
  }

  private async upsertAgentMemoryInMemory(input: UpsertAgentMemoryInput): Promise<AgentMemoryRecord> {
    const existing = this.findAgentMemoryInMemory(input.agentId, input.taskId);
    const record = buildAgentMemoryRecord(input, existing || undefined);
    if (existing) {
      removeFromIndex(this.agentMemoryIndex, existing.agentId, existing.memoryId);
    }
    this.agentMemories.set(record.memoryId, record);
    addToIndex(this.agentMemoryIndex, record.agentId, record.memoryId);
    logger.info({ agentId: record.agentId, taskId: record.taskId }, 'Agent memory upserted (memory)');
    return record;
  }

  private async findAgentMemoryPersistent(agentId: string, taskId: string): Promise<AgentMemoryRecord | null> {
    const result = await this.pool!.query<AgentMemoryRow>(
      'SELECT * FROM agent_memories WHERE agent_id = $1 AND task_id = $2 LIMIT 1',
      [agentId, taskId],
    );
    return result.rows[0] ? mapAgentMemoryRow(result.rows[0]) : null;
  }

  private findAgentMemoryInMemory(agentId: string, taskId: string): AgentMemoryRecord | null {
    return Array.from(this.agentMemories.values()).find((record) => record.agentId === agentId && record.taskId === taskId) || null;
  }

  private async listAgentMemoriesPersistent(agentId: string, limit?: number): Promise<AgentMemoryRecord[]> {
    const normalizedLimit = normalizeLimit(limit);
    const suffix = normalizedLimit ? ` LIMIT ${normalizedLimit}` : '';
    const result = await this.pool!.query<AgentMemoryRow>(
      `SELECT * FROM agent_memories WHERE agent_id = $1 ORDER BY updated_at DESC${suffix}`,
      [agentId],
    );
    return result.rows.map(mapAgentMemoryRow);
  }

  private async recordKnowledgeDocumentPersistent(input: RecordKnowledgeMemoryInput): Promise<KnowledgeMemoryDocument> {
    const document = buildKnowledgeMemoryDocument(input);
    const result = await this.pool!.query<KnowledgeMemoryRow>(
      `
        INSERT INTO knowledge_memory_documents (
          knowledge_id, agent_id, task_id, collection_name, title, source,
          format, chunk_count, document_count, embedding_provider_id,
          embedding_model_id, owner_sub, metadata, created_at, updated_at
        ) VALUES (
          $1::uuid, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13::jsonb, $14::timestamptz, $15::timestamptz
        )
        RETURNING *
      `,
      [
        document.knowledgeId,
        document.agentId ?? null,
        document.taskId ?? null,
        document.collection,
        document.title,
        document.source,
        document.format ?? null,
        document.chunkCount,
        document.documentCount,
        document.embeddingProviderId ?? null,
        document.embeddingModelId ?? null,
        document.ownerSub ?? null,
        JSON.stringify(document.metadata || {}),
        document.createdAt,
        document.updatedAt,
      ],
    );
    const stored = mapKnowledgeMemoryRow(result.rows[0]);
    logger.info({ collection: stored.collection, knowledgeId: stored.knowledgeId }, 'Knowledge memory recorded (postgres)');
    return stored;
  }

  private async listKnowledgeDocumentsPersistent(options: KnowledgeListOptions): Promise<KnowledgeMemoryDocument[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (options.collection) {
      params.push(options.collection);
      clauses.push(`collection_name = $${params.length}`);
    }
    if (typeof options.agentId === 'string' && options.agentId.length > 0) {
      params.push(options.agentId);
      clauses.push(`agent_id = $${params.length}`);
    }
    // Permission scope: a non-operator sees only shared docs (owner_sub IS NULL) plus their own.
    if (options.visibleTo && !options.visibleTo.isOperator) {
      params.push(options.visibleTo.callerSub);
      clauses.push(`(owner_sub IS NULL OR owner_sub = $${params.length})`);
    }
    const whereClause = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const normalizedLimit = normalizeLimit(options.limit);
    const suffix = normalizedLimit ? ` LIMIT ${normalizedLimit}` : '';
    const result = await this.pool!.query<KnowledgeMemoryRow>(
      `SELECT * FROM knowledge_memory_documents${whereClause} ORDER BY created_at DESC${suffix}`,
      params,
    );
    return result.rows.map(mapKnowledgeMemoryRow);
  }

  private async persistLatestCheckpointReference(checkpoint: TaskCheckpoint): Promise<void> {
    const existingTask = await this.taskStore.get(checkpoint.taskId);
    if (!existingTask) {
      return;
    }
    const nextTask: StoredTask = {
      ...existingTask,
      metadata: {
        ...(existingTask.metadata || {}),
        latestCheckpoint: {
          checkpointId: checkpoint.checkpointId,
          createdAt: checkpoint.createdAt,
          label: checkpoint.label || '',
          trigger: checkpoint.trigger,
        },
      },
      updatedAt: new Date().toISOString(),
    };
    await this.taskStore.replace(nextTask);
  }
}
