/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Redis-backed schedule persistence store for self-scheduling runtime
 */

import Redis from 'ioredis';
import { createChildLogger } from '@/shared/logger';
import { ScheduleRecordSchema, type ScheduleRecord } from '../types';

const logger = createChildLogger({ module: 'redis-schedule-store' });
const DEFAULT_KEY_PREFIX = 'oshal:scheduler';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';

/**
 * @description Construction options for RedisScheduleStore.
 */
export interface RedisScheduleStoreOptions {
  redisUrl?: string;
  keyPrefix?: string;
}

/**
 * @description Redis persistence adapter for schedule records and next-run indexes.
 */
export class RedisScheduleStore {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly readyTimeoutMs: number;

  constructor(options: RedisScheduleStoreOptions = {}) {
    this.keyPrefix = options.keyPrefix || DEFAULT_KEY_PREFIX;
    this.readyTimeoutMs = 5000;
    this.redis = new Redis(options.redisUrl || process.env.REDIS_URL || DEFAULT_REDIS_URL, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.on('error', (error) => logger.error({ err: error }, 'Redis schedule store connection error'));
  }

  /**
   * @description Verifies Redis connectivity for scheduler operations.
   *
   * @returns True when Redis responds to ping.
   */
  async ping(): Promise<boolean> {
    try {
      await this.ensureReady();
      const result = await this.redis.ping();
      const ok = result === 'PONG';
      logger.info({ ok }, 'Redis schedule store ping result');
      return ok;
    } catch (error) {
      logger.error({ err: error }, 'Redis schedule store ping failed');
      return false;
    }
  }

  /**
   * @description Gracefully closes the Redis connection.
   */
  async close(): Promise<void> {
    try {
      if (!this.isConnectionActive()) {
        return;
      }
      await this.redis.quit();
      logger.info('Redis schedule store closed');
    } catch (error) {
      logger.error({ err: error }, 'Failed to close Redis schedule store');
    }
  }

  /**
   * @description Stores or replaces a schedule and updates next-run index keys.
   *
   * @param schedule - Normalized schedule record to persist.
   */
  async saveSchedule(schedule: ScheduleRecord): Promise<void> {
    await this.ensureReady();
    const pipeline = this.redis.pipeline();
    pipeline.set(this.scheduleKey(schedule.id), JSON.stringify(schedule));
    pipeline.sadd(this.scheduleIndexKey(), schedule.id);

    if (schedule.status === 'active' && schedule.nextRunAt) {
      pipeline.zadd(this.nextRunKey(), new Date(schedule.nextRunAt).getTime(), schedule.id);
    } else {
      pipeline.zrem(this.nextRunKey(), schedule.id);
    }

    await pipeline.exec();
    logger.info({ scheduleId: schedule.id, status: schedule.status }, 'Saved schedule record');
  }

  /**
   * @description Loads a schedule record by identifier.
   *
   * @param scheduleId - Stable schedule identifier.
   * @returns Parsed schedule record when found.
   */
  async getSchedule(scheduleId: string): Promise<ScheduleRecord | null> {
    await this.ensureReady();
    const raw = await this.redis.get(this.scheduleKey(scheduleId));
    return this.parseSchedule(raw, scheduleId);
  }

  /**
   * @description Loads all known schedule records from Redis.
   *
   * @returns All parseable schedule records.
   */
  async listSchedules(): Promise<ScheduleRecord[]> {
    await this.ensureReady();
    const ids = await this.redis.smembers(this.scheduleIndexKey());
    if (ids.length === 0) {
      return [];
    }

    const rawSchedules = await this.redis.mget(ids.map((id) => this.scheduleKey(id)));
    const schedules: ScheduleRecord[] = [];
    for (let index = 0; index < ids.length; index++) {
      const parsed = this.parseSchedule(rawSchedules[index], ids[index]);
      if (parsed) {
        schedules.push(parsed);
      }
    }
    return schedules;
  }

  /**
   * @description Rebuilds the due-schedule sorted set from persisted schedule records.
   * This repairs legacy or drifted Redis state where an active schedule exists in
   * the schedule index but is absent from the next-run index.
   *
   * @returns Counts for observability.
   */
  async reconcileScheduleIndex(): Promise<{ scanned: number; indexed: number; removed: number }> {
    await this.ensureReady();
    const schedules = await this.listSchedules();
    const pipeline = this.redis.pipeline();
    let indexed = 0;
    let removed = 0;

    for (const schedule of schedules) {
      const nextRunMs = schedule.nextRunAt ? Date.parse(schedule.nextRunAt) : Number.NaN;
      if (schedule.status === 'active' && Number.isFinite(nextRunMs)) {
        pipeline.zadd(this.nextRunKey(), nextRunMs, schedule.id);
        indexed++;
        continue;
      }

      pipeline.zrem(this.nextRunKey(), schedule.id);
      removed++;
    }

    if (indexed > 0 || removed > 0) {
      await pipeline.exec();
    }

    logger.info({ scanned: schedules.length, indexed, removed }, 'Reconciled Redis schedule next-run index');
    return { scanned: schedules.length, indexed, removed };
  }

  /**
   * @description Deletes a schedule and removes all associated index entries.
   *
   * @param scheduleId - Stable schedule identifier.
   * @returns True when a schedule key was removed.
   */
  async deleteSchedule(scheduleId: string): Promise<boolean> {
    await this.ensureReady();
    const pipeline = this.redis.pipeline();
    pipeline.del(this.scheduleKey(scheduleId));
    pipeline.srem(this.scheduleIndexKey(), scheduleId);
    pipeline.zrem(this.nextRunKey(), scheduleId);

    const results = await pipeline.exec();
    const deletedCount = Number(results?.[0]?.[1] || 0);
    logger.info({ scheduleId, deletedCount }, 'Deleted schedule record');
    return deletedCount > 0;
  }

  /**
   * @description Pops due schedule identifiers from the next-run sorted-set index.
   *
   * @param nowMs - Current timestamp in milliseconds.
   * @param limit - Maximum number of IDs to pop.
   * @returns Identifiers for schedules due to execute.
   */
  async popDueScheduleIds(nowMs: number, limit: number): Promise<string[]> {
    await this.ensureReady();
    const ids = await this.redis.zrangebyscore(this.nextRunKey(), '-inf', nowMs, 'LIMIT', 0, limit);
    if (ids.length === 0) {
      return [];
    }
    await this.redis.zrem(this.nextRunKey(), ...ids);
    logger.info({ dueCount: ids.length }, 'Popped due schedules from Redis index');
    return ids;
  }

  /**
   * @description Redis key builder for schedule payload entries.
   */
  private scheduleKey(scheduleId: string): string {
    return `${this.keyPrefix}:schedule:${scheduleId}`;
  }

  /**
   * @description Redis key builder for schedule ID index.
   */
  private scheduleIndexKey(): string {
    return `${this.keyPrefix}:schedule-ids`;
  }

  /**
   * @description Redis key builder for schedule next-run index.
   */
  private nextRunKey(): string {
    return `${this.keyPrefix}:next-run`;
  }

  /**
   * @description Parses and validates a schedule payload string from Redis.
   *
   * @param raw - Raw JSON string payload.
   * @param scheduleId - Schedule identifier for logging context.
   * @returns Parsed schedule record when valid.
   */
  private parseSchedule(raw: string | null, scheduleId: string): ScheduleRecord | null {
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      return ScheduleRecordSchema.parse(parsed);
    } catch (error) {
      logger.error({ err: error, scheduleId }, 'Failed to parse schedule payload from Redis');
      return null;
    }
  }

  /**
   * @description Waits until Redis reaches a ready state before issuing commands.
   */
  private async ensureReady(): Promise<void> {
    if (this.readConnectionStatus() === 'ready') {
      return;
    }

    if (this.readConnectionStatus() === 'wait') {
      await this.redis.connect();
    }

    if (this.readConnectionStatus() === 'ready') {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`Redis connection not ready within ${this.readyTimeoutMs}ms (status: ${this.redis.status})`));
      }, this.readyTimeoutMs);

      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (error: unknown) => {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.redis.off('ready', onReady);
        this.redis.off('error', onError);
      };

      this.redis.on('ready', onReady);
      this.redis.on('error', onError);
    });
  }

  /**
   * @description Returns whether the Redis client is still in a state that can accept `quit`.
   */
  private isConnectionActive(): boolean {
    return !['end', 'close'].includes(this.readConnectionStatus());
  }

  /**
   * @description Reads the current Redis connection state without TypeScript narrowing issues.
   */
  private readConnectionStatus(): string {
    return this.redis.status;
  }
}
