/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Token Chase step 5: end-to-end SAVINGS aggregation over graded variant replays — the real estimated-vs-actual number (replaces the hardcoded demo). Pure + unit-tested; consumed by the corpus read and the whole-run loop.
 */

import type { VariantReplayResult } from './token-chase-optimize-service';

/**
 * @description One graded frame's cost outcome, flattened to just what a savings roll-up needs.
 * Sourced either from the corpus (persisted rows) or from a live run's replay results.
 */
export interface SavingsRow {
  baselineCostUsd: number | null;
  variantCostUsd: number | null;
  tier: string | null;
  equivalent: boolean | null;
}

/**
 * @description Estimated-vs-actual savings over a set of graded variant replays. `realizableSavedUsd`
 * is the HONEST number: only `equivalent-cheaper` frames (same answer within tolerance, lower cost) can
 * be swapped with zero quality risk, so only their savings count toward what you can actually bank.
 * The total baseline/variant costs are reported for context; divergent frames are counted, not banked.
 */
export interface SavingsSummary {
  scope: 'run' | 'all';
  runId?: string;
  /** Graded frames considered (a real baseline-vs-variant comparison existed). */
  observations: number;
  /** Sum of baseline (as-run) costs across graded frames. */
  baselineCostUsd: number;
  /** Sum of variant (cheaper-lane) costs across graded frames. */
  variantCostUsd: number;
  /** Dollars saved by applying ONLY the zero-risk equivalent-cheaper swaps. */
  realizableSavedUsd: number;
  /** Realizable savings as a percent of the baseline cost of the swappable frames (null if none). */
  realizablePct: number | null;
  /** Frame outcome breakdown. */
  tiers: { equivalentCheaper: number; equivalentPricier: number; divergent: number };
  currency: 'USD';
}

/** Round to 6 dp (the corpus stores NUMERIC(12,6)) to avoid float dust in the payload. */
function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function num(v: number | null | undefined): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * @description Roll graded frames into a SavingsSummary. Only equivalent-cheaper frames contribute to
 * realizable savings; equivalent-pricier and divergent frames are counted but never banked.
 * @param rows - flattened graded frames (from the corpus or a live run)
 * @param scope - 'run' for one run, 'all' for the caller's whole corpus
 * @param runId - the run id when scope === 'run'
 * @returns the savings roll-up
 */
export function aggregateSavingsRows(rows: SavingsRow[], scope: 'run' | 'all', runId?: string): SavingsSummary {
  let baselineCostUsd = 0;
  let variantCostUsd = 0;
  let realizableSavedUsd = 0;
  let realizableBaseline = 0;
  const tiers = { equivalentCheaper: 0, equivalentPricier: 0, divergent: 0 };

  for (const r of rows) {
    const b = num(r.baselineCostUsd);
    const v = num(r.variantCostUsd);
    baselineCostUsd += b;
    variantCostUsd += v;
    if (r.tier === 'equivalent-cheaper') {
      tiers.equivalentCheaper += 1;
      realizableSavedUsd += Math.max(0, b - v);
      realizableBaseline += b;
    } else if (r.tier === 'equivalent-pricier') {
      tiers.equivalentPricier += 1;
    } else if (r.tier === 'divergent') {
      tiers.divergent += 1;
    }
  }

  return {
    scope,
    ...(runId ? { runId } : {}),
    observations: rows.length,
    baselineCostUsd: round6(baselineCostUsd),
    variantCostUsd: round6(variantCostUsd),
    realizableSavedUsd: round6(realizableSavedUsd),
    realizablePct: realizableBaseline > 0 ? Math.round((realizableSavedUsd / realizableBaseline) * 100) : null,
    tiers,
    currency: 'USD',
  };
}

/**
 * @description Flatten a live run's graded variant replay results into savings rows (skips frames that
 * were excluded/errored and never produced a graded diff).
 * @param results - variant replay results from a whole-run loop
 * @returns the savings rows to aggregate
 */
export function resultsToSavingsRows(results: VariantReplayResult[]): SavingsRow[] {
  return results
    .filter((r) => r.variant && r.diff && r.tier)
    .map((r) => ({
      baselineCostUsd: r.baseline?.costUsd ?? null,
      variantCostUsd: r.variant?.costUsd ?? null,
      tier: r.tier,
      equivalent: r.diff?.equivalent ?? null,
    }));
}
