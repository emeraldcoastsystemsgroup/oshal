/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * FeedbackLoopService — GAP I: Human Review Verdicts → Agent Quality Scores
 * 
 * When a human reviews a ticket deliverable (via Plane comment or hot-swap chat),
 * their verdict (APPROVE / REVISE / REJECT) feeds back into agent quality metrics.
 * This creates a closed loop: agent performance improves based on human feedback.
 * 
 * Feedback sources:
 * 1. Plane ticket state changes (Done = approved, Cancelled = rejected)
 * 2. Explicit human review comments containing verdict keywords
 * 3. Hot-swap chat feedback ("good job" / "needs work")
 * 
 * Created: 2026-02-19 — Sprint 3, GAP I
 */

const logger = require('../../utils/logger');

/**
 * @description Canonical set of human review verdict values. Exported alongside the
 * service so callers and metric consumers agree on a single vocabulary for
 * approve/revise/reject outcomes rather than passing around ad-hoc strings.
 */
const VERDICT = {
  APPROVE: 'approve',
  REVISE: 'revise',
  REJECT: 'reject',
};

// Keywords that signal human verdict in comments
const VERDICT_KEYWORDS = {
  approve: ['approved', 'lgtm', 'looks good', 'great work', 'excellent', 'well done', 'perfect', 'ship it', '👍', '✅'],
  revise: ['needs work', 'revise', 'redo', 'not quite', 'close but', 'almost', 'update', 'fix this', 'improve'],
  reject: ['rejected', 'unacceptable', 'wrong', 'terrible', 'useless', 'start over', 'completely wrong', '❌', '👎'],
};

/**
 * @description Closes the human-in-the-loop quality cycle: it captures reviewer
 * verdicts on ticket deliverables and turns them into durable, queryable signals
 * that feed agent quality scoring. The goal is to let real human judgement,
 * gathered from Plane state changes, review comments, or hot-swap chat, steer
 * agent performance over time instead of relying on automated gates alone.
 */
class FeedbackLoopService {
  /**
   * @description Wires the service to its backing stores so feedback can be both
   * persisted for later analysis and reflected immediately in agent quality
   * metrics. Redis is treated as optional/best-effort so the service degrades
   * gracefully when no store is available.
   * @param {Object} redis - Redis client used to persist feedback history; when absent, writes are skipped.
   * @param {Object} agentMetrics - AgentMetricsService used to record each verdict as a gate result for quality scoring.
   */
  constructor(redis, agentMetrics) {
    this.redis = redis;
    this.agentMetrics = agentMetrics; // AgentMetricsService for recording quality
    this.prefix = 'feedback:';

    logger.info('[FeedbackLoop] Service initialized');
  }

  /**
   * Record human feedback for a ticket deliverable
   * @param {Object} params
   * @param {string} params.ticketId - Ticket that was reviewed
   * @param {string} params.agentId - Agent who produced the deliverable
   * @param {string} params.verdict - 'approve' | 'revise' | 'reject'
   * @param {string} [params.comment] - Optional human comment
   * @param {string} [params.reviewer] - Who gave the feedback
   */
  async recordFeedback(params) {
    const { ticketId, agentId, verdict, comment = '', reviewer = 'human' } = params;
    const now = Date.now();

    logger.info(`[FeedbackLoop] ${reviewer} → ${agentId}: ${verdict} on ticket ${ticketId}`);

    if (!this.redis) return;

    try {
      const entry = JSON.stringify({
        ticketId, agentId, verdict, comment: comment.substring(0, 500),
        reviewer, ts: now,
      });

      // Per-agent feedback history
      await this.redis.zadd(`${this.prefix}agent:${agentId}`, now, entry);
      await this.redis.expire(`${this.prefix}agent:${agentId}`, 7 * 86400); // 7 day retention

      // Per-ticket feedback
      await this.redis.zadd(`${this.prefix}ticket:${ticketId}`, now, entry);
      await this.redis.expire(`${this.prefix}ticket:${ticketId}`, 7 * 86400);

      // Global feedback log
      await this.redis.zadd(`${this.prefix}global`, now, entry);

      // Update agent quality score in AgentMetricsService
      if (this.agentMetrics) {
        const score = verdict === VERDICT.APPROVE ? 1.0 
                    : verdict === VERDICT.REVISE ? 0.5 
                    : 0.0;
        // Record as a gate result (pass for approve, fail for reject)
        await this.agentMetrics.recordGateResult(agentId, verdict === VERDICT.REJECT ? 'fail' : 'pass');
      }
    } catch (err) {
      logger.warn(`[FeedbackLoop] Redis write failed: ${err.message}`);
    }
  }

  /**
   * Analyze a comment text and extract verdict (if any)
   * @param {string} commentText - Human comment
   * @returns {string|null} Detected verdict or null
   */
  detectVerdict(commentText) {
    if (!commentText) return null;
    const lower = commentText.toLowerCase();

    // Check reject first (strongest signal)
    for (const kw of VERDICT_KEYWORDS.reject) {
      if (lower.includes(kw)) return VERDICT.REJECT;
    }
    // Then approve
    for (const kw of VERDICT_KEYWORDS.approve) {
      if (lower.includes(kw)) return VERDICT.APPROVE;
    }
    // Then revise
    for (const kw of VERDICT_KEYWORDS.revise) {
      if (lower.includes(kw)) return VERDICT.REVISE;
    }

    return null;
  }

  /**
   * Get feedback summary for an agent
   */
  async getAgentFeedback(agentId) {
    if (!this.redis) return { agentId, approvals: 0, revisions: 0, rejections: 0, total: 0 };

    try {
      const entries = await this.redis.zrangebyscore(`${this.prefix}agent:${agentId}`, '-inf', '+inf');
      let approvals = 0, revisions = 0, rejections = 0;

      for (const raw of entries) {
        try {
          const e = JSON.parse(raw);
          if (e.verdict === VERDICT.APPROVE) approvals++;
          else if (e.verdict === VERDICT.REVISE) revisions++;
          else if (e.verdict === VERDICT.REJECT) rejections++;
        } catch { /* skip */ }
      }

      const total = approvals + revisions + rejections;
      return {
        agentId,
        approvals,
        revisions,
        rejections,
        total,
        approvalRate: total > 0 ? Math.round((approvals / total) * 100) : 0,
        qualityScore: total > 0 ? Math.round(((approvals * 1.0 + revisions * 0.5) / total) * 100) : 0,
      };
    } catch {
      return { agentId, approvals: 0, revisions: 0, rejections: 0, total: 0 };
    }
  }

  /**
   * Get global feedback summary
   */
  async getGlobalFeedback() {
    if (!this.redis) return { total: 0, byAgent: {} };

    try {
      const entries = await this.redis.zrangebyscore(`${this.prefix}global`, '-inf', '+inf');
      const byAgent = {};
      let total = 0;

      for (const raw of entries) {
        try {
          const e = JSON.parse(raw);
          if (!byAgent[e.agentId]) {
            byAgent[e.agentId] = { approvals: 0, revisions: 0, rejections: 0 };
          }
          if (e.verdict === VERDICT.APPROVE) byAgent[e.agentId].approvals++;
          else if (e.verdict === VERDICT.REVISE) byAgent[e.agentId].revisions++;
          else if (e.verdict === VERDICT.REJECT) byAgent[e.agentId].rejections++;
          total++;
        } catch { /* skip */ }
      }

      return { total, byAgent };
    } catch {
      return { total: 0, byAgent: {} };
    }
  }
}

module.exports = FeedbackLoopService;
module.exports.VERDICT = VERDICT;
