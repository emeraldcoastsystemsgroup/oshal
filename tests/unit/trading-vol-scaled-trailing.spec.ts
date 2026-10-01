/**
 * CHANGE LOG
 * -----------------------------------------------------------------------------
 * SEQ                 | AUTHOR                      | DESCRIPTION
 * -----------------------------------------------------------------------------
 * 1 | maintainer@emeraldcoastsystemsgroup.com   | Unit tests for volatility-scaled trailing stops (trading-advisor.md item 12): trailingExits giveback scaling with asset volatility, floor/cap limits, Map and Record inputs, and thin session multiplier interaction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  trailingExits,
  nextPeaks,
  RISK_POLICIES,
  type Position,
  type RiskPolicy,
} from '../../src/features/trading';

function pos(symbol: string, qty: number, avgEntryPrice: number, currentPrice: number, unmanaged = false): Position {
  return {
    symbol,
    qty,
    avgEntryPrice,
    currentPrice,
    marketValue: qty * currentPrice,
    unmanaged,
  };
}

describe('volatility-scaled trailing stops (trading-advisor.md item 12)', () => {
  const active: RiskPolicy = RISK_POLICIES.active; // trailArmPct: 5, trailGivebackPct: 3
  const origEnv = process.env.TRADING_BASELINE_VOL_PCT;

  beforeEach(() => {
    delete process.env.TRADING_BASELINE_VOL_PCT;
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.TRADING_BASELINE_VOL_PCT = origEnv;
    } else {
      delete process.env.TRADING_BASELINE_VOL_PCT;
    }
  });

  it('behaves identically to baseline when volPcts is omitted (volMult = 1)', () => {
    // Entry $100 -> Peak $110 (gain +10% >= 5% arm).
    // Now $106.3: giveback = (110 - 106.3) / 110 = 3.36% (>= 3% standard giveback) -> triggers trailing exit.
    const peaks = nextPeaks([pos('AAPL', 10, 100, 110)], new Map());
    const exits = trailingExits([pos('AAPL', 10, 100, 106.3)], peaks, active);
    expect(exits).toHaveLength(1);
    expect(exits[0].symbol).toBe('AAPL');
    expect(exits[0].reason).toBe('trailing_stop');

    // Now $107: giveback = (110 - 107) / 110 = 2.73% (< 3%) -> no exit.
    const exitsWiggle = trailingExits([pos('AAPL', 10, 100, 107)], peaks, active);
    expect(exitsWiggle).toHaveLength(0);
  });

  it('widens giveback threshold for high-volatility assets to prevent shakeout', () => {
    // Volatile stock (e.g. NVDA with daily vol = 6%, baseline = 2% -> volMult = 3.0x).
    // Required giveback = 3% * 3.0 = 9%.
    // Entry $100 -> Peak $130 (gain +30% >= 5% arm).
    const volMap = new Map<string, number>([['NVDA', 6.0]]);
    const peaks = nextPeaks([pos('NVDA', 10, 100, 130)], new Map());

    // Price pulls back from $130 to $124: giveback = (130 - 124) / 130 = 4.62% (gain is +24% >= 5%).
    // Under unscaled policy (3%), this 4.62% giveback would be stopped out.
    // Under vol-scaled policy (9%), this 4.62% wiggle is preserved!
    const unscaledExits = trailingExits([pos('NVDA', 10, 100, 124)], peaks, active);
    expect(unscaledExits).toHaveLength(1); // unscaled triggers premature exit

    const volScaledExits = trailingExits([pos('NVDA', 10, 100, 124)], peaks, active, 1, volMap);
    expect(volScaledExits).toHaveLength(0); // vol-scaled holds through the noise

    // Deeper drop: price pulls back to $117: giveback = (130 - 117) / 130 = 10% (>= 9% required, gain +17% >= 5%) -> triggers exit.
    const deepExits = trailingExits([pos('NVDA', 10, 100, 117)], peaks, active, 1, volMap);
    expect(deepExits).toHaveLength(1);
    expect(deepExits[0].symbol).toBe('NVDA');
    expect(deepExits[0].reason).toBe('trailing_stop');
  });

  it('tightens giveback threshold for calm low-volatility assets', () => {
    // Calm stock (e.g. KO with daily vol = 1.0%, baseline = 2% -> volMult = 0.5x).
    // Required giveback = 3% * 0.5 = 1.5%.
    const volMap = new Map<string, number>([['KO', 1.0]]);
    const peaks = nextPeaks([pos('KO', 50, 100, 110)], new Map());

    // Price pulls back from $110 to $108: giveback = (110 - 108) / 110 = 1.82% (gain +8% >= 5%).
    // Under unscaled policy (3%), 1.82% would NOT trigger.
    // Under vol-scaled policy (1.5%), 1.82% >= 1.5% DOES trigger.
    const unscaledExits = trailingExits([pos('KO', 50, 100, 108)], peaks, active);
    expect(unscaledExits).toHaveLength(0);

    const volScaledExits = trailingExits([pos('KO', 50, 100, 108)], peaks, active, 1, volMap);
    expect(volScaledExits).toHaveLength(1);
    expect(volScaledExits[0].symbol).toBe('KO');

    // Tiny pullback to $109: giveback = (110 - 109) / 110 = 0.91% (< 1.5%) -> holds.
    const tinyWiggle = trailingExits([pos('KO', 50, 100, 109)], peaks, active, 1, volMap);
    expect(tinyWiggle).toHaveLength(0);
  });

  it('caps volatility multiplier at 3.0x and floors at 0.5x', () => {
    // Ultra-volatile stock (vol = 12%, baseline = 2% -> raw ratio = 6.0x -> capped at 3.0x -> 9% giveback).
    // Entry $100 -> Peak $130 (gain +30% >= 5%).
    const extremeVol = new Map<string, number>([['MEME', 12.0]]);
    const peaks = nextPeaks([pos('MEME', 10, 100, 130)], new Map());

    // Pullback to $117: giveback = (130 - 117) / 130 = 10.0% >= 9.0% -> triggers.
    // If cap was not applied (6x -> 18%), 10.0% would not trigger.
    const cappedExits = trailingExits([pos('MEME', 10, 100, 117)], peaks, active, 1, extremeVol);
    expect(cappedExits).toHaveLength(1);

    // Ultra-low volatility stock (vol = 0.1%, baseline = 2% -> raw ratio = 0.05x -> floored at 0.5x -> 1.5% giveback).
    const lowVol = new Map<string, number>([['BOND', 0.1]]);
    const bondPeaks = nextPeaks([pos('BOND', 10, 100, 110)], new Map());

    // 0.8% giveback: (110 - 109.12) / 110 = 0.8% (< 1.5% floor) -> holds.
    // If floor was not applied (0.05x -> 0.15%), 0.8% would prematurely trigger.
    const flooredExits = trailingExits([pos('BOND', 10, 100, 109.12)], bondPeaks, active, 1, lowVol);
    expect(flooredExits).toHaveLength(0);
  });

  it('accepts volPcts as a Record<string, number> as well as Map', () => {
    // 5% vol -> volMult = 2.5x -> required giveback = 7.5%
    // Entry $100 -> Peak $130 (gain +30% >= 5%).
    const volRecord: Record<string, number> = { TSLA: 5.0 };
    const peaks = nextPeaks([pos('TSLA', 10, 100, 130)], new Map());

    // Drop from 130 to 123: giveback = (130 - 123) / 130 = 5.38% (< 7.5%, gain +23% >= 5%) -> holds
    const exits1 = trailingExits([pos('TSLA', 10, 100, 123)], peaks, active, 1, volRecord);
    expect(exits1).toHaveLength(0);

    // Drop from 130 to 119: giveback = (130 - 119) / 130 = 8.46% (>= 7.5%, gain +19% >= 5%) -> triggers
    const exits2 = trailingExits([pos('TSLA', 10, 100, 119)], peaks, active, 1, volRecord);
    expect(exits2).toHaveLength(1);
    expect(exits2[0].symbol).toBe('TSLA');
  });

  it('falls back to 1.0x multiplier if symbol is missing or has non-positive vol', () => {
    const volMap = new Map<string, number>([
      ['ZERO', 0],
      ['NEG', -2.5],
    ]);
    const peaks = nextPeaks([
      pos('MISSING', 10, 100, 110),
      pos('ZERO', 10, 100, 110),
      pos('NEG', 10, 100, 110),
    ], new Map());

    // All drop to 106.3 (giveback 3.36% >= default 3%)
    const exits = trailingExits([
      pos('MISSING', 10, 100, 106.3),
      pos('ZERO', 10, 100, 106.3),
      pos('NEG', 10, 100, 106.3),
    ], peaks, active, 1, volMap);

    expect(exits).toHaveLength(3);
  });

  it('compounds with thin-session givebackMult (extended hours)', () => {
    // Active giveback = 3%. Thin session givebackMult = 1.5 -> unscaled = 4.5%.
    // With vol = 4.0% (volMult = 2.0x), requiredGiveback = 3% * 1.5 * 2.0 = 9.0%.
    // Entry $100 -> Peak $130 (gain +30% >= 5%).
    const volMap = new Map<string, number>([['AMZN', 4.0]]);
    const peaks = nextPeaks([pos('AMZN', 10, 100, 130)], new Map());

    // Drop to 122: giveback = (130 - 122) / 130 = 6.15%.
    // > 4.5% (would exit if only session mult applied)
    // < 9.0% (holds because session mult AND vol mult are compounded)
    const exits = trailingExits([pos('AMZN', 10, 100, 122)], peaks, active, 1.5, volMap);
    expect(exits).toHaveLength(0);

    // Drop to 117: giveback = (130 - 117) / 130 = 10% >= 9.0% -> exits
    const exitsDeep = trailingExits([pos('AMZN', 10, 100, 117)], peaks, active, 1.5, volMap);
    expect(exitsDeep).toHaveLength(1);
    expect(exitsDeep[0].symbol).toBe('AMZN');
  });

  it('respects TRADING_BASELINE_VOL_PCT environment variable override', () => {
    process.env.TRADING_BASELINE_VOL_PCT = '4.0'; // custom baseline 4%
    // Asset with vol = 4.0% now gets volMult = 1.0x (instead of 2.0x)
    const volMap = new Map<string, number>([['SPY', 4.0]]);
    const peaks = nextPeaks([pos('SPY', 10, 100, 110)], new Map());

    // Drop to 106.3 (giveback 3.36% >= 3% * 1.0) -> exits
    const exits = trailingExits([pos('SPY', 10, 100, 106.3)], peaks, active, 1, volMap);
    expect(exits).toHaveLength(1);
  });

  it('ignores unmanaged positions (ADR-159)', () => {
    const volMap = new Map<string, number>([['UNMGD', 1.0]]);
    const peaks = nextPeaks([pos('UNMGD', 10, 100, 110, true)], new Map());
    // Meets all exit criteria (gain > arm, giveback > threshold), but unmanaged = true
    const exits = trailingExits([pos('UNMGD', 10, 100, 100, true)], peaks, active, 1, volMap);
    expect(exits).toHaveLength(0);
  });
});
