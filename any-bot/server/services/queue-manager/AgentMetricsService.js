/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

'use strict';

/**
 * AgentMetricsService — PHASE_21 GAP B + Issue #008 + Issue #009 + PHASE_67
 * 
 * Tracks per-agent performance metrics in Redis with 24h rolling window:
 * - Response times (ms) per phase
 * - Gate pass/fail counts
 * - Bid win/loss counts
 * - Escalation counts
 * - Tickets completed/failed
 * - LLM token costs (input/output tokens + cost_usd) — Issue #008
 * 
 * PHASE_67: Per-ticket and per-project cost rollup:
 * - Per-ticket cost storage with phase breakdown
 * - Subtask cost rollup to parent ticket
 * - Per-project cost aggregation
 * 
 * Issue #009: On startup, pre-populates metrics index with ALL agents from
 * ai-lab/bot-personas/ so they appear in the dashboard even before first task.
 * 
 * Data stored in Redis sorted sets (ZADD) with timestamp scores for rolling windows.
 * Exposed via GET /api/v1/metrics/agents
 * 
 * Redis key patterns:
 *   metrics:agent:{agentId}:response_times   — ZSET (score=timestamp, member=JSON{phase,ms,ticketId})
 *   metrics:agent:{agentId}:gate_results     — ZSET (score=timestamp, member=JSON{phase,passed,ticketId})
 *   metrics:agent:{agentId}:bid_results      — ZSET (score=timestamp, member=JSON{won,ticketId,confidence})
 *   metrics:agent:{agentId}:escalations      — ZSET (score=timestamp, member=JSON{ticketId,reason})
 *   metrics:agent:{agentId}:completions      — ZSET (score=timestamp, member=JSON{ticketId,success,phase})
 *   metrics:agent:{agentId}:costs            — ZSET (score=timestamp, member=JSON{ticketId,input_tokens,output_tokens,cost_usd,model})
 *   metrics:agents:index                     — SET of all agent IDs that have metrics
 *   metrics:agent:{agentId}:last_seen        — STRING ISO timestamp of last activity
 *   metrics:ticket:{ticketId}:cost           — HASH {totalCost, totalTokens, inputTokens, outputTokens, phases JSON, updatedAt}
 *   metrics:ticket:{ticketId}:parent         — STRING parent ticket ID (for rollup)
 *   metrics:project:{projectId}:cost         — HASH {totalCost, totalTokens, ticketCount, updatedAt}
 *   metrics:project:{projectId}:tickets      — SET of ticket IDs in this project
 */

const logger = require('../../utils/logger');

const METRICS_PREFIX = 'metrics:agent:';
const AGENTS_INDEX_KEY = 'metrics:agents:index';
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const CLEANUP_BATCH_SIZE = 100;

/**
 * @description Service that captures and aggregates per-agent and per-ticket/project
 * performance and cost telemetry in Redis. It exists so the dashboard and Task Explorer
 * can surface live operational health (response latency, gate quality, bid success,
 * escalations, throughput) and LLM spend without coupling the queue/processing code to
 * any storage or reporting concerns. Recording calls are intentionally best-effort
 * (failures are swallowed and logged) so metrics never block or break task processing.
 * Agent-level events use a 24h rolling window via sorted sets, while ticket/project
 * cost rollups persist until explicitly cleared.
 */
class AgentMetricsService {
  /**
   * @description Construct the service bound to a Redis client. No I/O happens here;
   * the periodic cleanup timer is only armed by start(). A null/absent Redis client is
   * tolerated so the service degrades gracefully (all operations become no-ops).
   * @param {Object} redisClient - ioredis-compatible client used for all metric storage.
   */
  constructor(redisClient) {
    this.redis = redisClient;
    this._cleanupInterval = null;
    this.isRunning = false;
  }

  /**
   * Start the metrics service — sets up periodic cleanup of expired data
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    // Cleanup expired metrics every 15 minutes
    this._cleanupInterval = setInterval(() => {
      this._cleanupExpiredMetrics().catch(err => {
        (logger.error || console.error)('AgentMetricsService cleanup error:', err.message);
      });
    }, 15 * 60 * 1000);

    (logger.info || console.log)('📊 AgentMetricsService started (24h rolling window)');
  }

  /**
   * Stop the metrics service
   */
  stop() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this.isRunning = false;
    (logger.info || console.log)('📊 AgentMetricsService stopped');
  }

  // ═══════════════════════════════════════════════════════
  // RECORDING METHODS — Called from QueueManagerService
  // ═══════════════════════════════════════════════════════

  /**
   * Record agent response time for a phase
   * Called from processWithAgent() with start/end timestamps
   */
  async recordResponseTime(agentId, ticketId, phase, durationMs) {
    if (!this.redis || !agentId) return;
    try {
      const key = `${METRICS_PREFIX}${agentId}:response_times`;
      const now = Date.now();
      const member = JSON.stringify({ phase, ms: durationMs, ticketId, ts: now });
      await this.redis.zadd(key, now, member);
      await this.redis.sadd(AGENTS_INDEX_KEY, agentId);
    } catch (err) {
      (logger.warn || console.warn)(`Metrics: Failed to record response time for ${agentId}:`, err.message);
    }
  }

  /**
   * Record gate pass/fail result
   * Called from _handleStandardPhaseGate()
   */
  async recordGateResult(agentId, ticketId, phase, passed) {
    if (!this.redis || !agentId) return;
    try {
      const key = `${METRICS_PREFIX}${agentId}:gate_results`;
      const now = Date.now();
      const member = JSON.stringify({ phase, passed, ticketId, ts: now });
      await this.redis.zadd(key, now, member);
      await this.redis.sadd(AGENTS_INDEX_KEY, agentId);
    } catch (err) {
      (logger.warn || console.warn)(`Metrics: Failed to record gate result for ${agentId}:`, err.message);
    }
  }

  /**
   * Record bid win or loss
   * Called from meshBroadcastRoute()
   */
  async recordBidResult(agentId, ticketId, won, confidence = null) {
    if (!this.redis || !agentId) return;
    try {
      const key = `${METRICS_PREFIX}${agentId}:bid_results`;
      const now = Date.now();
      const member = JSON.stringify({ won, ticketId, confidence, ts: now });
      await this.redis.zadd(key, now, member);
      await this.redis.sadd(AGENTS_INDEX_KEY, agentId);
    } catch (err) {
      (logger.warn || console.warn)(`Metrics: Failed to record bid result for ${agentId}:`, err.message);
    }
  }

  /**
   * Record escalation event
   * Called from evaluateAgentCompletion() when escalation happens
   */
  async recordEscalation(agentId, ticketId, reason) {
    if (!this.redis || !agentId) return;
    try {
      const key = `${METRICS_PREFIX}${agentId}:escalations`;
      const now = Date.now();
      const member = JSON.stringify({ ticketId, reason, ts: now });
      await this.redis.zadd(key, now, member);
      await this.redis.sadd(AGENTS_INDEX_KEY, agentId);
    } catch (err) {
      (logger.warn || console.warn)(`Metrics: Failed to record escalation for ${agentId}:`, err.message);
    }
  }

  /**
   * Record ticket completion (success or failure)
   * Called from evaluateAgentCompletion() or phase completion
   */
  async recordCompletion(agentId, ticketId, success, phase = null) {
    if (!this.redis || !agentId) return;
    try {
      const key = `${METRICS_PREFIX}${agentId}:completions`;
      const now = Date.now();
      const member = JSON.stringify({ ticketId, success, phase, ts: now });
      await this.redis.zadd(key, now, member);
      await this.redis.sadd(AGENTS_INDEX_KEY, agentId);
      // Update last_seen timestamp
      await this.redis.set(`${METRICS_PREFIX}${agentId}:last_seen`, new Date().toISOString());
    } catch (err) {
      (logger.warn || console.warn)(`Metrics: Failed to record completion for ${agentId}:`, err.message);
    }
  }

  /**
   * ⭐ Issue #008: Record LLM token cost for an agent's task.
   * Called from QueueManagerService after receiving agent response.
   * 
   * @param {string} agentId - Agent identifier
   * @param {string} ticketId - Ticket being processed
   * @param {Object} costData - Cost breakdown
   * @param {number} costData.input_tokens - Number of input tokens used
   * @param {number} costData.output_tokens - Number of output tokens generated
   * @param {number} costData.cost_usd - Total cost in USD
   * @param {string} [costData.model] - Model used (e.g., 'claude-3-5-sonnet', 'gpt-4o')
   * @param {string} [costData.phase] - Phase during which cost was incurred
   */
  async recordCost(agentId, ticketId, costData = {}) {
    if (!this.redis || !agentId) return;
    try {
      const key = `${METRICS_PREFIX}${agentId}:costs`;
      const now = Date.now();
      const member = JSON.stringify({
        ticketId,
        input_tokens: costData.input_tokens || 0,
        output_tokens: costData.output_tokens || 0,
        cost_usd: costData.cost_usd || 0,
        model: costData.model || 'unknown',
        phase: costData.phase || null,
        ts: now,
      });
      await this.redis.zadd(key, now, member);
      await this.redis.sadd(AGENTS_INDEX_KEY, agentId);
      // Update last_seen timestamp
      await this.redis.set(`${METRICS_PREFIX}${agentId}:last_seen`, new Date().toISOString());
      logger.debug(`[AgentMetricsService.recordCost] ${agentId} ticket=${ticketId} cost=$${(costData.cost_usd || 0).toFixed(6)} tokens=${(costData.input_tokens || 0) + (costData.output_tokens || 0)}`);
    } catch (err) {
      (logger.warn || console.warn)(`Metrics: Failed to record cost for ${agentId}:`, err.message);
    }
  }

  /**
   * ⭐ Issue #009: Pre-populate metrics index with ALL known agents.
   * Called on startup so ALL agents appear in the dashboard even before first task.
   * Agents with no activity will show zero metrics but will be visible.
   * 
   * @param {string[]} agentIds - List of all agent IDs to pre-register
   * @returns {Promise<number>} Number of agents pre-populated
   */
  async prePopulateAllAgents(agentIds) {
    if (!this.redis || !agentIds || agentIds.length === 0) return 0;
    try {
      let count = 0;
      for (const agentId of agentIds) {
        // Add to index — this makes them visible in the dashboard
        await this.redis.sadd(AGENTS_INDEX_KEY, agentId);
        // Set last_seen to startup time if not already set
        const lastSeenKey = `${METRICS_PREFIX}${agentId}:last_seen`;
        const existing = await this.redis.get(lastSeenKey);
        if (!existing) {
          await this.redis.set(lastSeenKey, new Date().toISOString());
        }
        count++;
      }
      logger.info(`[AgentMetricsService.prePopulateAllAgents] Pre-populated ${count} agents in metrics index`);
      return count;
    } catch (err) {
      logger.warn(`[AgentMetricsService.prePopulateAllAgents] Failed: ${err.message}`);
      return 0;
    }
  }

  // ═══════════════════════════════════════════════════════
  // QUERY METHODS — Called from API endpoint
  // ═══════════════════════════════════════════════════════

  /**
   * Get all agent metrics for the rolling window.
   * Issue #009: Returns ALL agents in the index, including inactive ones with zero metrics.
   * @param {boolean} [includeInactive=true] - Include agents with zero activity (default true)
   */
  async getAllAgentMetrics(includeInactive = true) {
    if (!this.redis) return [];

    try {
      const agentIds = await this.redis.smembers(AGENTS_INDEX_KEY);
      if (!agentIds || agentIds.length === 0) return [];

      const cutoff = Date.now() - ROLLING_WINDOW_MS;
      const results = [];

      for (const agentId of agentIds) {
        const metrics = await this._getAgentMetrics(agentId, cutoff);
        if (metrics) {
          results.push(metrics);
        } else if (includeInactive) {
          // ⭐ Issue #009: Include agents with zero activity so they appear in dashboard
          const lastSeenRaw = await this.redis.get(`${METRICS_PREFIX}${agentId}:last_seen`);
          results.push({
            agentId,
            window: '24h',
            updatedAt: new Date().toISOString(),
            lastSeen: lastSeenRaw || null,
            status: 'inactive',
            responseTimes: { avg: 0, min: 0, max: 0, count: 0, history: [] },
            gates: { passCount: 0, failCount: 0, passRate: 0, total: 0 },
            bids: { winCount: 0, lossCount: 0, winRate: 0, avgConfidence: 0, total: 0 },
            escalations: { count: 0 },
            completions: { completed: 0, failed: 0, total: 0 },
            costs: { totalCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, totalTokens: 0, taskCount: 0 },
            totalEvents: 0,
          });
        }
      }

      // Sort: active agents first (by totalEvents desc), then inactive alphabetically
      results.sort((a, b) => {
        if (b.totalEvents !== a.totalEvents) return b.totalEvents - a.totalEvents;
        return a.agentId.localeCompare(b.agentId);
      });
      return results;
    } catch (err) {
      (logger.error || console.error)('AgentMetricsService: Failed to get all metrics:', err.message);
      return [];
    }
  }

  /**
   * Get metrics for a single agent
   */
  async getAgentMetrics(agentId) {
    if (!this.redis || !agentId) return null;
    const cutoff = Date.now() - ROLLING_WINDOW_MS;
    return this._getAgentMetrics(agentId, cutoff);
  }

  /**
   * Internal: Aggregate metrics for one agent within the rolling window
   */
  async _getAgentMetrics(agentId, cutoff) {
    try {
      const prefix = `${METRICS_PREFIX}${agentId}:`;

      // Fetch all metric types within rolling window
      const [responseTimes, gateResults, bidResults, escalations, completions] = await Promise.all([
        this.redis.zrangebyscore(prefix + 'response_times', cutoff, '+inf'),
        this.redis.zrangebyscore(prefix + 'gate_results', cutoff, '+inf'),
        this.redis.zrangebyscore(prefix + 'bid_results', cutoff, '+inf'),
        this.redis.zrangebyscore(prefix + 'escalations', cutoff, '+inf'),
        this.redis.zrangebyscore(prefix + 'completions', cutoff, '+inf'),
      ]);

      // Parse and aggregate response times
      const parsedResponseTimes = responseTimes.map(r => JSON.parse(r));
      const avgResponseTime = parsedResponseTimes.length > 0
        ? Math.round(parsedResponseTimes.reduce((sum, r) => sum + r.ms, 0) / parsedResponseTimes.length)
        : 0;
      const minResponseTime = parsedResponseTimes.length > 0
        ? Math.min(...parsedResponseTimes.map(r => r.ms))
        : 0;
      const maxResponseTime = parsedResponseTimes.length > 0
        ? Math.max(...parsedResponseTimes.map(r => r.ms))
        : 0;

      // Response time history (last 20 entries for sparkline)
      const responseTimeHistory = parsedResponseTimes.slice(-20).map(r => ({
        ms: r.ms,
        phase: r.phase,
        ts: r.ts,
      }));

      // Gate pass/fail
      const parsedGates = gateResults.map(r => JSON.parse(r));
      const gatePassCount = parsedGates.filter(g => g.passed).length;
      const gateFailCount = parsedGates.filter(g => !g.passed).length;
      const gatePassRate = parsedGates.length > 0
        ? Math.round((gatePassCount / parsedGates.length) * 100)
        : 0;

      // Bid win/loss
      const parsedBids = bidResults.map(r => JSON.parse(r));
      const bidWinCount = parsedBids.filter(b => b.won).length;
      const bidLossCount = parsedBids.filter(b => !b.won).length;
      const bidWinRate = parsedBids.length > 0
        ? Math.round((bidWinCount / parsedBids.length) * 100)
        : 0;
      const avgConfidence = parsedBids.filter(b => b.confidence != null).length > 0
        ? parseFloat((parsedBids.filter(b => b.confidence != null)
            .reduce((sum, b) => sum + b.confidence, 0) / parsedBids.filter(b => b.confidence != null).length).toFixed(3))
        : 0;

      // Escalations
      const escalationCount = escalations.length;

      // Completions
      const parsedCompletions = completions.map(r => JSON.parse(r));
      const ticketsCompleted = parsedCompletions.filter(c => c.success).length;
      const ticketsFailed = parsedCompletions.filter(c => !c.success).length;

      // ⭐ Issue #008: Fetch and aggregate cost data
      const costRaw = await this.redis.zrangebyscore(prefix + 'costs', cutoff, '+inf');
      const parsedCosts = costRaw.map(r => JSON.parse(r));
      const totalCostUsd = parsedCosts.reduce((sum, c) => sum + (c.cost_usd || 0), 0);
      const totalInputTokens = parsedCosts.reduce((sum, c) => sum + (c.input_tokens || 0), 0);
      const totalOutputTokens = parsedCosts.reduce((sum, c) => sum + (c.output_tokens || 0), 0);
      // Cost history (last 20 for sparkline)
      const costHistory = parsedCosts.slice(-20).map(c => ({
        cost_usd: c.cost_usd,
        input_tokens: c.input_tokens,
        output_tokens: c.output_tokens,
        model: c.model,
        phase: c.phase,
        ts: c.ts,
      }));

      const totalEvents = parsedResponseTimes.length + parsedGates.length + 
        parsedBids.length + escalations.length + parsedCompletions.length;

      // Skip agents with zero activity in window
      if (totalEvents === 0) return null;

      // Get last_seen timestamp
      const lastSeenRaw = await this.redis.get(prefix + 'last_seen');

      return {
        agentId,
        window: '24h',
        updatedAt: new Date().toISOString(),
        lastSeen: lastSeenRaw || null,
        status: 'active',
        responseTimes: {
          avg: avgResponseTime,
          min: minResponseTime,
          max: maxResponseTime,
          count: parsedResponseTimes.length,
          history: responseTimeHistory,
        },
        gates: {
          passCount: gatePassCount,
          failCount: gateFailCount,
          passRate: gatePassRate,
          total: parsedGates.length,
        },
        bids: {
          winCount: bidWinCount,
          lossCount: bidLossCount,
          winRate: bidWinRate,
          avgConfidence,
          total: parsedBids.length,
        },
        escalations: {
          count: escalationCount,
        },
        completions: {
          completed: ticketsCompleted,
          failed: ticketsFailed,
          total: parsedCompletions.length,
        },
        // ⭐ Issue #008: Cost rollup for Task Explorer
        costs: {
          totalCostUsd: parseFloat(totalCostUsd.toFixed(6)),
          totalInputTokens,
          totalOutputTokens,
          totalTokens: totalInputTokens + totalOutputTokens,
          taskCount: parsedCosts.length,
          history: costHistory,
        },
        totalEvents,
      };
    } catch (err) {
      (logger.warn || console.warn)(`Metrics: Failed to get metrics for ${agentId}:`, err.message);
      return null;
    }
  }

  /**
   * Get summary statistics across all agents
   */
  async getSummary() {
    const allMetrics = await this.getAllAgentMetrics();
    if (allMetrics.length === 0) {
      return {
        totalAgentsTracked: 0,
        totalBids: 0,
        totalGateChecks: 0,
        totalEscalations: 0,
        totalCompletions: 0,
        avgResponseTimeMs: 0,
        overallGatePassRate: 0,
        overallBidWinRate: 0,
        topPerformers: [],
        window: '24h',
      };
    }

    const totalBids = allMetrics.reduce((s, m) => s + m.bids.total, 0);
    const totalGateChecks = allMetrics.reduce((s, m) => s + m.gates.total, 0);
    const totalGatePasses = allMetrics.reduce((s, m) => s + m.gates.passCount, 0);
    const totalBidWins = allMetrics.reduce((s, m) => s + m.bids.winCount, 0);
    const totalEscalations = allMetrics.reduce((s, m) => s + m.escalations.count, 0);
    const totalCompletions = allMetrics.reduce((s, m) => s + m.completions.total, 0);
    const allResponseTimes = allMetrics.filter(m => m.responseTimes.count > 0);
    const avgResponseTimeMs = allResponseTimes.length > 0
      ? Math.round(allResponseTimes.reduce((s, m) => s + m.responseTimes.avg, 0) / allResponseTimes.length)
      : 0;

    // Top performers: sorted by gate pass rate, then bid win rate
    const topPerformers = [...allMetrics]
      .filter(m => m.gates.total >= 1 || m.bids.total >= 1)
      .sort((a, b) => {
        const scoreA = a.gates.passRate * 0.6 + a.bids.winRate * 0.4;
        const scoreB = b.gates.passRate * 0.6 + b.bids.winRate * 0.4;
        return scoreB - scoreA;
      })
      .slice(0, 5)
      .map(m => ({
        agentId: m.agentId,
        gatePassRate: m.gates.passRate,
        bidWinRate: m.bids.winRate,
        avgResponseTime: m.responseTimes.avg,
      }));

    return {
      totalAgentsTracked: allMetrics.length,
      totalBids,
      totalGateChecks,
      totalEscalations,
      totalCompletions,
      avgResponseTimeMs,
      overallGatePassRate: totalGateChecks > 0 ? Math.round((totalGatePasses / totalGateChecks) * 100) : 0,
      overallBidWinRate: totalBids > 0 ? Math.round((totalBidWins / totalBids) * 100) : 0,
      topPerformers,
      window: '24h',
    };
  }

  // ═══════════════════════════════════════════════════════
  // PHASE_67: PER-TICKET COST TRACKING
  // ═══════════════════════════════════════════════════════

  /**
   * ⭐ PHASE_67: Record cost for a specific ticket.
   * Called after each agent dispatch completes. Accumulates cost across phases.
   * Also updates per-project cost if projectId is provided.
   * 
   * @param {string} ticketId - Plane ticket UUID
   * @param {Object} costData - Cost breakdown for this dispatch
   * @param {number} costData.cost_usd - Cost in USD
   * @param {number} costData.input_tokens - Input tokens used
   * @param {number} costData.output_tokens - Output tokens generated
   * @param {string} [costData.phase] - Phase name (e.g., 'EXECUTION', 'TESTING')
   * @param {string} [costData.agentId] - Agent that incurred the cost
   * @param {string} [costData.model] - Model used
   * @param {string} [costData.projectId] - Plane project UUID (for project rollup)
   * @param {string} [costData.parentTicketId] - Parent ticket UUID (for subtask rollup)
   */
  async recordTicketCost(ticketId, costData = {}) {
    if (!this.redis || !ticketId) return;
    try {
      const key = `metrics:ticket:${ticketId}:cost`;
      const costUsd = costData.cost_usd || 0;
      const inputTokens = costData.input_tokens || 0;
      const outputTokens = costData.output_tokens || 0;
      const now = new Date().toISOString();

      // Atomically increment ticket cost totals using HINCRBYFLOAT / HINCRBY
      await this.redis.hincrbyfloat(key, 'totalCost', costUsd);
      await this.redis.hincrby(key, 'totalTokens', inputTokens + outputTokens);
      await this.redis.hincrby(key, 'inputTokens', inputTokens);
      await this.redis.hincrby(key, 'outputTokens', outputTokens);
      await this.redis.hincrby(key, 'dispatchCount', 1);
      await this.redis.hset(key, 'updatedAt', now);

      // Append phase entry to phases list
      const phaseEntry = JSON.stringify({
        phase: costData.phase || 'unknown',
        agentId: costData.agentId || 'unknown',
        cost_usd: costUsd,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        model: costData.model || 'unknown',
        ts: now,
      });
      await this.redis.rpush(`metrics:ticket:${ticketId}:phases`, phaseEntry);

      // No TTL on ticket costs — they persist until explicitly cleared
      // (unlike agent metrics which have 24h rolling window)

      logger.debug(`[PHASE_67] Ticket ${ticketId.substring(0, 8)} cost +$${costUsd.toFixed(4)} (total dispatches: +1)`);

      // Store parent relationship for subtask rollup
      if (costData.parentTicketId) {
        await this.redis.set(`metrics:ticket:${ticketId}:parent`, costData.parentTicketId);
        logger.debug(`[PHASE_67] Ticket ${ticketId.substring(0, 8)} parent set to ${costData.parentTicketId.substring(0, 8)}`);
      }

      // Update per-project cost if projectId provided
      if (costData.projectId) {
        await this._updateProjectCost(costData.projectId, ticketId, costUsd, inputTokens + outputTokens);
      }
    } catch (err) {
      logger.warn(`[PHASE_67] Failed to record ticket cost for ${ticketId}: ${err.message}`);
    }
  }

  /**
   * ⭐ PHASE_67: Get cost for a specific ticket.
   * Returns own cost + aggregated subtask costs.
   * 
   * @param {string} ticketId - Plane ticket UUID
   * @param {Object} [options] - Options
   * @param {boolean} [options.includeSubtasks=true] - Include subtask cost rollup
   * @param {string[]} [options.subtaskIds] - Pre-fetched subtask IDs (avoids DB query)
   * @returns {Promise<Object|null>} Ticket cost data or null
   */
  async getTicketCost(ticketId, options = {}) {
    if (!this.redis || !ticketId) return null;
    try {
      const key = `metrics:ticket:${ticketId}:cost`;
      const data = await this.redis.hgetall(key);
      
      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      const ownCost = {
        ticketId,
        totalCost: parseFloat(data.totalCost || 0),
        totalTokens: parseInt(data.totalTokens || 0),
        inputTokens: parseInt(data.inputTokens || 0),
        outputTokens: parseInt(data.outputTokens || 0),
        dispatchCount: parseInt(data.dispatchCount || 0),
        updatedAt: data.updatedAt || null,
        realCostData: true,
      };

      // Get phase breakdown
      const phases = await this.redis.lrange(`metrics:ticket:${ticketId}:phases`, 0, -1);
      ownCost.phases = phases.map(p => {
        try { return JSON.parse(p); } catch (_) { return null; }
      }).filter(Boolean);

      // Subtask rollup
      if (options.includeSubtasks !== false && options.subtaskIds && options.subtaskIds.length > 0) {
        let subtaskTotalCost = 0;
        let subtaskTotalTokens = 0;
        let subtasksWithCost = 0;

        for (const subtaskId of options.subtaskIds) {
          const subtaskCost = await this.getTicketCost(subtaskId, { includeSubtasks: false });
          if (subtaskCost) {
            subtaskTotalCost += subtaskCost.totalCost;
            subtaskTotalTokens += subtaskCost.totalTokens;
            subtasksWithCost++;
          }
        }

        ownCost.subtaskCount = options.subtaskIds.length;
        ownCost.subtasksWithCost = subtasksWithCost;
        ownCost.subtaskCost = parseFloat(subtaskTotalCost.toFixed(6));
        ownCost.subtaskTokens = subtaskTotalTokens;
        ownCost.aggregatedCost = parseFloat((ownCost.totalCost + subtaskTotalCost).toFixed(6));
        ownCost.aggregatedTokens = ownCost.totalTokens + subtaskTotalTokens;
      }

      return ownCost;
    } catch (err) {
      logger.warn(`[PHASE_67] Failed to get ticket cost for ${ticketId}: ${err.message}`);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════
  // PHASE_67: PER-PROJECT COST TRACKING
  // ═══════════════════════════════════════════════════════

  /**
   * ⭐ PHASE_67: Internal — update project cost totals.
   * Called from recordTicketCost when projectId is provided.
   */
  async _updateProjectCost(projectId, ticketId, costUsd, totalTokens) {
    if (!this.redis || !projectId) return;
    try {
      const key = `metrics:project:${projectId}:cost`;
      await this.redis.hincrbyfloat(key, 'totalCost', costUsd);
      await this.redis.hincrby(key, 'totalTokens', totalTokens);
      await this.redis.hset(key, 'updatedAt', new Date().toISOString());
      
      // Track which tickets belong to this project
      await this.redis.sadd(`metrics:project:${projectId}:tickets`, ticketId);
      
      // Update ticket count from set size
      const ticketCount = await this.redis.scard(`metrics:project:${projectId}:tickets`);
      await this.redis.hset(key, 'ticketCount', ticketCount);

      logger.debug(`[PHASE_67] Project ${projectId.substring(0, 8)} cost +$${costUsd.toFixed(4)} (${ticketCount} tickets)`);
    } catch (err) {
      logger.warn(`[PHASE_67] Failed to update project cost for ${projectId}: ${err.message}`);
    }
  }

  /**
   * ⭐ PHASE_67: Get cost for a specific project.
   * @param {string} projectId - Plane project UUID
   * @returns {Promise<Object|null>} Project cost data or null
   */
  async getProjectCost(projectId) {
    if (!this.redis || !projectId) return null;
    try {
      const key = `metrics:project:${projectId}:cost`;
      const data = await this.redis.hgetall(key);
      
      if (!data || Object.keys(data).length === 0) {
        return null;
      }

      return {
        projectId,
        totalCost: parseFloat(data.totalCost || 0),
        totalTokens: parseInt(data.totalTokens || 0),
        ticketCount: parseInt(data.ticketCount || 0),
        updatedAt: data.updatedAt || null,
      };
    } catch (err) {
      logger.warn(`[PHASE_67] Failed to get project cost for ${projectId}: ${err.message}`);
      return null;
    }
  }

  /**
   * ⭐ PHASE_67: Get costs for all projects.
   * @returns {Promise<Object[]>} Array of project cost objects
   */
  async getAllProjectCosts() {
    if (!this.redis) return [];
    try {
      // Scan for all project cost keys
      let cursor = '0';
      const projects = [];

      do {
        const [nextCursor, keys] = await this.redis.scan(cursor, 'MATCH', 'metrics:project:*:cost', 'COUNT', 100);
        cursor = nextCursor;

        for (const key of keys) {
          const data = await this.redis.hgetall(key);
          if (data && Object.keys(data).length > 0) {
            // Extract projectId from key: metrics:project:{projectId}:cost
            const projectId = key.replace('metrics:project:', '').replace(':cost', '');
            projects.push({
              projectId,
              totalCost: parseFloat(data.totalCost || 0),
              totalTokens: parseInt(data.totalTokens || 0),
              ticketCount: parseInt(data.ticketCount || 0),
              updatedAt: data.updatedAt || null,
            });
          }
        }
      } while (cursor !== '0');

      // Sort by cost descending
      projects.sort((a, b) => b.totalCost - a.totalCost);
      return projects;
    } catch (err) {
      logger.warn(`[PHASE_67] Failed to get all project costs: ${err.message}`);
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════
  // MAINTENANCE
  // ═══════════════════════════════════════════════════════

  /**
   * Remove metrics older than the rolling window
   */
  async _cleanupExpiredMetrics() {
    const cutoff = Date.now() - ROLLING_WINDOW_MS;
    const agentIds = await this.redis.smembers(AGENTS_INDEX_KEY);
    
    let totalRemoved = 0;
    for (const agentId of agentIds) {
      const prefix = `${METRICS_PREFIX}${agentId}:`;
      // ⭐ Issue #008: Added 'costs' to cleanup
      const suffixes = ['response_times', 'gate_results', 'bid_results', 'escalations', 'completions', 'costs'];
      
      for (const suffix of suffixes) {
        const removed = await this.redis.zremrangebyscore(prefix + suffix, '-inf', cutoff);
        totalRemoved += removed;
      }

      // If agent has no metrics left AND no last_seen, remove from index
      // Note: pre-populated agents (Issue #009) keep their last_seen key so they stay visible
      let hasData = false;
      for (const suffix of suffixes) {
        const count = await this.redis.zcard(prefix + suffix);
        if (count > 0) { hasData = true; break; }
      }
      // Also check last_seen — if it exists, keep in index (pre-populated agent)
      if (!hasData) {
        const lastSeen = await this.redis.get(prefix + 'last_seen');
        if (!lastSeen) {
          await this.redis.srem(AGENTS_INDEX_KEY, agentId);
        }
      }
    }

    if (totalRemoved > 0) {
      (logger.info || console.log)(`📊 Metrics cleanup: removed ${totalRemoved} expired entries`);
    }
  }

  /**
   * Reset all metrics (for testing)
   */
  async resetAll() {
    const agentIds = await this.redis.smembers(AGENTS_INDEX_KEY);
    for (const agentId of agentIds) {
      const prefix = `${METRICS_PREFIX}${agentId}:`;
      // ⭐ Issue #008: Added 'costs' to reset
      const suffixes = ['response_times', 'gate_results', 'bid_results', 'escalations', 'completions', 'costs'];
      for (const suffix of suffixes) {
        await this.redis.del(prefix + suffix);
      }
      await this.redis.del(prefix + 'last_seen');
    }
    await this.redis.del(AGENTS_INDEX_KEY);
    (logger.info || console.log)('📊 All agent metrics reset');
  }
}

/**
 * @description Default export of the AgentMetricsService class so callers (notably the
 * queue manager and the metrics API routes) can instantiate it with a shared Redis client.
 */
module.exports = AgentMetricsService;
