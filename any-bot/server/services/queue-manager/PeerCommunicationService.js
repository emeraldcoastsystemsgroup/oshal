/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * PeerCommunicationService — Bot-to-Bot Communication (Issue #014)
 * 
 * Enables peer-to-peer messaging between agents during ticket processing.
 * Signals are ASYNC side-channel — they do NOT consume phase turns.
 * 
 * Signal Types:
 * - HELP_REQUEST: "I need help with X" → broadcasts to all, collects offers
 * - KNOWLEDGE_SHARE: "I learned X" → broadcasts knowledge to all peers
 * - CAPABILITY_QUERY: "Can anyone do X?" → collects capability responses
 * - DIRECT_MESSAGE: Point-to-point message to specific agent
 * - DELEGATE: Create sub-ticket at depth+1 (hard cap at current+1)
 * 
 * Architecture:
 * - Runs on EVERY bot (not just PM)
 * - Uses MeshBroadcastNetwork.sendDirect() for point-to-point
 * - Uses MeshBroadcastNetwork.broadcast() for broadcasts
 * - Stores communication history in Redis for the ticket lifecycle
 * 
 * Created: 2026-02-19 — Issue #014, PHASE_22
 */

const logger = require('../../utils/logger');

/**
 * @description Per-bot peer communication layer that lets agents collaborate
 * over an async side-channel while processing a ticket, without spending phase
 * turns. It wraps the mesh network to send help requests, share knowledge,
 * exchange direct messages, and delegate sub-work (depth-capped to avoid runaway
 * delegation chains), while tracking session stats and persisting a ticket-scoped
 * communication trail in Redis. Instantiated on every bot so any agent can both
 * initiate and respond to peer signals.
 */
class PeerCommunicationService {
  /**
   * @param {Object} options
   * @param {Object} options.meshBroadcast - MeshBroadcastNetwork instance
   * @param {Object} options.redis - Redis client
   * @param {string} options.agentId - This bot's agent ID
   */
  constructor(options = {}) {
    this.meshBroadcast = options.meshBroadcast || null;
    this.redis = options.redis || null;
    this.agentId = options.agentId || process.env.AGENT_ID || 'unknown';
    this.maxDelegationDepth = 2; // Hard cap: parent ticket + 1 sub-ticket level
    
    // ⭐ PHASE_24 Issue #018: PrivateMeshManager integration
    this.privateMeshManager = options.privateMeshManager || null;
    
    // In-memory stats for this session
    this.stats = {
      helpRequestsSent: 0,
      helpRequestsReceived: 0,
      knowledgeShared: 0,
      knowledgeReceived: 0,
      directMessagesSent: 0,
      directMessagesReceived: 0,
      delegationsSent: 0,
      delegationsReceived: 0,
    };

    logger.info(`[PeerComm] Initialized for ${this.agentId}`);
  }

  /**
   * Send a HELP_REQUEST to all peers
   * "I'm stuck on X, can anyone help?"
   * 
   * @param {Object} params
   * @param {string} params.ticketId - Current ticket being processed
   * @param {string} params.topic - What help is needed
   * @param {string} params.context - Additional context
   * @param {string[]} [params.requiredCapabilities] - Specific capabilities needed
   * @returns {Promise<Object>} Aggregated help offers
   */
  async requestHelp(params) {
    const { ticketId, topic, context = '', requiredCapabilities = [] } = params;
    const signalId = `help_${this.agentId}_${Date.now()}`;

    logger.info(`[PeerComm] ${this.agentId} requesting help: "${topic}" (ticket: ${ticketId})`);

    if (!this.meshBroadcast) {
      logger.warn('[PeerComm] No MeshBroadcastNetwork — cannot send help request');
      return { success: false, error: 'No mesh broadcast network', offers: [] };
    }

    const result = await this.meshBroadcast.broadcast('HELP_REQUEST', {
      requesting_agent: this.agentId,
      ticket_id: ticketId,
      topic,
      context: context.substring(0, 500),
      required_capabilities: requiredCapabilities,
    }, {
      signalId,
      excludeAgents: [this.agentId], // Don't ask yourself
    });

    this.stats.helpRequestsSent++;

    // Log to Redis for ticket history
    await this._logCommunication(ticketId, 'HELP_REQUEST', {
      from: this.agentId,
      topic,
      responses: result ? result.responded : 0,
      offers: result ? result.claims?.length : 0,
    });

    const offers = result?.claims?.map(c => ({
      agentId: c.agent_id,
      confidence: c.confidence,
      reason: c.reason,
    })) || [];

    logger.info(`[PeerComm] Help request result: ${offers.length} offers from ${result?.responded || 0} respondents`);

    return {
      success: true,
      signalId,
      offers,
      totalResponded: result?.responded || 0,
    };
  }

  /**
   * Share knowledge with all peers
   * "I learned something useful for this ticket domain"
   * 
   * @param {Object} params
   * @param {string} params.ticketId - Related ticket
   * @param {string} params.topic - Knowledge topic
   * @param {string} params.content - The actual knowledge/insight
   * @param {string[]} [params.tags] - Categorization tags
   * @returns {Promise<Object>} Broadcast result
   */
  async shareKnowledge(params) {
    const { ticketId, topic, content, tags = [] } = params;
    const signalId = `knowledge_${this.agentId}_${Date.now()}`;

    logger.info(`[PeerComm] ${this.agentId} sharing knowledge: "${topic}"`);

    if (!this.meshBroadcast) {
      return { success: false, error: 'No mesh broadcast network' };
    }

    const result = await this.meshBroadcast.broadcast('KNOWLEDGE_SHARE', {
      sharing_agent: this.agentId,
      ticket_id: ticketId,
      topic,
      content: content.substring(0, 2000),
      tags,
      timestamp: new Date().toISOString(),
    }, {
      signalId,
      excludeAgents: [this.agentId],
    });

    this.stats.knowledgeShared++;

    await this._logCommunication(ticketId, 'KNOWLEDGE_SHARE', {
      from: this.agentId,
      topic,
      recipientCount: result?.responded || 0,
    });

    return {
      success: true,
      signalId,
      delivered: result?.responded || 0,
    };
  }

  /**
   * Send a direct message to a specific agent
   * Point-to-point, not broadcast
   * 
   * @param {Object} params
   * @param {string} params.targetAgent - Recipient agent ID
   * @param {string} params.ticketId - Related ticket
   * @param {string} params.message - The message content
   * @param {string} [params.type] - Message type: 'question', 'suggestion', 'feedback'
   * @returns {Promise<Object>} Delivery result
   */
  async sendDirectMessage(params) {
    const { targetAgent, ticketId, message, type = 'message' } = params;

    logger.info(`[PeerComm] ${this.agentId} → ${targetAgent}: DM (${type})`);

    if (!this.meshBroadcast) {
      return { success: false, error: 'No mesh broadcast network' };
    }

    const result = await this._sendDirect(targetAgent, 'DIRECT_MESSAGE', {
      from_agent: this.agentId,
      to_agent: targetAgent,
      ticket_id: ticketId,
      message_type: type,
      content: message.substring(0, 2000),
      timestamp: new Date().toISOString(),
    });

    this.stats.directMessagesSent++;

    await this._logCommunication(ticketId, 'DIRECT_MESSAGE', {
      from: this.agentId,
      to: targetAgent,
      type,
      delivered: result?.success || false,
    });

    return result;
  }

  /**
   * Delegate work to another agent by creating a sub-task
   * Hard-capped at depth+1 to prevent infinite delegation chains
   * 
   * @param {Object} params
   * @param {string} params.ticketId - Parent ticket
   * @param {string} params.targetAgent - Agent to delegate to (or 'auto' for best match)
   * @param {string} params.task - Task description
   * @param {number} [params.currentDepth] - Current delegation depth (0 = root)
   * @returns {Promise<Object>} Delegation result
   */
  async delegate(params) {
    const { ticketId, targetAgent, task, currentDepth = 0 } = params;

    // Hard cap on delegation depth
    if (currentDepth >= this.maxDelegationDepth) {
      logger.warn(`[PeerComm] Delegation depth ${currentDepth} exceeds max ${this.maxDelegationDepth} — refusing`);
      return {
        success: false,
        error: `Delegation depth limit reached (max: ${this.maxDelegationDepth})`,
        depth: currentDepth,
      };
    }

    logger.info(`[PeerComm] ${this.agentId} delegating to ${targetAgent}: "${task.substring(0, 80)}" (depth: ${currentDepth})`);

    if (!this.meshBroadcast) {
      return { success: false, error: 'No mesh broadcast network' };
    }

    const result = await this._sendDirect(targetAgent, 'DELEGATE', {
      from_agent: this.agentId,
      to_agent: targetAgent,
      parent_ticket_id: ticketId,
      task: task.substring(0, 2000),
      delegation_depth: currentDepth + 1,
      timestamp: new Date().toISOString(),
    });

    this.stats.delegationsSent++;

    await this._logCommunication(ticketId, 'DELEGATE', {
      from: this.agentId,
      to: targetAgent,
      task: task.substring(0, 200),
      depth: currentDepth + 1,
      delivered: result?.success || false,
    });

    return {
      success: result?.success || false,
      delegationDepth: currentDepth + 1,
      targetAgent,
    };
  }

  /**
   * Handle an incoming peer communication signal
   * Called by MeshSignalHandler when a peer signal arrives
   * 
   * @param {string} type - Signal type
   * @param {Object} payload - Signal payload
   * @returns {Object} Response to sender
   */
  handleIncoming(type, payload) {
    switch (type) {
      case 'HELP_REQUEST':
        this.stats.helpRequestsReceived++;
        return this._handleHelpRequest(payload);
      
      case 'KNOWLEDGE_SHARE':
        this.stats.knowledgeReceived++;
        return this._handleKnowledgeShare(payload);
      
      case 'DIRECT_MESSAGE':
        this.stats.directMessagesReceived++;
        return this._handleDirectMessage(payload);
      
      case 'DELEGATE':
        this.stats.delegationsReceived++;
        return this._handleDelegation(payload);
      
      default:
        return { status: 'unsupported', type };
    }
  }

  /**
   * Handle incoming HELP_REQUEST
   */
  _handleHelpRequest(payload) {
    const { requesting_agent, topic, ticket_id } = payload;
    logger.info(`[PeerComm] ${this.agentId} received help request from ${requesting_agent}: "${topic}"`);

    // For now, acknowledge receipt. The MeshSignalHandler bid evaluation
    // determines if we can help (claim=true means we can contribute)
    return {
      agent_id: this.agentId,
      status: 'acknowledged',
      type: 'HELP_REQUEST',
      can_help: true, // MeshSignalHandler's bid eval determines the real answer
      message: `${this.agentId} acknowledges help request for "${topic}"`,
    };
  }

  /**
   * Handle incoming KNOWLEDGE_SHARE
   */
  _handleKnowledgeShare(payload) {
    const { sharing_agent, topic, content } = payload;
    logger.info(`[PeerComm] ${this.agentId} received knowledge from ${sharing_agent}: "${topic}" (${(content || '').length} chars)`);

    // Store in local context for this bot's future prompts
    // In a full implementation, this would feed into SwarmMemoryService
    return {
      agent_id: this.agentId,
      status: 'received',
      type: 'KNOWLEDGE_SHARE',
      message: `Knowledge "${topic}" received and indexed`,
    };
  }

  /**
   * Handle incoming DIRECT_MESSAGE
   */
  _handleDirectMessage(payload) {
    const { from_agent, message_type, content } = payload;
    logger.info(`[PeerComm] ${this.agentId} received DM from ${from_agent} (${message_type}): ${(content || '').substring(0, 100)}`);

    return {
      agent_id: this.agentId,
      status: 'received',
      type: 'DIRECT_MESSAGE',
      message: `DM received from ${from_agent}`,
    };
  }

  /**
   * Handle incoming DELEGATE
   */
  _handleDelegation(payload) {
    const { from_agent, task, delegation_depth } = payload;
    logger.info(`[PeerComm] ${this.agentId} received delegation from ${from_agent} (depth: ${delegation_depth}): "${(task || '').substring(0, 100)}"`);

    if (delegation_depth > this.maxDelegationDepth) {
      return {
        agent_id: this.agentId,
        status: 'rejected',
        type: 'DELEGATE',
        reason: `Delegation depth ${delegation_depth} exceeds limit ${this.maxDelegationDepth}`,
      };
    }

    return {
      agent_id: this.agentId,
      status: 'accepted',
      type: 'DELEGATE',
      message: `Delegation accepted by ${this.agentId} (depth: ${delegation_depth})`,
    };
  }

  /**
   * Send a signal directly to a specific agent
   */
  async _sendDirect(targetAgentId, signalType, payload) {
    if (!this.meshBroadcast || !this.meshBroadcast.agentRegistry) {
      return { success: false, error: 'No mesh network' };
    }

    try {
      // Find target agent's endpoint
      const allAgents = await this.meshBroadcast.agentRegistry.query({ available: true });
      const normalizedTarget = targetAgentId.startsWith('swarm-') ? targetAgentId : targetAgentId;
      const target = allAgents.find(a => 
        a.agent_id === normalizedTarget || 
        a.agent_id === `swarm-${normalizedTarget}` ||
        `swarm-${a.agent_id}` === normalizedTarget
      );

      if (!target || !target.endpoint) {
        logger.warn(`[PeerComm] Target agent ${targetAgentId} not found or has no endpoint`);
        return { success: false, error: `Agent ${targetAgentId} not reachable` };
      }

      // Send via MeshBroadcastNetwork's _sendSignal
      const signal = {
        type: signalType,
        payload,
        source: this.agentId,
        signal_id: `peer_${Date.now()}`,
      };

      const result = await this.meshBroadcast._sendSignal(target, signal);
      return { success: result.success, response: result.response };
    } catch (error) {
      logger.error(`[PeerComm] sendDirect failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Log peer communication to Redis for ticket history
   */
  async _logCommunication(ticketId, type, data) {
    if (!this.redis) return;
    
    try {
      const key = `peer-comm:${ticketId}`;
      const entry = JSON.stringify({
        type,
        ...data,
        timestamp: new Date().toISOString(),
      });
      await this.redis.rpush(key, entry);
      await this.redis.expire(key, 86400); // 24h TTL
    } catch (err) {
      // Non-critical — just logging
      logger.debug(`[PeerComm] Redis log failed: ${err.message}`);
    }
  }

  /**
   * Get communication stats for this session
   */
  getStats() {
    return {
      agentId: this.agentId,
      ...this.stats,
      totalSent: this.stats.helpRequestsSent + this.stats.knowledgeShared + 
                 this.stats.directMessagesSent + this.stats.delegationsSent,
      totalReceived: this.stats.helpRequestsReceived + this.stats.knowledgeReceived + 
                     this.stats.directMessagesReceived + this.stats.delegationsReceived,
    };
  }

  /**
   * Get communication history for a ticket from Redis
   */
  async getTicketHistory(ticketId) {
    if (!this.redis) return [];
    
    try {
      const key = `peer-comm:${ticketId}`;
      const entries = await this.redis.lrange(key, 0, -1);
      return entries.map(e => {
        try { return JSON.parse(e); } catch { return { raw: e }; }
      });
    } catch {
      return [];
    }
  }
}

module.exports = PeerCommunicationService;
