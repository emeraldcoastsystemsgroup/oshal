/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Documentation backfill: added file-header change log block and JSDoc on exported members
 */

/**
 * Token Tracker
 * Tracks token usage across LLM requests
 */

/**
 * @description Accumulates LLM token usage so callers can observe cost and
 * cache effectiveness over the lifetime of a session. Centralizing the running
 * totals and per-request history in one stateful object lets the rest of the
 * system report spend, detect cache regressions, and surface usage stats
 * without each call site having to maintain its own counters.
 */
class TokenTracker {
  constructor() {
    this.reset();
  }

  /**
   * Reset tracker
   */
  reset() {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCacheWrites = 0;
    this.totalCacheReads = 0;
    this.requestCount = 0;
    this.history = [];
  }

  /**
   * Track a request
   */
  track(usage) {
    const {
      inputTokens = 0,
      outputTokens = 0,
      cacheWrites = 0,
      cacheReads = 0,
      cost = 0,
      model = 'unknown',
      timestamp = Date.now(),
    } = usage;

    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCacheWrites += cacheWrites;
    this.totalCacheReads += cacheReads;
    this.requestCount++;

    const entry = {
      requestNumber: this.requestCount,
      inputTokens,
      outputTokens,
      cacheWrites,
      cacheReads,
      cost,
      model,
      timestamp,
    };

    this.history.push(entry);

    return entry;
  }

  /**
   * Get totals
   */
  getTotals() {
    return {
      inputTokens: this.totalInputTokens,
      outputTokens: this.totalOutputTokens,
      totalTokens: this.totalInputTokens + this.totalOutputTokens,
      cacheWrites: this.totalCacheWrites,
      cacheReads: this.totalCacheReads,
      requestCount: this.requestCount,
    };
  }

  /**
   * Get history
   */
  getHistory() {
    return [...this.history];
  }

  /**
   * Get latest request
   */
  getLatest() {
    return this.history[this.history.length - 1] || null;
  }

  /**
   * Get cache efficiency
   */
  getCacheEfficiency() {
    const total = this.totalInputTokens + this.totalCacheWrites + this.totalCacheReads;
    if (total === 0) return 0;
    
    return Math.round((this.totalCacheReads / total) * 100);
  }

  /**
   * Get statistics
   */
  getStats() {
    const totals = this.getTotals();
    
    return {
      ...totals,
      averageInputTokens: this.requestCount > 0 ? Math.round(this.totalInputTokens / this.requestCount) : 0,
      averageOutputTokens: this.requestCount > 0 ? Math.round(this.totalOutputTokens / this.requestCount) : 0,
      cacheEfficiency: this.getCacheEfficiency(),
    };
  }
}

module.exports = TokenTracker;
