/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * DATE         | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-063 §eval-wall — lock down the
 *              | green-wall rollup + success-rate trend math (honest-null + per-day bucketing).
 */

/**
 * @description
 * Unit tests for the eval-wall pure functions: computeGreenWall (the green-wall rollup) and
 * computeEvalTrend (the per-day success-rate sparkline). Both are pure (no DB), and the whole
 * point of the wall is that unmeasured fields stay NULL rather than becoming a fabricated 0 — so
 * these tests pin that "honest-null" contract as much as the arithmetic.
 */

import {
  computeGreenWall,
  computeEvalTrend,
  type EvalRun,
} from '../../src/features/operational-intelligence/eval-results-store';

/** Minimal EvalRun factory — everything unmeasured (null) unless overridden. */
function run(over: Partial<EvalRun> = {}): EvalRun {
  return {
    scenario: 'scn',
    state: 'pass',
    heuristicScore: null,
    judgeScore: null,
    finalScore: null,
    passed: true,
    latencyMs: null,
    retries: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    securityFindings: null,
    ...over,
  };
}

describe('computeGreenWall', () => {
  it('returns all-null honest rollup with clean posture when there are no runs', () => {
    const w = computeGreenWall([]);
    expect(w.totalRuns).toBe(0);
    expect(w.successRate).toBeNull();
    expect(w.avgLatencyMs).toBeNull();
    expect(w.avgRetries).toBeNull();
    expect(w.totalCostUsd).toBeNull();
    expect(w.avgQuality).toBeNull();
    expect(w.postureSummary).toEqual({ totalSecurityFindings: null, runsWithFindings: 0, clean: true });
  });

  it('computes success rate as passed / total', () => {
    const w = computeGreenWall([run({ passed: true }), run({ passed: false, state: 'fail' }), run({ passed: true })]);
    expect(w.totalRuns).toBe(3);
    expect(w.successRate).toBeCloseTo(2 / 3, 5);
  });

  it('keeps unmeasured numeric aggregates NULL (no fabricated 0)', () => {
    // Cost/latency unreported on every run → the rollup must be null, not 0.
    const w = computeGreenWall([run({ finalScore: 80 }), run({ finalScore: 90 })]);
    expect(w.totalCostUsd).toBeNull();
    expect(w.avgLatencyMs).toBeNull();
    expect(w.avgRetries).toBeNull();
    // Quality WAS reported on both → real mean.
    expect(w.avgQuality).toBeCloseTo(85, 5);
  });

  it('averages only the runs that reported a field, ignoring nulls', () => {
    const w = computeGreenWall([run({ latencyMs: 100 }), run({ latencyMs: null }), run({ latencyMs: 300 })]);
    expect(w.avgLatencyMs).toBeCloseTo(200, 5); // (100 + 300) / 2, the null is skipped
  });

  it('sums cost across runs that reported it', () => {
    const w = computeGreenWall([run({ costUsd: 0.01 }), run({ costUsd: 0.02 }), run({ costUsd: null })]);
    expect(w.totalCostUsd).toBeCloseTo(0.03, 6);
  });

  it('flags posture not-clean when any run reports security findings', () => {
    const w = computeGreenWall([run({ securityFindings: 0 }), run({ securityFindings: 2 })]);
    expect(w.postureSummary.clean).toBe(false);
    expect(w.postureSummary.runsWithFindings).toBe(1);
    expect(w.postureSummary.totalSecurityFindings).toBe(2);
  });
});

describe('computeEvalTrend', () => {
  it('buckets runs by UTC day, oldest first, with per-day success rate', () => {
    const t = computeEvalTrend([
      run({ runAt: '2026-06-20T05:00:00.000Z', passed: true, finalScore: 90 }),
      run({ runAt: '2026-06-20T06:00:00.000Z', passed: false, state: 'fail', finalScore: 50 }),
      run({ runAt: '2026-06-21T05:00:00.000Z', passed: true, finalScore: 80 }),
    ]);
    expect(t.map((p) => p.date)).toEqual(['2026-06-20', '2026-06-21']);
    expect(t[0]).toMatchObject({ date: '2026-06-20', total: 2, passed: 1 });
    expect(t[0].successRate).toBeCloseTo(0.5, 5);
    expect(t[0].avgQuality).toBeCloseTo(70, 5); // (90 + 50) / 2
    expect(t[1]).toMatchObject({ date: '2026-06-21', total: 1, passed: 1 });
    expect(t[1].successRate).toBe(1);
  });

  it('omits runs without a runAt and reports null quality when none scored', () => {
    const t = computeEvalTrend([
      run({ runAt: undefined, passed: true }),
      run({ runAt: '2026-06-21T05:00:00.000Z', passed: true, finalScore: null }),
    ]);
    expect(t).toHaveLength(1);
    expect(t[0].date).toBe('2026-06-21');
    expect(t[0].avgQuality).toBeNull();
  });

  it('returns an empty trend for no runs', () => {
    expect(computeEvalTrend([])).toEqual([]);
  });
});
