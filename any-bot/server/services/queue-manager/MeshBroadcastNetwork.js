/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * MeshBroadcastNetwork — Signal Broadcaster for Agent Swarm
 * 
 * Phase 2: Broadcasts signals (BID_REQUEST, CAPABILITY_QUERY, HEALTH_PING) to ALL
 * registered agents simultaneously via HTTP POST to their /api/v1/agentic/mesh-signal
 * endpoints. Collects responses within a configurable bid window and returns ranked results.
 * 
 * ## How It Works
 * ```
 * QueueManagerService → meshBroadcast.broadcastBidRequest(ticket)
 *   → query AgentRegistry for all agents with endpoints
 *   → POST /api/v1/agentic/mesh-signal to EACH agent in parallel
 *   → collect responses within 10s bid window (Promise.allSettled + timeout)
 *   → rank claimants by confidence descending
 *   → return { lead, contributors, claims[], no_claims[], elapsed_ms }
 * ```
 * 
 * ## Fallback Strategy
 * Never throws. Returns empty/null results on failure so the caller can fall back
 * to CapabilityMatcher v3 or LLMAgentRouter.
 * 
 * @see {@link MeshSignalHandler} for how each bot evaluates signals
 * @see {@link docs/MESH_BROADCAST_NETWORK.md} for full design
 */

const http = require('http');
const logger = require('../../utils/logger');

class MeshBroadcastNetwork {
  /**
   * @param {Object} options
   * @param {Object} options.agentRegistry - AgentRegistry instance (reads agent endpoints)
   * @param {Object} [options.redis] - Redis client (for optional signal logging)
   * @param {number} [options.bidWindowMs] - Max time to wait for all bids (default 10000ms)
   * @param {number} [options.requestTimeoutMs] - Per-agent request timeout (default 8000ms)
   * @param {number} [options.minClaimConfidence] - Minimum confidence to accept a claim (default 0.3)
   */
  constructor(options = {}) {
    this.agentRegistry = options.agentRegistry || null;
    this.redis = options.redis || null;
    this.bidWindowMs = options.bidWindowMs || 10000;
    this.requestTimeoutMs = options.requestTimeoutMs || 8000;
    this.minClaimConfidence = options.minClaimConfidence || 0.3;
    this.enabled = true;

    logger.info(`[MeshBroadcast] Initialized (bidWindow: ${this.bidWindowMs}ms, requestTimeout: ${this.requestTimeoutMs}ms, minConfidence: ${this.minClaimConfidence})`);
  }

  /**
   * Broadcast a BID_REQUEST to all agents and return ranked claimants.
   * This is the main entry point for mesh bid routing.
   * 
   * @param {Object} ticket - Plane ticket { id, name, description_stripped, ... }
   * @param {Object} analysis - CapabilityMatcher analysis { capabilities, complexity, categories }
   * @param {Object} [options] - { phase, excludeAgents }
   * @returns {Promise<Object|null>} BroadcastResult or null on failure
   */
  async broadcastBidRequest(ticket, analysis, options = {}) {
    if (!this.enabled || !this.agentRegistry) {
      logger.warn('[MeshBroadcast] Disabled or no AgentRegistry — skipping broadcast');
      return null;
    }

    const startTime = Date.now();
    const signalId = `bid_${ticket.id}_${Date.now()}`;

    try {
      // Build the bid payload from ticket + analysis
      const payload = this._buildBidPayload(ticket, analysis, options);

      // Broadcast to all agents
      const result = await this.broadcast('BID_REQUEST', payload, {
        signalId,
        excludeAgents: options.excludeAgents || [],
      });

      if (!result) return null;

      result.signal_id = signalId;
      result.elapsed_ms = Date.now() - startTime;

      // Log summary
      const claimCount = result.claims.length;
      const leadStr = result.lead ? `${result.lead.agent_id} (${result.lead.confidence.toFixed(2)})` : 'none';
      logger.info(`[MeshBroadcast] BID_REQUEST for "${ticket.name?.substring(0, 50)}" → ${result.responded}/${result.total_agents} responded, ${claimCount} claims, lead=${leadStr} (${result.elapsed_ms}ms)`);

      return result;
    } catch (error) {
      logger.error(`[MeshBroadcast] broadcastBidRequest failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Generic broadcast: send a signal to all registered agents with endpoints.
   * 
   * @param {string} signalType - 'BID_REQUEST', 'CAPABILITY_QUERY', 'HEALTH_PING', etc.
   * @param {Object} payload - Signal-specific payload
   * @param {Object} [options] - { signalId, excludeAgents }
   * @returns {Promise<Object|null>} Aggregated broadcast result
   */
  async broadcast(signalType, payload, options = {}) {
    const { signalId, excludeAgents = [] } = options;
    const startTime = Date.now();

    try {
      // Get all agents with HTTP endpoints
      const allAgents = await this.agentRegistry.query({ available: true });
      const agents = allAgents.filter(a =>
        a.endpoint &&
        a.endpoint !== 'local' &&
        !excludeAgents.includes(a.agent_id)
      );

      if (agents.length === 0) {
        logger.warn('[MeshBroadcast] No agents with endpoints available for broadcast');
        return null;
      }

      logger.info(`[MeshBroadcast] Broadcasting ${signalType} to ${agents.length} agents (bid window: ${this.bidWindowMs}ms)`);

      // Build signal envelope
      const signal = {
        type: signalType,
        payload,
        source: 'queue-manager',
        signal_id: signalId || `sig_${Date.now()}`,
      };

      // Send to ALL agents in parallel, with bid window timeout
      const sendPromises = agents.map(agent =>
        this._sendSignal(agent, signal)
      );

      // Race: all responses vs bid window timeout
      const results = await Promise.race([
        Promise.allSettled(sendPromises),
        new Promise(resolve =>
          setTimeout(() => {
            logger.warn(`[MeshBroadcast] Bid window expired (${this.bidWindowMs}ms) — collecting partial results`);
            // Resolve with whatever we have so far
            Promise.allSettled(sendPromises).then(resolve);
          }, this.bidWindowMs)
        ),
      ]);

      // Aggregate results
      return this._aggregateResults(results, agents, startTime);
    } catch (error) {
      logger.error(`[MeshBroadcast] Broadcast failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Send a signal to a single agent via HTTP POST.
   * 
   * @param {Object} agent - Agent record from registry { agent_id, endpoint, ... }
   * @param {Object} signal - Signal envelope { type, payload, source, signal_id }
   * @returns {Promise<Object>} Response with agent_id or error
   */
  async _sendSignal(agent, signal) {
    return new Promise((resolve) => {
      const agentId = agent.agent_id;
      try {
        const url = new URL(`${agent.endpoint}/api/v1/agentic/mesh-signal`);
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
          timeout: this.requestTimeoutMs,
        }, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(data);
              resolve({ success: true, agent_id: agentId, response: parsed });
            } catch (e) {
              // Non-JSON response (e.g., HTML 404 page)
              resolve({ success: false, agent_id: agentId, error: 'non-json-response', statusCode: res.statusCode });
            }
          });
        });

        req.on('error', (err) => {
          resolve({ success: false, agent_id: agentId, error: err.message });
        });

        req.on('timeout', () => {
          req.destroy();
          resolve({ success: false, agent_id: agentId, error: 'timeout' });
        });

        req.write(postData);
        req.end();
      } catch (err) {
        resolve({ success: false, agent_id: agentId, error: err.message });
      }
    });
  }

  /**
   * Aggregate raw Promise.allSettled results into a structured BroadcastResult.
   * 
   * @param {Array} results - Promise.allSettled results
   * @param {Array} agents - Original agent list
   * @param {number} startTime - Broadcast start timestamp
   * @returns {Object} BroadcastResult
   */
  _aggregateResults(results, agents, startTime) {
    const claims = [];
    const noClaims = [];
    let responded = 0;
    let errors = 0;
    let timedOut = 0;

    for (const result of results) {
      if (result.status === 'rejected') {
        errors++;
        continue;
      }

      const value = result.value;
      if (!value.success) {
        if (value.error === 'timeout') {
          timedOut++;
        } else {
          errors++;
        }
        continue;
      }

      responded++;
      const response = value.response;

      if (response.claim && response.confidence >= this.minClaimConfidence) {
        claims.push({
          agent_id: response.agent_id || value.agent_id,
          confidence: response.confidence,
          reason: response.reason || '',
          capabilities_matched: response.capabilities_matched || [],
          latency_ms: response.latency_ms || 0,
          evaluation_method: response.evaluation_method || 'unknown',
        });
      } else {
        noClaims.push({
          agent_id: response.agent_id || value.agent_id,
          confidence: response.confidence || 0,
          reason: response.reason || 'No claim',
        });
      }
    }

    // Rank by confidence descending
    const ranked = this._rankBids(claims);

    return {
      total_agents: agents.length,
      responded,
      timed_out: timedOut,
      errors,
      claims: ranked.all,
      no_claims: noClaims,
      lead: ranked.lead,
      contributors: ranked.contributors,
      elapsed_ms: Date.now() - startTime,
      method: 'mesh_broadcast',
    };
  }

  /**
   * Rank bid claims by confidence descending.
   * 
   * @param {Array} claims - Array of claim objects with confidence
   * @returns {Object} { lead, contributors, all }
   */
  _rankBids(claims) {
    if (!claims || claims.length === 0) {
      return { lead: null, contributors: [], all: [] };
    }

    // Sort by confidence descending
    const sorted = [...claims].sort((a, b) => b.confidence - a.confidence);

    return {
      lead: sorted[0],
      contributors: sorted.slice(1),
      all: sorted,
    };
  }

  /**
   * Build BID_REQUEST payload from ticket and analysis data.
   * 
   * @param {Object} ticket - Plane ticket
   * @param {Object} analysis - CapabilityMatcher analysis
   * @param {Object} options - { phase }
   * @returns {Object} BID_REQUEST payload
   */
  _buildBidPayload(ticket, analysis, options = {}) {
    const description = ticket.description_stripped || ticket.name || '';

    return {
      title: (ticket.name || '').substring(0, 200),
      description: description.substring(0, 500),
      required_capabilities: analysis.capabilities || [],
      ticket_id: ticket.id,
      complexity: analysis.complexity || 'medium',
      phase: options.phase || analysis.currentPhase || null,
    };
  }

  /**
   * ⭐ PHASE_24 Issue #018: Send signal only to mesh members (not all agents)
   * Looks up mesh members from MeshChannelStore and sends signal to each.
   * 
   * @param {string} meshId - Mesh channel ID
   * @param {Object} signal - Signal envelope to send
   * @param {Object} meshChannelStore - MeshChannelStore instance
   * @param {Object} [options] - { excludeAgents }
   * @returns {Promise<Object|null>} Aggregated result or null
   */
  async sendToMesh(meshId, signal, meshChannelStore, options = {}) {
    if (!this.enabled || !this.agentRegistry || !meshChannelStore) {
      logger.warn('[MeshBroadcast] sendToMesh: missing dependencies');
      return null;
    }

    try {
      const channel = await meshChannelStore.getChannel(meshId);
      if (!channel || !channel.members || channel.members.length === 0) {
        logger.warn(`[MeshBroadcast] sendToMesh: mesh ${meshId} not found or empty`);
        return null;
      }

      const excludeAgents = options.excludeAgents || [];
      const targetMembers = channel.members.filter(m => !excludeAgents.includes(m));

      if (targetMembers.length === 0) {
        return { total_agents: 0, responded: 0, claims: [], no_claims: [] };
      }

      // Resolve member endpoints
      const allAgents = await this.agentRegistry.query({ available: true });
      const memberAgents = [];
      for (const memberId of targetMembers) {
        const agent = allAgents.find(a =>
          a.agent_id === memberId ||
          a.agent_id === `swarm-${memberId}` ||
          `swarm-${a.agent_id}` === memberId
        );
        if (agent && agent.endpoint && agent.endpoint !== 'local') {
          memberAgents.push(agent);
        }
      }

      if (memberAgents.length === 0) {
        logger.warn(`[MeshBroadcast] sendToMesh: no reachable agents in mesh ${meshId}`);
        return null;
      }

      logger.info(`[MeshBroadcast] sendToMesh ${signal.type} to ${memberAgents.length} members in mesh ${meshId}`);

      const sendPromises = memberAgents.map(agent => this._sendSignal(agent, signal));
      const results = await Promise.allSettled(sendPromises);

      return this._aggregateResults(results, memberAgents, Date.now());
    } catch (error) {
      logger.error(`[MeshBroadcast] sendToMesh failed: ${error.message}`);
      return null;
    }
  }
}

module.exports = MeshBroadcastNetwork;
