/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * RoutingDecisionLog — Transparent routing audit trail for the Queue Manager
 *
 * Every time the QM makes a routing decision, it logs a structured entry here.
 * The log is:
 *   1. Written to Redis (last 100 decisions, 24h TTL)
 *   2. Written to the ticket's workspace as ROUTING-DECISIONS.md
 *   3. Posted as a Plane comment on the ticket (optional, controlled by env var)
 *
 * This solves the "why isn't email-bot getting the ticket?" problem by making
 * every routing decision fully transparent and auditable.
 *
 * ## Log Entry Structure
 * ```json
 * {
 *   "ticketId": "3d9291df-...",
 *   "ticketTitle": "send an email to...",
 *   "timestamp": "2026-02-23T16:00:00Z",
 *   "phase": 4,
 *   "phaseName": "EXECUTION",
 *   "ticketDepth": 0,
 *   "selectedAgent": "project-manager",
 *   "routingMethod": "HIERARCHICAL_ROOT",
 *   "allAgentsConsidered": [
 *     { "agentId": "email-bot", "score": 35, "capabilities": ["email","smtp",...], "routingKeywords": ["email",...], "reason": "..." },
 *     { "agentId": "project-manager", "score": 42, "capabilities": ["planning",...], "reason": "..." }
 *   ],
 *   "whySelected": "Root ticket (depth 0) always routes to project-manager for triage",
 *   "whyOthersSkipped": {
 *     "email-bot": "Root tickets always go to project-manager regardless of capabilities"
 *   },
 *   "ticketKeywords": ["email", "send", "zip"],
 *   "capabilityHints": ["build", "present"],
 *   "warnings": ["email-bot has routing_keywords matching ticket but was not selected"]
 * }
 * ```
 *
 * @module queue-manager/RoutingDecisionLog
 */

const logger = require('../../utils/logger');
const path = require('path');
const fs = require('fs');

/**
 * @class RoutingDecisionLog
 * @description Captures and persists the Queue Manager's routing rationale so
 * that "why did agent X (not) get this ticket?" is always answerable after the
 * fact. Each decision is fanned out to three sinks (Redis ring buffer, the
 * ticket workspace ROUTING-DECISIONS.md, and optionally a Plane comment) so
 * operators can audit routing without re-running the QM. All sinks are
 * best-effort: a failure in any one of them must never block the routing path.
 */
class RoutingDecisionLog {
  /**
   * @description Construct the audit logger and resolve its output sinks from
   * explicit options first, then environment variables, then safe defaults.
   * No I/O happens here; sinks are exercised lazily on {@link record}.
   * @param {Object} redisClient - Connected Redis client used as the decision ring buffer; pass a falsy value to disable Redis persistence and reads.
   * @param {Object} [options={}] - Sink overrides.
   * @param {string} [options.workspaceRoot] - Base directory under which per-task ROUTING-DECISIONS.md files are written (falls back to WORKSPACE_DIR env, then /app/workspace).
   * @param {number} [options.maxEntries=100] - Maximum decisions retained in the global Redis ring buffer.
   * @param {boolean} [options.postToPlane] - Whether to mirror decisions as Plane comments (defaults to the QM_ROUTING_LOG_TO_PLANE env flag; off because it is noisy).
   * @param {boolean} [options.writeToWorkspace=true] - Whether to append decisions to the workspace markdown log.
   * @param {boolean} [options.logToConsole=true] - Whether to emit a human-readable summary to the logger.
   */
  constructor(redisClient, options = {}) {
    this.redis = redisClient;
    this.workspaceRoot = options.workspaceRoot || process.env.WORKSPACE_DIR || '/app/workspace';
    this.maxEntries = options.maxEntries || 100;
    this.redisKey = 'qm:routing_decisions';
    this.redisTTL = 86400; // 24 hours
    // Post routing decisions as Plane comments? Default OFF (too noisy for normal ops)
    this.postToPlane = options.postToPlane || process.env.QM_ROUTING_LOG_TO_PLANE === 'true';
    // Write to workspace files? Default ON
    this.writeToWorkspace = options.writeToWorkspace !== false;
    // Log to console at INFO level? Default ON
    this.logToConsole = options.logToConsole !== false;
  }

  /**
   * Record a routing decision.
   *
   * @param {Object} params
   * @param {string} params.ticketId - Plane ticket UUID
   * @param {string} params.ticketTitle - Ticket name/title
   * @param {string} params.ticketDescription - Ticket description (first 300 chars)
   * @param {number|null} params.phase - Current phase number (null for subtasks)
   * @param {string|null} params.phaseName - Phase name string
   * @param {number} params.ticketDepth - Decomposition depth (0 = root)
   * @param {string} params.selectedAgent - The agent that was selected
   * @param {string} params.routingMethod - How the agent was selected (e.g. HIERARCHICAL_ROOT, CAPABILITY_MATCHER, LLM_ROUTER, MESH_BID, PM_ASSIGNED, FALLBACK)
   * @param {Object[]} params.allAgentsConsidered - All agents that were evaluated
   * @param {string} params.whySelected - Human-readable explanation of why this agent was chosen
   * @param {Object} [params.whyOthersSkipped] - Map of agentId → reason why they were NOT selected
   * @param {string[]} [params.ticketKeywords] - Keywords extracted from ticket
   * @param {string[]} [params.capabilityHints] - Capability hints from CapabilityMatcher
   * @param {string[]} [params.warnings] - Any routing warnings (e.g. specialist ignored)
   * @param {string|null} [params.taskId] - Workspace task ID (for file writing)
   */
  async record(params) {
    const {
      ticketId,
      ticketTitle = '',
      ticketDescription = '',
      phase = null,
      phaseName = null,
      ticketDepth = 0,
      selectedAgent,
      routingMethod,
      allAgentsConsidered = [],
      whySelected = '',
      whyOthersSkipped = {},
      ticketKeywords = [],
      capabilityHints = [],
      warnings = [],
      taskId = null,
    } = params;

    const entry = {
      ticketId,
      ticketTitle: ticketTitle.substring(0, 200),
      ticketDescription: ticketDescription.substring(0, 300),
      timestamp: new Date().toISOString(),
      phase,
      phaseName,
      ticketDepth,
      selectedAgent,
      routingMethod,
      allAgentsConsidered: allAgentsConsidered.map(a => ({
        agentId: a.agentId || a.agent_id,
        score: typeof a.score === 'number' ? Math.round(a.score * 10) / 10 : null,
        capabilities: a.capabilities || [],
        routingKeywords: a.routing_keywords || a.routingKeywords || [],
        status: a.status || 'unknown',
        currentLoad: a.current_load || 0,
        maxConcurrent: a.max_concurrent || 3,
      })),
      whySelected,
      whyOthersSkipped,
      ticketKeywords,
      capabilityHints,
      warnings,
    };

    // 1. Log to console
    if (this.logToConsole) {
      this._logToConsole(entry);
    }

    // 2. Store in Redis
    await this._storeInRedis(entry);

    // 3. Write to workspace file
    if (this.writeToWorkspace && taskId) {
      await this._writeToWorkspace(entry, taskId);
    }

    return entry;
  }

  /**
   * Log routing decision to console in a readable format
   * @private
   */
  _logToConsole(entry) {
    const phaseStr = entry.phase ? ` Phase ${entry.phase} (${entry.phaseName})` : '';
    const depthStr = entry.ticketDepth > 0 ? ` depth=${entry.ticketDepth}` : '';

    logger.info(`[ROUTING DECISION]${phaseStr}${depthStr} ticket=${entry.ticketId.substring(0, 8)} → ${entry.selectedAgent} (method: ${entry.routingMethod})`);
    logger.info(`[ROUTING DECISION] Why: ${entry.whySelected}`);

    if (entry.warnings.length > 0) {
      entry.warnings.forEach(w => logger.warn(`[ROUTING WARNING] ${w}`));
    }

    if (entry.allAgentsConsidered.length > 0) {
      const sorted = [...entry.allAgentsConsidered].sort((a, b) => (b.score || 0) - (a.score || 0));
      logger.info(`[ROUTING DECISION] Agent scores (top 5):`);
      sorted.slice(0, 5).forEach((a, i) => {
        const selected = a.agentId === entry.selectedAgent ? ' ← SELECTED' : '';
        logger.info(`[ROUTING DECISION]   ${i + 1}. ${a.agentId}: score=${a.score ?? 'N/A'} caps=[${a.capabilities.join(',')}]${selected}`);
      });
    }

    if (Object.keys(entry.whyOthersSkipped).length > 0) {
      logger.info(`[ROUTING DECISION] Agents NOT selected:`);
      Object.entries(entry.whyOthersSkipped).forEach(([agentId, reason]) => {
        logger.info(`[ROUTING DECISION]   - ${agentId}: ${reason}`);
      });
    }
  }

  /**
   * Store entry in Redis ring buffer (last N decisions)
   * @private
   */
  async _storeInRedis(entry) {
    if (!this.redis) return;
    try {
      // Push to list, trim to maxEntries
      await this.redis.lpush(this.redisKey, JSON.stringify(entry));
      await this.redis.ltrim(this.redisKey, 0, this.maxEntries - 1);
      await this.redis.expire(this.redisKey, this.redisTTL);

      // Also store per-ticket for easy lookup
      const ticketKey = `qm:routing_decisions:${entry.ticketId}`;
      await this.redis.lpush(ticketKey, JSON.stringify(entry));
      await this.redis.ltrim(ticketKey, 0, 19); // last 20 per ticket
      await this.redis.expire(ticketKey, this.redisTTL);
    } catch (err) {
      logger.debug(`[RoutingDecisionLog] Redis store failed (non-fatal): ${err.message}`);
    }
  }

  /**
   * Write routing decision to workspace ROUTING-DECISIONS.md
   * @private
   */
  async _writeToWorkspace(entry, taskId) {
    try {
      const wsDir = path.join(this.workspaceRoot, taskId);
      if (!fs.existsSync(wsDir)) {
        fs.mkdirSync(wsDir, { recursive: true });
      }

      const logFile = path.join(wsDir, 'ROUTING-DECISIONS.md');
      const markdown = this._formatMarkdown(entry);

      // Append to existing file or create new
      if (fs.existsSync(logFile)) {
        const existing = fs.readFileSync(logFile, 'utf8');
        fs.writeFileSync(logFile, existing + '\n\n---\n\n' + markdown);
      } else {
        const header = `# Routing Decision Log\n\n**Ticket:** ${entry.ticketTitle}\n**ID:** ${entry.ticketId}\n\nThis file records every routing decision made by the Queue Manager for this ticket.\nUse it to understand WHY a specific agent was (or was not) selected.\n\n---\n\n`;
        fs.writeFileSync(logFile, header + markdown);
      }
    } catch (err) {
      logger.debug(`[RoutingDecisionLog] Workspace write failed (non-fatal): ${err.message}`);
    }
  }

  /**
   * Format a routing decision entry as Markdown
   * @private
   */
  _formatMarkdown(entry) {
    const phaseStr = entry.phase ? `Phase ${entry.phase} — ${entry.phaseName}` : 'Non-phased (subtask)';
    const sorted = [...entry.allAgentsConsidered].sort((a, b) => (b.score || 0) - (a.score || 0));

    let md = `## ${entry.timestamp} — ${phaseStr}\n\n`;
    md += `**Selected Agent:** \`${entry.selectedAgent}\`\n`;
    md += `**Routing Method:** \`${entry.routingMethod}\`\n`;
    md += `**Ticket Depth:** ${entry.ticketDepth}\n`;
    md += `**Ticket Keywords:** ${entry.ticketKeywords.join(', ') || 'none'}\n`;
    md += `**Capability Hints:** ${entry.capabilityHints.join(', ') || 'none'}\n\n`;

    md += `### Why \`${entry.selectedAgent}\` Was Selected\n\n`;
    md += `${entry.whySelected}\n\n`;

    if (sorted.length > 0) {
      md += `### All Agents Considered (Ranked by Score)\n\n`;
      md += `| Rank | Agent | Score | Capabilities | Keywords | Status | Selected? |\n`;
      md += `|------|-------|-------|--------------|----------|--------|-----------|\n`;
      sorted.forEach((a, i) => {
        const selected = a.agentId === entry.selectedAgent ? '✅ YES' : '❌ No';
        const caps = a.capabilities.slice(0, 4).join(', ') + (a.capabilities.length > 4 ? '...' : '');
        const kws = (a.routingKeywords || []).slice(0, 3).join(', ') + ((a.routingKeywords || []).length > 3 ? '...' : '');
        md += `| ${i + 1} | \`${a.agentId}\` | ${a.score ?? 'N/A'} | ${caps} | ${kws} | ${a.status} | ${selected} |\n`;
      });
      md += '\n';
    }

    if (Object.keys(entry.whyOthersSkipped).length > 0) {
      md += `### Why Other Agents Were NOT Selected\n\n`;
      Object.entries(entry.whyOthersSkipped).forEach(([agentId, reason]) => {
        md += `- **\`${agentId}\`**: ${reason}\n`;
      });
      md += '\n';
    }

    if (entry.warnings.length > 0) {
      md += `### ⚠️ Routing Warnings\n\n`;
      entry.warnings.forEach(w => {
        md += `- ${w}\n`;
      });
      md += '\n';
    }

    return md;
  }

  /**
   * Get recent routing decisions from Redis
   * @param {number} limit - Max entries to return
   * @returns {Promise<Object[]>} Recent routing decisions
   */
  async getRecent(limit = 20) {
    if (!this.redis) return [];
    try {
      const entries = await this.redis.lrange(this.redisKey, 0, limit - 1);
      return entries.map(e => {
        try { return JSON.parse(e); } catch { return null; }
      }).filter(Boolean);
    } catch (err) {
      logger.debug(`[RoutingDecisionLog] Redis read failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Get routing decisions for a specific ticket
   * @param {string} ticketId - Ticket UUID
   * @returns {Promise<Object[]>} Routing decisions for this ticket
   */
  async getForTicket(ticketId) {
    if (!this.redis) return [];
    try {
      const ticketKey = `qm:routing_decisions:${ticketId}`;
      const entries = await this.redis.lrange(ticketKey, 0, 19);
      return entries.map(e => {
        try { return JSON.parse(e); } catch { return null; }
      }).filter(Boolean);
    } catch (err) {
      logger.debug(`[RoutingDecisionLog] Redis read failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Build a human-readable routing report for a ticket
   * Useful for debugging "why didn't email-bot get this ticket?"
   * @param {string} ticketId - Ticket UUID
   * @returns {Promise<string>} Markdown report
   */
  async buildTicketReport(ticketId) {
    const decisions = await this.getForTicket(ticketId);
    if (decisions.length === 0) {
      return `# Routing Report for ${ticketId}\n\nNo routing decisions recorded for this ticket.`;
    }

    let report = `# Routing Decision Report\n\n`;
    report += `**Ticket:** ${decisions[0].ticketTitle}\n`;
    report += `**ID:** ${ticketId}\n`;
    report += `**Total Routing Decisions:** ${decisions.length}\n\n`;

    const agentCounts = {};
    decisions.forEach(d => {
      agentCounts[d.selectedAgent] = (agentCounts[d.selectedAgent] || 0) + 1;
    });

    report += `## Agent Selection Summary\n\n`;
    Object.entries(agentCounts).sort((a, b) => b[1] - a[1]).forEach(([agent, count]) => {
      report += `- **${agent}**: selected ${count} time(s)\n`;
    });
    report += '\n';

    const allWarnings = decisions.flatMap(d => d.warnings || []);
    if (allWarnings.length > 0) {
      report += `## ⚠️ All Routing Warnings\n\n`;
      allWarnings.forEach(w => { report += `- ${w}\n`; });
      report += '\n';
    }

    report += `## Decision Timeline\n\n`;
    decisions.reverse().forEach((d, i) => {
      report += `### Decision ${i + 1}: ${d.timestamp}\n`;
      report += `- **Phase:** ${d.phase ? `${d.phase} (${d.phaseName})` : 'Non-phased'}\n`;
      report += `- **Selected:** \`${d.selectedAgent}\` via \`${d.routingMethod}\`\n`;
      report += `- **Why:** ${d.whySelected}\n\n`;
    });

    return report;
  }
}

module.exports = RoutingDecisionLog;
