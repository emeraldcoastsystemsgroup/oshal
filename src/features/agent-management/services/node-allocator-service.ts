/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Phase 2: NodeAllocatorService — manages generic node pool via Redis registry, assigns bots to idle nodes, detects unconsumed messages for wake-on-demand
 * 2 | maintainer@emeraldcoastsystemsgroup.com   | Authenticate assign/release calls with the shared service secret so the node's fail-closed machine control plane never receives anonymous credential-bearing requests.
 * 3 | maintainer@emeraldcoastsystemsgroup.com   | Validate node ids and endpoint origins; Redis-learned hosts must match the node id or NODE_POOL_ALLOWED_HOSTS, preventing registry poisoning from turning credential-bearing assignment calls into SSRF/exfiltration.
 * 4 | maintainer@emeraldcoastsystemsgroup.com   | Decomposed assignNode into focused reservation, HTTP, persistence, and rollback helpers so the security-sensitive control flow remains below the repository's fifty-line function limit.
 * 5 | maintainer@emeraldcoastsystemsgroup.com   | Quarantine nodes after any unknown assign/release outcome. A rejected, timed-out, or unreachable release can no longer be recorded as idle while the prior assignment's credentials may still be resident.
 * 6 | maintainer@emeraldcoastsystemsgroup.com   | Fence partial Redis transitions: an active-map residue can no longer bypass quarantine, release cleanup failures withhold the node, and restart registration removes stale assignments before idle membership is restored.
 * 7 | maintainer@emeraldcoastsystemsgroup.com   | SEC-05: retire credential-bearing node assignments and reject legacy carriers before reservation or network activity.
 */

import Redis from 'ioredis';
import { createChildLogger } from '@/shared/logger';
import { serviceSecretHeaders } from '@/shared/middleware/authz';
import {
  normalizeConfiguredNodeEndpoint,
  normalizeRegisteredNodeEndpoint,
  requireSafeNodeId,
} from './node-pool-endpoint';

const logger = createChildLogger({ module: 'node-allocator-service' });

const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const KEY_PREFIX = 'node:pool';
const QUARANTINED_NODES_KEY = `${KEY_PREFIX}:quarantined`;
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
  status: 'idle' | 'assigning' | 'active' | 'releasing' | 'quarantined';
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
 *   node:pool:{nodeId}:status     → "idle" | "assigning" | "active" | "releasing" | "quarantined"
 *   node:pool:{nodeId}:assignment → JSON { agentId, agent, model, provider, assignedAt }
 *   node:pool:{nodeId}:heartbeat  → timestamp (EXPIRE-based liveness)
 *   node:pool:{nodeId}:endpoint   → HTTP endpoint URL for this node
 *   node:pool:idle                → Redis SET of idle nodeIds (O(1) SPOP)
 *   node:pool:active              → Redis HASH { agentId → nodeId }
 *   node:pool:quarantined         → Redis SET of nodes requiring a confirmed release/re-register
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
    this.nodeEndpoints = Object.create(null) as Record<string, string>;
    for (const [nodeId, endpoint] of Object.entries(options.nodeEndpoints || {})) {
      this.nodeEndpoints[nodeId] = normalizeConfiguredNodeEndpoint(nodeId, endpoint);
    }

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
    if (Object.prototype.hasOwnProperty.call(config, 'credentials')) {
      throw new Error('credential fields are not accepted on node assignments');
    }
    const startedAt = Date.now();
    logger.info({ agentId: config.agentId, agent: config.agent, model: config.model, provider: config.provider }, 'Assigning node for agent');
    const existing = await this.findExistingAssignment(config);
    if (existing) return existing;
    const { nodeId, endpoint } = await this.reserveIdleNode(config.agentId);
    try {
      await this.redis.set(`${KEY_PREFIX}:${nodeId}:status`, 'assigning');
      await this.requestNodeAssignment(nodeId, endpoint, config);
      const assignment = this.buildAssignment(nodeId, endpoint, config);
      await this.persistAssignment(assignment);
      logger.info({ nodeId, agentId: config.agentId, agent: config.agent, durationMs: Date.now() - startedAt }, 'Node assigned successfully');
      return assignment;
    } catch (error) {
      await this.quarantineNode(nodeId, 'assignment_outcome_unknown');
      logger.error({ err: error, nodeId, agentId: config.agentId }, 'Node assignment failed — node quarantined');
      throw error;
    }
  }

  private async findExistingAssignment(config: NodeAssignmentConfig): Promise<NodeAssignment | null> {
    const rawNodeId = await this.redis.hget(`${KEY_PREFIX}:active`, config.agentId);
    if (!rawNodeId) return null;
    const nodeId = requireSafeNodeId(rawNodeId);
    const [status, quarantined, assignmentRaw] = await Promise.all([
      this.redis.get(`${KEY_PREFIX}:${nodeId}:status`),
      this.redis.sismember(QUARANTINED_NODES_KEY, nodeId),
      this.redis.get(`${KEY_PREFIX}:${nodeId}:assignment`),
    ]);
    if (status !== 'active' || quarantined === 1 || !assignmentRaw) {
      await this.quarantineNode(nodeId, 'stale_active_mapping');
      throw new Error(`Agent ${config.agentId} has an uncertain quarantined node assignment`);
    }
    try {
      const endpoint = await this.getNodeEndpoint(nodeId);
      const assignment = parseStoredAssignment(assignmentRaw, nodeId, config.agentId, endpoint);
      logger.info({ agentId: config.agentId, nodeId }, 'Agent already active on node');
      return assignment;
    } catch (error) {
      await this.quarantineNode(nodeId, 'invalid_active_assignment');
      throw error;
    }
  }

  private async reserveIdleNode(agentId: string): Promise<{ nodeId: string; endpoint: string }> {
    const candidate = await this.redis.spop(`${KEY_PREFIX}:idle`);
    if (!candidate) {
      logger.warn({ agentId }, 'No idle nodes available in pool');
      throw new Error('No idle nodes available — pool exhausted');
    }
    let nodeId: string;
    try {
      nodeId = requireSafeNodeId(candidate);
    } catch (error) {
      await this.redis.sadd(QUARANTINED_NODES_KEY, candidate);
      throw error;
    }
    try {
      return { nodeId, endpoint: await this.getNodeEndpoint(nodeId) };
    } catch (error) {
      await this.quarantineNode(nodeId, 'endpoint_validation_failed');
      throw error;
    }
  }

  private async requestNodeAssignment(
    nodeId: string,
    endpoint: string,
    config: NodeAssignmentConfig,
  ): Promise<void> {
    const response = await fetch(`${endpoint}/node/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...serviceSecretHeaders() },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      const responseBody = (await response.text()).slice(0, 2_048);
      throw new Error(`Node ${nodeId} rejected assignment: ${response.status} ${responseBody}`);
    }
  }

  private buildAssignment(
    nodeId: string,
    endpoint: string,
    config: NodeAssignmentConfig,
  ): NodeAssignment {
    return {
      nodeId,
      agentId: config.agentId,
      agent: config.agent,
      model: config.model,
      provider: config.provider,
      assignedAt: new Date().toISOString(),
      nodeEndpoint: endpoint,
    };
  }

  private async persistAssignment(assignment: NodeAssignment): Promise<void> {
    const { nodeId, agentId } = assignment;
    await Promise.all([
      this.redis.set(`${KEY_PREFIX}:${nodeId}:status`, 'active'),
      this.redis.set(`${KEY_PREFIX}:${nodeId}:assignment`, JSON.stringify(assignment)),
      this.redis.hset(`${KEY_PREFIX}:active`, agentId, nodeId),
      this.redis.srem(QUARANTINED_NODES_KEY, nodeId),
      this.redis.lpush(`${KEY_PREFIX}:history:${nodeId}`, JSON.stringify({ ...assignment, action: 'assign' })),
      this.redis.ltrim(`${KEY_PREFIX}:history:${nodeId}`, 0, 99),
    ]);
  }

  private async quarantineNode(nodeId: string, reason: string): Promise<void> {
    // Idle membership is reuse authority. Remove it before every other registry write so a
    // later failure can withhold capacity but cannot make an uncertain node assignable.
    await this.redis.srem(`${KEY_PREFIX}:idle`, nodeId);
    await this.redis.set(`${KEY_PREFIX}:${nodeId}:status`, 'quarantined');
    await this.redis.sadd(QUARANTINED_NODES_KEY, nodeId);
    await this.redis.lpush(`${KEY_PREFIX}:history:${nodeId}`, JSON.stringify({
      nodeId,
      action: 'quarantine',
      reason,
      at: new Date().toISOString(),
    }));
  }

  /**
   * @description Releases a node from its current assignment and returns it to idle.
   * @param nodeId - The node to release
   */
  async releaseNode(nodeId: string): Promise<void> {
    const safeNodeId = requireSafeNodeId(nodeId);
    const startedAt = Date.now();
    logger.info({ nodeId: safeNodeId }, 'Releasing node');

    let agentId: string | undefined;
    try {
      const endpoint = await this.getNodeEndpoint(safeNodeId);
      const assignmentRaw = await this.redis.get(`${KEY_PREFIX}:${safeNodeId}:assignment`);
      agentId = assignmentRaw ? (JSON.parse(assignmentRaw) as { agentId?: string }).agentId : undefined;
      await this.requestNodeRelease(safeNodeId, endpoint);
    } catch (error) {
      await this.quarantineNode(safeNodeId, 'release_not_acknowledged');
      logger.error({ err: error, nodeId: safeNodeId }, 'Node release was not acknowledged — node quarantined');
      throw error;
    }

    try {
      await this.persistReleasedNode(safeNodeId, agentId);
    } catch (error) {
      await this.quarantineAfterRegistryFailure(safeNodeId, error);
      throw error;
    }

    logger.info({ nodeId: safeNodeId, agentId, durationMs: Date.now() - startedAt }, 'Node released — returned to idle pool');
  }

  private async requestNodeRelease(nodeId: string, endpoint: string): Promise<void> {
    const response = await fetch(`${endpoint}/node/release`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...serviceSecretHeaders() },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const responseBody = (await response.text()).slice(0, 2_048);
      throw new Error(`Node ${nodeId} rejected release: ${response.status} ${responseBody}`);
    }
  }

  /** @description Clears assignment authority before adding a positively released node to idle. */
  private async persistReleasedNode(nodeId: string, agentId?: string): Promise<void> {
    await Promise.all([
      this.redis.del(`${KEY_PREFIX}:${nodeId}:assignment`),
      agentId ? this.redis.hdel(`${KEY_PREFIX}:active`, agentId) : Promise.resolve(),
      this.redis.lpush(`${KEY_PREFIX}:history:${nodeId}`, JSON.stringify({
        nodeId,
        agentId,
        action: 'release',
        at: new Date().toISOString(),
      })),
    ]);
    await this.redis.set(`${KEY_PREFIX}:${nodeId}:status`, 'idle');
    await this.redis.srem(QUARANTINED_NODES_KEY, nodeId);
    await this.redis.sadd(`${KEY_PREFIX}:idle`, nodeId);
  }

  /** @description Best-effort fence when Redis cleanup fails after the node acknowledged release. */
  private async quarantineAfterRegistryFailure(nodeId: string, cause: unknown): Promise<void> {
    try {
      await this.quarantineNode(nodeId, 'release_registry_cleanup_failed');
    } catch (quarantineError) {
      logger.error({ err: quarantineError, cause, nodeId }, 'Failed to persist node quarantine after registry cleanup error');
    }
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

  /** @description Returns nodes withheld from reuse until release is positively acknowledged. */
  async getQuarantinedNodes(): Promise<string[]> {
    return await this.redis.smembers(QUARANTINED_NODES_KEY);
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
  async getPoolStatus(): Promise<{
    idle: string[];
    active: Record<string, string>;
    quarantined: string[];
    totalNodes: number;
  }> {
    const [idle, active, quarantined] = await Promise.all([
      this.getIdleNodes(),
      this.getActiveAssignments(),
      this.getQuarantinedNodes(),
    ]);
    return {
      idle,
      active,
      quarantined,
      totalNodes: new Set([...idle, ...Object.values(active), ...quarantined]).size,
    };
  }

  /**
   * @description Registers a node in the pool. Called by the node itself on startup
   * or by the allocator when configuring the pool.
   */
  async registerNode(nodeId: string, endpoint: string): Promise<void> {
    const safeNodeId = requireSafeNodeId(nodeId);
    const trustedEndpoint = normalizeRegisteredNodeEndpoint(safeNodeId, endpoint);
    this.nodeEndpoints[safeNodeId] = trustedEndpoint;
    await this.clearNodeRegistryResidue(safeNodeId);
    await this.redis.set(`${KEY_PREFIX}:${safeNodeId}:endpoint`, trustedEndpoint);
    await this.redis.set(`${KEY_PREFIX}:${safeNodeId}:status`, 'idle');
    await this.redis.srem(QUARANTINED_NODES_KEY, safeNodeId);
    // Registration follows node-process crash recovery; idle is restored only after every stale
    // active/assignment record has been removed successfully.
    await this.redis.sadd(`${KEY_PREFIX}:idle`, safeNodeId);
    logger.info({ nodeId: safeNodeId, endpoint: trustedEndpoint }, 'Node registered in pool');
  }

  /** @description Removes every process-registry reference to a restarted, locally scrubbed node. */
  private async clearNodeRegistryResidue(nodeId: string): Promise<void> {
    const active = await this.redis.hgetall(`${KEY_PREFIX}:active`);
    const staleAgents = Object.entries(active)
      .filter(([, assignedNodeId]) => assignedNodeId === nodeId)
      .map(([agentId]) => agentId);
    await this.redis.del(`${KEY_PREFIX}:${nodeId}:assignment`);
    for (const agentId of staleAgents) {
      await this.redis.hdel(`${KEY_PREFIX}:active`, agentId);
    }
  }

  /**
   * @description Records a heartbeat for a node (EXPIRE-based liveness detection).
   */
  async heartbeat(nodeId: string): Promise<void> {
    const safeNodeId = requireSafeNodeId(nodeId);
    await this.redis.set(`${KEY_PREFIX}:${safeNodeId}:heartbeat`, String(Date.now()), 'EX', HEARTBEAT_TTL_SECONDS);
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
    const safeNodeId = requireSafeNodeId(nodeId);
    if (this.nodeEndpoints[safeNodeId]) return this.nodeEndpoints[safeNodeId];
    const endpoint = await this.redis.get(`${KEY_PREFIX}:${safeNodeId}:endpoint`);
    if (endpoint) {
      const trusted = normalizeRegisteredNodeEndpoint(safeNodeId, endpoint);
      this.nodeEndpoints[safeNodeId] = trusted;
      return trusted;
    }
    // Fallback to Docker internal convention
    return normalizeRegisteredNodeEndpoint(safeNodeId, `http://${safeNodeId}:5000`);
  }

  /**
   * @description Disconnects from Redis.
   */
  async disconnect(): Promise<void> {
    this.redis.disconnect();
  }
}

/** @description Validates process-registry data before treating an active mapping as authority. */
function parseStoredAssignment(
  raw: string,
  expectedNodeId: string,
  expectedAgentId: string,
  trustedEndpoint: string,
): NodeAssignment {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Stored node assignment is invalid: ${expectedNodeId}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Stored node assignment is invalid: ${expectedNodeId}`);
  }
  const record = value as Record<string, unknown>;
  const fields = ['agent', 'model', 'provider', 'assignedAt'] as const;
  if (
    record.nodeId !== expectedNodeId
    || record.agentId !== expectedAgentId
    || fields.some((field) => typeof record[field] !== 'string' || record[field] === '')
  ) {
    throw new Error(`Stored node assignment does not match active authority: ${expectedNodeId}`);
  }
  return {
    nodeId: expectedNodeId,
    agentId: expectedAgentId,
    agent: String(record.agent),
    model: String(record.model),
    provider: String(record.provider),
    assignedAt: String(record.assignedAt),
    nodeEndpoint: trustedEndpoint,
  };
}
