/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * CostTrackingService — GAP L: Bedrock Token Usage Tracking
 * 
 * Tracks LLM token consumption per agent, per ticket, and per phase.
 * Stores in Redis ZSETs with 24h rolling window (same pattern as AgentMetricsService).
 * 
 * Metrics tracked:
 * - Input tokens per call
 * - Output tokens per call  
 * - Total cost estimate (based on Bedrock pricing)
 * - Per-agent cumulative usage
 * - Per-ticket cumulative usage
 * 
 * Created: 2026-02-19 — Sprint 3, GAP L
 */

const logger = require('../../utils/logger');

// Approximate Bedrock Claude pricing (per 1K tokens) — GovCloud
const PRICING = {
  'claude-sonnet': { input: 0.003, output: 0.015 },
  'claude-haiku': { input: 0.00025, output: 0.00125 },
  default: { input: 0.003, output: 0.015 },
};

/**
 * @description Service that meters LLM token spend so operators can see, in
 * near real time, what each agent and ticket is costing. It exists because
 * Bedrock bills opaquely per token; surfacing a running cost estimate lets the
 * swarm enforce budgets and spot runaway phases before they become expensive.
 * Backed by Redis ZSETs on a 24h rolling window (mirroring AgentMetricsService),
 * with an in-memory session tally as a fallback when Redis is unavailable.
 */
class CostTrackingService {
  /**
   * @description Wire up the cost tracker against an optional Redis client.
   * When Redis is absent the service still works, degrading to in-memory
   * session-only totals so callers never have to special-case its absence.
   * @param {Object} [redis] - Redis client used for durable, windowed tracking; when falsy the service runs in session-only mode.
   */
  constructor(redis) {
    this.redis = redis;
    this.prefix = 'cost:';
    this.windowMs = 24 * 60 * 60 * 1000; // 24h rolling window
    
    // In-memory session totals
    this.sessionTotals = {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      callCount: 0,
    };

    logger.info('[CostTracking] Service initialized');
  }

  /**
   * Record a Bedrock API call's token usage
   * @param {Object} params
   * @param {string} params.agentId - Agent that made the call
   * @param {string} params.ticketId - Ticket being processed
   * @param {number} params.inputTokens - Input/prompt tokens
   * @param {number} params.outputTokens - Output/completion tokens
   * @param {string} [params.model] - Model identifier
   * @param {number} [params.phase] - Current phase (1-7)
   */
  async recordUsage(params) {
    const { agentId, ticketId, inputTokens = 0, outputTokens = 0, model = 'claude-sonnet', phase = 0 } = params;
    const now = Date.now();
    
    // Calculate estimated cost
    const pricing = PRICING[model] || PRICING.default;
    const cost = (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output;

    // Update session totals
    this.sessionTotals.inputTokens += inputTokens;
    this.sessionTotals.outputTokens += outputTokens;
    this.sessionTotals.estimatedCost += cost;
    this.sessionTotals.callCount++;

    if (!this.redis) return;

    try {
      const entry = JSON.stringify({
        agentId, ticketId, inputTokens, outputTokens, cost, model, phase, ts: now,
      });

      // Per-agent cost tracking
      await this.redis.zadd(`${this.prefix}agent:${agentId}`, now, entry);

      // Per-ticket cost tracking
      if (ticketId) {
        await this.redis.zadd(`${this.prefix}ticket:${ticketId}`, now, entry);
      }

      // Global cost tracking
      await this.redis.zadd(`${this.prefix}global`, now, entry);

      // Cleanup old entries (outside 24h window)
      const cutoff = now - this.windowMs;
      await this.redis.zremrangebyscore(`${this.prefix}agent:${agentId}`, '-inf', cutoff);
      if (ticketId) {
        await this.redis.zremrangebyscore(`${this.prefix}ticket:${ticketId}`, '-inf', cutoff);
      }
      await this.redis.zremrangebyscore(`${this.prefix}global`, '-inf', cutoff);

      logger.debug(`[CostTracking] Recorded: ${agentId} ${inputTokens}+${outputTokens} tokens, $${cost.toFixed(6)}`);
    } catch (err) {
      logger.warn(`[CostTracking] Redis write failed: ${err.message}`);
    }
  }

  /**
   * Get cost summary for an agent (24h window)
   */
  async getAgentCosts(agentId) {
    if (!this.redis) return this._emptyCostSummary(agentId);

    try {
      const cutoff = Date.now() - this.windowMs;
      const entries = await this.redis.zrangebyscore(`${this.prefix}agent:${agentId}`, cutoff, '+inf');
      return this._summarizeEntries(entries, agentId);
    } catch {
      return this._emptyCostSummary(agentId);
    }
  }

  /**
   * Get cost summary for a ticket
   */
  async getTicketCosts(ticketId) {
    if (!this.redis) return this._emptyCostSummary(ticketId);

    try {
      const entries = await this.redis.zrangebyscore(`${this.prefix}ticket:${ticketId}`, '-inf', '+inf');
      return this._summarizeEntries(entries, ticketId);
    } catch {
      return this._emptyCostSummary(ticketId);
    }
  }

  /**
   * Get global cost summary (24h)
   */
  async getGlobalCosts() {
    if (!this.redis) {
      return { ...this.sessionTotals, period: 'session' };
    }

    try {
      const cutoff = Date.now() - this.windowMs;
      const entries = await this.redis.zrangebyscore(`${this.prefix}global`, cutoff, '+inf');
      const summary = this._summarizeEntries(entries, 'global');

      // Per-agent breakdown
      const byAgent = {};
      for (const raw of entries) {
        try {
          const e = JSON.parse(raw);
          if (!byAgent[e.agentId]) {
            byAgent[e.agentId] = { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
          }
          byAgent[e.agentId].inputTokens += e.inputTokens || 0;
          byAgent[e.agentId].outputTokens += e.outputTokens || 0;
          byAgent[e.agentId].cost += e.cost || 0;
          byAgent[e.agentId].calls++;
        } catch { /* skip */ }
      }

      summary.byAgent = byAgent;
      return summary;
    } catch {
      return { ...this.sessionTotals, period: 'session' };
    }
  }

  /**
   * @description Fold a list of raw Redis ZSET entries into a single aggregate
   * cost summary. Centralizes the parsing/rounding logic so every public getter
   * returns an identically shaped result and malformed entries are skipped
   * rather than aborting the whole summary.
   * @param {string[]} entries - JSON-encoded usage records pulled from a ZSET.
   * @param {string} label - Identifier (agent/ticket/global) echoed back on the summary.
   * @returns {Object} Aggregated totals: tokens, rounded/ formatted cost, call count, and period.
   */
  _summarizeEntries(entries, label) {
    let inputTokens = 0, outputTokens = 0, totalCost = 0, calls = 0;

    for (const raw of entries) {
      try {
        const e = JSON.parse(raw);
        inputTokens += e.inputTokens || 0;
        outputTokens += e.outputTokens || 0;
        totalCost += e.cost || 0;
        calls++;
      } catch { /* skip */ }
    }

    return {
      label,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      estimatedCost: Math.round(totalCost * 1000000) / 1000000, // 6 decimal places
      estimatedCostFormatted: `$${totalCost.toFixed(4)}`,
      calls,
      period: '24h',
    };
  }

  /**
   * @description Produce a zeroed-out summary for the case where there is no
   * data (no Redis, or a read failure). Returning a well-formed empty summary
   * keeps callers free of null checks and gives the UI a stable shape to render.
   * @param {string} label - Identifier echoed back on the empty summary.
   * @returns {Object} A summary object with all counters at zero.
   */
  _emptyCostSummary(label) {
    return { label, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCost: 0, calls: 0, period: '24h' };
  }

  /**
   * @description Expose the process-lifetime running totals accumulated in
   * memory, independent of the 24h Redis window. Useful for a quick
   * "since startup" view and as the source of truth when Redis is unavailable.
   * Returns a copy so callers cannot mutate the internal tally.
   * @returns {Object} A shallow copy of the in-memory session totals.
   */
  getSessionTotals() {
    return { ...this.sessionTotals };
  }
}

module.exports = CostTrackingService;
