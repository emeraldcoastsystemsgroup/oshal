/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * AdaptiveComplexityService — GAP H: Dynamic Complexity Scoring
 * 
 * Replaces static low/medium/high complexity with dynamic scoring based on:
 * 1. Ticket history — similar tickets' actual processing time
 * 2. Agent performance — how agents scored on similar work
 * 3. Content analysis — description length, technical keywords, attachment count
 * 4. Historical escalation rate — how often similar tickets escalated
 * 
 * Output: A numeric complexity score (1-10) instead of categorical low/med/high.
 * This feeds into CompetencyRanker for better agent selection.
 * 
 * Created: 2026-02-19 — Sprint 3, GAP H
 */

const logger = require('../../utils/logger');

// Technical keywords that indicate higher complexity
const COMPLEXITY_INDICATORS = {
  high: [
    'architecture', 'migration', 'refactor', 'security', 'performance', 'scalability',
    'kubernetes', 'deployment', 'infrastructure', 'database', 'distributed', 'microservices',
    'authentication', 'authorization', 'encryption', 'compliance', 'multi-tenant',
    'integration', 'real-time', 'machine learning', 'pipeline', 'cicd', 'terraform',
  ],
  medium: [
    'api', 'endpoint', 'bug', 'feature', 'implement', 'create', 'update', 'test',
    'configure', 'service', 'component', 'module', 'workflow', 'automation',
    'dashboard', 'monitoring', 'logging', 'debugging', 'optimization',
  ],
  low: [
    'typo', 'readme', 'documentation', 'comment', 'rename', 'label', 'description',
    'format', 'style', 'spacing', 'changelog', 'version', 'tag', 'status',
  ],
};

/**
 * @description Computes a dynamic, numeric complexity score (1-10) for a ticket
 * so downstream agent selection can move beyond coarse low/medium/high buckets.
 * Scores blend three weighted signals — live content analysis, historical
 * processing time for similar work, and the escalation rate of similar tickets —
 * and learn over time as outcomes are recorded back into Redis. Redis is optional:
 * when absent the service degrades gracefully to content-only scoring.
 */
class AdaptiveComplexityService {
  /**
   * @description Initialize the service with an optional Redis client used for
   * historical learning; without it, scoring falls back to content analysis only.
   * @param {Object} redis - Redis client (or null) for outcome storage/lookups.
   */
  constructor(redis) {
    this.redis = redis;
    this.prefix = 'complexity:';

    logger.info('[AdaptiveComplexity] Service initialized');
  }

  /**
   * Score a ticket's complexity dynamically (1-10)
   * 
   * @param {Object} ticket - Plane ticket
   * @param {Object} [history] - Optional historical data
   * @returns {Promise<Object>} { score, level, factors, confidence }
   */
  async scoreTicket(ticket, history = null) {
    const factors = {};
    let totalScore = 0;
    let factorCount = 0;

    // Factor 1: Content analysis (always available)
    const contentScore = this._analyzeContent(ticket);
    factors.content = contentScore;
    totalScore += contentScore.score * 2; // Weight: 2x
    factorCount += 2;

    // Factor 2: Historical processing time for similar tickets
    if (this.redis) {
      try {
        const histScore = await this._getHistoricalScore(ticket);
        if (histScore) {
          factors.historical = histScore;
          totalScore += histScore.score * 3; // Weight: 3x (strongest signal)
          factorCount += 3;
        }
      } catch { /* skip historical */ }
    }

    // Factor 3: Escalation rate for similar work
    if (this.redis) {
      try {
        const escScore = await this._getEscalationScore(ticket);
        if (escScore) {
          factors.escalation = escScore;
          totalScore += escScore.score;
          factorCount++;
        }
      } catch { /* skip */ }
    }

    // Calculate final score (1-10)
    const rawScore = factorCount > 0 ? totalScore / factorCount : 5;
    const score = Math.max(1, Math.min(10, Math.round(rawScore)));

    // Map to categorical level for backwards compatibility
    const level = score <= 3 ? 'low' : score <= 6 ? 'medium' : 'high';

    const result = {
      score,
      level,
      factors,
      confidence: factorCount >= 4 ? 'high' : factorCount >= 2 ? 'medium' : 'low',
      method: 'adaptive',
    };

    logger.info(`[AdaptiveComplexity] Ticket "${(ticket.name || '').substring(0, 50)}" → score=${score}/10 (${level}), confidence=${result.confidence}`);

    return result;
  }

  /**
   * Record actual processing outcome for future learning
   * @param {Object} params
   * @param {string} params.ticketId - Ticket ID
   * @param {string} params.title - Ticket title
   * @param {number} params.processingTimeMs - Actual processing time
   * @param {number} params.phaseCount - How many phases were used
   * @param {boolean} params.escalated - Whether ticket escalated
   * @param {string[]} params.categories - Ticket categories/tags
   */
  async recordOutcome(params) {
    const { ticketId, title = '', processingTimeMs, phaseCount, escalated, categories = [] } = params;

    if (!this.redis) return;

    try {
      const keywords = this._extractKeywords(title);
      const entry = JSON.stringify({
        ticketId, processingTimeMs, phaseCount, escalated,
        keywords, categories, ts: Date.now(),
      });

      // Store by keywords for future similarity matching
      for (const kw of keywords.slice(0, 5)) {
        await this.redis.zadd(`${this.prefix}keyword:${kw}`, Date.now(), entry);
        await this.redis.expire(`${this.prefix}keyword:${kw}`, 30 * 86400); // 30 day retention
      }

      // Global outcomes for aggregate stats
      await this.redis.zadd(`${this.prefix}outcomes`, Date.now(), entry);

      logger.debug(`[AdaptiveComplexity] Recorded outcome for ticket ${ticketId}: ${processingTimeMs}ms, ${phaseCount} phases, escalated=${escalated}`);
    } catch (err) {
      logger.warn(`[AdaptiveComplexity] Record outcome failed: ${err.message}`);
    }
  }

  /**
   * Analyze ticket content for complexity signals
   */
  _analyzeContent(ticket) {
    const text = `${ticket.name || ''} ${ticket.description_stripped || ''}`.toLowerCase();
    const wordCount = text.split(/\s+/).length;

    let highCount = 0, medCount = 0, lowCount = 0;

    for (const kw of COMPLEXITY_INDICATORS.high) {
      if (text.includes(kw)) highCount++;
    }
    for (const kw of COMPLEXITY_INDICATORS.medium) {
      if (text.includes(kw)) medCount++;
    }
    for (const kw of COMPLEXITY_INDICATORS.low) {
      if (text.includes(kw)) lowCount++;
    }

    // Length-based scoring
    let lengthScore = wordCount < 20 ? 2 : wordCount < 100 ? 4 : wordCount < 300 ? 6 : 8;

    // Keyword-based scoring
    let keywordScore = 5; // neutral default
    if (highCount >= 3) keywordScore = 9;
    else if (highCount >= 1) keywordScore = 7;
    else if (medCount >= 3) keywordScore = 6;
    else if (lowCount >= 2 && highCount === 0) keywordScore = 3;
    else if (lowCount >= 1 && highCount === 0 && medCount === 0) keywordScore = 2;

    // Average of length and keyword scores
    const score = Math.round((lengthScore + keywordScore) / 2);

    return {
      score,
      wordCount,
      highKeywords: highCount,
      medKeywords: medCount,
      lowKeywords: lowCount,
    };
  }

  /**
   * Look up historical processing times for tickets with similar keywords
   */
  async _getHistoricalScore(ticket) {
    const keywords = this._extractKeywords(ticket.name || '');
    if (keywords.length === 0) return null;

    let totalTime = 0, count = 0;

    for (const kw of keywords.slice(0, 3)) {
      try {
        const entries = await this.redis.zrangebyscore(`${this.prefix}keyword:${kw}`, '-inf', '+inf');
        for (const raw of entries) {
          try {
            const e = JSON.parse(raw);
            if (e.processingTimeMs) {
              totalTime += e.processingTimeMs;
              count++;
            }
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    if (count === 0) return null;

    const avgTimeMs = totalTime / count;
    // Map processing time to complexity score
    // < 30s = simple (2), 30s-2min = medium (5), > 2min = complex (8)
    const score = avgTimeMs < 30000 ? 2
      : avgTimeMs < 60000 ? 4
      : avgTimeMs < 120000 ? 6
      : avgTimeMs < 300000 ? 8
      : 10;

    return { score, avgTimeMs: Math.round(avgTimeMs), sampleSize: count };
  }

  /**
   * Check escalation rate for similar tickets
   */
  async _getEscalationScore(ticket) {
    const keywords = this._extractKeywords(ticket.name || '');
    if (keywords.length === 0) return null;

    let escalated = 0, total = 0;

    for (const kw of keywords.slice(0, 3)) {
      try {
        const entries = await this.redis.zrangebyscore(`${this.prefix}keyword:${kw}`, '-inf', '+inf');
        for (const raw of entries) {
          try {
            const e = JSON.parse(raw);
            if (e.escalated) escalated++;
            total++;
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }

    if (total === 0) return null;

    const escalationRate = escalated / total;
    // High escalation = high complexity
    const score = escalationRate < 0.1 ? 2
      : escalationRate < 0.3 ? 5
      : escalationRate < 0.5 ? 7
      : 9;

    return { score, escalationRate: Math.round(escalationRate * 100), sampleSize: total };
  }

  /**
   * Extract meaningful keywords from text
   */
  _extractKeywords(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .filter(w => !['this', 'that', 'with', 'from', 'have', 'been', 'will', 'should', 'would', 'could', 'about'].includes(w))
      .slice(0, 10);
  }
}

module.exports = AdaptiveComplexityService;
