/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * CompetencyRanker — Competency-Based Agent Ranking for Phase Routing
 * 
 * Ranks ALL agents by competency for a specific task, using Mesh Broadcast
 * bid confidence as the primary signal. Returns an ordered list (most competent first)
 * instead of just a single winner.
 * 
 * ## How It Works
 * ```
 * QueueManagerService calls rankAgentsForPhase(ticket, phase, agents)
 *   → Broadcasts BID_REQUEST to all agents
 *   → Collects confidence scores (0.0-1.0) from each
 *   → Applies phase-specific role weighting (e.g., PM boosted for PLANNING)
 *   → Returns ordered list: [{agentId, confidence, role, reason}, ...]
 *   → Most competent SME goes first, then second-most, etc.
 * ```
 * 
 * ## Phase-Specific Role Mapping
 * - PLANNING:          Architect/PM go first (boost PM confidence)
 * - SPECIALIST_INPUT:  Domain SME first (no PM)
 * - EXECUTION:         Best-fit SME first (highest bid)
 * - TESTING:           QA-capable agents first (exclude executor)
 * - REVIEW:            Different agents than executor (cross-review)
 * 
 * Created: 2026-02-18 — Issue #012, PHASE_18
 */

const logger = require('../../utils/logger');

/**
 * Mandatory agents that MUST participate in every multi-bot phase/round.
 * These agents are injected into the ranked list regardless of competency score.
 * Added: 2026-02-24 — Architect+Tester Sprint
 */
const MANDATORY_AGENTS = ['architect-bot', 'tester-bot'];

/**
 * Roles assigned to mandatory agents when injected.
 * These override the phase-specific role assignment for mandatory agents.
 */
const MANDATORY_ROLES = {
  'architect-bot': 'mandatory-architect',
  'tester-bot': 'mandatory-tester',
};

/**
 * @description Competency-based ranker that orders agents for a given ticket and
 * workflow phase, so phase routing can dispatch work to the most capable SMEs
 * (and suitable backups) rather than picking a single winner. It exists to turn
 * Mesh Broadcast bid confidence — with capability-keyword fallback and
 * phase-specific role weighting — into a stable, ordered roster the
 * QueueManagerService can act on, and to persist the resulting role assignments
 * for a ticket's lifecycle. Exported as the module's default (CommonJS) value.
 */
class CompetencyRanker {
  /**
   * @param {Object} opts
   * @param {Object} opts.meshBroadcast - MeshBroadcastNetwork instance
   * @param {Object} opts.agentRegistry - AgentRegistry instance
   * @param {Object} opts.redis - Redis client
   */
  constructor(opts = {}) {
    this.meshBroadcast = opts.meshBroadcast || null;
    this.agentRegistry = opts.agentRegistry || null;
    this.redis = opts.redis || null;
  }

  /**
   * Rank all agents by competency for a specific ticket + phase.
   * Returns the full ranked list (not just the winner).
   * 
   * @param {Object} ticket - Plane ticket { id, name, description_stripped }
   * @param {Object} analysis - CapabilityMatcher analysis { capabilities, complexity, priority }
   * @param {number} phase - Current phase number (1-7)
   * @param {Object[]} allAgents - All registered agents from AgentRegistry
   * @param {Object} [opts] - { excludeAgents: string[], executorAgentId: string }
   * @returns {Promise<Array<{agentId: string, confidence: number, role: string, reason: string}>>}
   */
  async rankAgentsForPhase(ticket, analysis, phase, allAgents, opts = {}) {
    const { excludeAgents = [], executorAgentId = null } = opts;

    // 1. Try mesh broadcast for real-time competency signals
    let bidResults = [];
    if (this.meshBroadcast && this.meshBroadcast.enabled) {
      try {
        const broadcastResult = await this.meshBroadcast.broadcastBidRequest(ticket, analysis, {
          phase: this._phaseToString(phase),
          excludeAgents,
          returnFullRanking: true, // Signal to return ALL bids, not just winner
        });

        if (broadcastResult && broadcastResult.claims && broadcastResult.claims.length > 0) {
          bidResults = broadcastResult.claims.map(claim => ({
            agentId: claim.agent_id,
            confidence: claim.confidence || 0,
            reason: claim.reason || 'Bid response',
            capabilities_matched: claim.capabilities_matched || [],
          }));
          logger.info(`[CompetencyRanker] Received ${bidResults.length} bids for ticket ${ticket.id} phase ${phase}`);
        }
      } catch (err) {
        logger.warn(`[CompetencyRanker] Mesh broadcast failed, using fallback ranking: ${err.message}`);
      }
    }

    // 2. Build competency map: agentId → score
    const competencyMap = new Map();

    // Seed all agents with base confidence (so non-bidders get a score too)
    for (const agent of allAgents) {
      if (excludeAgents.includes(agent.agent_id)) continue;
      
      // Base score from capability keyword matching
      const capabilityOverlap = this._calculateCapabilityOverlap(agent, analysis);
      competencyMap.set(agent.agent_id, {
        agentId: agent.agent_id,
        confidence: capabilityOverlap * 0.3, // Base: 0-0.3 from keywords
        role: 'contributor',
        reason: `Capability match: ${(capabilityOverlap * 100).toFixed(0)}%`,
        capabilities_matched: [],
      });
    }

    // Override with real bid confidences (higher quality signal)
    for (const bid of bidResults) {
      if (excludeAgents.includes(bid.agentId)) continue;
      if (!competencyMap.has(bid.agentId)) continue;

      competencyMap.set(bid.agentId, {
        agentId: bid.agentId,
        confidence: bid.confidence,
        role: 'bidder',
        reason: bid.reason,
        capabilities_matched: bid.capabilities_matched,
      });
    }

    // 3. Apply phase-specific role weighting
    const ranked = Array.from(competencyMap.values());
    this._applyPhaseWeighting(ranked, phase, executorAgentId);

    // 4. Sort by confidence descending
    ranked.sort((a, b) => b.confidence - a.confidence);

    // 5. Assign role labels based on position + phase
    this._assignRoles(ranked, phase);

    logger.info(`[CompetencyRanker] Ranked ${ranked.length} agents for ticket ${ticket.id} phase ${phase}: ${ranked.slice(0, 5).map(r => `${r.agentId}(${r.confidence.toFixed(2)}/${r.role})`).join(', ')}`);

    return ranked;
  }

  /**
   * Get the top N agents for a phase (convenience method)
   * @param {Object} ticket
   * @param {Object} analysis
   * @param {number} phase
   * @param {Object[]} allAgents
   * @param {number} n - How many to return
   * @param {Object} [opts]
   * @returns {Promise<Array>}
   */
  async getTopN(ticket, analysis, phase, allAgents, n = 3, opts = {}) {
    const ranked = await this.rankAgentsForPhase(ticket, analysis, phase, allAgents, opts);
    return ranked.slice(0, n);
  }

  /**
   * Store role assignments for a ticket in Redis
   * Persists which agents are assigned which roles for the lifecycle
   * @param {string} ticketId
   * @param {Object} assignments - { architect: agentId, pm: agentId, executor: agentId, tester: agentId, reviewers: [agentId, ...] }
   */
  async storeRoleAssignments(ticketId, assignments) {
    if (!this.redis) return;
    try {
      const key = `qm:ticket_roles:${ticketId}`;
      await this.redis.set(key, JSON.stringify(assignments), 'EX', 86400); // 24h TTL
      logger.info(`[CompetencyRanker] Stored role assignments for ticket ${ticketId}: ${JSON.stringify(assignments)}`);
    } catch (err) {
      logger.warn(`[CompetencyRanker] Failed to store role assignments: ${err.message}`);
    }
  }

  /**
   * Get stored role assignments for a ticket
   * @param {string} ticketId
   * @returns {Promise<Object|null>}
   */
  async getRoleAssignments(ticketId) {
    if (!this.redis) return null;
    try {
      const key = `qm:ticket_roles:${ticketId}`;
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      logger.warn(`[CompetencyRanker] Failed to get role assignments: ${err.message}`);
      return null;
    }
  }

  /**
   * Update a single role in stored assignments
   * @param {string} ticketId
   * @param {string} role - e.g., 'executor', 'tester'
   * @param {string} agentId
   */
  async updateRoleAssignment(ticketId, role, agentId) {
    const existing = await this.getRoleAssignments(ticketId) || {};
    existing[role] = agentId;
    await this.storeRoleAssignments(ticketId, existing);
  }

  // ── Private Methods ──────────────────────────────────────────────

  /**
   * Calculate capability overlap between agent and ticket analysis
   * @private
   */
  _calculateCapabilityOverlap(agent, analysis) {
    if (!agent.capabilities || !analysis.capabilities) return 0.1;
    
    const agentCaps = new Set((agent.capabilities || []).map(c => c.toLowerCase()));
    const ticketCaps = analysis.capabilities || [];
    
    if (ticketCaps.length === 0) return 0.1;
    
    let matchCount = 0;
    for (const cap of ticketCaps) {
      if (agentCaps.has(cap.toLowerCase())) matchCount++;
    }
    
    return Math.min(matchCount / ticketCaps.length, 1.0);
  }

  /**
   * Apply phase-specific weighting adjustments to ranked list
   * @private
   */
  _applyPhaseWeighting(ranked, phase, executorAgentId) {
    for (const entry of ranked) {
      switch (phase) {
        case 2: // PLANNING
          // Boost PM agents for planning phase
          if (entry.agentId === 'project-manager' || entry.agentId.includes('pm')) {
            entry.confidence = Math.min(entry.confidence + 0.3, 1.0);
            entry.reason += ' (+PM planning boost)';
          }
          break;

        case 3: // SPECIALIST_INPUT
          // Penalize PM for specialist input (want domain experts)
          if (entry.agentId === 'project-manager') {
            entry.confidence = Math.max(entry.confidence - 0.5, 0);
            entry.reason += ' (-PM penalty for specialist phase)';
          }
          break;

        case 4: // EXECUTION
          // No special weighting — pure competency
          break;

        case 5: // TESTING
          // Penalize executor (fresh eyes needed)
          if (entry.agentId === executorAgentId) {
            entry.confidence = Math.max(entry.confidence - 0.5, 0);
            entry.reason += ' (-executor penalty for testing)';
          }
          // Penalize PM (not a tester role)
          if (entry.agentId === 'project-manager') {
            entry.confidence = Math.max(entry.confidence - 0.2, 0);
            entry.reason += ' (-PM penalty for testing)';
          }
          break;

        case 6: // REVIEW
          // Penalize executor (can't review own work)
          if (entry.agentId === executorAgentId) {
            entry.confidence = Math.max(entry.confidence - 0.5, 0);
            entry.reason += ' (-executor penalty for review)';
          }
          break;
      }
    }
  }

  /**
   * Assign human-readable role labels based on position and phase
   * @private
   */
  _assignRoles(ranked, phase) {
    const rolesByPhase = {
      2: ['architect', 'co-planner', 'advisor'],
      3: ['domain-expert', 'specialist', 'advisor'],
      4: ['primary-executor', 'secondary-executor', 'support'],
      5: ['primary-tester', 'secondary-tester', 'qa-support'],
      6: ['primary-reviewer', 'secondary-reviewer', 'quality-check'],
    };

    const roles = rolesByPhase[phase] || ['primary', 'secondary', 'support'];

    for (let i = 0; i < ranked.length; i++) {
      if (i < roles.length) {
        ranked[i].role = roles[i];
      } else {
        ranked[i].role = 'observer';
      }
    }
  }

  /**
   * Convert phase number to string for mesh broadcast options
   * @private
   */
  _phaseToString(phase) {
    const map = { 1: 'INTAKE', 2: 'PLANNING', 3: 'SPECIALIST_INPUT', 4: 'EXECUTION', 5: 'TESTING', 6: 'REVIEW', 7: 'DELIVERY' };
    return map[phase] || 'UNKNOWN';
  }
}

// Backward-compatible: module.exports = CompetencyRanker class
// Plus named exports for MANDATORY_AGENTS and MANDATORY_ROLES
module.exports = CompetencyRanker;
module.exports.CompetencyRanker = CompetencyRanker;
module.exports.MANDATORY_AGENTS = MANDATORY_AGENTS;
module.exports.MANDATORY_ROLES = MANDATORY_ROLES;
