/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Added Redis-backed runtime agent registry for live swarm worker availability and targeted assignment
 */

import Redis from 'ioredis';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'agent-runtime-registry-service' });
const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const DEFAULT_KEY_PREFIX = 'oshal:runtime-agent';
const DEFAULT_TTL_SECONDS = 90;

/**
 * @description Runtime availability payload stored for one live swarm agent.
 */
export interface AgentRuntimeRegistration {
  agentId: string;
  agentName: string;
  aliases?: string[];
  role: string;
  capabilities: string[];
  status: 'online' | 'offline';
  endpointUrl?: string;
  internalEndpointUrl?: string;
  externalPort?: number | null;
  startedAt: string;
  heartbeatAt: string;
}

/**
 * @description Configuration options for the runtime agent registry.
 */
export interface AgentRuntimeRegistryOptions {
  redisUrl?: string;
  keyPrefix?: string;
  ttlSeconds?: number;
}

/**
 * @description Redis-backed runtime registry for currently alive swarm workers.
 */
export class AgentRuntimeRegistryService {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;

  constructor(options: AgentRuntimeRegistryOptions = {}) {
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.redis = new Redis(options.redisUrl ?? process.env.REDIS_URL ?? DEFAULT_REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    this.redis.on('error', (error) => logger.error({ err: error }, 'Runtime agent registry Redis connection error'));
  }

  /**
   * @description Upserts one live agent registration with a TTL heartbeat.
   * @param registration - Canonical runtime registration payload.
   * @returns Normalized registration after persistence.
   */
  async upsertAgent(registration: AgentRuntimeRegistration): Promise<AgentRuntimeRegistration> {
    const normalized = normalizeRegistration(registration);
    await this.redis.set(buildRegistryKey(this.keyPrefix, normalized.agentId), JSON.stringify(normalized), 'EX', this.ttlSeconds);
    logger.info(
      {
        agentId: normalized.agentId,
        agentName: normalized.agentName,
        externalPort: normalized.externalPort ?? null,
        ttlSeconds: this.ttlSeconds,
      },
      'Upserted runtime agent registration',
    );
    return normalized;
  }

  /**
   * @description Reads one runtime registration by canonical agent ID.
   * @param agentId - Canonical agent identifier.
   * @returns Parsed runtime registration or null when the TTL has expired.
   */
  async getAgentRegistration(agentId: string): Promise<AgentRuntimeRegistration | null> {
    logger.info({ agentId }, 'Reading runtime agent registration');
    const payload = await this.redis.get(buildRegistryKey(this.keyPrefix, agentId));
    return parseRegistration(agentId, payload);
  }

  /**
   * @description Lists all currently alive runtime registrations from Redis.
   * @returns Parsed runtime registrations with expired and malformed rows removed.
   */
  async listAgentRegistrations(): Promise<AgentRuntimeRegistration[]> {
    logger.info({ keyPrefix: this.keyPrefix }, 'Listing runtime agent registrations');
    const keys = await scanRegistrationKeys(this.redis, this.keyPrefix);
    if (keys.length === 0) {
      return [];
    }

    const payloads = await this.redis.mget(keys);
    const registrations = payloads.flatMap((payload, index) => {
      const agentId = keys[index]?.slice(this.keyPrefix.length + 1) ?? 'unknown-agent';
      const parsed = parseRegistration(agentId, payload);
      return parsed ? [parsed] : [];
    });

    logger.info({ registrationCount: registrations.length }, 'Runtime agent registrations loaded');
    return registrations;
  }

  /**
   * @description Lists canonical agent IDs that currently have a live runtime heartbeat.
   * @returns Online agent IDs suitable for routing-time availability filtering.
   */
  async listOnlineAgentIds(): Promise<string[]> {
    const registrations = await this.listAgentRegistrations();
    const onlineAgentIds = registrations
      .filter((registration) => registration.status === 'online')
      .map((registration) => registration.agentId);
    logger.info({ onlineAgentCount: onlineAgentIds.length }, 'Resolved online agent IDs from runtime registry');
    return onlineAgentIds;
  }

  /**
   * @description Removes one runtime registration immediately.
   * @param agentId - Canonical agent identifier.
   * @returns Nothing.
   */
  async unregisterAgent(agentId: string): Promise<void> {
    await this.redis.del(buildRegistryKey(this.keyPrefix, agentId));
    logger.info({ agentId }, 'Removed runtime agent registration');
  }

  /**
   * @description Disconnects the Redis client used by the runtime registry.
   * @returns Nothing.
   */
  async disconnect(): Promise<void> {
    await this.redis.quit();
    logger.info('Runtime agent registry disconnected');
  }
}

function normalizeRegistration(registration: AgentRuntimeRegistration): AgentRuntimeRegistration {
  return {
    ...registration,
    aliases: normalizeAliases(registration.aliases),
    capabilities: registration.capabilities.map((capability) => capability.trim()).filter((capability) => capability.length > 0),
    endpointUrl: registration.endpointUrl?.trim() ?? '',
    internalEndpointUrl: registration.internalEndpointUrl?.trim() ?? '',
  };
}

function normalizeAliases(aliases?: string[]): string[] {
  if (!aliases) {
    return [];
  }

  const seen = new Set<string>();
  return aliases
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0)
    .filter((alias) => {
      if (seen.has(alias)) {
        return false;
      }
      seen.add(alias);
      return true;
    });
}

function buildRegistryKey(keyPrefix: string, agentId: string): string {
  return `${keyPrefix}:${agentId}`;
}

async function scanRegistrationKeys(redis: Redis, keyPrefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', `${keyPrefix}:*`, 'COUNT', '100');
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys.sort();
}

function parseRegistration(agentId: string, payload: string | null): AgentRuntimeRegistration | null {
  if (!payload) {
    return null;
  }

  try {
    const parsed = JSON.parse(payload) as AgentRuntimeRegistration;
    return normalizeRegistration(parsed);
  } catch (error) {
    logger.error({ err: error, agentId }, 'Failed to parse runtime agent registration');
    return null;
  }
}
