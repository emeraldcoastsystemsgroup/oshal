/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial implementation — message store interface ported from any-bot MessageStore.js
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Normalized Change Log header to governance-compliant timestamp and author format
 */

import type { StoredMessage, CreateMessageInput } from '@/shared/types';

/**
 * @description Interface for message persistence operations.
 * Abstracted from any-bot's SQLite-backed MessageStore.
 * Implementations may use SQLite, PostgreSQL, or in-memory storage.
 */
export interface IMessageStore {
  /**
   * @description Save a new message.
   * @param input - Message creation input
   * @returns The stored message with generated ID and timestamp
   */
  save(input: CreateMessageInput): Promise<StoredMessage>;

  /**
   * @description Get all messages for a task, ordered chronologically.
   * @param taskId - Task identifier
   * @returns Array of messages
   */
  getByTask(taskId: string): Promise<StoredMessage[]>;

  /**
   * @description Get the most recent N messages for a task.
   * Used for building LLM conversation context.
   * @param taskId - Task identifier
   * @param count - Number of recent messages to retrieve
   * @returns Array of recent messages (newest last)
   */
  getRecent(taskId: string, count: number): Promise<StoredMessage[]>;

  /**
   * @description Get a single message by ID.
   * @param messageId - Message identifier
   * @returns Message record or null
   */
  get(messageId: string): Promise<StoredMessage | null>;

  /**
   * @description Delete all messages for a task.
   * @param taskId - Task identifier
   */
  deleteByTask(taskId: string): Promise<void>;

  /**
   * @description Replace the full message set for one task.
   * Used by checkpoint restore flows that need exact message-state recovery.
   * @param taskId - Task identifier
   * @param messages - Full ordered message snapshot
   */
  replaceTaskMessages(taskId: string, messages: StoredMessage[]): Promise<void>;

  /**
   * @description Get total message count for a task.
   * @param taskId - Task identifier
   * @returns Message count
   */
  count(taskId: string): Promise<number>;
}
