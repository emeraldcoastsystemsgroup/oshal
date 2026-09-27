/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com | Direct-path metrics fold, extracted from TaskController.processMessage (which is over the file cap and must not grow). The direct path recorded only totalTokens, so chat_tasks could not show an input-token saving and a provider that reported no total produced NaN. The fold now carries the input/output split, the endpoint-reported cached-token count and the invariant-cache state, and it counts a turn served from a cache handle as a cache hit.
 */

/** @param {unknown} value @returns {number} A non-negative finite count, else 0. */
function toCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** @param {unknown} value @returns {number} A finite amount, else 0. */
function toAmount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * @description Fold one direct-path provider response into a task's running apiMetrics. The
 * result is the full replacement metrics object TaskController.updateMetrics merges in.
 *
 * `totalTokens` prefers the endpoint-reported total (Google counts thinking tokens there and
 * nowhere else) and falls back to input + output. `cacheReads` is the endpoint-reported count of
 * prompt tokens served from a cache; a turn with any is a cache hit, as is a turn the provider
 * reports as served from an invariant-preamble handle, so `cacheHits` reads the same on both
 * the agentic and the direct path.
 * @param {Object} [apiMetrics] - The task's current apiMetrics (may be empty).
 * @param {{usage?: Object, cost?: number, promptCache?: string}} response - The provider response.
 * @returns {{totalTokens:number,totalCost:number,requestCount:number,inputTokens:number,outputTokens:number,cacheReads:number,cacheHits:number,promptCache?:string}}
 */
function mergeDirectResponseMetrics(apiMetrics, response) {
  const current = apiMetrics || {};
  const usage = (response && response.usage) || {};
  const inputTokens = toCount(usage.inputTokens);
  const outputTokens = toCount(usage.outputTokens);
  const cacheReads = toCount(usage.cacheReads !== undefined ? usage.cacheReads : usage.cacheReadTokens);
  const totalTokens = toCount(usage.totalTokens) || inputTokens + outputTokens;
  const promptCache = typeof response?.promptCache === 'string' ? response.promptCache : null;
  const servedFromHandle = promptCache === 'hit' || promptCache === 'created';
  return {
    totalTokens: toCount(current.totalTokens) + totalTokens,
    totalCost: toAmount(current.totalCost) + toAmount(response && response.cost),
    requestCount: toCount(current.requestCount) + 1,
    inputTokens: toCount(current.inputTokens) + inputTokens,
    outputTokens: toCount(current.outputTokens) + outputTokens,
    cacheReads: toCount(current.cacheReads) + cacheReads,
    cacheHits: toCount(current.cacheHits) + (cacheReads > 0 || servedFromHandle ? 1 : 0),
    ...(promptCache ? { promptCache } : {}),
  };
}

module.exports = { mergeDirectResponseMetrics };
