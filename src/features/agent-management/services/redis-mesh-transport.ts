/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Redis Streams mesh transport for durable inter-agent envelope delivery
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Added claimOrphaned via XAUTOCLAIM to recover messages stuck on dead consumers
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Added subscribe() poll-loop method for channel subscriptions, removed blocking XREADGROUP
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Hardening-backlog #9: subscribe() poll loop now counts consecutive failures, backs off exponentially to a 30s cap, and logs one distinct `unhealthy:true` line past MESH_SUBSCRIBE_UNHEALTHY_AFTER (default 10) instead of hot-spinning identical errors at the base interval forever.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Point hardening-backlog comment at docs/backlog/hardening.md (docs consolidation follow-up)
 */

import Redis from 'ioredis';
import { createChildLogger } from '@/shared/logger';
import type { MeshEnvelope, MeshTransport, ConsumedEnvelope, MeshSubscription } from './mesh-communication-service';

const logger = createChildLogger({ module: 'redis-mesh-transport' });
const DEFAULT_KEY_PREFIX = 'oshal:mesh';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const DEFAULT_CONSUMER_GROUP = 'swarm-workers';
const DEFAULT_MAX_LEN = 10000;

/**
 * @description Construction options for RedisMeshTransport.
 */
export interface RedisMeshTransportOptions {
  redisUrl?: string;
  keyPrefix?: string;
  consumerGroup?: string;
  maxStreamLen?: number;
}

/**
 * @description Redis Streams implementation of MeshTransport for durable envelope delivery.
 */
export class RedisMeshTransport implements MeshTransport {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly consumerGroup: string;
  private readonly maxStreamLen: number;
  /** Per-process cache of stream+group pairs already ensured, so the hot consume/publish path skips
   *  a redundant XGROUP CREATE round-trip once a group exists. Keyed `${streamKey}::${groupName}`. */
  private readonly ensuredGroups = new Set<string>();

  constructor(options: RedisMeshTransportOptions = {}) {
    this.keyPrefix = options.keyPrefix || DEFAULT_KEY_PREFIX;
    this.consumerGroup = options.consumerGroup || DEFAULT_CONSUMER_GROUP;
    this.maxStreamLen = options.maxStreamLen || DEFAULT_MAX_LEN;
    this.redis = new Redis(options.redisUrl || process.env.REDIS_URL || DEFAULT_REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    this.redis.on('error', (err) => logger.error({ err }, 'Redis mesh transport connection error'));
  }

  /**
   * @description Publishes a mesh envelope to the channel's Redis Stream.
   */
  async publish(envelope: MeshEnvelope): Promise<void> {
    const streamKey = `${this.keyPrefix}:${envelope.channel}`;
    await this.ensureConsumerGroup(streamKey);
    await this.redis.xadd(
      streamKey, 'MAXLEN', '~', String(this.maxStreamLen), '*',
      'data', JSON.stringify(envelope),
    );
    logger.info(
      { correlationId: envelope.correlationId, toAgentId: envelope.toAgentId, channel: envelope.channel, streamKey },
      'Published mesh envelope to Redis Stream',
    );
  }

  /**
   * @description Reads pending envelopes from a channel stream using the default consumer group.
   */
  async consume(channel: string, consumerId: string, count = 10): Promise<ConsumedEnvelope[]> {
    return this.consumeWithGroup(channel, consumerId, this.consumerGroup, count);
  }

  /**
   * @description Reads pending envelopes using a specific consumer group.
   * This allows the worker and the reply listener to have separate groups
   * so they don't compete for messages on the same channel.
   */
  async consumeWithGroup(channel: string, consumerId: string, group: string, count = 10): Promise<ConsumedEnvelope[]> {
    const streamKey = `${this.keyPrefix}:${channel}`;
    await this.ensureConsumerGroup(streamKey, group);
    // First drain pending messages (claimed but unacked — e.g. from a pod restart).
    // '0' returns messages previously delivered to this consumer but not yet acked.
    const pending = await this.redis.xreadgroup(
      'GROUP', group, consumerId,
      'COUNT', String(count),
      'STREAMS', streamKey, '0',
    );
    if (pending && pending.length > 0) {
      const parsed = parseStreamResults(pending as Array<[string, Array<[string, string[]]>]>);
      if (parsed.length > 0) return parsed;
    }
    // Then read new messages.
    const results = await this.redis.xreadgroup(
      'GROUP', group, consumerId,
      'COUNT', String(count),
      'STREAMS', streamKey, '>',
    );
    if (!results || results.length === 0) {
      return [];
    }
    return parseStreamResults(results as Array<[string, Array<[string, string[]]>]>);
  }

  /**
   * @description Acknowledges a processed stream entry.
   */
  async ack(channel: string, entryId: string, group?: string): Promise<void> {
    const streamKey = `${this.keyPrefix}:${channel}`;
    await this.redis.xack(streamKey, group || this.consumerGroup, entryId);
  }

  /**
   * @description Subscribes to a channel with an auto-polling loop. Returns a handle to stop.
   */
  subscribe(
    channel: string,
    consumerId: string,
    handler: (envelope: MeshEnvelope, entryId: string) => Promise<void>,
    pollIntervalMs = 1000,
  ): MeshSubscription {
    let running = true;
    // Backoff/give-up guardrail (docs/backlog/hardening.md #9): a persistent outage (Redis
    // down, auth failure) must not hot-spin the poll at the base interval forever and
    // bury the signal in identical error lines. Count consecutive failures, back off
    // exponentially up to a cap, and emit ONE distinct `unhealthy` line past a
    // threshold so log-based monitoring can alert. We keep retrying (Redis may recover)
    // rather than terminating the subscription.
    let consecutiveFailures = 0;
    const maxBackoffMs = Math.max(pollIntervalMs, 30_000);
    const unhealthyThreshold = Math.max(1, Number(process.env.MESH_SUBSCRIBE_UNHEALTHY_AFTER ?? 10));
    const loop = async () => {
      while (running) {
        try {
          const consumed = await this.consume(channel, consumerId);
          for (const { entryId, envelope } of consumed) {
            try {
              await handler(envelope, entryId);
            } catch (handlerErr) {
              logger.error({ err: handlerErr, channel, entryId }, 'Subscription handler error');
            }
            await this.ack(channel, entryId);
          }
          consecutiveFailures = 0;
        } catch (err) {
          consecutiveFailures += 1;
          const backoffMs = Math.min(pollIntervalMs * 2 ** Math.min(consecutiveFailures - 1, 10), maxBackoffMs);
          if (consecutiveFailures === unhealthyThreshold) {
            logger.error({ err, channel, consecutiveFailures, backoffMs, unhealthy: true }, 'Subscription UNHEALTHY — consecutive poll failures crossed threshold (backing off, still retrying)');
          } else {
            logger.error({ err, channel, consecutiveFailures, backoffMs }, 'Subscription poll error');
          }
          if (running) {
            await sleep(backoffMs);
          }
          continue;
        }
        if (running) {
          await sleep(pollIntervalMs);
        }
      }
    };
    loop().catch((err) => logger.error({ err, channel }, 'Subscription loop terminated'));
    return { stop: () => { running = false; } };
  }

  /**
   * @description Claims orphaned messages from dead consumers using XAUTOCLAIM.
   */
  async claimOrphaned(channel: string, consumerId: string, minIdleMs = 60000, count = 5, group?: string): Promise<ConsumedEnvelope[]> {
    const streamKey = `${this.keyPrefix}:${channel}`;
    const targetGroup = group || this.consumerGroup;
    try {
      const result = await this.redis.call(
        'XAUTOCLAIM', streamKey, targetGroup, consumerId,
        String(minIdleMs), '0-0', 'COUNT', String(count),
      ) as [string, Array<[string, string[]]>, string[]];
      if (!result || !Array.isArray(result[1]) || result[1].length === 0) {
        return [];
      }
      const envelopes: ConsumedEnvelope[] = [];
      for (const [entryId, fields] of result[1]) {
        const dataIndex = fields.indexOf('data');
        if (dataIndex === -1 || dataIndex + 1 >= fields.length) {
          continue;
        }
        try {
          const envelope = JSON.parse(fields[dataIndex + 1]) as MeshEnvelope;
          envelopes.push({ entryId, envelope });
        } catch {
          logger.warn({ entryId }, 'Failed to parse claimed envelope');
        }
      }
      if (envelopes.length > 0) {
        logger.info({ channel, consumerId, claimed: envelopes.length }, 'Claimed orphaned messages from dead consumers');
      }
      return envelopes;
    } catch (error) {
      // Issue #6: after a FLUSHDB the stream + consumer group don't exist
      // yet — Redis returns "NOGROUP No such key ... or consumer group
      // 'swarm-execution'". The stream + group recreate themselves on the
      // next XADD/XGROUP CREATE, so this isn't a real failure; demote the
      // log to debug for that specific reply error so log noise stays low.
      const msg = (error as Error)?.message ?? '';
      if (msg.startsWith('NOGROUP')) {
        logger.debug({ channel }, 'XAUTOCLAIM skipped — stream/group not yet created (NOGROUP — expected after flush or first run)');
      } else {
        logger.warn({ err: error, channel }, 'XAUTOCLAIM not available; skipping orphan recovery');
      }
      return [];
    }
  }

  /**
   * @description Removes all consumers from the group except the given one.
   */
  async purgeStaleConsumers(channel: string, keepConsumerId: string): Promise<void> {
    const streamKey = `${this.keyPrefix}:${channel}`;
    try {
      await this.ensureConsumerGroup(streamKey);
      const info = await this.redis.call('XINFO', 'CONSUMERS', streamKey, this.consumerGroup) as Array<unknown[]>;
      let removed = 0;
      for (const entry of info) {
        const nameIdx = (entry as string[]).indexOf('name');
        if (nameIdx === -1 || nameIdx + 1 >= (entry as string[]).length) continue;
        const name = (entry as string[])[nameIdx + 1];
        if (name !== keepConsumerId) {
          await this.redis.call('XGROUP', 'DELCONSUMER', streamKey, this.consumerGroup, name);
          removed++;
        }
      }
      if (removed > 0) {
        logger.info({ channel, keepConsumerId, removed }, 'Purged stale consumers from group');
      }
    } catch (error) {
      logger.warn({ err: error, channel }, 'Failed to purge stale consumers');
    }
  }

  /**
   * @description Gracefully disconnects from Redis.
   */
  async disconnect(): Promise<void> {
    await this.redis.quit();
  }

  /**
   * @description Creates the consumer group if it does not exist.
   */
  private async ensureConsumerGroup(streamKey: string, group?: string, startFrom?: string): Promise<void> {
    const groupName = group || this.consumerGroup;
    const cacheKey = `${streamKey}::${groupName}`;
    if (this.ensuredGroups.has(cacheKey)) return;
    // Default groups start from '0' (beginning). Execution groups start from '$' (latest)
    // so they don't replay historical messages.
    const offset = startFrom || (groupName === 'swarm-execution' ? '$' : '0');
    try {
      await this.redis.xgroup('CREATE', streamKey, groupName, offset, 'MKSTREAM');
      this.ensuredGroups.add(cacheKey);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) {
        throw error;
      }
      // Group already exists — record it so we don't re-issue CREATE on every call.
      this.ensuredGroups.add(cacheKey);
    }
  }
}

/**
 * @description Parses raw Redis XREADGROUP results into typed envelopes.
 */
function parseStreamResults(results: Array<[string, Array<[string, string[]]>]>): ConsumedEnvelope[] {
  const envelopes: ConsumedEnvelope[] = [];
  for (const [, entries] of results) {
    for (const [entryId, fields] of entries) {
      const dataIndex = fields.indexOf('data');
      if (dataIndex === -1 || dataIndex + 1 >= fields.length) {
        continue;
      }
      try {
        const envelope = JSON.parse(fields[dataIndex + 1]) as MeshEnvelope;
        envelopes.push({ entryId, envelope });
      } catch {
        logger.warn({ entryId }, 'Failed to parse mesh envelope from Redis Stream');
      }
    }
  }
  return envelopes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
