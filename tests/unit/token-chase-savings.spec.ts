import { describe, expect, it } from 'vitest';
import { aggregateSavingsRows, resultsToSavingsRows, type SavingsRow } from '../../src/features/token-chase/services/token-chase-savings';
import type { VariantReplayResult } from '../../src/features/token-chase/services/token-chase-optimize-service';

describe('token-chase savings aggregation', () => {
  it('banks only the zero-risk equivalent-cheaper swaps', () => {
    const rows: SavingsRow[] = [
      { baselineCostUsd: 0.10, variantCostUsd: 0.02, tier: 'equivalent-cheaper', equivalent: true }, // saves 0.08
      { baselineCostUsd: 0.05, variantCostUsd: 0.06, tier: 'equivalent-pricier', equivalent: true }, // costs more — skip
      { baselineCostUsd: 0.20, variantCostUsd: 0.03, tier: 'divergent', equivalent: false },         // cheaper but WRONG — never bank
    ];
    const s = aggregateSavingsRows(rows, 'run', 'run-1');

    expect(s.scope).toBe('run');
    expect(s.runId).toBe('run-1');
    expect(s.observations).toBe(3);
    expect(s.baselineCostUsd).toBeCloseTo(0.35, 6);
    expect(s.variantCostUsd).toBeCloseTo(0.11, 6);
    expect(s.realizableSavedUsd).toBeCloseTo(0.08, 6); // only the equivalent-cheaper frame
    expect(s.realizablePct).toBe(80);                  // 0.08 / 0.10
    expect(s.tiers).toEqual({ equivalentCheaper: 1, equivalentPricier: 1, divergent: 1 });
  });

  it('returns an all-zero summary for an empty corpus', () => {
    const s = aggregateSavingsRows([], 'all');
    expect(s).toMatchObject({ scope: 'all', observations: 0, baselineCostUsd: 0, variantCostUsd: 0, realizableSavedUsd: 0, realizablePct: null });
    expect(s.runId).toBeUndefined();
  });

  it('flattens graded run results and drops ungraded ones', () => {
    const results = [
      { runId: 'r', seq: 1, baseline: { costUsd: 0.10 }, variant: { costUsd: 0.02 }, diff: { equivalent: true }, tier: 'equivalent-cheaper' },
      { runId: 'r', seq: 2, baseline: null, variant: null, diff: null, tier: null }, // excluded frame — no grade
    ] as unknown as VariantReplayResult[];

    const rows = resultsToSavingsRows(results);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ baselineCostUsd: 0.10, variantCostUsd: 0.02, tier: 'equivalent-cheaper' });

    const s = aggregateSavingsRows(rows, 'run', 'r');
    expect(s.realizableSavedUsd).toBeCloseTo(0.08, 6);
    expect(s.tiers.equivalentCheaper).toBe(1);
  });
});
