/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * PrivateMeshManager — Core Lifecycle Manager for Private Mesh Channels
 * 
 * Singleton per bot. Manages Redis pub/sub subscriptions, mesh creation/join/
 * leave/dissolve, message routing, and delegation within private mesh channels.
 * 
 * Architecture:
 * - Uses a DEDICATED Redis client for pub/sub (ioredis requirement — subscriber
 *   client cannot run other commands)
 * - Uses the shared Redis client (via MeshChannelStore) for state persistence
 * - Integrates with MeshBroadcastNetwork for sending MESH_INVITE signals to
 *   remote agents via HTTP POST
 * - Integrates with AgentRegistry for resolving agent endpoints
 * 
 * Created: 2026-02-19 — Issue #018, PHASE_24
 */

const crypto = require('crypto');
const logger = require('../../utils/logger');
const MeshChannelStore = require('./MeshChannelStore');
const {
  MESH_SIGNAL_TYPES,
  MESH_SCOPES,
  MESH_STATUS,
  MESSAGE_TYPES,
  REDIS_KEYS,
  createSignal,
  createChannelState,
  validateSignal,
} = require('./MeshProtocol');

/**
 * @class PrivateMeshManager
 * @description Singleton-per-bot coordinator for private mesh channels. Exists so a
 *   swarm agent can spin up an ephemeral, scoped collaboration space (per ticket, ad-hoc,
 *   or dashboard), invite peers, exchange and delegate work over Redis pub/sub, and persist
 *   a conversation transcript before the channel is dissolved. Centralizing this here keeps
 *   subscription lifecycle, state persistence (via MeshChannelStore), cross-agent signalling
 *   (via MeshBroadcastNetwork/AgentRegistry), and expiry cleanup in one auditable place.
 */
class PrivateMeshManager {
  /**
   * @param {Object} options
   * @param {Object} options.redis - ioredis command client
   * @param {Object} [options.subscriberRedis] - Dedicated ioredis subscriber client (created internally if not provided)
   * @param {Object} [options.agentRegistry] - AgentRegistry instance
   * @param {Object} [options.meshBroadcast] - MeshBroadcastNetwork instance
   * @param {string} [options.agentId] - This bot's agent ID
   */
  constructor(options = {}) {
    this.redis = options.redis || null;
    this.agentRegistry = options.agentRegistry || null;
    this.meshBroadcast = options.meshBroadcast || null;
    this.agentId = options.agentId || process.env.AGENT_ID || 'unknown';

    // Redis subscriber client — dedicated for pub/sub (cannot run other commands)
    this.subscriberRedis = options.subscriberRedis || null;
    this._subscribedChannels = new Set();

    // MeshChannelStore for persistence
    this.store = new MeshChannelStore(this.redis);

    // In-memory message handlers: meshId → [callback, ...]
    this._messageHandlers = new Map();

    // Cleanup interval
    this._cleanupInterval = null;

    // Stats
    this.stats = {
      meshesCreated: 0,
      meshesJoined: 0,
      messagesSent: 0,
      messagesReceived: 0,
      delegationsSent: 0,
      delegationsReceived: 0,
    };

    logger.info(`[PrivateMesh] Manager initialized for ${this.agentId}`);
  }

  /**
   * Initialize the manager — set up subscriber client and cleanup timer
   */
  async initialize() {
    // Create subscriber Redis client if not provided
    if (this.redis && !this.subscriberRedis) {
      try {
        const Redis = require('ioredis');
        const redisOpts = {
          host: process.env.REDIS_HOST || 'oshal-redis',
          port: parseInt(process.env.REDIS_PORT || '6379'),
          password: process.env.REDIS_PASSWORD,
          maxRetriesPerRequest: 3,
          retryStrategy: (times) => Math.min(times * 100, 3000),
        };
        this.subscriberRedis = new Redis(redisOpts);
        await this.subscriberRedis.ping();
        logger.info('[PrivateMesh] Subscriber Redis client connected');
      } catch (err) {
        logger.warn(`[PrivateMesh] Subscriber Redis failed: ${err.message} — pub/sub disabled`);
        this.subscriberRedis = null;
      }
    }

    // Set up pub/sub message handler
    if (this.subscriberRedis) {
      this.subscriberRedis.on('message', (channel, message) => {
        this._handlePubSubMessage(channel, message);
      });
    }

    // Re-subscribe to any meshes this agent belongs to
    try {
      const activeMeshes = await this.store.listMeshesForAgent(this.agentId);
      for (const meshId of activeMeshes) {
        await this._subscribeToMesh(meshId);
      }
      if (activeMeshes.length > 0) {
        logger.info(`[PrivateMesh] Re-subscribed to ${activeMeshes.length} active meshes`);
      }
    } catch (err) {
      logger.debug(`[PrivateMesh] Re-subscribe check failed: ${err.message}`);
    }

    // Start periodic cleanup of expired meshes (every 5 minutes)
    this._cleanupInterval = setInterval(() => this._autoDissolveExpired(), 5 * 60 * 1000);

    logger.info(`[PrivateMesh] Initialized for ${this.agentId}`);
    return { success: true, agentId: this.agentId };
  }

  /**
   * Shutdown — clean up resources
   */
  async shutdown() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    if (this.subscriberRedis) {
      try {
        await this.subscriberRedis.quit();
      } catch { /* ignore */ }
    }
    logger.info('[PrivateMesh] Shut down');
  }

  // ═══════════════════════════════════════════
  // Mesh Lifecycle
  // ═══════════════════════════════════════════

  /**
   * Create a new private mesh channel
   * @param {Object} opts
   * @param {string} opts.topic - What this mesh is about
   * @param {string} [opts.scope] - 'ticket', 'adhoc', or 'dashboard'
   * @param {string[]} [opts.inviteAgents] - Agent IDs to invite
   * @param {string} [opts.ticketId] - Associated Plane ticket
   * @param {string} [opts.taskId] - Associated workspace task
   * @param {number} [opts.ttlSeconds] - Custom TTL
   * @param {string[]} [opts.capabilitiesNeeded] - Required capabilities for invitees
   * @returns {Promise<Object>} { success, meshId, channel }
   */
  async createMesh(opts = {}) {
    const channelState = createChannelState({
      topic: opts.topic || 'Private mesh',
      scope: opts.scope || MESH_SCOPES.ADHOC,
      owner_agent_id: this.agentId,
      members: [this.agentId],
      ticket_id: opts.ticketId || null,
      task_id: opts.taskId || null,
      ttl_seconds: opts.ttlSeconds,
    });

    // Persist to Redis
    const created = await this.store.createChannel(channelState);
    if (!created) {
      return { success: false, error: 'Failed to create mesh channel in Redis' };
    }

    // Subscribe this agent to the pub/sub channel
    await this._subscribeToMesh(channelState.mesh_id);

    // Post system message
    await this._postSystemMessage(channelState.mesh_id,
      `Mesh created by ${this.agentId}. Topic: ${channelState.topic}`);

    this.stats.meshesCreated++;

    // Send MESH_INVITE to requested agents
    const inviteResults = [];
    if (opts.inviteAgents && opts.inviteAgents.length > 0) {
      for (const targetAgent of opts.inviteAgents) {
        if (targetAgent === this.agentId) continue; // Don't invite yourself
        const inviteResult = await this._sendInvite(channelState.mesh_id, targetAgent, {
          topic: channelState.topic,
          capabilities_needed: opts.capabilitiesNeeded || [],
        });
        inviteResults.push({ agent: targetAgent, ...inviteResult });
      }
    }

    // Mark as active once invites sent
    await this.store.updateChannel(channelState.mesh_id, { status: MESH_STATUS.ACTIVE });

    logger.info(`[PrivateMesh] Created mesh ${channelState.mesh_id} (scope=${channelState.scope}, invites=${inviteResults.length})`);

    return {
      success: true,
      meshId: channelState.mesh_id,
      channel: channelState,
      inviteResults,
    };
  }

  /**
   * Join a mesh (accept invitation)
   * @param {string} meshId
   * @param {string} [agentId] - Defaults to this.agentId
   * @returns {Promise<Object>}
   */
  async joinMesh(meshId, agentId = null) {
    const joiningAgent = agentId || this.agentId;

    // Add member to channel
    const added = await this.store.addMember(meshId, joiningAgent);
    if (!added) {
      return { success: false, error: 'Mesh not found or join failed' };
    }

    // Subscribe to pub/sub if it's THIS agent joining
    if (joiningAgent === this.agentId) {
      await this._subscribeToMesh(meshId);
    }

    // Post system message
    await this._postSystemMessage(meshId, `${joiningAgent} joined the mesh`);

    // Send MESH_ACCEPT signal back to mesh
    await this.sendMessage(meshId, this.agentId,
      `${joiningAgent} has joined and is ready to collaborate`, MESSAGE_TYPES.SYSTEM);

    this.stats.meshesJoined++;
    logger.info(`[PrivateMesh] ${joiningAgent} joined mesh ${meshId}`);

    return { success: true, meshId, agentId: joiningAgent };
  }

  /**
   * Leave a mesh
   * @param {string} meshId
   * @param {string} [agentId]
   * @param {string} [reason]
   * @returns {Promise<Object>}
   */
  async leaveMesh(meshId, agentId = null, reason = '') {
    const leavingAgent = agentId || this.agentId;

    const channel = await this.store.getChannel(meshId);
    if (!channel) {
      return { success: false, error: 'Mesh not found' };
    }

    // If owner leaves, dissolve the mesh
    if (channel.owner_agent_id === leavingAgent) {
      return this.dissolveMesh(meshId, leavingAgent);
    }

    // Remove member
    await this.store.removeMember(meshId, leavingAgent);

    // Unsubscribe from pub/sub if it's THIS agent leaving
    if (leavingAgent === this.agentId) {
      await this._unsubscribeFromMesh(meshId);
    }

    // Post system message
    await this._postSystemMessage(meshId,
      `${leavingAgent} left the mesh${reason ? ': ' + reason : ''}`);

    logger.info(`[PrivateMesh] ${leavingAgent} left mesh ${meshId}`);
    return { success: true, meshId, agentId: leavingAgent };
  }

  /**
   * Dissolve an entire mesh (owner only)
   * Saves conversation transcript before cleanup.
   * @param {string} meshId
   * @param {string} [agentId] - Must be the owner
   * @returns {Promise<Object>}
   */
  async dissolveMesh(meshId, agentId = null) {
    const dissolverAgent = agentId || this.agentId;

    const channel = await this.store.getChannel(meshId);
    if (!channel) {
      return { success: false, error: 'Mesh not found' };
    }

    // Only owner can dissolve (or force-dissolve for expired)
    if (channel.owner_agent_id !== dissolverAgent && dissolverAgent !== '__system__') {
      return { success: false, error: 'Only the mesh owner can dissolve' };
    }

    // ⭐ Save conversation transcript BEFORE dissolving
    let transcriptPath = null;
    try {
      transcriptPath = await this.saveTranscript(meshId);
    } catch (err) {
      logger.warn(`[PrivateMesh] Failed to save transcript for ${meshId}: ${err.message}`);
    }

    // Mark as dissolving
    await this.store.updateChannel(meshId, { status: MESH_STATUS.DISSOLVING });

    // Notify all members via pub/sub
    await this._postSystemMessage(meshId,
      `Mesh dissolved by ${dissolverAgent}. Channel closing.${transcriptPath ? ` Transcript saved: ${transcriptPath}` : ''}`);

    // Unsubscribe this agent
    await this._unsubscribeFromMesh(meshId);

    // Mark as dissolved
    await this.store.updateChannel(meshId, { status: MESH_STATUS.DISSOLVED });

    // Clean up after a short delay (let members see the dissolve message)
    setTimeout(async () => {
      await this.store.deleteChannel(meshId);
    }, 5000);

    logger.info(`[PrivateMesh] Mesh ${meshId} dissolved by ${dissolverAgent}${transcriptPath ? ` (transcript: ${transcriptPath})` : ''}`);
    return { success: true, meshId, dissolvedBy: dissolverAgent, transcriptPath };
  }

  // ═══════════════════════════════════════════
  // Messaging
  // ═══════════════════════════════════════════

  /**
   * Send a message to all mesh members via Redis pub/sub
   * @param {string} meshId
   * @param {string} fromAgentId
   * @param {string} content - Message text
   * @param {string} [type] - 'text', 'delegation', 'result', 'system'
   * @param {Object} [metadata] - Additional metadata
   * @returns {Promise<Object>}
   */
  async sendMessage(meshId, fromAgentId, content, type = MESSAGE_TYPES.TEXT, metadata = {}) {
    // Verify sender is a member (unless system message)
    if (type !== MESSAGE_TYPES.SYSTEM) {
      const isMember = await this.store.isMember(meshId, fromAgentId);
      if (!isMember) {
        return { success: false, error: `${fromAgentId} is not a member of mesh ${meshId}` };
      }
    }

    const message = {
      id: `msg_${crypto.randomBytes(6).toString('hex')}`,
      mesh_id: meshId,
      from: fromAgentId,
      type,
      content,
      timestamp: new Date().toISOString(),
      metadata,
    };

    // Persist to message history
    await this.store.appendMessage(meshId, message);

    // Publish to Redis pub/sub channel
    if (this.redis) {
      try {
        const pubChannel = REDIS_KEYS.PUBSUB + meshId;
        await this.redis.publish(pubChannel, JSON.stringify(message));
      } catch (err) {
        logger.error(`[PrivateMesh] Pub/sub publish failed: ${err.message}`);
      }
    }

    this.stats.messagesSent++;
    return { success: true, messageId: message.id, meshId };
  }

  /**
   * Delegate a sub-task to a specific mesh member
   * @param {string} meshId
   * @param {string} fromAgentId
   * @param {string} toAgentId
   * @param {string} taskDescription
   * @returns {Promise<Object>}
   */
  async delegateTask(meshId, fromAgentId, toAgentId, taskDescription) {
    const channel = await this.store.getChannel(meshId);
    if (!channel) {
      return { success: false, error: 'Mesh not found' };
    }

    // Verify both agents are members
    if (!channel.members.includes(fromAgentId) || !channel.members.includes(toAgentId)) {
      return { success: false, error: 'Both agents must be mesh members for delegation' };
    }

    // Send MESH_DELEGATE message
    await this.sendMessage(meshId, fromAgentId, taskDescription, MESSAGE_TYPES.DELEGATION, {
      delegate_to: toAgentId,
      delegate_from: fromAgentId,
    });

    // Also send HTTP signal to the target agent for immediate processing
    if (this.meshBroadcast) {
      const signal = createSignal('MESH_DELEGATE', meshId, fromAgentId, {
        task: taskDescription,
        mesh_topic: channel.topic,
      }, toAgentId);

      await this._sendSignalToAgent(toAgentId, signal);
    }

    this.stats.delegationsSent++;
    logger.info(`[PrivateMesh] ${fromAgentId} delegated task to ${toAgentId} in mesh ${meshId}`);

    return { success: true, meshId, from: fromAgentId, to: toAgentId };
  }

  /**
   * Return a result from a delegation
   * @param {string} meshId
   * @param {string} fromAgentId
   * @param {string} result
   * @param {Object} [metadata]
   * @returns {Promise<Object>}
   */
  async returnResult(meshId, fromAgentId, result, metadata = {}) {
    return this.sendMessage(meshId, fromAgentId, result, MESSAGE_TYPES.RESULT, metadata);
  }

  // ═══════════════════════════════════════════
  // Queries
  // ═══════════════════════════════════════════

  /**
   * Get current mesh channel state
   * @param {string} meshId
   * @returns {Promise<Object|null>}
   */
  async getMeshState(meshId) {
    return this.store.getChannel(meshId);
  }

  /**
   * Get message history for a mesh
   * @param {string} meshId
   * @param {number} [limit=50]
   * @returns {Promise<Object[]>}
   */
  async getHistory(meshId, limit = 50) {
    return this.store.getMessages(meshId, -limit, -1);
  }

  /**
   * List all active meshes this agent belongs to
   * @param {string} [agentId] - Defaults to this.agentId
   * @returns {Promise<Object[]>} Array of mesh channel states
   */
  async listActiveMeshes(agentId = null) {
    const targetAgent = agentId || this.agentId;
    const meshIds = await this.store.listMeshesForAgent(targetAgent);
    const meshes = [];
    for (const meshId of meshIds) {
      const channel = await this.store.getChannel(meshId);
      if (channel) {
        meshes.push(channel);
      }
    }
    return meshes;
  }

  /**
   * Get manager stats
   * @returns {Object}
   */
  getStats() {
    return {
      agentId: this.agentId,
      subscribedChannels: this._subscribedChannels.size,
      ...this.stats,
    };
  }

  // ═══════════════════════════════════════════
  // Message Handler Registration
  // ═══════════════════════════════════════════

  /**
   * Register a callback for incoming messages on a specific mesh
   * @param {string} meshId
   * @param {Function} callback - (message) => void
   */
  onMessage(meshId, callback) {
    if (!this._messageHandlers.has(meshId)) {
      this._messageHandlers.set(meshId, []);
    }
    this._messageHandlers.get(meshId).push(callback);
  }

  /**
   * Remove all message handlers for a mesh
   * @param {string} meshId
   */
  offMessage(meshId) {
    this._messageHandlers.delete(meshId);
  }

  /**
   * ⭐ PHASE_32 Issue #030: Public method to subscribe to mesh with message handler
   * Wraps internal _subscribeToMesh and registers a message handler
   * @param {string} meshId
   * @param {Function} messageHandler - (message) => Promise<void>
   * @returns {Promise<Object>}
   */
  async subscribeToMesh(meshId, messageHandler) {
    // Subscribe to Redis pub/sub
    await this._subscribeToMesh(meshId);

    // Register message handler
    if (messageHandler) {
      this.onMessage(meshId, messageHandler);
    }

    logger.info(`[PrivateMesh] ${this.agentId} subscribed to mesh ${meshId} with handler`);
    return { success: true, meshId };
  }

  // ═══════════════════════════════════════════
  // Internal: Pub/Sub
  // ═══════════════════════════════════════════

  /**
   * Subscribe to a mesh's Redis pub/sub channel
   */
  async _subscribeToMesh(meshId) {
    if (!this.subscriberRedis) return;
    const channel = REDIS_KEYS.PUBSUB + meshId;
    if (this._subscribedChannels.has(channel)) return;

    try {
      await this.subscriberRedis.subscribe(channel);
      this._subscribedChannels.add(channel);
      logger.debug(`[PrivateMesh] Subscribed to ${channel}`);
    } catch (err) {
      logger.error(`[PrivateMesh] Subscribe failed for ${channel}: ${err.message}`);
    }
  }

  /**
   * List all active meshes this agent belongs to
   * ⭐ PHASE_32 Issue #030: Enhanced to return message counts and last message
   * @param {string} [agentId] - Defaults to this.agentId
   * @returns {Promise<Object[]>} Array of mesh channel states with metadata
   */
  async listActiveMeshes(agentId = null) {
    const targetAgent = agentId || this.agentId;
    const meshIds = await this.store.listMeshesForAgent(targetAgent);
    const meshes = [];
    
    for (const meshId of meshIds) {
      const channel = await this.store.getChannel(meshId);
      if (channel) {
        // Get message count
        const messageCount = await this.store.getMessageCount(meshId);
        
        // Get last message
        const lastMessages = await this.store.getMessages(meshId, -1, -1);
        const lastMessage = lastMessages.length > 0 ? lastMessages[0] : null;
        
        meshes.push({
          ...channel,
          message_count: messageCount,
          last_message: lastMessage,
        });
      }
    }
    
    return meshes;
  }

  /**
   * Handle an incoming pub/sub message
   */
  _handlePubSubMessage(channel, rawMessage) {
    try {
      const message = JSON.parse(rawMessage);

      // Skip messages from self (we already have them locally)
      if (message.from === this.agentId) return;

      this.stats.messagesReceived++;

      // Extract meshId from channel name
      const meshId = channel.replace(REDIS_KEYS.PUBSUB, '');

      logger.debug(`[PrivateMesh] Received message in ${meshId} from ${message.from}: ${(message.content || '').substring(0, 80)}`);

      // Invoke registered handlers
      const handlers = this._messageHandlers.get(meshId);
      if (handlers) {
        for (const handler of handlers) {
          try {
            handler(message);
          } catch (err) {
            logger.error(`[PrivateMesh] Message handler error: ${err.message}`);
          }
        }
      }
    } catch (err) {
      logger.error(`[PrivateMesh] Failed to parse pub/sub message: ${err.message}`);
    }
  }

  // ═══════════════════════════════════════════
  // Internal: HTTP Signal Sending
  // ═══════════════════════════════════════════

  /**
   * Send a MESH_INVITE to a remote agent via HTTP
   */
  async _sendInvite(meshId, targetAgentId, payload) {
    const signal = createSignal('MESH_INVITE', meshId, this.agentId, {
      topic: payload.topic,
      capabilities_needed: payload.capabilities_needed || [],
      members: [this.agentId],
    }, targetAgentId);

    return this._sendSignalToAgent(targetAgentId, signal);
  }

  /**
   * Send a mesh signal to a specific agent via HTTP POST
   * Uses MeshBroadcastNetwork's internal _sendSignal or direct HTTP
   */
  async _sendSignalToAgent(targetAgentId, signal) {
    if (!this.agentRegistry) {
      return { success: false, error: 'No AgentRegistry — cannot resolve agent endpoint' };
    }

    try {
      const allAgents = await this.agentRegistry.query({ available: true });
      const normalizedTarget = targetAgentId.startsWith('swarm-') ? targetAgentId : targetAgentId;
      const target = allAgents.find(a =>
        a.agent_id === normalizedTarget ||
        a.agent_id === `swarm-${normalizedTarget}` ||
        `swarm-${a.agent_id}` === normalizedTarget
      );

      if (!target || !target.endpoint) {
        logger.warn(`[PrivateMesh] Agent ${targetAgentId} not found or has no endpoint`);
        return { success: false, error: `Agent ${targetAgentId} not reachable` };
      }

      if (this.meshBroadcast) {
        const result = await this.meshBroadcast._sendSignal(target, signal);
        return { success: result.success, response: result.response };
      }

      // Fallback: direct HTTP
      return await this._httpPost(target.endpoint, signal);
    } catch (err) {
      logger.error(`[PrivateMesh] _sendSignalToAgent failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Direct HTTP POST fallback
   */
  async _httpPost(endpoint, signal) {
    const http = require('http');
    return new Promise((resolve) => {
      try {
        const url = new URL(`${endpoint}/api/v1/agentic/mesh-signal`);
        const postData = JSON.stringify(signal);
        const req = http.request({
          hostname: url.hostname,
          port: url.port || 5000,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: 8000,
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try {
              resolve({ success: true, response: JSON.parse(data) });
            } catch {
              resolve({ success: true, response: data });
            }
          });
        });
        req.on('error', (err) => resolve({ success: false, error: err.message }));
        req.on('timeout', () => { req.destroy(); resolve({ success: false, error: 'timeout' }); });
        req.write(postData);
        req.end();
      } catch (err) {
        resolve({ success: false, error: err.message });
      }
    });
  }

  // ═══════════════════════════════════════════
  // Transcript: Save & Retrieve Conversation Logs
  // ═══════════════════════════════════════════

  /**
   * Save the full mesh conversation as a markdown transcript file.
   * Saved to docs-ralf/projects/agentic-swarm-project/ralf-sessions/ alongside
   * handover documents, or to /app/workspace/ as fallback.
   * 
   * @param {string} meshId
   * @returns {Promise<string|null>} File path of saved transcript, or null
   */
  async saveTranscript(meshId) {
    const fs = require('fs');
    const path = require('path');

    const channel = await this.store.getChannel(meshId);
    if (!channel) return null;

    const messages = await this.store.getMessages(meshId, 0, -1);
    if (!messages || messages.length === 0) return null;

    // Build markdown transcript
    const lines = [];
    lines.push(`# Mesh Conversation Transcript`);
    lines.push('');
    lines.push(`**Mesh ID:** ${meshId}`);
    lines.push(`**Topic:** ${channel.topic}`);
    lines.push(`**Scope:** ${channel.scope}`);
    lines.push(`**Owner:** ${channel.owner_agent_id}`);
    lines.push(`**Members:** ${(channel.members || []).join(', ')}`);
    lines.push(`**Created:** ${channel.created_at}`);
    lines.push(`**Ticket:** ${channel.ticket_id || 'N/A'}`);
    lines.push(`**Messages:** ${messages.length}`);
    lines.push(`**Saved:** ${new Date().toISOString()}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of messages) {
      const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString() : '??:??';
      const from = msg.from || 'unknown';
      const type = msg.type || 'text';
      const content = msg.content || '';

      if (type === 'system') {
        lines.push(`> 🔧 **[${ts}] SYSTEM:** ${content}`);
      } else if (type === 'delegation') {
        const to = msg.metadata?.delegate_to || 'unknown';
        lines.push(`> 📋 **[${ts}] ${from} → ${to} (DELEGATION):** ${content}`);
      } else if (type === 'result') {
        lines.push(`> ✅ **[${ts}] ${from} (RESULT):** ${content}`);
      } else {
        lines.push(`**[${ts}] ${from}:** ${content}`);
      }
      lines.push('');
    }

    lines.push('---');
    lines.push(`*Transcript generated by PrivateMeshManager at ${new Date().toISOString()}*`);

    const markdown = lines.join('\n');

    // Determine output path
    // Priority 1: docs-ralf/projects/agentic-swarm-project/ralf-sessions/
    // Priority 2: /app/workspace/mesh-transcripts/
    // Priority 3: current working directory
    const safeId = meshId.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 60);
    const filename = `MESH_TRANSCRIPT_${safeId}.md`;

    const candidateDirs = [
      path.resolve(__dirname, '../../../docs-ralf/projects/agentic-swarm-project/ralf-sessions'),
      '/app/workspace/mesh-transcripts',
      path.resolve(__dirname, '../../../workspace/mesh-transcripts'),
    ];

    let savedPath = null;
    for (const dir of candidateDirs) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, filename);
        fs.writeFileSync(filePath, markdown, 'utf8');
        savedPath = filePath;
        logger.info(`[PrivateMesh] Transcript saved: ${savedPath} (${messages.length} messages, ${markdown.length} bytes)`);
        break;
      } catch (err) {
        logger.debug(`[PrivateMesh] Cannot save transcript to ${dir}: ${err.message}`);
      }
    }

    // Also store transcript in Redis for API retrieval (24h TTL)
    if (this.redis && savedPath) {
      try {
        await this.redis.set(`mesh:transcript:${meshId}`, markdown, 'EX', 86400);
      } catch { /* non-critical */ }
    }

    return savedPath;
  }

  /**
   * Get a saved transcript from Redis or file system
   * @param {string} meshId
   * @returns {Promise<string|null>} Markdown transcript or null
   */
  async getTranscript(meshId) {
    // Try Redis first
    if (this.redis) {
      try {
        const transcript = await this.redis.get(`mesh:transcript:${meshId}`);
        if (transcript) return transcript;
      } catch { /* fall through to file */ }
    }

    // Try file system
    const fs = require('fs');
    const path = require('path');
    const safeId = meshId.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 60);
    const filename = `MESH_TRANSCRIPT_${safeId}.md`;

    const candidateDirs = [
      path.resolve(__dirname, '../../../docs-ralf/projects/agentic-swarm-project/ralf-sessions'),
      '/app/workspace/mesh-transcripts',
      path.resolve(__dirname, '../../../workspace/mesh-transcripts'),
    ];

    for (const dir of candidateDirs) {
      try {
        const filePath = path.join(dir, filename);
        if (fs.existsSync(filePath)) {
          return fs.readFileSync(filePath, 'utf8');
        }
      } catch { /* try next */ }
    }

    return null;
  }

  /**
   * List all saved transcripts
   * @returns {Promise<Object[]>} Array of { meshId, filename, size, modified }
   */
  async listTranscripts() {
    const fs = require('fs');
    const path = require('path');
    const transcripts = [];

    const candidateDirs = [
      path.resolve(__dirname, '../../../docs-ralf/projects/agentic-swarm-project/ralf-sessions'),
      '/app/workspace/mesh-transcripts',
      path.resolve(__dirname, '../../../workspace/mesh-transcripts'),
    ];

    for (const dir of candidateDirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter(f => f.startsWith('MESH_TRANSCRIPT_'));
        for (const file of files) {
          const filePath = path.join(dir, file);
          const stat = fs.statSync(filePath);
          transcripts.push({
            filename: file,
            path: filePath,
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        }
      } catch { /* skip dir */ }
    }

    return transcripts;
  }

  // ═══════════════════════════════════════════
  // Internal: System Messages
  // ═══════════════════════════════════════════

  async _postSystemMessage(meshId, content) {
    const message = {
      id: `sys_${crypto.randomBytes(4).toString('hex')}`,
      mesh_id: meshId,
      from: '__system__',
      type: MESSAGE_TYPES.SYSTEM,
      content,
      timestamp: new Date().toISOString(),
    };
    await this.store.appendMessage(meshId, message);

    // Also publish to pub/sub
    if (this.redis) {
      try {
        const pubChannel = REDIS_KEYS.PUBSUB + meshId;
        await this.redis.publish(pubChannel, JSON.stringify(message));
      } catch { /* non-critical */ }
    }
  }

  // ═══════════════════════════════════════════
  // Internal: Cleanup
  // ═══════════════════════════════════════════

  /**
   * Periodic cleanup of expired meshes
   * Redis TTL handles most expiry, but this catches edge cases
   */
  async _autoDissolveExpired() {
    try {
      const meshIds = await this.store.listMeshesForAgent(this.agentId);
      for (const meshId of meshIds) {
        const channel = await this.store.getChannel(meshId);
        if (!channel) {
          // Already expired in Redis — clean up local state
          await this._unsubscribeFromMesh(meshId);
          continue;
        }
        // Check if channel should be dissolved based on created_at + ttl
        const createdMs = new Date(channel.created_at).getTime();
        const expiryMs = createdMs + (channel.ttl_seconds * 1000);
        if (Date.now() > expiryMs && channel.status !== MESH_STATUS.DISSOLVED) {
          logger.info(`[PrivateMesh] Auto-dissolving expired mesh: ${meshId}`);
          await this.dissolveMesh(meshId, '__system__');
        }
      }
    } catch (err) {
      logger.debug(`[PrivateMesh] Cleanup error: ${err.message}`);
    }
  }
}

module.exports = PrivateMeshManager;
