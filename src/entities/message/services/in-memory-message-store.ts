/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — in-memory message store for dev/testing
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added optional Postgres-backed persistence with fallback mode for restart-safe message history
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Close the owned Postgres pool when persistence initialization fails before falling back to memory
 */

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createChildLogger } from '@/shared/logger';
import { createOptionalPostgresPool, ensureConversationStoreSchema } from '@/shared/services/database';
import type { CreateMessageInput, StoredMessage } from '@/shared/types';
import type { IMessageStore } from '../types';

const logger = createChildLogger({ module: 'in-memory-message-store' });

interface MessageRow {
  message_id: string;
  task_id: string;
  role: 'user' | 'assistant';
  type: string;
  text: string;
  content_blocks: unknown[] | string | null;
  metadata: Record<string, unknown> | string | null;
  created_at: string | Date;
}

/**
 * @description Message store with optional Postgres persistence.
 * Uses memory fallback when Postgres is unavailable.
 */
export class InMemoryMessageStore implements IMessageStore {
  private readonly messages: Map<string, StoredMessage>;
  private readonly taskIndex: Map<string, string[]>;
  private pool: Pool | null;
  private persistentMode: boolean;
  private readonly initPromise: Promise<void>;

  constructor() {
    this.messages = new Map();
    this.taskIndex = new Map();
    this.pool = createOptionalPostgresPool('message-store');
    this.persistentMode = false;
    this.initPromise = this.initializePersistence();
    logger.info({ hasPool: Boolean(this.pool) }, 'Message store initialized');
  }

  /**
   * @description Save a new message.
   *
   * @param input - Message payload
   * @returns Stored message
   */
  async save(input: CreateMessageInput): Promise<StoredMessage> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      return this.savePersistent(input);
    }
    return this.saveInMemory(input);
  }

  /**
   * @description Load all messages for a task.
   *
   * @param taskId - Task identifier
   * @returns Ordered messages
   */
  async getByTask(taskId: string): Promise<StoredMessage[]> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      return this.getByTaskPersistent(taskId);
    }
    const ids = this.taskIndex.get(taskId) ?? [];
    const results = this.resolveIds(ids);
    logger.debug({ taskId, count: results.length }, 'Messages retrieved by task (memory)');
    return results;
  }

  /**
   * @description Load most recent messages for a task.
   *
   * @param taskId - Task identifier
   * @param count - Maximum number of records
   * @returns Ordered recent messages
   */
  async getRecent(taskId: string, count: number): Promise<StoredMessage[]> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      return this.getRecentPersistent(taskId, count);
    }
    const all = await this.getByTask(taskId);
    const recent = all.slice(-count);
    logger.debug({ taskId, requested: count, returned: recent.length }, 'Recent messages retrieved (memory)');
    return recent;
  }

  /**
   * @description Load one message by identifier.
   *
   * @param messageId - Message identifier
   * @returns Message or null
   */
  async get(messageId: string): Promise<StoredMessage | null> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      return this.getPersistent(messageId);
    }
    const message = this.messages.get(messageId) ?? null;
    logger.debug({ messageId, found: Boolean(message) }, 'Message lookup (memory)');
    return message;
  }

  /**
   * @description Delete all messages for a task.
   *
   * @param taskId - Task identifier
   */
  async deleteByTask(taskId: string): Promise<void> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      await this.deleteByTaskPersistent(taskId);
      return;
    }
    const ids = this.taskIndex.get(taskId) ?? [];
    ids.forEach((id) => this.messages.delete(id));
    this.taskIndex.delete(taskId);
    logger.info({ taskId, deletedCount: ids.length }, 'Messages deleted by task (memory)');
  }

  /**
   * @description Replace the full message history for a task.
   *
   * @param taskId - Task identifier
   * @param messages - Ordered snapshot to restore
   */
  async replaceTaskMessages(taskId: string, messages: StoredMessage[]): Promise<void> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      await this.replaceTaskMessagesPersistent(taskId, messages);
      return;
    }
    await this.deleteByTask(taskId);
    for (const message of messages) {
      this.messages.set(message.messageId, cloneStoredMessage(message));
      this.addToTaskIndex(taskId, message.messageId);
    }
    logger.info({ taskId, count: messages.length }, 'Task messages replaced (memory)');
  }

  /**
   * @description Get message count for task.
   *
   * @param taskId - Task identifier
   * @returns Message count
   */
  async count(taskId: string): Promise<number> {
    await this.awaitInitialization();
    if (this.persistentMode) {
      return this.countPersistent(taskId);
    }
    const ids = this.taskIndex.get(taskId) ?? [];
    logger.debug({ taskId, count: ids.length }, 'Message count (memory)');
    return ids.length;
  }

  /**
   * @description Initialize Postgres persistence when available.
   */
  private async initializePersistence(): Promise<void> {
    if (!this.pool) {
      return;
    }
    const candidatePool = this.pool;
    try {
      await ensureConversationStoreSchema(candidatePool);
      this.persistentMode = true;
      logger.info('Message store persistence mode enabled (postgres)');
    } catch (error) {
      logger.error({ err: error }, 'Message store persistence init failed; falling back to memory');
      this.persistentMode = false;
      try {
        await candidatePool.end();
      } catch (cleanupError) {
        logger.warn({ err: cleanupError }, 'Failed to close message store Postgres pool after persistence init failure');
      }
      this.pool = null;
    }
  }

  /**
   * @description Await asynchronous initialization.
   */
  private async awaitInitialization(): Promise<void> {
    await this.initPromise;
  }

  /**
   * @description Save message in memory mode.
   */
  private saveInMemory(input: CreateMessageInput): StoredMessage {
    const message = buildStoredMessage(input);
    this.messages.set(message.messageId, message);
    this.addToTaskIndex(input.taskId, message.messageId);
    logger.info({ messageId: message.messageId, taskId: input.taskId, role: input.role }, 'Message saved (memory)');
    return message;
  }

  /**
   * @description Save message in Postgres mode.
   */
  private async savePersistent(input: CreateMessageInput): Promise<StoredMessage> {
    const message = buildStoredMessage(input);
    const query = `
      INSERT INTO chat_messages (
        message_id, task_id, role, type, text, content_blocks, metadata, created_at
      ) VALUES (
        $1::uuid, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::timestamptz
      )
      RETURNING *
    `;
    const params = [
      message.messageId,
      message.taskId,
      message.role,
      message.type,
      message.text,
      JSON.stringify(message.contentBlocks),
      JSON.stringify(message.metadata),
      message.createdAt,
    ];
    const result = await this.pool!.query<MessageRow>(query, params);
    const stored = mapMessageRow(result.rows[0]);
    logger.info({ messageId: stored.messageId, taskId: stored.taskId, role: stored.role }, 'Message saved (postgres)');
    return stored;
  }

  /**
   * @description Fetch all messages for task from Postgres.
   */
  private async getByTaskPersistent(taskId: string): Promise<StoredMessage[]> {
    const query = 'SELECT * FROM chat_messages WHERE task_id = $1 ORDER BY created_at ASC';
    const result = await this.pool!.query<MessageRow>(query, [taskId]);
    const messages = result.rows.map(mapMessageRow);
    logger.debug({ taskId, count: messages.length }, 'Messages retrieved by task (postgres)');
    return messages;
  }

  /**
   * @description Fetch recent messages for task from Postgres.
   */
  private async getRecentPersistent(taskId: string, count: number): Promise<StoredMessage[]> {
    const normalizedCount = normalizeLimit(count);
    if (normalizedCount === 0) {
      return [];
    }
    const query = `
      SELECT * FROM chat_messages
      WHERE task_id = $1
      ORDER BY created_at DESC
      LIMIT ${normalizedCount}
    `;
    const result = await this.pool!.query<MessageRow>(query, [taskId]);
    const messages = result.rows.reverse().map(mapMessageRow);
    logger.debug({ taskId, requested: normalizedCount, returned: messages.length }, 'Recent messages retrieved (postgres)');
    return messages;
  }

  /**
   * @description Fetch one message by id from Postgres.
   */
  private async getPersistent(messageId: string): Promise<StoredMessage | null> {
    const query = 'SELECT * FROM chat_messages WHERE message_id = $1::uuid LIMIT 1';
    const result = await this.pool!.query<MessageRow>(query, [messageId]);
    if (result.rows.length === 0) {
      logger.debug({ messageId, found: false }, 'Message lookup (postgres)');
      return null;
    }
    const message = mapMessageRow(result.rows[0]);
    logger.debug({ messageId, found: true }, 'Message lookup (postgres)');
    return message;
  }

  /**
   * @description Delete all messages for task in Postgres.
   */
  private async deleteByTaskPersistent(taskId: string): Promise<void> {
    const query = 'DELETE FROM chat_messages WHERE task_id = $1';
    const result = await this.pool!.query(query, [taskId]);
    logger.info({ taskId, deletedCount: result.rowCount }, 'Messages deleted by task (postgres)');
  }

  /**
   * @description Replace all messages for a task in one transaction.
   *
   * @param taskId - Task identifier
   * @param messages - Ordered snapshot to restore
   */
  private async replaceTaskMessagesPersistent(taskId: string, messages: StoredMessage[]): Promise<void> {
    const client = await this.pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM chat_messages WHERE task_id = $1', [taskId]);
      for (const message of messages) {
        await client.query(
          `
            INSERT INTO chat_messages (
              message_id, task_id, role, type, text, content_blocks, metadata, created_at
            ) VALUES (
              $1::uuid, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::timestamptz
            )
          `,
          [
            message.messageId,
            taskId,
            message.role,
            message.type,
            message.text,
            JSON.stringify(message.contentBlocks || []),
            JSON.stringify(message.metadata || {}),
            message.createdAt,
          ],
        );
      }
      await client.query('COMMIT');
      logger.info({ taskId, count: messages.length }, 'Task messages replaced (postgres)');
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ err: error, taskId }, 'Failed to replace task messages (postgres)');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * @description Count messages for task in Postgres.
   */
  private async countPersistent(taskId: string): Promise<number> {
    const query = 'SELECT COUNT(*)::int AS count FROM chat_messages WHERE task_id = $1';
    const result = await this.pool!.query<{ count: number }>(query, [taskId]);
    const count = result.rows[0]?.count ?? 0;
    logger.debug({ taskId, count }, 'Message count (postgres)');
    return count;
  }

  /**
   * @description Add message id to in-memory task index.
   */
  private addToTaskIndex(taskId: string, messageId: string): void {
    const existing = this.taskIndex.get(taskId) ?? [];
    existing.push(messageId);
    this.taskIndex.set(taskId, existing);
  }

  /**
   * @description Resolve in-memory ids to message objects.
   */
  private resolveIds(ids: string[]): StoredMessage[] {
    return ids
      .map((id) => this.messages.get(id))
      .filter((message): message is StoredMessage => message !== undefined);
  }
}

/**
 * @description Build stored message object with generated identity and timestamp.
 *
 * @param input - Message payload
 * @returns Stored message
 */
function buildStoredMessage(input: CreateMessageInput): StoredMessage {
  return {
    messageId: randomUUID(),
    taskId: input.taskId,
    role: input.role,
    type: input.type,
    text: input.text,
    contentBlocks: input.contentBlocks ?? [],
    metadata: input.metadata ?? {},
    createdAt: new Date().toISOString(),
  };
}

/**
 * @description Clone one stored message snapshot for in-memory restoration safety.
 *
 * @param message - Stored message snapshot
 * @returns Cloned stored message
 */
function cloneStoredMessage(message: StoredMessage): StoredMessage {
  return {
    ...message,
    contentBlocks: [...message.contentBlocks],
    metadata: { ...(message.metadata || {}) },
  };
}

/**
 * @description Map Postgres row into StoredMessage.
 *
 * @param row - Postgres row
 * @returns Stored message
 */
function mapMessageRow(row: MessageRow): StoredMessage {
  return {
    messageId: row.message_id,
    taskId: row.task_id,
    role: row.role,
    type: row.type as StoredMessage['type'],
    text: row.text,
    contentBlocks: parseJsonArray(row.content_blocks),
    metadata: parseJsonObject(row.metadata),
    createdAt: toIsoString(row.created_at),
  };
}

/**
 * @description Parse JSON array value safely.
 *
 * @param value - Raw row value
 * @returns Parsed array
 */
function parseJsonArray(value: unknown): StoredMessage['contentBlocks'] {
  if (Array.isArray(value)) {
    return value as StoredMessage['contentBlocks'];
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as StoredMessage['contentBlocks'];
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to parse content blocks JSON');
    }
  }
  return [];
}

/**
 * @description Parse JSON object value safely.
 *
 * @param value - Raw row value
 * @returns Parsed object
 */
function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to parse message metadata JSON');
    }
  }
  return {};
}

/**
 * @description Normalize date value into ISO string.
 *
 * @param value - Raw date value
 * @returns ISO datetime string
 */
function toIsoString(value: string | Date): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/**
 * @description Normalize LIMIT values to non-negative integers.
 *
 * @param count - Raw limit value
 * @returns Normalized limit value
 */
function normalizeLimit(count: number): number {
  const parsed = Number.parseInt(String(count ?? 0), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
