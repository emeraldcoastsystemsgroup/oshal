/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * PhaseRoundOrchestrator — Mandatory Multi-Round Phase Execution
 * 
 * Enforces 2 mandatory rounds per phase with competency-ranked agent ordering.
 * Generalizes PhaseReviewCycle (which only ran on REVIEW phase) to ALL phases.
 * 
 * ## How It Works
 * ```
 * Phase 2 (PLANNING):
 *   Round 1: Most competent architect creates the plan
 *   Round 2: Second-most competent reviews/improves the plan
 *   QM summarizes both rounds → gate check → advance
 * 
 * Phase 4 (EXECUTION):
 *   Round 1: Top SME executes the work
 *   Round 2: Second SME reviews execution, suggests improvements
 *   QM summarizes → gate check → advance
 * 
 * Phase 5 (TESTING):
 *   Round 1: Primary tester runs tests
 *   Round 2: Secondary tester validates + cross-checks
 *   QM summarizes → gate check → advance
 * 
 * Phase 6 (REVIEW):
 *   Round 1: Primary reviewer evaluates quality
 *   Round 2: Secondary reviewer + PM sign-off
 *   Consensus → advance to DELIVERY
 * ```
 * 
 * ## Integration with Existing PhaseReviewCycle
 * PhaseReviewCycle continues to manage the REVIEW phase (Phase 6) consensus logic.
 * PhaseRoundOrchestrator wraps ALL phases and delegates REVIEW to PhaseReviewCycle.
 * 
 * ## Redis State
 * Key: `qm:phase_rounds:{ticketId}:{phase}`
 * Value: { currentRound, maxRounds, rounds: [{agentId, status, startedAt, completedAt}], ... }
 * 
 * Created: 2026-02-18 — Issue #012, PHASE_18
 */

const logger = require('../../utils/logger');
const { MANDATORY_AGENTS, MANDATORY_ROLES } = require('./CompetencyRanker');

// Round states
/**
 * @description Canonical lifecycle states for a single round within a phase, used to
 * track and render per-round progress and to keep Redis state and status comments
 * consistent across the orchestrator.
 */
const ROUND_STATES = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  SKIPPED: 'skipped',
};

// Orchestrator states
/**
 * @description High-level states describing where a phase's multi-round execution
 * stands as a whole, so callers can decide whether orchestration is still active,
 * waiting between rounds, or fully complete and ready to advance the phase.
 */
const ORCHESTRATOR_STATES = {
  NOT_STARTED: 'not_started',
  ROUND_IN_PROGRESS: 'round_in_progress',
  BETWEEN_ROUNDS: 'between_rounds',
  ALL_ROUNDS_COMPLETE: 'all_rounds_complete',
};

/**
 * @description Enforces mandatory multi-round execution for every workflow phase so
 * that each phase gets a primary agent plus at least one independent reviewer/improver,
 * generalizing the REVIEW-only review cycle to all phases. It selects and orders agents
 * by competency (injecting mandatory participants where required), persists per-round
 * progress in Redis, builds the prompt context handed to each round's agent, and reports
 * status back to the queue manager so phases only advance once all rounds are complete.
 */
class PhaseRoundOrchestrator {
  /**
   * @param {Object} opts
   * @param {Object} opts.redis - Redis client
   * @param {number} opts.defaultRounds - Default number of rounds per phase (default: 2)
   * @param {Object} opts.competencyRanker - CompetencyRanker instance
   * @param {Object} opts.handoverManager - RALFHandoverManager instance
   */
  constructor(opts = {}) {
    this.redis = opts.redis;
    this.defaultRounds = parseInt(opts.defaultRounds || process.env.PHASE_ROUNDS || '2');
    this.competencyRanker = opts.competencyRanker || null;
    this.handoverManager = opts.handoverManager || null;

    // Phase-specific round overrides
    this.phaseRoundConfig = {
      1: 1,  // INTAKE: 1 round (automated)
      2: 2,  // PLANNING: 2 rounds (architect + reviewer)
      3: 2,  // SPECIALIST_INPUT: 2 rounds (2 domain experts)
      4: 2,  // EXECUTION: 2 rounds (executor + improver)
      5: 2,  // TESTING: 2 rounds (2 testers)
      6: 2,  // REVIEW: 2 rounds (managed by PhaseReviewCycle)
      7: 1,  // DELIVERY: 1 round (automated)
    };
  }

  /**
   * Initialize round tracking for a ticket entering a new phase.
   * Called by QM when a ticket advances to a new phase.
   * 
   * @param {string} ticketId
   * @param {number} phase - Phase number (1-7)
   * @param {Array} rankedAgents - Competency-ranked agents from CompetencyRanker
   * @param {Object} [opts] - { complexity, executorAgentId }
   * @returns {Promise<Object>} Round orchestration state
   */
  async initPhaseRounds(ticketId, phase, rankedAgents, opts = {}) {
    const configuredRounds = this.getMaxRounds(phase);
    
    // Select agents for each round based on competency ranking
    // Note: _assignAgentsToRounds may expand rounds beyond configuredRounds
    // to accommodate mandatory agents (architect-bot, tester-bot)
    const roundAssignments = this._assignAgentsToRounds(rankedAgents, configuredRounds, phase);
    const maxRounds = roundAssignments.length || configuredRounds;

    const state = {
      ticketId,
      phase,
      currentRound: 1,
      maxRounds,
      state: ORCHESTRATOR_STATES.ROUND_IN_PROGRESS,
      rounds: roundAssignments.map((assignment, idx) => ({
        round: idx + 1,
        agentId: assignment.agentId,
        role: assignment.role,
        confidence: assignment.confidence,
        status: idx === 0 ? ROUND_STATES.IN_PROGRESS : ROUND_STATES.PENDING,
        startedAt: idx === 0 ? Date.now() : null,
        completedAt: null,
      })),
      complexity: opts.complexity || 'medium',
      executorAgentId: opts.executorAgentId || null,
      createdAt: Date.now(),
    };

    await this._saveState(ticketId, phase, state);

    logger.info(`[PhaseRounds] Initialized ${maxRounds} rounds for ticket ${ticketId} phase ${phase}: ${roundAssignments.map(r => `R${r.round}:${r.agentId}`).join(', ')}`);

    return state;
  }

  /**
   * Get current round orchestration state
   * @param {string} ticketId
   * @param {number} phase
   * @returns {Promise<Object|null>}
   */
  async getState(ticketId, phase) {
    return this._loadState(ticketId, phase);
  }

  /**
   * Check if round orchestration is active for a ticket+phase
   * @param {string} ticketId
   * @param {number} phase
   * @returns {Promise<boolean>}
   */
  async isActive(ticketId, phase) {
    const state = await this._loadState(ticketId, phase);
    return state !== null && state.state !== ORCHESTRATOR_STATES.ALL_ROUNDS_COMPLETE;
  }

  /**
   * Get the agent assigned to the current round
   * @param {string} ticketId
   * @param {number} phase
   * @returns {Promise<{agentId: string, round: number, role: string}|null>}
   */
  async getCurrentRoundAgent(ticketId, phase) {
    const state = await this._loadState(ticketId, phase);
    if (!state) return null;

    const currentRoundData = state.rounds.find(r => r.round === state.currentRound);
    if (!currentRoundData) return null;

    return {
      agentId: currentRoundData.agentId,
      round: state.currentRound,
      role: currentRoundData.role,
      maxRounds: state.maxRounds,
    };
  }

  /**
   * Record that the current round is complete and advance to next round (or finish).
   * Called after an agent finishes its work on the current round.
   * 
   * @param {string} ticketId
   * @param {number} phase
   * @param {string} agentId - Agent that completed the round
   * @param {string} agentResponse - Agent's response text (for handover extraction)
   * @param {string} workspaceTaskId - For writing handover docs
   * @returns {Promise<{action: string, state: Object}>}
   *   action: 'NEXT_ROUND' | 'PHASE_COMPLETE' | 'ERROR'
   */
  async completeRound(ticketId, phase, agentId, agentResponse, workspaceTaskId) {
    const state = await this._loadState(ticketId, phase);
    if (!state) {
      logger.warn(`[PhaseRounds] No state found for ${ticketId} phase ${phase}`);
      return { action: 'ERROR', state: null };
    }

    // Mark current round as completed
    const currentRound = state.rounds.find(r => r.round === state.currentRound);
    if (currentRound) {
      currentRound.status = ROUND_STATES.COMPLETED;
      currentRound.completedAt = Date.now();
    }

    // Write RALF handover for this round — AUDIT TRAIL ONLY (non-blocking)
    // The comment thread is the PRIMARY handover chain (previousComments injection).
    // File-based handovers are a secondary record for workspace browsing, not prompt injection.
    if (this.handoverManager && workspaceTaskId) {
      try {
        this.handoverManager.writeHandover(
          workspaceTaskId, agentId, phase, state.currentRound, agentResponse
        );
        logger.debug(`[PhaseRounds] Handover audit trail written: ${agentId}_PHASE_${phase}_ROUND_${state.currentRound}.md`);
      } catch (handoverErr) {
        logger.debug(`[PhaseRounds] Handover write failed (non-fatal, audit only): ${handoverErr.message}`);
      }
    }

    // Check if there are more rounds
    if (state.currentRound < state.maxRounds) {
      // Advance to next round
      state.currentRound++;
      state.state = ORCHESTRATOR_STATES.BETWEEN_ROUNDS;

      // Mark next round as in-progress
      const nextRound = state.rounds.find(r => r.round === state.currentRound);
      if (nextRound) {
        nextRound.status = ROUND_STATES.IN_PROGRESS;
        nextRound.startedAt = Date.now();
      }

      state.state = ORCHESTRATOR_STATES.ROUND_IN_PROGRESS;
      await this._saveState(ticketId, phase, state);

      logger.info(`[PhaseRounds] Ticket ${ticketId} phase ${phase}: Round ${state.currentRound - 1} complete → Starting Round ${state.currentRound} (agent: ${nextRound?.agentId})`);

      return { action: 'NEXT_ROUND', state };
    } else {
      // All rounds complete
      state.state = ORCHESTRATOR_STATES.ALL_ROUNDS_COMPLETE;
      await this._saveState(ticketId, phase, state);

      logger.info(`[PhaseRounds] Ticket ${ticketId} phase ${phase}: All ${state.maxRounds} rounds complete`);

      return { action: 'PHASE_COMPLETE', state };
    }
  }

  /**
   * Get the number of mandatory rounds for a phase
   * @param {number} phase
   * @returns {number}
   */
  getMaxRounds(phase) {
    return this.phaseRoundConfig[phase] || this.defaultRounds;
  }

  /**
   * Build the prompt context for the current round's agent.
   * Includes QM summary, previous rounds' output, handover instructions.
   * 
   * @param {string} ticketId
   * @param {number} phase
   * @param {string} agentId
   * @param {string} workspaceTaskId
   * @param {Object} ticket - { id, name }
   * @param {Object} [opts] - { roleAssignments, complexity }
   * @returns {Promise<string>} Combined prompt context
   */
  async buildRoundContext(ticketId, phase, agentId, workspaceTaskId, ticket, opts = {}) {
    const state = await this._loadState(ticketId, phase);
    const sections = [];

    // 1. QM Executive Summary (from RALF handovers)
    if (this.handoverManager && workspaceTaskId) {
      const handovers = this.handoverManager.readHandovers(ticketId, workspaceTaskId);
      const summary = this.handoverManager.generateSummary(
        handovers, ticket, phase, state?.currentRound || 1, opts
      );
      sections.push(summary);
    }

    // 2. Context recall for returning agents
    if (this.handoverManager && workspaceTaskId) {
      const previousHandover = this.handoverManager.readAgentHandover(agentId, workspaceTaskId);
      if (previousHandover) {
        sections.push(this.handoverManager.generateContextRecall(previousHandover, agentId));
      }
    }

    // 3. Round info
    if (state) {
      const currentRoundData = state.rounds.find(r => r.round === state.currentRound);
      sections.push(`═══════════════════════════════════════════
🔄 ROUND ${state.currentRound} of ${state.maxRounds}
═══════════════════════════════════════════

**Your Role:** ${currentRoundData?.role || 'participant'}
**Round:** ${state.currentRound} of ${state.maxRounds} mandatory rounds
**Previous Rounds:** ${state.rounds.filter(r => r.status === 'completed').map(r => `R${r.round}:${r.agentId}(${r.role})`).join(', ') || 'None (you are first)'}

${state.currentRound === 1 
  ? '**You are the PRIMARY agent for this phase.** Create the initial work product.'
  : `**You are REVIEWING/IMPROVING Round ${state.currentRound - 1}'s output.** Read the previous agent's work carefully, then enhance, correct, or validate it.`}

═══════════════════════════════════════════`);
    }

    // 4. Handover writing instructions
    if (this.handoverManager) {
      sections.push(this.handoverManager.getHandoverInstructions(
        agentId, phase, state?.currentRound || 1
      ));
    }

    return sections.join('\n\n');
  }

  /**
   * Format a Plane comment about the round orchestration status
   * @param {Object} state - Current orchestration state
   * @returns {string}
   */
  formatStatusComment(state) {
    if (!state) return '';

    const phaseNames = { 1: 'INTAKE', 2: 'PLANNING', 3: 'SPECIALIST_INPUT', 4: 'EXECUTION', 5: 'TESTING', 6: 'REVIEW', 7: 'DELIVERY' };

    const roundsStatus = state.rounds.map(r => {
      const statusEmoji = {
        [ROUND_STATES.COMPLETED]: '✅',
        [ROUND_STATES.IN_PROGRESS]: '🔄',
        [ROUND_STATES.PENDING]: '⏳',
        [ROUND_STATES.SKIPPED]: '⏭️',
      };
      return `${statusEmoji[r.status] || '❓'} Round ${r.round}: **${r.agentId}** (${r.role}) — ${r.status}`;
    }).join('\n');

    return `🔄 **Phase ${state.phase} (${phaseNames[state.phase] || 'UNKNOWN'}) — Round ${state.currentRound}/${state.maxRounds}**

${roundsStatus}

---
*Phase Round Orchestrator v1.0*`;
  }

  /**
   * Clean up round tracking for a ticket+phase
   * @param {string} ticketId
   * @param {number} phase
   */
  async cleanup(ticketId, phase) {
    try {
      const key = `qm:phase_rounds:${ticketId}:${phase}`;
      await this.redis.del(key);
      logger.debug(`[PhaseRounds] Cleaned up round tracking for ${ticketId} phase ${phase}`);
    } catch (err) {
      logger.debug(`[PhaseRounds] Cleanup failed: ${err.message}`);
    }
  }

  /**
   * Clean up ALL round tracking for a ticket (when lifecycle ends)
   * @param {string} ticketId
   */
  async cleanupAll(ticketId) {
    for (let phase = 1; phase <= 7; phase++) {
      await this.cleanup(ticketId, phase);
    }
  }

  // ── Private Methods ──────────────────────────────────────────────

  /**
   * Assign agents to rounds based on competency ranking.
   * 
   * For multi-round phases (2-6), mandatory agents (architect-bot, tester-bot)
   * are ALWAYS included. The assignment strategy:
   *   1. Inject mandatory agents that aren't already in the top-N ranked list
   *   2. Expand maxRounds if needed to accommodate mandatory + domain agents
   *   3. Domain specialist gets first round, mandatory agents fill remaining rounds
   * 
   * For single-round phases (1=INTAKE, 7=DELIVERY), mandatory agents are NOT injected
   * because these are automated phases.
   * 
   * Updated: 2026-02-24 — Architect+Tester Sprint (mandatory participant support)
   * @private
   */
  _assignAgentsToRounds(rankedAgents, maxRounds, phase) {
    // Single-round phases (INTAKE, DELIVERY) — no mandatory injection
    if (maxRounds <= 1) {
      return this._assignAgentsSimple(rankedAgents, maxRounds);
    }

    // Multi-round phases (2-6) — inject mandatory agents
    return this._assignAgentsWithMandatory(rankedAgents, maxRounds, phase);
  }

  /**
   * Simple assignment for single-round phases (no mandatory injection)
   * @private
   */
  _assignAgentsSimple(rankedAgents, maxRounds) {
    const assignments = [];
    for (let i = 0; i < maxRounds; i++) {
      if (i < rankedAgents.length) {
        assignments.push({
          round: i + 1,
          agentId: rankedAgents[i].agentId,
          role: rankedAgents[i].role || `round-${i + 1}`,
          confidence: rankedAgents[i].confidence || 0,
        });
      } else if (rankedAgents.length > 0) {
        assignments.push({
          round: i + 1,
          agentId: rankedAgents[0].agentId,
          role: `round-${i + 1}-reuse`,
          confidence: rankedAgents[0].confidence || 0,
        });
      }
    }
    return assignments;
  }

  /**
   * Assignment with mandatory agent injection for multi-round phases.
   * 
   * Strategy:
   *   - Round 1: Top domain specialist (from CompetencyRanker)
   *   - Remaining rounds: Mandatory agents that aren't already assigned
   *   - If mandatory agents ARE the top-ranked, they keep their slot
   *   - Expand total rounds to fit: max(configured rounds, domain + mandatory count)
   * 
   * @private
   */
  _assignAgentsWithMandatory(rankedAgents, configuredRounds, phase) {
    const assignments = [];
    const assignedIds = new Set();

    // Identify which mandatory agents are already in the ranked list
    const rankedIds = new Set(rankedAgents.map(a => a.agentId));

    // Build the final agent list: domain specialists + mandatory agents
    // Start with the top-ranked agents from CompetencyRanker
    const agentSlots = [];

    // Slot 1: Top domain specialist (always first)
    if (rankedAgents.length > 0) {
      agentSlots.push(rankedAgents[0]);
      assignedIds.add(rankedAgents[0].agentId);
    }

    // Inject mandatory agents that aren't already in slot 1
    for (const mandatoryId of MANDATORY_AGENTS) {
      if (assignedIds.has(mandatoryId)) continue; // Already assigned as domain specialist

      // Find the mandatory agent in the ranked list (they may have a score)
      const fromRanked = rankedAgents.find(a => a.agentId === mandatoryId);
      agentSlots.push({
        agentId: mandatoryId,
        role: MANDATORY_ROLES[mandatoryId] || 'mandatory-participant',
        confidence: fromRanked ? fromRanked.confidence : 0.95, // High confidence for mandatory
        reason: `Mandatory participant (${MANDATORY_ROLES[mandatoryId] || mandatoryId})`,
      });
      assignedIds.add(mandatoryId);
    }

    // Fill remaining slots with next-best domain specialists (if rounds allow)
    for (let i = 1; i < rankedAgents.length && agentSlots.length < configuredRounds; i++) {
      if (!assignedIds.has(rankedAgents[i].agentId)) {
        agentSlots.push(rankedAgents[i]);
        assignedIds.add(rankedAgents[i].agentId);
      }
    }

    // Determine actual round count: at least configuredRounds, but expand if mandatory agents need more
    const actualRounds = Math.max(configuredRounds, agentSlots.length);

    // Build assignments
    for (let i = 0; i < actualRounds; i++) {
      if (i < agentSlots.length) {
        const agent = agentSlots[i];
        const isMandatory = MANDATORY_AGENTS.includes(agent.agentId);
        assignments.push({
          round: i + 1,
          agentId: agent.agentId,
          role: isMandatory ? (MANDATORY_ROLES[agent.agentId] || agent.role) : (agent.role || `round-${i + 1}`),
          confidence: agent.confidence || 0,
        });
      } else if (agentSlots.length > 0) {
        // Reuse top agent for any remaining rounds
        assignments.push({
          round: i + 1,
          agentId: agentSlots[0].agentId,
          role: `round-${i + 1}-reuse`,
          confidence: agentSlots[0].confidence || 0,
        });
      }
    }

    logger.info(`[PhaseRounds] Mandatory injection for phase ${phase}: ${assignments.length} rounds (configured: ${configuredRounds}, mandatory agents injected: ${MANDATORY_AGENTS.filter(id => assignedIds.has(id)).length})`);

    return assignments;
  }

  /**
   * Save orchestration state to Redis
   * @private
   */
  async _saveState(ticketId, phase, state) {
    try {
      const key = `qm:phase_rounds:${ticketId}:${phase}`;
      await this.redis.set(key, JSON.stringify(state), 'EX', 86400); // 24h TTL
    } catch (err) {
      logger.error(`[PhaseRounds] Failed to save state: ${err.message}`);
    }
  }

  /**
   * Load orchestration state from Redis
   * @private
   */
  async _loadState(ticketId, phase) {
    try {
      const key = `qm:phase_rounds:${ticketId}:${phase}`;
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      logger.warn(`[PhaseRounds] Failed to load state: ${err.message}`);
      return null;
    }
  }
}

module.exports = { PhaseRoundOrchestrator, ROUND_STATES, ORCHESTRATOR_STATES };
