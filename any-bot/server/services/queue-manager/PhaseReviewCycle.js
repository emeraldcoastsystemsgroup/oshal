/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * PhaseReviewCycle — Consensus-Driven Round-Robin Review Within Phases
 * 
 * After each phase's primary work is done, a review cycle begins where multiple
 * bots review the output. The cycle continues until consensus (all reviewers approve)
 * or a max-round safety limit is hit.
 * 
 * ## How It Works
 * ```
 * Phase 4 (EXECUTION) completes → PhaseReviewCycle starts
 *   → Round 1: Bot A reviews → posts handover with observations
 *   → Round 1: Bot B reviews → posts handover, requests changes
 *   → QM sees "REVISE" → routes BACK to executor for changes
 *   → Round 2: Executor addresses feedback → updates handover
 *   → Round 2: Bot A re-reviews → APPROVE
 *   → Round 2: Bot B re-reviews → APPROVE  
 *   → Consensus reached → phase gate passes → advance to next phase
 * ```
 * 
 * ## Handover Protocol
 * Every bot MUST:
 * 1. READ the current phase handover (from workspace `developer-handovers/`)
 * 2. READ previous cycle handovers (if any)
 * 3. WRITE/UPDATE the handover with their observations when they finish their turn
 * 
 * ## Context Window
 * During EXECUTION and REVIEW phases, NO context window limits are applied.
 * Bots run for as many turns as they need to ensure completeness.
 * 
 * @see TicketPhaseManager for phase lifecycle
 * @see QueueManagerService for routing integration
 */

const logger = require('../../utils/logger');

// Review cycle states
/**
 * @description Enumerates the lifecycle states a phase review cycle can occupy, so
 * routing logic and status reporting share one canonical set of state values instead
 * of comparing magic strings. Exported alongside the class for consumers that need to
 * reason about cycle state without instantiating the manager.
 */
const CYCLE_STATES = {
  NOT_STARTED: 'not_started',
  IN_PROGRESS: 'in_progress',
  AWAITING_REVISION: 'awaiting_revision',
  CONSENSUS_REACHED: 'consensus_reached',
  MAX_ROUNDS_HIT: 'max_rounds_hit',
};

/**
 * @description Manages the consensus-driven, multi-round review cycle that runs after a
 * phase's primary work is finished, coordinating reviewer turns, verdict collection, and
 * routing back to the executor until reviewers reach consensus or a safety round limit is
 * hit. It also builds the reviewer/executor prompts and human-readable status comments so
 * the orchestration layer can drive the cycle and report progress without owning the rules.
 * This class is the module's default export.
 */
class PhaseReviewCycle {
  /**
   * @param {Object} redisClient - Redis client for state persistence
   * @param {Object} [options]
   * @param {number} [options.maxRounds=3] - Max review rounds before forcing advancement
   * @param {number} [options.minReviewers=2] - Min reviewers per round (excluding the executor)
   * @param {number} [options.maxReviewers=4] - Max reviewers per round
   */
  constructor(redisClient, options = {}) {
    this.redis = redisClient;
    this.maxRounds = options.maxRounds || 3;
    this.minReviewers = options.minReviewers || 2;
    this.maxReviewers = options.maxReviewers || 4;
  }

  /**
   * Get the review cycle state for a ticket+phase
   * @param {string} ticketId
   * @param {number} phase
   * @returns {Promise<Object|null>} Cycle state
   */
  async getCycleState(ticketId, phase) {
    try {
      const key = `qm:review_cycle:${ticketId}:${phase}`;
      const data = await this.redis.get(key);
      return data ? JSON.parse(data) : null;
    } catch (err) {
      logger.warn(`[ReviewCycle] Failed to get cycle state for ${ticketId}:${phase}: ${err.message}`);
      return null;
    }
  }

  /**
   * Initialize a review cycle for a phase
   * Called after the primary agent completes phase work.
   * @param {string} ticketId
   * @param {number} phase
   * @param {string} executorAgentId - The agent who did the primary work
   * @param {string[]} reviewerAgentIds - Agents who should review (excluding executor)
   * @returns {Promise<Object>} Initial cycle state
   */
  async initCycle(ticketId, phase, executorAgentId, reviewerAgentIds) {
    const cycleState = {
      ticketId,
      phase,
      state: CYCLE_STATES.IN_PROGRESS,
      currentRound: 1,
      maxRounds: this.maxRounds,
      executorAgentId,
      reviewerAgentIds,
      // Track each reviewer's verdict per round: { agentId: { round: verdict } }
      verdicts: {},
      // Track who still needs to review this round
      pendingReviewers: [...reviewerAgentIds],
      completedReviewers: [],
      // History of all rounds for context
      roundHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await this._saveCycleState(ticketId, phase, cycleState);
    logger.info(`[ReviewCycle] Initialized for ticket ${ticketId} phase ${phase}: executor=${executorAgentId}, reviewers=[${reviewerAgentIds.join(', ')}], maxRounds=${this.maxRounds}`);
    return cycleState;
  }

  /**
   * Record a reviewer's verdict for the current round
   * @param {string} ticketId
   * @param {number} phase
   * @param {string} reviewerAgentId
   * @param {string} verdict - 'APPROVE' | 'REVISE' | 'CONCERN'
   * @param {string} feedback - The reviewer's feedback/observations
   * @returns {Promise<Object>} Updated cycle state with next action
   */
  async recordVerdict(ticketId, phase, reviewerAgentId, verdict, feedback = '') {
    const state = await this.getCycleState(ticketId, phase);
    if (!state) {
      throw new Error(`No review cycle found for ${ticketId}:${phase}`);
    }

    // Record verdict
    if (!state.verdicts[reviewerAgentId]) {
      state.verdicts[reviewerAgentId] = {};
    }
    state.verdicts[reviewerAgentId][state.currentRound] = {
      verdict: verdict.toUpperCase(),
      feedback,
      timestamp: Date.now(),
    };

    // Move from pending to completed
    state.pendingReviewers = state.pendingReviewers.filter(id => id !== reviewerAgentId);
    if (!state.completedReviewers.includes(reviewerAgentId)) {
      state.completedReviewers.push(reviewerAgentId);
    }

    logger.info(`[ReviewCycle] ${reviewerAgentId} verdict: ${verdict} for ${ticketId}:${phase} round ${state.currentRound} (${state.pendingReviewers.length} pending)`);

    // Check if all reviewers have responded for this round
    if (state.pendingReviewers.length === 0) {
      return await this._evaluateRound(state);
    }

    // More reviewers still pending
    state.updatedAt = Date.now();
    await this._saveCycleState(ticketId, phase, state);
    return {
      ...state,
      action: 'CONTINUE_ROUND',
      nextReviewer: state.pendingReviewers[0],
      message: `Waiting for ${state.pendingReviewers.length} more reviewer(s)`,
    };
  }

  /**
   * Get the next reviewer who needs to review this round
   * @param {string} ticketId
   * @param {number} phase
   * @returns {Promise<string|null>} Next reviewer agent ID, or null if round complete
   */
  async getNextReviewer(ticketId, phase) {
    const state = await this.getCycleState(ticketId, phase);
    if (!state) return null;
    if (state.pendingReviewers.length === 0) return null;
    return state.pendingReviewers[0];
  }

  /**
   * Check if a review cycle is active for this ticket+phase
   * @param {string} ticketId
   * @param {number} phase
   * @returns {Promise<boolean>}
   */
  async isActive(ticketId, phase) {
    const state = await this.getCycleState(ticketId, phase);
    if (!state) return false;
    return state.state === CYCLE_STATES.IN_PROGRESS || state.state === CYCLE_STATES.AWAITING_REVISION;
  }

  /**
   * Select reviewers for a phase based on the ticket's domain
   * Excludes the executor and picks relevant specialists.
   * @param {Object[]} allAgents - All registered agents
   * @param {string} executorAgentId - The agent who executed (exclude from review)
   * @param {Object} analysis - CapabilityMatcher analysis with capabilities
   * @returns {string[]} Array of reviewer agent IDs
   */
  selectReviewers(allAgents, executorAgentId, analysis = {}) {
    // Exclude executor and project-manager (PM manages the cycle, doesn't review)
    const candidates = allAgents.filter(a => 
      a.agent_id !== executorAgentId &&
      a.agent_id !== 'project-manager'
    );

    if (candidates.length === 0) return [];

    // Sort by relevance to ticket capabilities
    const ticketCaps = analysis.capabilities || [];
    const scored = candidates.map(agent => {
      const agentCaps = Array.isArray(agent.capabilities) ? agent.capabilities : [];
      const overlap = ticketCaps.filter(c => agentCaps.includes(c)).length;
      return { agent, score: overlap };
    });

    // Sort by relevance (highest overlap first), then take min-max reviewers
    scored.sort((a, b) => b.score - a.score);
    
    const count = Math.min(
      Math.max(this.minReviewers, Math.min(scored.length, this.maxReviewers)),
      scored.length
    );

    const selected = scored.slice(0, count).map(s => s.agent.agent_id);
    logger.info(`[ReviewCycle] Selected ${selected.length} reviewers: [${selected.join(', ')}] (from ${candidates.length} candidates)`);
    return selected;
  }

  /**
   * Build the review prompt that tells a reviewer what to do
   * Includes handover context and instructions to read/write handovers.
   * @param {Object} cycleState - Current cycle state
   * @param {string} reviewerAgentId - This reviewer's ID
   * @param {string} phaseOutput - The primary agent's work output
   * @returns {string} Review prompt block
   */
  buildReviewPrompt(cycleState, reviewerAgentId, phaseOutput) {
    const round = cycleState.currentRound;
    const totalReviewers = cycleState.reviewerAgentIds.length;
    const completedThisRound = cycleState.completedReviewers.length;

    // Gather previous round feedback for context
    let previousFeedback = '';
    if (round > 1) {
      const prevRoundVerdicts = [];
      for (const [agentId, rounds] of Object.entries(cycleState.verdicts)) {
        for (const [roundNum, verdict] of Object.entries(rounds)) {
          if (parseInt(roundNum) === round - 1) {
            prevRoundVerdicts.push(`**${agentId}:** ${verdict.verdict} — ${verdict.feedback}`);
          }
        }
      }
      if (prevRoundVerdicts.length > 0) {
        previousFeedback = `\n\n## Previous Round Feedback (Round ${round - 1})\n${prevRoundVerdicts.join('\n\n')}`;
      }
    }

    // Gather THIS round's feedback from reviewers who already went
    let currentRoundFeedback = '';
    const currentVerdicts = [];
    for (const [agentId, rounds] of Object.entries(cycleState.verdicts)) {
      if (rounds[round]) {
        currentVerdicts.push(`**${agentId}:** ${rounds[round].verdict} — ${rounds[round].feedback}`);
      }
    }
    if (currentVerdicts.length > 0) {
      currentRoundFeedback = `\n\n## This Round's Reviews So Far (Round ${round})\n${currentVerdicts.join('\n\n')}`;
    }

    return `═══════════════════════════════════════════
🔄 REVIEW CYCLE — Round ${round}/${cycleState.maxRounds}
═══════════════════════════════════════════

You are **${reviewerAgentId}**, participating in a **consensus review cycle**.

**Review Round:** ${round} of ${cycleState.maxRounds}
**Executor:** ${cycleState.executorAgentId}
**Reviewers:** ${cycleState.reviewerAgentIds.join(', ')}
**Your Position:** Reviewer ${completedThisRound + 1} of ${totalReviewers}
${previousFeedback}${currentRoundFeedback}

═══════════════════════════════════════════
YOUR REVIEW TASKS
═══════════════════════════════════════════

1. **READ** the full thread above — the original ticket, the plan, and the execution output
2. **READ** the \`developer-handovers/\` folder for any handover documents from this phase
3. **EVALUATE** the work against the original ticket requirements
4. **OBSERVE** what other reviewers said (above) — build on their feedback, don't repeat it
5. **POST YOUR VERDICT** using one of the formats below
6. **WRITE/UPDATE** the phase handover in \`developer-handovers/\` with your observations

═══════════════════════════════════════════
VERDICT FORMAT (pick ONE)
═══════════════════════════════════════════

**APPROVE** — The work is complete and meets requirements:
\`\`\`
## Review Verdict: APPROVE
**Reviewer:** ${reviewerAgentId}
**Round:** ${round}
The deliverable is [specific praise]. It addresses [which requirements].
[Any minor suggestions for future improvement, not blocking]
\`\`\`

**REVISE** — The work needs specific changes before it can pass:
\`\`\`
## Review Verdict: REVISE
**Reviewer:** ${reviewerAgentId}
**Round:** ${round}
### Issues Found
1. [Specific issue — what's wrong, where, and how to fix it]
2. [Another specific issue]
### Required Changes
- [Concrete action item the executor must address]
\`\`\`

═══════════════════════════════════════════
HANDOVER PROTOCOL
═══════════════════════════════════════════

After posting your verdict, **write or update** the review handover file:
\`developer-handovers/REVIEW_CYCLE_ROUND_${String(round).padStart(2, '0')}_${reviewerAgentId}.md\`

Include:
- What you reviewed
- Your verdict and reasoning
- Observations for the next reviewer or the executor
- Any patterns you noticed across multiple reviews

**READ** these handover files BEFORE starting your review:
- \`developer-handovers/REVIEW_CYCLE_ROUND_*.md\` (all previous review handovers)
- \`developer-handovers/EXECUTION_*.md\` (the executor's handover)

═══════════════════════════════════════════
IMPORTANT
═══════════════════════════════════════════

- Be SPECIFIC in feedback — vague comments waste everyone's time
- Build on other reviewers' observations — don't repeat what they said
- This cycle continues until ALL reviewers APPROVE or ${cycleState.maxRounds} rounds pass
- The executor will see YOUR feedback and must address it in the next round
═══════════════════════════════════════════`;
  }

  /**
   * Build the revision prompt for the executor after reviewers request changes
   * @param {Object} cycleState - Current cycle state  
   * @param {Object[]} revisionRequests - Array of { agentId, feedback } from REVISE verdicts
   * @returns {string} Revision prompt block
   */
  buildRevisionPrompt(cycleState, revisionRequests) {
    const feedbackList = revisionRequests
      .map(r => `### ${r.agentId}\n${r.feedback}`)
      .join('\n\n');

    return `═══════════════════════════════════════════
🔧 REVISION REQUESTED — Round ${cycleState.currentRound}/${cycleState.maxRounds}
═══════════════════════════════════════════

Your previous work was reviewed by ${cycleState.reviewerAgentIds.length} agents.
**${revisionRequests.length} reviewer(s) requested changes.**

═══════════════════════════════════════════
FEEDBACK FROM REVIEWERS
═══════════════════════════════════════════

${feedbackList}

═══════════════════════════════════════════
YOUR TASKS
═══════════════════════════════════════════

1. **READ** each reviewer's feedback carefully
2. **READ** the review handovers in \`developer-handovers/REVIEW_CYCLE_ROUND_*.md\`
3. **ADDRESS** each specific issue raised
4. **UPDATE** your deliverable with the changes
5. **UPDATE** your handover in \`developer-handovers/\` explaining what you changed
6. **POST** your updated deliverable with a clear "Changes Made" section

Your response must include:
## Changes Made (Round ${cycleState.currentRound} Revision)
- [Change 1 — addresses [reviewer]'s concern about X]
- [Change 2 — addresses [reviewer]'s request for Y]

Then the full updated deliverable below.

═══════════════════════════════════════════
HANDOVER UPDATE
═══════════════════════════════════════════

Update your execution handover file:
\`developer-handovers/EXECUTION_REVISION_${String(cycleState.currentRound).padStart(2, '0')}.md\`

Include what changes you made and why, so reviewers can verify in the next round.
═══════════════════════════════════════════`;
  }

  /**
   * Generate a Plane comment summarizing the review cycle status
   * @param {Object} cycleState - Current cycle state
   * @returns {string} Formatted comment
   */
  formatCycleComment(cycleState) {
    const verdictEmoji = { APPROVE: '✅', REVISE: '🔧', CONCERN: '⚠️' };
    
    let verdictSummary = '';
    for (const [agentId, rounds] of Object.entries(cycleState.verdicts)) {
      const latestRound = Math.max(...Object.keys(rounds).map(Number));
      const latest = rounds[latestRound];
      const emoji = verdictEmoji[latest.verdict] || '❓';
      verdictSummary += `\n- ${emoji} **${agentId}:** ${latest.verdict}`;
      if (latest.feedback) {
        verdictSummary += ` — ${latest.feedback.substring(0, 200)}`;
      }
    }

    const stateEmoji = {
      [CYCLE_STATES.IN_PROGRESS]: '🔄',
      [CYCLE_STATES.AWAITING_REVISION]: '🔧',
      [CYCLE_STATES.CONSENSUS_REACHED]: '✅',
      [CYCLE_STATES.MAX_ROUNDS_HIT]: '⏱️',
    };

    return `${stateEmoji[cycleState.state] || '❓'} **Review Cycle — Round ${cycleState.currentRound}/${cycleState.maxRounds}**

**Status:** ${cycleState.state}
**Executor:** ${cycleState.executorAgentId}
**Reviewers:** ${cycleState.reviewerAgentIds.join(', ')}

**Verdicts:**${verdictSummary || '\n- (no verdicts yet)'}

${cycleState.state === CYCLE_STATES.CONSENSUS_REACHED ? '🎉 **All reviewers approved! Phase advancing.**' : ''}
${cycleState.state === CYCLE_STATES.MAX_ROUNDS_HIT ? `⏱️ **Max rounds (${cycleState.maxRounds}) reached. Advancing with best effort.**` : ''}

---
*Phase Review Cycle v1.0*`;
  }

  /**
   * Parse a reviewer's response to extract their verdict
   * @param {string} responseText - The reviewer's full response
   * @returns {{ verdict: string, feedback: string }}
   */
  parseVerdict(responseText) {
    if (!responseText) return { verdict: 'APPROVE', feedback: 'No response provided' };
    
    const lower = responseText.toLowerCase();
    
    // Check for explicit verdict markers
    if (lower.includes('review verdict: revise') || lower.includes('verdict: revise')) {
      return { verdict: 'REVISE', feedback: this._extractFeedback(responseText, 'REVISE') };
    }
    if (lower.includes('review verdict: approve') || lower.includes('verdict: approve')) {
      return { verdict: 'APPROVE', feedback: this._extractFeedback(responseText, 'APPROVE') };
    }
    
    // Fallback: look for strong signals
    const reviseSignals = ['needs revision', 'must be revised', 'requires changes', 'issues found', 'required changes'];
    const approveSignals = ['approved', 'looks good', 'well done', 'complete and meets', 'passes review'];
    
    const hasRevise = reviseSignals.some(s => lower.includes(s));
    const hasApprove = approveSignals.some(s => lower.includes(s));
    
    if (hasRevise && !hasApprove) {
      return { verdict: 'REVISE', feedback: responseText.substring(0, 2000) };
    }
    
    // Default to APPROVE if no clear signal (don't block on ambiguous reviews)
    return { verdict: 'APPROVE', feedback: responseText.substring(0, 2000) };
  }

  // =====================================================================
  // PRIVATE METHODS
  // =====================================================================

  /**
   * Evaluate the completed round — check for consensus or trigger next round
   * @private
   */
  async _evaluateRound(state) {
    const round = state.currentRound;
    
    // Collect all verdicts for this round
    const roundVerdicts = [];
    for (const [agentId, rounds] of Object.entries(state.verdicts)) {
      if (rounds[round]) {
        roundVerdicts.push({
          agentId,
          verdict: rounds[round].verdict,
          feedback: rounds[round].feedback,
        });
      }
    }

    // Save round to history
    state.roundHistory.push({
      round,
      verdicts: roundVerdicts,
      timestamp: Date.now(),
    });

    // Check for consensus (all APPROVE)
    const allApproved = roundVerdicts.every(v => v.verdict === 'APPROVE');
    const revisionRequests = roundVerdicts.filter(v => v.verdict === 'REVISE');

    if (allApproved) {
      // 🎉 Consensus reached!
      state.state = CYCLE_STATES.CONSENSUS_REACHED;
      state.updatedAt = Date.now();
      await this._saveCycleState(state.ticketId, state.phase, state);
      
      logger.info(`[ReviewCycle] ✅ CONSENSUS for ${state.ticketId}:${state.phase} — all ${roundVerdicts.length} reviewers approved in round ${round}`);
      return {
        ...state,
        action: 'CONSENSUS',
        message: `All ${roundVerdicts.length} reviewers approved. Phase output accepted.`,
      };
    }

    // Check max rounds
    if (round >= state.maxRounds) {
      state.state = CYCLE_STATES.MAX_ROUNDS_HIT;
      state.updatedAt = Date.now();
      await this._saveCycleState(state.ticketId, state.phase, state);
      
      logger.warn(`[ReviewCycle] ⏱️ MAX ROUNDS for ${state.ticketId}:${state.phase} — ${revisionRequests.length} still requesting changes after ${round} rounds`);
      return {
        ...state,
        action: 'MAX_ROUNDS',
        message: `Max rounds (${state.maxRounds}) reached. ${revisionRequests.length} reviewer(s) still want changes. Advancing with best effort.`,
        revisionRequests,
      };
    }

    // Revisions requested — route back to executor
    state.state = CYCLE_STATES.AWAITING_REVISION;
    state.updatedAt = Date.now();
    await this._saveCycleState(state.ticketId, state.phase, state);
    
    logger.info(`[ReviewCycle] 🔧 REVISION for ${state.ticketId}:${state.phase} round ${round} — ${revisionRequests.length} reviewer(s) want changes`);
    return {
      ...state,
      action: 'REVISE',
      message: `${revisionRequests.length} reviewer(s) requested changes. Routing back to executor.`,
      revisionRequests,
    };
  }

  /**
   * Start a new round after the executor has addressed revision feedback
   * @param {string} ticketId
   * @param {number} phase
   * @returns {Promise<Object>} Updated cycle state
   */
  async startNextRound(ticketId, phase) {
    const state = await this.getCycleState(ticketId, phase);
    if (!state) throw new Error(`No review cycle for ${ticketId}:${phase}`);

    state.currentRound += 1;
    state.state = CYCLE_STATES.IN_PROGRESS;
    state.pendingReviewers = [...state.reviewerAgentIds];
    state.completedReviewers = [];
    state.updatedAt = Date.now();

    await this._saveCycleState(ticketId, phase, state);
    logger.info(`[ReviewCycle] Starting round ${state.currentRound} for ${ticketId}:${phase}`);
    return state;
  }

  /**
   * Save cycle state to Redis
   * @private
   */
  async _saveCycleState(ticketId, phase, state) {
    try {
      const key = `qm:review_cycle:${ticketId}:${phase}`;
      await this.redis.set(key, JSON.stringify(state), 'EX', 86400); // 24h TTL
    } catch (err) {
      logger.error(`[ReviewCycle] Failed to save cycle state for ${ticketId}:${phase}: ${err.message}`);
    }
  }

  /**
   * Extract feedback text from a review response
   * @private
   */
  _extractFeedback(text, verdict) {
    // Try to extract the section after "Issues Found" or "Required Changes"
    const issuesMatch = text.match(/###?\s*Issues Found([\s\S]*?)(?=###|\n---|\n##|$)/i);
    const changesMatch = text.match(/###?\s*Required Changes([\s\S]*?)(?=###|\n---|\n##|$)/i);
    
    const parts = [];
    if (issuesMatch) parts.push(issuesMatch[1].trim());
    if (changesMatch) parts.push(changesMatch[1].trim());
    
    if (parts.length > 0) return parts.join('\n\n');
    
    // Fallback: return everything after the verdict line
    const verdictLine = text.indexOf(`Verdict: ${verdict}`);
    if (verdictLine > -1) {
      return text.substring(verdictLine + 20).trim().substring(0, 2000);
    }
    
    return text.substring(0, 2000);
  }
}

module.exports = PhaseReviewCycle;
module.exports.CYCLE_STATES = CYCLE_STATES;
