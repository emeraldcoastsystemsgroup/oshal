/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | BF-031: Redis-backed subtask lifecycle store — survives PM container restarts during active ticket processing
 */

import Redis from 'ioredis';
import { createChildLogger } from '@/shared/logger';
import type { SubtaskLifecycleStore } from './subtask-lifecycle-store';
import type { ParentWithSubtasks } from './subtask-lifecycle-service';

const logger = createChildLogger({ module: 'redis-subtask-lifecycle-store' });
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const KEY_PREFIX = 'oshal:subtask-registry';
const DEFAULT_TTL_SECONDS = 7200; // 2 hours — covers typical ticket lifecycle

/**
 * @description Redis-backed subtask lifecycle store. Persists the parent→child
 * subtask registry so PM container restarts don't lose in-flight child ticket tracking.
 * Key pattern: `oshal:subtask-registry:{parentUnitId}` → JSON ParentWithSubtasks
 */
export class RedisSubtaskLifecycleStore implements SubtaskLifecycleStore {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;

  constructor(redisUrl?: string, ttlSeconds?: number) {
    this.ttlSeconds = ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.redis = new Redis(redisUrl ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    this.redis.on('error', (err) => logger.error({ err }, 'Redis subtask store connection error'));
    logger.info({ ttlSeconds: this.ttlSeconds }, 'RedisSubtaskLifecycleStore initialized');
  }

  /**
   * @description Retrieves a parent entry from Redis.
   * @param parentUnitId - The parent's unit identifier
   * @returns Parent entry or null
   */
  async get(parentUnitId: string): Promise<ParentWithSubtasks | null> {
    const raw = await this.redis.get(this.key(parentUnitId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ParentWithSubtasks;
    } catch (err) {
      logger.error({ err, parentUnitId }, 'Failed to parse subtask registry entry');
      return null;
    }
  }

  /**
   * @description Stores a parent entry in Redis with TTL.
   * @param parentUnitId - The parent's unit identifier
   * @param entry - Parent-with-subtasks entry
   */
  async set(parentUnitId: string, entry: ParentWithSubtasks): Promise<void> {
    await this.redis.set(this.key(parentUnitId), JSON.stringify(entry), 'EX', this.ttlSeconds);
  }

  /**
   * @description Deletes a parent entry from Redis.
   * @param parentUnitId - The parent's unit identifier
   * @returns True if deleted
   */
  async delete(parentUnitId: string): Promise<boolean> {
    const count = await this.redis.del(this.key(parentUnitId));
    return count > 0;
  }

  /**
   * @description Checks whether a parent entry exists in Redis.
   * @param parentUnitId - The parent's unit identifier
   * @returns True if found
   */
  async has(parentUnitId: string): Promise<boolean> {
    const exists = await this.redis.exists(this.key(parentUnitId));
    return exists === 1;
  }

  /**
   * @description Returns all parent entries from Redis.
   * @returns All tracked parent entries
   */
  async values(): Promise<ParentWithSubtasks[]> {
    const keys = await this.scanKeys();
    if (keys.length === 0) return [];
    const payloads = await this.redis.mget(keys);
    return payloads.flatMap((raw) => {
      if (!raw) return [];
      try {
        return [JSON.parse(raw) as ParentWithSubtasks];
      } catch {
        return [];
      }
    });
  }

  private key(parentUnitId: string): string {
    return `${KEY_PREFIX}:${parentUnitId}`;
  }

  private async scanKeys(): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.scan(cursor, 'MATCH', `${KEY_PREFIX}:*`, 'COUNT', '100');
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }
}
