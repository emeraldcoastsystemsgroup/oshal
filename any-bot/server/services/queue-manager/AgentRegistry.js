/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * AgentRegistry — Redis-Based Agent Tracking & Capability Registry
 * 
 * @module queue-manager/AgentRegistry
 * @description Maintains real-time registry of all 16+ agents in the swarm, stored in
 * Redis with TTL-based auto-cleanup. Each agent's capabilities, routing_keywords,
 * status, load, and workspace scoping are tracked. The registry is the single source
 * of truth for which agents are alive and available for ticket routing.
 * 
 * ## Busy State Watchdog (Issue #001 Fix)
 * Instead of a dumb TTL kill, the registry supports an intelligent watchdog pattern:
 * - Agents write activity heartbeats to Redis via `recordActivity()` whenever they
 *   make LLM calls, write files, or do meaningful work.
 * - QueueManagerService calls `checkStuckAgents()` every 15 minutes.
 * - If an agent has been busy for > 60 minutes AND has no activity heartbeat in
 *   60 minutes → it is considered STUCK (not just slow).
 * - Stuck agents are force-released: busy status cleared, active ticket requeued to Todo.
 * - Active agents (recent heartbeat) are left alone regardless of how long they've been busy.
 * 
 * ## Redis Key Structure
 * ```
 * Key:     queue-manager:agent:{agentId}
 * TTL:     NONE (persistent — agents never expire from registry)
 * Value:   JSON { agentId, capabilities[], routingKeywords[], status, 
 *                 currentLoad, maxConcurrent, workspaces[], endpoint, lastHeartbeat,
 *                 busy_since, active_ticket_id }
 * 
 * Key:     agent:activity:{agentId}
 * TTL:     3600 seconds (1 hour — auto-expires if agent goes silent)
 * Value:   JSON { agentId, last_activity, activity_type, ticket_id }
 * ```
 * 
 * ## Integration Context
 * - **Written by**: {@link AgentBootstrap} on container startup (register + heartbeat)
 * - **Read by**: {@link QueueManagerService} → {@link CapabilityMatcher} for ticket routing
 * - **Queried by**: Health dashboard for agent status display
 * 
 * ## Multi-Tenant Workspace Scoping
 * Each agent can serve:
 * - `['*']` — All workspaces (default for most agents)
 * - `['workspace-id-1', 'workspace-id-2']` — Specific workspaces only
 * Filtering is done at query time via `canServeWorkspace()`.
 * 
 * ## Agent Lifecycle
 * ```
 * Container Start → register() → heartbeat(30s) → ... → persistent in Redis (no TTL expiry)
 * ```
 * 
 * @see {@link AgentBootstrap} for registration flow
 * @see {@link CapabilityMatcher} for how registry data is used in routing
 * @see {@link QueueManagerService.checkStuckAgents} for watchdog implementation
 */

const logger = require('../../utils/logger');

// How long an agent can be busy with NO activity before being considered stuck
const STUCK_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes

// Activity heartbeat TTL — if agent goes silent, key auto-expires
const ACTIVITY_TTL_SECONDS = 3600; // 1 hour

/**
 * @class AgentRegistry
 * @description Single source of truth for the swarm's live agent population. It exists
 * so that ticket routing decisions are made against the real, current state of every
 * agent (who is alive, what they can do, how loaded they are, and which workspaces they
 * may serve) rather than static config — and so that agents stuck without progress can
 * be detected and reclaimed instead of silently holding work. State is persisted in Redis
 * so it survives process restarts and is shared across the distributed components that
 * register, route, and monitor agents.
 */
class AgentRegistry {
  /**
   * @description Bind the registry to a Redis client and fix the key namespaces used for
   * agent records and activity heartbeats. A Redis client is mandatory because Redis is
   * the durable, shared backing store the whole swarm reads and writes through; construction
   * fails fast if it is missing so misconfiguration surfaces immediately rather than at
   * first query.
   * @param {Object} redisClient - Connected Redis client used for all registry persistence and pub/sub.
   */
  constructor(redisClient) {
    if (!redisClient) {
      throw new Error('Redis client is required for AgentRegistry');
    }
    this.redis = redisClient;
    this.keyPrefix = 'queue-manager:agent:';
    this.activityPrefix = 'agent:activity:';
  }

  /**
   * Register an agent in the registry
   * @param {Object} agentConfig - Agent configuration
   * @param {string} agentConfig.agent_id - Unique agent identifier
   * @param {string[]} agentConfig.capabilities - List of capabilities
   * @param {string} agentConfig.status - Agent status (idle/busy/offline)
   * @param {number} agentConfig.current_load - Current workload
   * @param {number} agentConfig.max_concurrent - Maximum concurrent tasks
   * @param {number} [agentConfig.success_rate] - Historical success rate
   * @param {string[]} [agentConfig.workspaces] - Workspace access list (['*'] for all, or specific IDs)
   * @param {string} [agentConfig.agent_scope] - Agent scope (shared/workspace-dedicated)
   * @returns {Promise<boolean>} Success status
   */
  async register(agentConfig) {
    logger.debug(`[AgentRegistry.register] START`, { agent_id: agentConfig.agent_id });
    try {
      const {
        agent_id,
        capabilities = [],
        status = 'idle',
        current_load = 0,
        max_concurrent = 3,
        success_rate = 1.0,
        workspaces = ['*'], // Default: shared agent serving all workspaces
        agent_scope = 'shared', // Default: shared
        endpoint = null, // HTTP endpoint for dispatch (e.g., http://swarm-research-bot:5000)
        port = null, // External port for dashboard health checks (e.g., 3033)
        selector_descriptor = '', // Mesh broadcast: natural language description of WHEN to select this agent
      } = agentConfig;

      if (!agent_id) {
        throw new Error('agent_id is required');
      }

      const key = `${this.keyPrefix}${agent_id}`;
      // Preserve enabled state across re-registrations (default: ON for new agents)
      let enabled = true;
      const existingData = await this.redis.get(key);
      if (existingData) {
        try {
          const existing = JSON.parse(existingData);
          if (typeof existing.enabled === 'boolean') {
            enabled = existing.enabled; // Preserve existing toggle state
          }
        } catch (e) { /* ignore parse errors, default to enabled */ }
      }

      const agentData = {
        agent_id,
        capabilities,
        status,
        current_load,
        max_concurrent,
        success_rate,
        workspaces,
        agent_scope,
        endpoint, // HTTP endpoint for QM to dispatch work to this agent's container
        port, // External port for dashboard health checks
        selector_descriptor, // Mesh broadcast: natural language WHEN-to-select description
        routing_keywords: agentConfig.routing_keywords || [], // ⭐ Dynamic routing keywords from persona YAML
        enabled, // Agent enable/disable toggle (default ON, configurable via dashboard)
        status_per_workspace: {}, // Track status per workspace
        load_per_workspace: {}, // Track load per workspace
        busy_since: null, // Timestamp when agent became busy (for watchdog)
        active_ticket_id: null, // Ticket currently being processed (for requeue on stuck)
        last_heartbeat: new Date().toISOString(),
        registered_at: new Date().toISOString()
      };

      await this.redis.set(key, JSON.stringify(agentData));
      await this.redis.persist(key); // PHASE_65: Infinite TTL — agents never expire from registry

      // ⭐ PHASE_48 Issue #048: Broadcast agent registration
      try {
        await this.redis.publish('swarm:agent-updates', JSON.stringify({
          type: 'agent-registered',
          agent_id,
          capabilities,
          port,
          endpoint,
          agent_scope,
          workspaces,
          timestamp: new Date().toISOString()
        }));
        logger.info(`[AgentRegistry.register] ✅ Broadcasted registration: ${agent_id}`);
      } catch (broadcastErr) {
        logger.warn(`[AgentRegistry.register] Broadcast failed (non-fatal): ${broadcastErr.message}`);
      }

      const workspaceScope = workspaces.includes('*') ? 'ALL workspaces' : workspaces.join(', ');
      logger.info(`[AgentRegistry.register] COMPLETE: ${agent_id} (${agent_scope}) caps=[${capabilities.join(', ')}] workspaces=${workspaceScope}`);
      return true;
    } catch (error) {
      logger.error(`[AgentRegistry.register] ERROR`, { error: error.message, stack: error.stack });
      return false;
    }
  }

  /**
   * Query agents based on filters
   * @param {Object} filters - Query filters
   * @param {string[]} [filters.capabilities] - Required capabilities
   * @param {string} [filters.status] - Agent status
   * @param {boolean} [filters.available] - Only available agents
   * @param {string} [filters.workspace] - Filter by workspace access
   * @returns {Promise<Object[]>} Matching agents
   */
  async query(filters = {}) {
    try {
      const keys = await this.redis.keys(`${this.keyPrefix}*`);
      
      if (keys.length === 0) {
        logger.warn('[AgentRegistry.query] No agents registered in system');
        return [];
      }

      const agents = [];
      for (const key of keys) {
        try {
          const data = await this.redis.get(key);
          if (data) {
            const agent = JSON.parse(data);
            agents.push(agent);
          }
        } catch (err) {
          logger.warn(`[AgentRegistry.query] Failed to parse agent data for key ${key}: ${err.message}`);
        }
      }

      // Apply filters
      let filtered = agents;

      // Filter by workspace access (MULTI-TENANT)
      if (filters.workspace) {
        filtered = filtered.filter(agent => {
          return agent.workspaces.includes('*') || agent.workspaces.includes(filters.workspace);
        });
      }

      // Filter by capabilities
      if (filters.capabilities && filters.capabilities.length > 0) {
        filtered = filtered.filter(agent => {
          return filters.capabilities.some(cap => 
            agent.capabilities.includes(cap)
          );
        });
      }

      // Filter by status
      if (filters.status) {
        filtered = filtered.filter(agent => agent.status === filters.status);
      }

      // Filter by availability (also excludes disabled agents)
      if (filters.available) {
        filtered = filtered.filter(agent => {
          return agent.enabled !== false && agent.status === 'idle' && agent.current_load < agent.max_concurrent;
        });
      }

      logger.info(`[AgentRegistry.query] Found ${filtered.length}/${agents.length} agents${filters.workspace ? ` for workspace: ${filters.workspace}` : ''}`);
      return filtered;
    } catch (error) {
      logger.error(`[AgentRegistry.query] ERROR`, { error: error.message });
      return [];
    }
  }

  /**
   * Increment agent's current load
   * @param {string} agentId - Agent identifier
   * @param {string} [workspaceId] - Workspace ID for per-workspace load tracking
   * @param {string} [ticketId] - Active ticket ID (stored for requeue on stuck detection)
   * @returns {Promise<boolean>} Success status
   */
  async incrementLoad(agentId, workspaceId = null, ticketId = null) {
    logger.debug(`[AgentRegistry.incrementLoad] START`, { agentId, workspaceId, ticketId });
    try {
      const key = `${this.keyPrefix}${agentId}`;
      const data = await this.redis.get(key);
      
      if (!data) {
        logger.warn(`[AgentRegistry.incrementLoad] Agent ${agentId} not found`);
        return false;
      }

      const agent = JSON.parse(data);
      agent.current_load++;
      agent.status = agent.current_load >= agent.max_concurrent ? 'busy' : 'idle';
      agent.last_updated = new Date().toISOString();

      // ⭐ Issue #001: Track when agent became busy and which ticket it's working on
      if (!agent.busy_since && agent.current_load > 0) {
        agent.busy_since = Date.now();
      }
      if (ticketId) {
        agent.active_ticket_id = ticketId;
      }

      // Track per-workspace load
      if (workspaceId) {
        agent.load_per_workspace[workspaceId] = (agent.load_per_workspace[workspaceId] || 0) + 1;
      }

      await this.redis.set(key, JSON.stringify(agent));
      // PHASE_65: No TTL — agent keys persist forever

      // Record initial activity heartbeat so watchdog knows work started
      await this.recordActivity(agentId, 'task_started', ticketId);

      const wsInfo = workspaceId ? ` (workspace: ${workspaceId})` : '';
      logger.info(`[AgentRegistry.incrementLoad] COMPLETE: ${agentId} load=${agent.current_load}/${agent.max_concurrent} status=${agent.status}${wsInfo}`);
      return true;
    } catch (error) {
      logger.error(`[AgentRegistry.incrementLoad] ERROR`, { agentId, error: error.message });
      return false;
    }
  }

  /**
   * Decrement agent's current load
   * @param {string} agentId - Agent identifier
   * @param {string} [workspaceId] - Workspace ID for per-workspace load tracking
   * @returns {Promise<boolean>} Success status
   */
  async decrementLoad(agentId, workspaceId = null) {
    logger.debug(`[AgentRegistry.decrementLoad] START`, { agentId, workspaceId });
    try {
      const key = `${this.keyPrefix}${agentId}`;
      const data = await this.redis.get(key);
      
      if (!data) {
        logger.warn(`[AgentRegistry.decrementLoad] Agent ${agentId} not found`);
        return false;
      }

      const agent = JSON.parse(data);
      agent.current_load = Math.max(0, agent.current_load - 1);
      agent.status = agent.current_load === 0 ? 'idle' : agent.status;
      agent.last_updated = new Date().toISOString();

      // ⭐ Issue #001: Clear busy tracking when load reaches zero
      if (agent.current_load === 0) {
        agent.busy_since = null;
        agent.active_ticket_id = null;
      }

      // Track per-workspace load
      if (workspaceId && agent.load_per_workspace[workspaceId]) {
        agent.load_per_workspace[workspaceId] = Math.max(0, agent.load_per_workspace[workspaceId] - 1);
      }

      await this.redis.set(key, JSON.stringify(agent));
      // PHASE_65: No TTL — agent keys persist forever

      // Clear activity heartbeat when task completes normally
      if (agent.current_load === 0) {
        try {
          await this.redis.del(`${this.activityPrefix}${agentId}`);
        } catch (e) { /* non-fatal */ }
      }

      const wsInfo = workspaceId ? ` (workspace: ${workspaceId})` : '';
      logger.info(`[AgentRegistry.decrementLoad] COMPLETE: ${agentId} load=${agent.current_load}/${agent.max_concurrent} status=${agent.status}${wsInfo}`);
      return true;
    } catch (error) {
      logger.error(`[AgentRegistry.decrementLoad] ERROR`, { agentId, error: error.message });
      return false;
    }
  }

  /**
   * ⭐ Issue #001: Record agent activity heartbeat.
   * Called by agents whenever they do meaningful work (LLM call, file write, API call).
   * The watchdog uses this to distinguish "slow but active" from "stuck in a loop".
   * 
   * @param {string} agentId - Agent identifier
   * @param {string} activityType - Type of activity ('llm_call', 'file_write', 'api_call', 'task_started', etc.)
   * @param {string} [ticketId] - Associated ticket ID
   * @returns {Promise<void>}
   */
  async recordActivity(agentId, activityType = 'heartbeat', ticketId = null) {
    try {
      const activityData = {
        agentId,
        last_activity: Date.now(),
        activity_type: activityType,
        ticket_id: ticketId,
      };
      const activityKey = `${this.activityPrefix}${agentId}`;
      await this.redis.set(activityKey, JSON.stringify(activityData));
      await this.redis.expire(activityKey, ACTIVITY_TTL_SECONDS); // Auto-expires if agent goes silent
      logger.debug(`[AgentRegistry.recordActivity] ${agentId} activity=${activityType} ticket=${ticketId || 'none'}`);
    } catch (err) {
      logger.warn(`[AgentRegistry.recordActivity] Failed (non-fatal): ${err.message}`);
    }
  }

  /**
   * ⭐ Issue #001: Get the last activity timestamp for an agent.
   * Returns null if no activity record exists (agent has been silent for > 1 hour).
   * 
   * @param {string} agentId - Agent identifier
   * @returns {Promise<Object|null>} Activity data or null
   */
  async getLastActivity(agentId) {
    try {
      const activityKey = `${this.activityPrefix}${agentId}`;
      const data = await this.redis.get(activityKey);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      logger.warn(`[AgentRegistry.getLastActivity] Failed: ${err.message}`);
      return null;
    }
  }

  /**
   * ⭐ Issue #001: Check all busy agents for stuck state.
   * Called by QueueManagerService every 15 minutes.
   * 
   * An agent is STUCK if:
   * 1. It has been busy for > STUCK_THRESHOLD_MS (60 minutes), AND
   * 2. Its activity heartbeat has expired (no activity in 60 minutes)
   *    — the Redis key auto-expires after 1 hour of silence
   * 
   * An agent is ACTIVE (leave alone) if:
   * 1. It has a recent activity heartbeat (Redis key still exists), OR
   * 2. It has been busy for < STUCK_THRESHOLD_MS
   * 
   * @returns {Promise<Array>} List of stuck agents: [{ agentId, activeTicketId, busySinceMs, reason }]
   */
  async checkStuckAgents() {
    logger.debug(`[AgentRegistry.checkStuckAgents] START — scanning for stuck agents`);
    const stuckAgents = [];
    const now = Date.now();

    try {
      const allAgents = await this.query({});
      const busyAgents = allAgents.filter(a => a.current_load > 0 && a.busy_since);

      logger.info(`[AgentRegistry.checkStuckAgents] Checking ${busyAgents.length} busy agents for stuck state`);

      for (const agent of busyAgents) {
        const busyDurationMs = now - agent.busy_since;

        // Not busy long enough to be considered stuck
        if (busyDurationMs < STUCK_THRESHOLD_MS) {
          logger.debug(`[AgentRegistry.checkStuckAgents] ${agent.agent_id} busy for ${Math.round(busyDurationMs / 60000)}min — within threshold, skipping`);
          continue;
        }

        // Check if agent has recent activity (still doing real work)
        const activity = await this.getLastActivity(agent.agent_id);

        if (activity) {
          // Activity heartbeat exists — agent is still active (just slow)
          const activityAgeMin = Math.round((now - activity.last_activity) / 60000);
          logger.info(`[AgentRegistry.checkStuckAgents] ${agent.agent_id} busy ${Math.round(busyDurationMs / 60000)}min but has activity ${activityAgeMin}min ago (${activity.activity_type}) — ACTIVE, leaving alone`);
          continue;
        }

        // No activity heartbeat AND busy > threshold → STUCK
        const busyMinutes = Math.round(busyDurationMs / 60000);
        logger.warn(`[AgentRegistry.checkStuckAgents] ⚠️  STUCK AGENT DETECTED: ${agent.agent_id} — busy ${busyMinutes}min with no activity heartbeat`);

        stuckAgents.push({
          agentId: agent.agent_id,
          activeTicketId: agent.active_ticket_id,
          busySinceMs: agent.busy_since,
          busyMinutes,
          reason: `No activity heartbeat for ${busyMinutes} minutes (threshold: ${STUCK_THRESHOLD_MS / 60000}min)`,
        });
      }

      logger.info(`[AgentRegistry.checkStuckAgents] COMPLETE — found ${stuckAgents.length} stuck agents out of ${busyAgents.length} busy`);
      return stuckAgents;
    } catch (error) {
      logger.error(`[AgentRegistry.checkStuckAgents] ERROR`, { error: error.message, stack: error.stack });
      return [];
    }
  }

  /**
   * ⭐ Issue #001: Force-release a stuck agent back to idle state.
   * Called by QueueManagerService after confirming an agent is stuck.
   * Returns the active ticket ID so the caller can requeue it.
   * 
   * @param {string} agentId - Agent identifier
   * @param {string} reason - Why the agent is being force-released (for logging/comments)
   * @returns {Promise<{success: boolean, activeTicketId: string|null}>}
   */
  async forceRelease(agentId, reason = 'stuck_timeout') {
    logger.info(`[AgentRegistry.forceRelease] START: ${agentId} reason=${reason}`);
    try {
      const key = `${this.keyPrefix}${agentId}`;
      const data = await this.redis.get(key);

      if (!data) {
        logger.warn(`[AgentRegistry.forceRelease] Agent ${agentId} not found`);
        return { success: false, activeTicketId: null };
      }

      const agent = JSON.parse(data);
      const activeTicketId = agent.active_ticket_id;
      const busyMinutes = agent.busy_since ? Math.round((Date.now() - agent.busy_since) / 60000) : 0;

      // Reset agent to idle
      agent.current_load = 0;
      agent.status = 'idle';
      agent.busy_since = null;
      agent.active_ticket_id = null;
      agent.load_per_workspace = {};
      agent.last_updated = new Date().toISOString();
      agent.last_force_release = {
        timestamp: new Date().toISOString(),
        reason,
        ticket_id: activeTicketId,
        busy_minutes: busyMinutes,
      };

      await this.redis.set(key, JSON.stringify(agent));
      // PHASE_65: No TTL — agent keys persist forever

      // Clear activity heartbeat
      try {
        await this.redis.del(`${this.activityPrefix}${agentId}`);
      } catch (e) { /* non-fatal */ }

      logger.info(`[AgentRegistry.forceRelease] COMPLETE: ${agentId} released after ${busyMinutes}min — ticket ${activeTicketId || 'none'} will be requeued`);
      return { success: true, activeTicketId };
    } catch (error) {
      logger.error(`[AgentRegistry.forceRelease] ERROR`, { agentId, error: error.message, stack: error.stack });
      return { success: false, activeTicketId: null };
    }
  }

  /**
   * Update agent status
   * @param {string} agentId - Agent identifier
   * @param {string} status - New status
   * @returns {Promise<boolean>} Success status
   */
  async updateStatus(agentId, status) {
    try {
      const key = `${this.keyPrefix}${agentId}`;
      const data = await this.redis.get(key);
      
      if (!data) {
        logger.warn(`[AgentRegistry.updateStatus] Agent ${agentId} not found`);
        return false;
      }

      const agent = JSON.parse(data);
      agent.status = status;
      agent.last_updated = new Date().toISOString();

      await this.redis.set(key, JSON.stringify(agent));
      // PHASE_65: No TTL — agent keys persist forever

      logger.info(`[AgentRegistry.updateStatus] ${agentId} → ${status}`);
      return true;
    } catch (error) {
      logger.error(`[AgentRegistry.updateStatus] ERROR`, { agentId, error: error.message });
      return false;
    }
  }

  /**
   * Get all registered agents
   * @returns {Promise<Object[]>} All agents
   */
  async getAll() {
    return await this.query({});
  }

  /**
   * Get specific agent by ID
   * @param {string} agentId - Agent identifier
   * @returns {Promise<Object|null>} Agent data or null
   */
  async getAgent(agentId) {
    try {
      const key = `${this.keyPrefix}${agentId}`;
      const data = await this.redis.get(key);
      if (!data) return null;
      return JSON.parse(data);
    } catch (error) {
      logger.error(`[AgentRegistry.getAgent] ERROR`, { agentId, error: error.message });
      return null;
    }
  }

  /**
   * Remove agent from registry
   * @param {string} agentId - Agent identifier
   * @returns {Promise<boolean>} Success status
   */
  async unregister(agentId) {
    try {
      const key = `${this.keyPrefix}${agentId}`;
      await this.redis.del(key);
      
      try {
        await this.redis.publish('swarm:agent-updates', JSON.stringify({
          type: 'agent-deregistered',
          agent_id: agentId,
          timestamp: new Date().toISOString()
        }));
        logger.info(`[AgentRegistry.unregister] ✅ Broadcasted deregistration: ${agentId}`);
      } catch (broadcastErr) {
        logger.warn(`[AgentRegistry.unregister] Broadcast failed (non-fatal): ${broadcastErr.message}`);
      }
      
      logger.info(`[AgentRegistry.unregister] COMPLETE: ${agentId}`);
      return true;
    } catch (error) {
      logger.error(`[AgentRegistry.unregister] ERROR`, { agentId, error: error.message });
      return false;
    }
  }

  /**
   * Send heartbeat for agent (updates last_heartbeat timestamp)
   * @param {string} agentId - Agent identifier
   * @returns {Promise<boolean>} Success status
   */
  async heartbeat(agentId) {
    try {
      const key = `${this.keyPrefix}${agentId}`;
      const data = await this.redis.get(key);
      
      if (!data) {
        logger.warn(`[AgentRegistry.heartbeat] Agent ${agentId} not found`);
        return false;
      }

      const agent = JSON.parse(data);
      agent.last_heartbeat = new Date().toISOString();

      await this.redis.set(key, JSON.stringify(agent));
      // PHASE_65: No TTL — agent keys persist forever (heartbeat just updates timestamp)

      return true;
    } catch (error) {
      logger.error(`[AgentRegistry.heartbeat] ERROR`, { agentId, error: error.message });
      return false;
    }
  }

  /**
   * Check if agent can serve a specific workspace
   * @param {string} agentId - Agent identifier
   * @param {string} workspaceId - Workspace ID to check
   * @returns {Promise<boolean>} True if agent can serve workspace
   */
  async canServeWorkspace(agentId, workspaceId) {
    try {
      const agent = await this.getAgent(agentId);
      if (!agent) {
        logger.warn(`[AgentRegistry.canServeWorkspace] Agent ${agentId} not found`);
        return false;
      }
      const canServe = agent.workspaces.includes('*') || agent.workspaces.includes(workspaceId);
      if (!canServe) {
        logger.warn(`[AgentRegistry.canServeWorkspace] ${agentId} cannot serve workspace ${workspaceId} (authorized: ${agent.workspaces.join(', ')})`);
      }
      return canServe;
    } catch (error) {
      logger.error(`[AgentRegistry.canServeWorkspace] ERROR`, { agentId, error: error.message });
      return false;
    }
  }

  /**
   * Enable or disable an agent (dashboard toggle)
   * @param {string} agentId - Agent identifier
   * @param {boolean} enabled - True to enable, false to disable
   * @returns {Promise<boolean>} Success status
   */
  async setEnabled(agentId, enabled) {
    try {
      const key = `${this.keyPrefix}${agentId}`;
      const data = await this.redis.get(key);
      
      if (!data) {
        logger.warn(`[AgentRegistry.setEnabled] Agent ${agentId} not found`);
        return false;
      }

      const agent = JSON.parse(data);
      agent.enabled = enabled;
      agent.last_updated = new Date().toISOString();

      await this.redis.set(key, JSON.stringify(agent));
      // PHASE_65: No TTL — agent keys persist forever

      logger.info(`[AgentRegistry.setEnabled] ${agentId} → ${enabled ? 'ENABLED' : 'DISABLED'}`);
      return true;
    } catch (error) {
      logger.error(`[AgentRegistry.setEnabled] ERROR`, { agentId, error: error.message });
      return false;
    }
  }

  /**
   * Clear all agents (for testing)
   * @returns {Promise<boolean>} Success status
   */
  async clearAll() {
    try {
      const keys = await this.redis.keys(`${this.keyPrefix}*`);
      if (keys.length > 0) {
        await Promise.all(keys.map(key => this.redis.del(key)));
        logger.info(`[AgentRegistry.clearAll] Cleared ${keys.length} agents from registry`);
      }
      return true;
    } catch (error) {
      logger.error(`[AgentRegistry.clearAll] ERROR`, { error: error.message });
      return false;
    }
  }
}

module.exports = AgentRegistry;
