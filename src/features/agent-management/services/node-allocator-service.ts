/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 2: NodeAllocatorService — manages generic node pool via Redis registry, assigns bots to idle nodes, detects unconsumed messages for wake-on-demand
 */

import Redis from 'ioredis';
import { createChildLogger } from '@/shared/logger';

const logger = createChildLogger({ module: 'node-allocator-service' });

const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const KEY_PREFIX = 'node:pool';
const HEARTBEAT_TTL_SECONDS = 60;
const PENDING_MESSAGE_SCAN_INTERVAL_MS = 10_000;

/**
 * @description Assignment request sent to a node's POST /node/assign endpoint.
 */
export interface NodeAssignmentConfig {
  agentId: string;
  personaFile: string;
  agent: string;
  model: string;
  provider: string;
  credentials?: Record<string, string>;
  toolAuthorizations?: string[];
  ttlSeconds?: number;
}

/**
 * @description Assignment result from the allocator.
 */
export interface NodeAssignment {
  nodeId: string;
  agentId: string;
  agent: string;
  model: string;
  provider: string;
  assignedAt: string;
  nodeEndpoint: string;
}

/**
 * @description Info about pending messages on an unconsumed agent stream.
 */
export interface PendingMessageInfo {
  agentId: string;
  channel: string;
  pendingCount: number;
  oldestMessageMs: number;
}

/**
 * @description Registered node in the pool with its endpoint URL.
 */
export interface PoolNode {
  nodeId: string;
  endpoint: string;
  status: 'idle' | 'assigning' | 'active' | 'releasing';
  agentId?: string;
  lastHeartbeat?: number;
}

/**
 * @description Options for constructing the NodeAllocatorService.
 */
export interface NodeAllocatorOptions {
  redisUrl?: string;
  /** Map of nodeId → HTTP endpoint URL for calling /node/assign. */
  nodeEndpoints?: Record<string, string>;
}

/**
 * @description Manages a pool of generic nodes, assigns bot identities on demand,
 * and detects unconsumed Redis Stream messages for wake-on-demand hot-loading.
 *
 * Redis registry schema:
 *   node:pool:{nodeId}:status     → "idle" | "assigning" | "active" | "releasing"
 *   node:pool:{nodeId}:assignment → JSON { agentId, agent, model, provider, assignedAt }
 *   node:pool:{nodeId}:heartbeat  → timestamp (EXPIRE-based liveness)
 *   node:pool:{nodeId}:endpoint   → HTTP endpoint URL for this node
 *   node:pool:idle                → Redis SET of idle nodeIds (O(1) SPOP)
 *   node:pool:active              → Redis HASH { agentId → nodeId }
 *   node:pool:history:{nodeId}    → Redis LIST of recent assignments (forensics)
 */
export class NodeAllocatorService {
  private readonly redis: Redis;
  private readonly nodeEndpoints: Record<string, string>;

  constructor(options: NodeAllocatorOptions = {}) {
    this.redis = new Redis(options.redisUrl || process.env.REDIS_URL || DEFAULT_REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableOfflineQueue: true,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    });
    this.redis.on('error', (err) => logger.error({ err }, 'NodeAllocator Redis connection error'));
    this.nodeEndpoints = options.nodeEndpoints || {};

    logger.info({ knownNodes: Object.keys(this.nodeEndpoints).length }, 'NodeAllocatorService initialized');
  }

  /**
   * @description Assigns a bot identity to an idle node from the pool.
   * 1. Checks if agentId is already active on a node → return existing assignment
   * 2. Pops an idle node from the pool
   * 3. Calls POST /node/assign on the node
   * 4. Updates Redis registry
   *
   * @param config - Bot assignment configuration
   * @returns Assignment result with nodeId and endpoint
   * @throws Error when no idle nodes are available or assignment fails
   */
  async assignNode(config: NodeAssignmentConfig): Promise<NodeAssignment> {
    const startedAt = Date.now();
    logger.info({ agentId: config.agentId, agent: config.agent, model: config.model, provider: config.provider }, 'Assigning node for agent');

    // Check if agent is already active
    const existingNodeId = await this.redis.hget(`${KEY_PREFIX}:active`, config.agentId);
    if (existingNodeId) {
      const endpoint = await this.getNodeEndpoint(existingNodeId);
      logger.info({ agentId: config.agentId, nodeId: existingNodeId }, 'Agent already active on node');
      return {
        nodeId: existingNodeId,
        agentId: config.agentId,
        agent: config.agent,
        model: config.model,
        provider: config.provider,
        assignedAt: new Date().toISOString(),
        nodeEndpoint: endpoint,
      };
    }

    // Pop an idle node
    const nodeId = await this.redis.spop(`${KEY_PREFIX}:idle`);
    if (!nodeId) {
      logger.warn({ agentId: config.agentId }, 'No idle nodes available in pool');
      throw new Error('No idle nodes available — pool exhausted');
    }

    const endpoint = await this.getNodeEndpoint(nodeId);

    try {
      // Mark as assigning
      await this.redis.set(`${KEY_PREFIX}:${nodeId}:status`, 'assigning');

      // Call the node's assign endpoint
      const response = await fetch(`${endpoint}/node/assign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Node ${nodeId} rejected assignment: ${response.status} ${body}`);
      }

      // Update registry
      const assignment: NodeAssignment = {
        nodeId,
        agentId: config.agentId,
        agent: config.agent,
        model: config.model,
        provider: config.provider,
        assignedAt: new Date().toISOString(),
        nodeEndpoint: endpoint,
      };

      await Promise.all([
        this.redis.set(`${KEY_PREFIX}:${nodeId}:status`, 'active'),
        this.redis.set(`${KEY_PREFIX}:${nodeId}:assignment`, JSON.stringify(assignment)),
        this.redis.hset(`${KEY_PREFIX}:active`, config.agentId, nodeId),
        this.redis.lpush(`${KEY_PREFIX}:history:${nodeId}`, JSON.stringify({ ...assignment, action: 'assign' })),
        this.redis.ltrim(`${KEY_PREFIX}:history:${nodeId}`, 0, 99),
      ]);

      logger.info({
        nodeId,
        agentId: config.agentId,
        agent: config.agent,
        durationMs: Date.now() - startedAt,
      }, 'Node assigned successfully');

      return assignment;
    } catch (error) {
      // Return node to idle pool on failure
      await this.redis.sadd(`${KEY_PREFIX}:idle`, nodeId);
      await this.redis.set(`${KEY_PREFIX}:${nodeId}:status`, 'idle');
      logger.error({ err: error, nodeId, agentId: config.agentId }, 'Node assignment failed — returned to idle pool');
      throw error;
    }
  }

  /**
   * @description Releases a node from its current assignment and returns it to idle.
   * @param nodeId - The node to release
   */
  async releaseNode(nodeId: string): Promise<void> {
    const startedAt = Date.now();
    logger.info({ nodeId }, 'Releasing node');

    const endpoint = await this.getNodeEndpoint(nodeId);
    const assignmentRaw = await this.redis.get(`${KEY_PREFIX}:${nodeId}:assignment`);
    const agentId = assignmentRaw ? (JSON.parse(assignmentRaw) as { agentId?: string }).agentId : undefined;

    try {
      // Call the node's release endpoint
      await fetch(`${endpoint}/node/release`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      logger.warn({ err: error, nodeId }, 'Node release HTTP call failed — proceeding with registry cleanup');
    }

    // Update registry regardless of HTTP result
    await Promise.all([
      this.redis.set(`${KEY_PREFIX}:${nodeId}:status`, 'idle'),
      this.redis.del(`${KEY_PREFIX}:${nodeId}:assignment`),
      this.redis.sadd(`${KEY_PREFIX}:idle`, nodeId),
      agentId ? this.redis.hdel(`${KEY_PREFIX}:active`, agentId) : Promise.resolve(),
      this.redis.lpush(`${KEY_PREFIX}:history:${nodeId}`, JSON.stringify({ nodeId, agentId, action: 'release', at: new Date().toISOString() })),
    ]);

    logger.info({ nodeId, agentId, durationMs: Date.now() - startedAt }, 'Node released — returned to idle pool');
  }

  /**
   * @description Finds which node is currently running a specific agent.
   * @returns nodeId if found, null if agent is not active
   */
  async findNodeForAgent(agentId: string): Promise<string | null> {
    return await this.redis.hget(`${KEY_PREFIX}:active`, agentId);
  }

  /**
   * @description Returns all idle node IDs in the pool.
   */
  async getIdleNodes(): Promise<string[]> {
    return await this.redis.smembers(`${KEY_PREFIX}:idle`);
  }

  /**
   * @description Returns the number of idle nodes available.
   */
  async getIdleCount(): Promise<number> {
    return await this.redis.scard(`${KEY_PREFIX}:idle`);
  }

  /**
   * @description Returns all active assignments as a map of agentId → nodeId.
   */
  async getActiveAssignments(): Promise<Record<string, string>> {
    return await this.redis.hgetall(`${KEY_PREFIX}:active`);
  }

  /**
   * @description Returns full pool status for monitoring/cockpit.
   */
  async getPoolStatus(): Promise<{ idle: string[]; active: Record<string, string>; totalNodes: number }> {
    const [idle, active] = await Promise.all([
      this.getIdleNodes(),
      this.getActiveAssignments(),
    ]);
    return {
      idle,
      active,
      totalNodes: idle.length + Object.keys(active).length,
    };
  }

  /**
   * @description Registers a node in the pool. Called by the node itself on startup
   * or by the allocator when configuring the pool.
   */
  async registerNode(nodeId: string, endpoint: string): Promise<void> {
    this.nodeEndpoints[nodeId] = endpoint;
    await Promise.all([
      this.redis.set(`${KEY_PREFIX}:${nodeId}:endpoint`, endpoint),
      this.redis.set(`${KEY_PREFIX}:${nodeId}:status`, 'idle'),
      this.redis.sadd(`${KEY_PREFIX}:idle`, nodeId),
    ]);
    logger.info({ nodeId, endpoint }, 'Node registered in pool');
  }

  /**
   * @description Records a heartbeat for a node (EXPIRE-based liveness detection).
   */
  async heartbeat(nodeId: string): Promise<void> {
    await this.redis.set(`${KEY_PREFIX}:${nodeId}:heartbeat`, String(Date.now()), 'EX', HEARTBEAT_TTL_SECONDS);
  }

  /**
   * @description Detects agent channels with pending unconsumed messages where
   * the target agent is not currently active on any node. These are candidates
   * for wake-on-demand hot-loading.
   *
   * Scans Redis streams matching lm32:mesh:agent.* and checks XPENDING counts.
   */
  async detectPendingMessages(): Promise<PendingMessageInfo[]> {
    const pending: PendingMessageInfo[] = [];
    const activeAgents = await this.getActiveAssignments();
    const activeAgentIds = new Set(Object.keys(activeAgents));

    try {
      // Scan for agent streams
      let cursor = '0';
      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', 'lm32:mesh:agent.*', 'COUNT', 100);
        cursor = nextCursor;

        for (const key of keys) {
          // Extract agentId from key: lm32:mesh:agent.{agentId}
          const agentId = key.replace('lm32:mesh:agent.', '');
          if (activeAgentIds.has(agentId)) continue;

          // Check stream length (unconsumed messages)
          const len = await this.redis.xlen(key);
          if (len > 0) {
            pending.push({
              agentId,
              channel: `agent.${agentId}`,
              pendingCount: len,
              oldestMessageMs: Date.now(), // approximate — could use XRANGE for exact
            });
          }
        }
      } while (cursor !== '0');
    } catch (error) {
      logger.error({ err: error }, 'Failed to scan for pending messages');
    }

    if (pending.length > 0) {
      logger.info({ pendingAgents: pending.map((p) => p.agentId), totalPending: pending.reduce((s, p) => s + p.pendingCount, 0) }, 'Detected unconsumed messages for inactive agents');
    }

    return pending;
  }

  /**
   * @description Returns the HTTP endpoint for a node, from cache or Redis.
   */
  private async getNodeEndpoint(nodeId: string): Promise<string> {
    if (this.nodeEndpoints[nodeId]) return this.nodeEndpoints[nodeId];
    const endpoint = await this.redis.get(`${KEY_PREFIX}:${nodeId}:endpoint`);
    if (endpoint) {
      this.nodeEndpoints[nodeId] = endpoint;
      return endpoint;
    }
    // Fallback to Docker internal convention
    return `http://${nodeId}:5000`;
  }

  /**
   * @description Disconnects from Redis.
   */
  async disconnect(): Promise<void> {
    this.redis.disconnect();
  }
}
