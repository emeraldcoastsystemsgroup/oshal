/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * StuckAgentWatchdog — Intelligent Stuck Agent Detection & Recovery
 * 
 * @module queue-manager/StuckAgentWatchdog
 * @description Runs every 15 minutes to detect agents that are stuck (busy with no
 * activity) and recovers them by:
 * 1. Force-releasing the agent back to idle state
 * 2. Posting a comment on the active Plane ticket explaining the timeout
 * 3. Resetting the ticket back to "Todo" state so the QM picks it up again
 * 
 * ## Detection Logic (Issue #001)
 * An agent is STUCK if:
 * - It has been busy for > 60 minutes (STUCK_THRESHOLD), AND
 * - Its Redis activity heartbeat has expired (no activity in 60 minutes)
 * 
 * An agent is ACTIVE (leave alone) if:
 * - It has a recent activity heartbeat (still doing real work), OR
 * - It has been busy for < 60 minutes (within normal range)
 * 
 * ## Ticket Requeue
 * When a stuck agent is detected, the associated ticket MUST be requeued:
 * - Post a comment: "Agent {agentId} timed out after {N}min — requeuing"
 * - Reset ticket state to "Todo" via PlaneDatabase
 * - Clear agent busy status in AgentRegistry
 * 
 * Created: 2026-02-24 — Issue #001, Swarm Improvement Sprint
 */

const logger = require('../../utils/logger');

// How often to run the watchdog check
const WATCHDOG_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * @description Background watchdog (the default export of this module) that
 * periodically reconciles the agent fleet against a "stuck" definition so a
 * single hung agent cannot silently strand its ticket. The class exists to make
 * recovery self-healing and operator-free: on a fixed cadence it detects agents
 * that are nominally busy but have gone quiet, force-releases them, requeues the
 * abandoned ticket for reprocessing, and records the event for observability —
 * all failures are treated as non-fatal so the swarm keeps moving.
 */
class StuckAgentWatchdog {
  /**
   * @param {Object} opts
   * @param {Object} opts.agentRegistry - AgentRegistry instance
   * @param {Object} opts.planeDatabase - PlaneDatabase instance (for ticket requeue)
   * @param {Object} opts.agentMetrics - AgentMetricsService instance (for recording)
   * @param {Object} [opts.redis] - Redis client (for direct ticket state updates)
   */
  constructor(opts = {}) {
    this.agentRegistry = opts.agentRegistry;
    this.planeDatabase = opts.planeDatabase;
    this.agentMetrics = opts.agentMetrics;
    this.redis = opts.redis;
    this._interval = null;
    this.isRunning = false;
    this._recoveredCount = 0;
  }

  /**
   * Start the watchdog — runs checkAndRecover() every 15 minutes
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    logger.info('[StuckAgentWatchdog] Started — checking every 15 minutes for stuck agents');

    // Run immediately on start, then every 15 minutes
    this.checkAndRecover().catch(err => {
      logger.warn(`[StuckAgentWatchdog] Initial check failed (non-fatal): ${err.message}`);
    });

    this._interval = setInterval(() => {
      this.checkAndRecover().catch(err => {
        logger.error(`[StuckAgentWatchdog] Check failed: ${err.message}`, { stack: err.stack });
      });
    }, WATCHDOG_INTERVAL_MS);
  }

  /**
   * Stop the watchdog
   */
  stop() {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
    this.isRunning = false;
    logger.info(`[StuckAgentWatchdog] Stopped (recovered ${this._recoveredCount} agents total)`);
  }

  /**
   * Main watchdog cycle: detect stuck agents and recover them.
   * Called every 15 minutes by the interval, and once on startup.
   * 
   * @returns {Promise<{checked: number, recovered: number, errors: number}>}
   */
  async checkAndRecover() {
    logger.debug('[StuckAgentWatchdog.checkAndRecover] START');
    const results = { checked: 0, recovered: 0, errors: 0 };

    try {
      if (!this.agentRegistry) {
        logger.warn('[StuckAgentWatchdog.checkAndRecover] No AgentRegistry — skipping');
        return results;
      }

      // Step 1: Find all stuck agents
      const stuckAgents = await this.agentRegistry.checkStuckAgents();
      results.checked = stuckAgents.length;

      if (stuckAgents.length === 0) {
        logger.debug('[StuckAgentWatchdog.checkAndRecover] No stuck agents found');
        return results;
      }

      logger.warn(`[StuckAgentWatchdog.checkAndRecover] Found ${stuckAgents.length} stuck agents — beginning recovery`);

      // Step 2: Recover each stuck agent
      for (const stuckAgent of stuckAgents) {
        try {
          await this._recoverAgent(stuckAgent);
          results.recovered++;
          this._recoveredCount++;
        } catch (err) {
          logger.error(`[StuckAgentWatchdog.checkAndRecover] Recovery failed for ${stuckAgent.agentId}`, {
            error: err.message,
            stack: err.stack,
            agentId: stuckAgent.agentId,
            ticketId: stuckAgent.activeTicketId,
          });
          results.errors++;
        }
      }

      logger.info(`[StuckAgentWatchdog.checkAndRecover] COMPLETE — recovered ${results.recovered}/${results.checked} agents (${results.errors} errors)`);
      return results;
    } catch (err) {
      logger.error('[StuckAgentWatchdog.checkAndRecover] ERROR', { error: err.message, stack: err.stack });
      return results;
    }
  }

  /**
   * Recover a single stuck agent:
   * 1. Force-release the agent (clear busy status)
   * 2. Post a comment on the Plane ticket
   * 3. Reset ticket to Todo state for reprocessing
   * 
   * @param {Object} stuckAgent - { agentId, activeTicketId, busyMinutes, reason }
   * @private
   */
  async _recoverAgent(stuckAgent) {
    const { agentId, activeTicketId, busyMinutes, reason } = stuckAgent;
    logger.info(`[StuckAgentWatchdog._recoverAgent] Recovering ${agentId} (busy ${busyMinutes}min, ticket: ${activeTicketId || 'none'})`);

    // Step 1: Force-release the agent
    const releaseResult = await this.agentRegistry.forceRelease(agentId, 'stuck_timeout');
    if (!releaseResult.success) {
      logger.warn(`[StuckAgentWatchdog._recoverAgent] Force-release failed for ${agentId} — may have already been released`);
      return;
    }

    logger.info(`[StuckAgentWatchdog._recoverAgent] ✅ Agent ${agentId} released from stuck state`);

    // Step 2: If there's an active ticket, requeue it
    // _requeueTicket handles both PlaneDatabase and Redis fallback internally
    if (activeTicketId) {
      await this._requeueTicket(activeTicketId, agentId, busyMinutes);
    }

    // Step 3: Record the recovery in metrics
    if (this.agentMetrics) {
      try {
        await this.agentMetrics.recordEscalation(agentId, activeTicketId || 'unknown', `stuck_timeout_${busyMinutes}min`);
      } catch (e) { /* non-fatal */ }
    }
  }

  /**
   * Requeue a ticket that was abandoned by a stuck agent.
   * Posts a comment explaining the timeout, then resets to Todo state.
   * 
   * @param {string} ticketId - Plane ticket ID
   * @param {string} agentId - Agent that was stuck
   * @param {number} busyMinutes - How long the agent was stuck
   * @private
   */
  async _requeueTicket(ticketId, agentId, busyMinutes) {
    logger.info(`[StuckAgentWatchdog._requeueTicket] Requeuing ticket ${ticketId} (abandoned by ${agentId} after ${busyMinutes}min)`);

    try {
      // Post a comment on the ticket explaining what happened
      const comment = `⚠️ **Agent Timeout — Ticket Requeued**

**Agent:** \`${agentId}\`
**Stuck Duration:** ${busyMinutes} minutes
**Detection:** No activity heartbeat for ${busyMinutes} minutes (threshold: 60min)

The agent was processing this ticket but stopped producing output. This could indicate:
- The agent's container crashed or restarted
- The LLM call timed out
- The agent entered an infinite loop

**Action Taken:** Agent released, ticket reset to Todo for reprocessing.
The Queue Manager will pick this up on the next polling cycle.

---
*StuckAgentWatchdog v1.0 — Automatic Recovery*`;

      // Post comment via PlaneDatabase
      if (this.planeDatabase && typeof this.planeDatabase.postComment === 'function') {
        await this.planeDatabase.postComment(ticketId, comment);
        logger.info(`[StuckAgentWatchdog._requeueTicket] Posted timeout comment on ticket ${ticketId}`);
      }

      // Reset ticket state to Todo
      if (this.planeDatabase && typeof this.planeDatabase.resetTicketToTodo === 'function') {
        await this.planeDatabase.resetTicketToTodo(ticketId);
        logger.info(`[StuckAgentWatchdog._requeueTicket] ✅ Ticket ${ticketId} reset to Todo — will be reprocessed`);
      } else if (this.redis) {
        // Fallback: use Redis to signal requeue if PlaneDatabase method not available
        await this.redis.lpush('qm:requeue_tickets', JSON.stringify({
          ticketId,
          reason: 'stuck_agent_timeout',
          agentId,
          busyMinutes,
          requeuedAt: new Date().toISOString(),
        }));
        logger.info(`[StuckAgentWatchdog._requeueTicket] ✅ Ticket ${ticketId} pushed to requeue list`);
      }

      // Clear any phase tracking for this ticket so it starts fresh
      if (this.redis) {
        try {
          // Clear phase state so ticket starts from INTAKE again
          await this.redis.del(`qm:ticket_phase:${ticketId}`);
          // Clear round orchestration state
          for (let phase = 1; phase <= 7; phase++) {
            await this.redis.del(`qm:phase_rounds:${ticketId}:${phase}`);
          }
          logger.debug(`[StuckAgentWatchdog._requeueTicket] Cleared phase state for ticket ${ticketId}`);
        } catch (e) {
          logger.warn(`[StuckAgentWatchdog._requeueTicket] Failed to clear phase state: ${e.message}`);
        }
      }
    } catch (err) {
      logger.error(`[StuckAgentWatchdog._requeueTicket] ERROR requeuing ticket ${ticketId}`, {
        error: err.message,
        stack: err.stack,
        ticketId,
        agentId,
      });
      // Don't rethrow — agent was already released, ticket requeue failure is non-fatal
    }
  }

  /**
   * Get watchdog statistics
   * @returns {Object} Stats about watchdog operation
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      totalRecovered: this._recoveredCount,
      intervalMs: WATCHDOG_INTERVAL_MS,
      nextCheckIn: this._interval ? `${Math.round(WATCHDOG_INTERVAL_MS / 60000)} minutes` : 'not running',
    };
  }
}

module.exports = StuckAgentWatchdog;
