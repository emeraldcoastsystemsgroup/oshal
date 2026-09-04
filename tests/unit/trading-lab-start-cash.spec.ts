/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Initial — capital-aware Lab backtests (operator 2026-09-04: "a $500K cash account should not backtest like $20K"). Pure guards: resolveStartCash honours a positive override and falls back to the $100K reference; metricsFor measures returns against the run's OWN starting capital (a $500K walk ending at $550K is +10%, not +450%); the SPY benchmark is rebased to the same capital; the default path is byte-identical to the pre-change reference.
 */
import { describe, it, expect } from 'vitest';
import { LAB_START_CASH, resolveStartCash, metricsFor, type EquityPoint, type WalkState } from '../../src/app/trading-strategy-lab-sim';

const state = (over: Partial<WalkState> = {}): WalkState => ({ cash: 0, lots: {}, coreQty: 0, barCount: 0, peakEquity: 0, maxDD: 0.1, wins: 3, losses: 1, trades: 4, lastDate: '2026-01-01', spyAnchor: 100, ...over });
const curve = (startCash: number, endMult: number, spyEndMult: number): EquityPoint[] => {
  const pts: EquityPoint[] = []; const n = 252;
  for (let i = 0; i < n; i++) { const f = i / (n - 1); pts.push({ d: `d${i}`, e: startCash * (1 + (endMult - 1) * f), s: startCash * (1 + (spyEndMult - 1) * f) }); }
  return pts;
};

describe('capital-aware Lab backtests', () => {
  it('resolveStartCash: positive override wins; anything else is the $100K reference', () => {
    expect(resolveStartCash({})).toBe(LAB_START_CASH);
    expect(resolveStartCash({ startCash: 461_972 })).toBe(461_972);
    expect(resolveStartCash({ startCash: 0 })).toBe(LAB_START_CASH);
    expect(resolveStartCash({ startCash: -5 })).toBe(LAB_START_CASH);
    expect(resolveStartCash({ startCash: Number.NaN })).toBe(LAB_START_CASH);
  });

  it('metricsFor measures the return against the run\'s OWN capital, not the reference', () => {
    const m500 = metricsFor(curve(500_000, 1.10, 1.05), state(), 500_000);
    expect(m500.totalReturnPct).toBeCloseTo(10, 5);
    expect(m500.spyReturnPct).toBeCloseTo(5, 5);
    expect(m500.alphaVsSpyPct).toBeCloseTo(5, 5);
    // The same curve read against the reference capital would claim +450% — the bug this guards.
    const wrong = metricsFor(curve(500_000, 1.10, 1.05), state());
    expect(wrong.totalReturnPct).toBeCloseTo(450, 5);
  });

  it('the default path is byte-identical to the reference (no third argument)', () => {
    const c = curve(LAB_START_CASH, 1.2, 1.1);
    expect(metricsFor(c, state())).toEqual(metricsFor(c, state(), LAB_START_CASH));
  });
});
