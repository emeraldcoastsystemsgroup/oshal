/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for mean-reversion regime gate (trading-advisor.md item 7): gate meanrev to range-bound regimes (|gap vs SMA| <= maxGap), stand down on steep selloffs and breakout rallies, tunable param bounds and optimizer grid integration.
 */
import { describe, it, expect } from 'vitest';
import {
  scoreSymbol,
  ensemble,
  DEFAULT_STRATEGY_PARAMS,
  type StrategyParams,
} from '../../src/features/trading';
import {
  TUNABLE_PARAMS,
  PARAM_LABELS,
  clampParam,
} from '../../src/app/trading-strategy-params';

/** Helper to generate steady baseline prices around a center value. */
function steadyCloses(center: number, count = 25): number[] {
  return Array.from({ length: count }, (_, i) => center + ((i % 2 === 0 ? 0.3 : -0.3)));
}

describe('mean-reversion regime gate (trading-advisor.md item 7)', () => {
  it('fires in range-bound regimes when RSI is oversold and gap is within maxGap', () => {
    // 25 bars around 100 with small oscillations, ending in a moderate dip to 98
    // SMA20 ~ 100. Gap = (98 - 100) / 100 = -2% (>= -4% maxGap)
    // Create an oversold sequence where price gently dips from 100 to 98
    const base = [
      100, 100.5, 99.8, 100.2, 100, 100.4, 99.7, 100.1, 100, 100.3,
      99.9, 100.2, 99.8, 100.1, 99.7, 99.5, 99.2, 98.9, 98.6, 98.4,
      98.2, 98.1, 98.0, 97.9, 97.8,
    ];
    const signals = scoreSymbol('RANGE_OVERSOLD', base);
    const meanrev = signals.find((s) => s.algo === 'meanrev');

    // Should fire 'up' because it is oversold within range (|gap| <= 4%)
    expect(meanrev).toBeDefined();
    expect(meanrev?.dir).toBe('up');
    expect(meanrev?.basis).toMatch(/RSI \d+ oversold/);
  });

  it('fires in range-bound regimes when RSI is overbought and gap is within maxGap', () => {
    // 25 bars around 100 with small oscillations, ending in a moderate pop to 102
    // SMA20 ~ 100. Gap = (102 - 100) / 100 = +2% (<= +4% maxGap)
    const base = [
      100, 99.5, 100.2, 99.8, 100, 99.6, 100.3, 99.9, 100, 99.7,
      100.1, 99.8, 100.2, 99.9, 100.3, 100.5, 100.8, 101.1, 101.4, 101.6,
      101.8, 101.9, 102.0, 102.1, 102.2,
    ];
    const signals = scoreSymbol('RANGE_OVERBOUGHT', base);
    const meanrev = signals.find((s) => s.algo === 'meanrev');

    // Should fire 'down' because it is overbought within range (|gap| <= 4%)
    expect(meanrev).toBeDefined();
    expect(meanrev?.dir).toBe('down');
    expect(meanrev?.basis).toMatch(/RSI \d+ overbought/);
  });

  it('stands down in a steep trending selloff, letting trend algos own the move', () => {
    // Sharp selloff: stock collapses from 100 to 88 over several bars
    // SMA20 will be around ~97, price = 88 -> gap ~ -9.3% (< -4% maxGap)
    // RSI will be deeply oversold (< 20)
    const selloff = [
      100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
      99, 98, 97, 96, 95, 94, 93, 91, 90, 89,
      88.5, 88.0, 87.5, 87.0, 86.5,
    ];
    const signals = scoreSymbol('SELLOFF', selloff);
    const meanrev = signals.find((s) => s.algo === 'meanrev');
    const momentum = signals.find((s) => s.algo === 'momentum');
    const donchian = signals.find((s) => s.algo === 'donchian');

    // Mean-reversion MUST stand down (return null) so it doesn't buy a falling knife
    expect(meanrev).toBeUndefined();

    // Trend algos must decisively vote down
    expect(momentum).toBeDefined();
    expect(momentum?.dir).toBe('down');
    expect(donchian).toBeDefined();
    expect(donchian?.dir).toBe('down');

    // The ensemble decision must be 'sell', not diluted into 'hold'
    const dec = ensemble(signals);
    expect(dec.action).toBe('sell');
    expect(dec.score).toBeLessThan(-DEFAULT_STRATEGY_PARAMS.ensembleThreshold);
  });

  it('stands down in a steep trending breakout, avoiding shorting the winner', () => {
    // Sharp breakout rally: stock explodes from 100 to 114 over several bars
    // SMA20 will be around ~103, price = 114 -> gap ~ +10.7% (> +4% maxGap)
    // RSI will be deeply overbought (> 80)
    const rally = [
      100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
      101, 102, 103, 104, 105, 106, 107, 109, 110, 111,
      112, 113, 114, 114.5, 115,
    ];
    const signals = scoreSymbol('RALLY', rally);
    const meanrev = signals.find((s) => s.algo === 'meanrev');
    const momentum = signals.find((s) => s.algo === 'momentum');
    const donchian = signals.find((s) => s.algo === 'donchian');

    // Mean-reversion MUST stand down (return null) so it doesn't fade the breakout
    expect(meanrev).toBeUndefined();

    // Trend algos must decisively vote up
    expect(momentum).toBeDefined();
    expect(momentum?.dir).toBe('up');
    expect(donchian).toBeDefined();
    expect(donchian?.dir).toBe('up');

    // The ensemble decision must be 'buy', not diluted into 'hold'
    const dec = ensemble(signals);
    expect(dec.action).toBe('buy');
    expect(dec.score).toBeGreaterThan(DEFAULT_STRATEGY_PARAMS.ensembleThreshold);
  });

  it('respects meanrevMaxTrendGap override in StrategyParams', () => {
    // Gap ~ -5.4%: between SMA20 (~97.3) and last price (92.0)
    const moderateSelloff = [
      100, 100, 100, 100, 100, 100, 100, 100, 100, 100,
      100, 100, 100, 100, 99, 98, 97, 96, 95.0, 94.0,
      93.5, 93.0, 92.5, 92.2, 92.0,
    ];

    // Under default maxGap = 0.04: gap exceeds 0.04 -> stands down
    const defaultSignals = scoreSymbol('TEST', moderateSelloff);
    expect(defaultSignals.find((s) => s.algo === 'meanrev')).toBeUndefined();

    // Under widened maxGap = 0.08: gap is within 0.08 -> fires
    const widenedParams: StrategyParams = {
      ...DEFAULT_STRATEGY_PARAMS,
      meanrevMaxTrendGap: 0.08,
    };
    const widenedSignals = scoreSymbol('TEST', moderateSelloff, undefined, 'SPY', widenedParams);
    const meanrevWidened = widenedSignals.find((s) => s.algo === 'meanrev');
    expect(meanrevWidened).toBeDefined();
    expect(meanrevWidened?.dir).toBe('up');

    // Under tight maxGap = 0.01: stands down even earlier
    const tightParams: StrategyParams = {
      ...DEFAULT_STRATEGY_PARAMS,
      meanrevMaxTrendGap: 0.01,
    };
    const tightSignals = scoreSymbol('TEST', moderateSelloff, undefined, 'SPY', tightParams);
    expect(tightSignals.find((s) => s.algo === 'meanrev')).toBeUndefined();
  });

  it('returns null if close history is too short for SMA20 (< 20 bars)', () => {
    const shortCloses = [100, 99, 98, 97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86];
    const signals = scoreSymbol('SHORT', shortCloses);
    expect(signals.find((s) => s.algo === 'meanrev')).toBeUndefined();
  });

  it('integrates with TUNABLE_PARAMS, PARAM_LABELS, and BOUNDS clamping', () => {
    expect(TUNABLE_PARAMS).toContain('meanrevMaxTrendGap');
    expect(PARAM_LABELS.meanrevMaxTrendGap).toBe('Mean-rev max trend gap');

    // Bounds: 0.01 to 0.20
    expect(clampParam('meanrevMaxTrendGap', 0.25)).toBe(0.20);
    expect(clampParam('meanrevMaxTrendGap', 0.005)).toBe(0.01);
    expect(clampParam('meanrevMaxTrendGap', 0.04567)).toBe(0.0457);
  });
});
