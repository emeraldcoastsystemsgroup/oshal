/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — dynamic deep-dive budget meter. Allocates the per-pulse LLM classify budget across feeds by a learned novelty signal (online bandit: exploit high-yield feeds, keep an exploration floor so none starves). Pure + unit-testable.
 */

/**
 * DEEP-DIVE BUDGET METER — decide how much of the (expensive, finite) LLM classify budget each feed gets
 * THIS pulse, learned from how novel each feed has been recently.
 *
 * The reward signal is each feed's NOVELTY = new / fetched over a recent window (already recorded in
 * `world_pulls`): a feed that keeps surfacing genuinely-new items earns more budget; a feed that recycles
 * the same headlines earns less. An EXPLORATION FLOOR keeps every feed sampled (so a feed that goes quiet
 * then breaks news isn't permanently starved) — i.e. an epsilon-greedy / softmax-style online bandit, not
 * a static split. Pure (no I/O) so the allocation math is unit-testable.
 */

export interface FeedNovelty { fetched: number; newItems: number; novelty: number; }

/** Exploration floor added to every feed's weight (so unproven/quiet feeds still get sampled). */
const EXPLORE_FLOOR = 0.25;
/** Optimistic novelty for a feed with no history yet — encourages trying new feeds. */
const COLD_NOVELTY = 0.6;

/**
 * @description Allocate `budget` classify slots across `feedIds` by recent novelty.
 * @param feedIds - The feeds in play this pulse.
 * @param novelty - Per-feed recent {fetched,newItems,novelty}; missing = cold (optimistic).
 * @param opts - budget (total slots), floor (min per feed), cap (max per feed), metered (false = even split).
 * @returns Map feedId → integer slot budget (sums ≈ budget, each within [floor, cap]).
 */
export function meterFeeds(
  feedIds: string[],
  novelty: Map<string, FeedNovelty>,
  opts: { budget: number; floor?: number; cap?: number; metered?: boolean },
): Map<string, number> {
  const out = new Map<string, number>();
  const n = feedIds.length;
  if (n === 0 || opts.budget <= 0) { for (const id of feedIds) out.set(id, 0); return out; }

  // Budget-aware floor: a fixed floor × N feeds can exceed the budget (e.g. floor 3 × 20 feeds = 60
  // slots for a budget of 3). Cap the floor at the per-feed even share so the floors alone can't
  // blow the budget.
  const floor = Math.min(Math.max(0, opts.floor ?? 3), Math.floor(opts.budget / n));
  const cap = Math.max(floor, opts.cap ?? Math.ceil(opts.budget / 2));

  // Even split when metering is off (or as the degenerate weighting).
  if (opts.metered === false) {
    const per = Math.max(floor, Math.min(cap, Math.floor(opts.budget / n)));
    for (const id of feedIds) out.set(id, per);
    return trimToBudget(out, feedIds, opts.budget);
  }

  // Weight = exploration floor + recent novelty (cold feeds optimistic). Allocate budget ∝ weight.
  const weights = feedIds.map((id) => {
    const nov = novelty.get(id);
    const score = nov ? nov.novelty : COLD_NOVELTY;
    return EXPLORE_FLOOR + Math.max(0, Math.min(1, score));
  });
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  feedIds.forEach((id, i) => {
    const raw = (weights[i] / total) * opts.budget;
    out.set(id, Math.max(floor, Math.min(cap, Math.round(raw))));
  });
  return trimToBudget(out, feedIds, opts.budget);
}

/**
 * @description Trim per-feed slots so their sum never exceeds the total budget. Rounding + per-feed
 * floors can push the sum over budget; shave one slot at a time from the largest allocations (never
 * below 0) until the sum fits.
 * @param out - Per-feed slot map to adjust in place.
 * @param feedIds - The feeds in allocation order.
 * @param budget - Total slot budget the sum must not exceed.
 * @returns The same map, trimmed to budget.
 */
function trimToBudget(out: Map<string, number>, feedIds: string[], budget: number): Map<string, number> {
  let sum = 0;
  for (const id of feedIds) sum += out.get(id) || 0;
  while (sum > budget) {
    // Find the feed with the most slots and shave one (deterministic: first max wins).
    let maxId = feedIds[0];
    let maxVal = out.get(maxId) || 0;
    for (const id of feedIds) {
      const v = out.get(id) || 0;
      if (v > maxVal) { maxVal = v; maxId = id; }
    }
    if (maxVal <= 0) break; // nothing left to trim
    out.set(maxId, maxVal - 1);
    sum -= 1;
  }
  return out;
}
