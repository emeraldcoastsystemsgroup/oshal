/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | ADR-063 — computeGreenWall rollup
 *            | math + honest-null behaviour (no fabricated numbers when fields are missing).
 */

import { test, expect } from '@playwright/test';
import { computeGreenWall, type EvalRun } from '@/features/operational-intelligence/eval-results-store';

function run(partial: Partial<EvalRun>): EvalRun {
  return {
    scenario: 's',
    state: 'pass',
    heuristicScore: null,
    judgeScore: null,
    finalScore: null,
    passed: false,
    latencyMs: null,
    retries: null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
    securityFindings: null,
    notes: null,
    ...partial,
  };
}

test.describe('computeGreenWall — rollup math + honest nulls', () => {
  test('empty input returns nulls (not fabricated zeros) and clean posture', () => {
    const w = computeGreenWall([]);
    expect(w.totalRuns).toBe(0);
    expect(w.successRate).toBeNull();
    expect(w.avgLatencyMs).toBeNull();
    expect(w.avgRetries).toBeNull();
    expect(w.totalCostUsd).toBeNull();
    expect(w.avgQuality).toBeNull();
    expect(w.postureSummary.totalSecurityFindings).toBeNull();
    expect(w.postureSummary.clean).toBe(true);
  });

  test('success rate, averages, and cost sum compute correctly', () => {
    const runs = [
      run({ passed: true, latencyMs: 100, retries: 0, costUsd: 0.01, finalScore: 90, securityFindings: 0 }),
      run({ passed: false, latencyMs: 300, retries: 2, costUsd: 0.03, finalScore: 50, securityFindings: 0 }),
    ];
    const w = computeGreenWall(runs);
    expect(w.totalRuns).toBe(2);
    expect(w.successRate).toBe(0.5);
    expect(w.avgLatencyMs).toBe(200);
    expect(w.avgRetries).toBe(1);
    expect(w.totalCostUsd).toBeCloseTo(0.04, 6);
    expect(w.avgQuality).toBe(70);
    expect(w.postureSummary.clean).toBe(true);
    expect(w.postureSummary.runsWithFindings).toBe(0);
  });

  test('averages ignore null fields and stay null when NONE report a field', () => {
    const runs = [
      run({ passed: true, latencyMs: 120, costUsd: null }),   // cost unmeasured
      run({ passed: true, latencyMs: null, costUsd: null }),  // latency + cost unmeasured
    ];
    const w = computeGreenWall(runs);
    expect(w.successRate).toBe(1);
    // avgLatency = only the one measured value (120), not (120+0)/2.
    expect(w.avgLatencyMs).toBe(120);
    // No run reported cost -> null, not 0.
    expect(w.totalCostUsd).toBeNull();
    // No run reported retries / quality -> null.
    expect(w.avgRetries).toBeNull();
    expect(w.avgQuality).toBeNull();
  });

  test('security posture is non-clean when any run reports findings', () => {
    const runs = [
      run({ passed: true, securityFindings: 0 }),
      run({ passed: true, securityFindings: 3 }),
    ];
    const w = computeGreenWall(runs);
    expect(w.postureSummary.totalSecurityFindings).toBe(3);
    expect(w.postureSummary.runsWithFindings).toBe(1);
    expect(w.postureSummary.clean).toBe(false);
  });
});
